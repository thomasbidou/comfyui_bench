"""Bench runner + live-event plumbing.

Architecture:
  * A dedicated background thread owns a long-lived asyncio loop and keeps a
    persistent WebSocket to ComfyUI's /ws. Every ComfyUI event is handed to
    the EventHub (thread-safe) which fans it out to subscribed browser WS
    clients. This loop lives for the whole app, independent of any bench.
  * A bench runs on its own thread: it queues all models, then polls
    /history/{prompt_id} for authoritative completion + the output file.
  * store holds benches + outputs (persisted to state/).
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
import uuid
from typing import Optional

from config import (BENCHES_PATH, OUTPUTS_PATH, config,
                    atomic_write_json, read_json)
from comfy import ComfyUI
from workflows import apply_overrides, model_name_for


# ---------------------------------------------------------------------------
# Thread-safe event hub: bridges ComfyUI WS (any thread) -> browser WS clients
# ---------------------------------------------------------------------------
class EventHub:
    def __init__(self):
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self._subscribers = set()   # asyncio.Queue (created on the hub loop)
        self._lock = threading.Lock()
        self._last_bench = None     # bench_id currently being driven

    def attach_loop(self, loop):
        self.loop = loop

    def set_active_bench(self, bench_id):
        self._last_bench = bench_id

    def subscribe(self):
        assert self.loop is not None, "hub loop not ready"
        q: asyncio.Queue = asyncio.Queue(maxsize=2000)
        with self._lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subscribers.discard(q)

    def publish(self, message: dict):
        loop = self.loop
        if loop is None:
            return
        with self._lock:
            subs = list(self._subscribers)
        if not subs:
            return
        def _fanout():
            for q in subs:
                try:
                    q.put_nowait(message)
                except asyncio.QueueFull:
                    pass
        try:
            loop.call_soon_threadsafe(_fanout)
        except RuntimeError:
            pass  # loop closed


hub = EventHub()


# ---------------------------------------------------------------------------
# ComfyUI WS listener: runs as an asyncio task on the MAIN (uvicorn) loop.
# Started from the FastAPI lifespan. Hub.loop == that loop, so publishing to
# subscriber queues (created on the same loop) is safe.
# ---------------------------------------------------------------------------
def _on_comfy_event(msg):
    t = msg.get("type")
    if t not in ("progress", "progress_state", "executing", "executed",
                 "execution_success", "execution_error", "status"):
        return
    data = dict(msg.get("data", {}))
    pid = data.get("prompt_id")
    if pid:
        pm = _pid_map.get(pid)
        if pm:
            data["bench_id"] = pm[0]
            data["model_key"] = pm[1]
    hub.publish({"type": t, "data": data})


# prompt_id -> (bench_id, model_key); maintained by the runner
_pid_map = {}
_pid_map_lock = threading.Lock()


def _register_pid(pid, bench_id, model_key):
    with _pid_map_lock:
        _pid_map[pid] = (bench_id, model_key)


def _forget_pid(pid):
    with _pid_map_lock:
        _pid_map.pop(pid, None)


async def ws_listener_task(comfy: ComfyUI, stop: asyncio.Event):
    """Long-running task on the main loop: relay ComfyUI events to the hub."""
    await comfy.listen_events(_on_comfy_event, stop)


def start_ws_listener_on_loop(comfy: ComfyUI, loop: asyncio.AbstractEventLoop):
    """Create the listener task on the given (main) loop and wire the hub."""
    global _ws_stop_event, _ws_task
    hub.attach_loop(loop)
    _ws_stop_event = asyncio.Event()
    _ws_task = asyncio.ensure_future(ws_listener_task(comfy, _ws_stop_event), loop=loop)
    return _ws_task


async def stop_ws_listener():
    global _ws_task, _ws_stop_event
    if _ws_stop_event is not None:
        _ws_stop_event.set()
    if _ws_task is not None:
        _ws_task.cancel()
        try:
            await _ws_task
        except (asyncio.CancelledError, Exception):
            pass


_ws_stop_event: Optional[asyncio.Event] = None
_ws_task: Optional[asyncio.Task] = None


# ---------------------------------------------------------------------------
# Store: benches + outputs
# ---------------------------------------------------------------------------
class BenchStore:
    def __init__(self):
        self._lock = threading.Lock()
        self.benches = read_json(BENCHES_PATH, {})   # {bench_id: bench}
        self.outputs = read_json(OUTPUTS_PATH, [])   # list[output]
        # mark any bench that was running when we last shut down as interrupted
        changed = False
        for b in self.benches.values():
            if b.get("status") == "running":
                b["status"] = "interrupted"
                changed = True
        if changed:
            atomic_write_json(BENCHES_PATH, self.benches)

    def _save_benches(self):
        atomic_write_json(BENCHES_PATH, self.benches)

    def _save_outputs(self):
        atomic_write_json(OUTPUTS_PATH, self.outputs)

    def create_bench(self, bench):
        with self._lock:
            self.benches[bench["id"]] = bench
            self._save_benches()

    def update_bench(self, bench_id, **fields):
        with self._lock:
            if bench_id in self.benches:
                self.benches[bench_id].update(fields)
                self._save_benches()

    def get_bench(self, bench_id):
        with self._lock:
            b = self.benches.get(bench_id)
            return dict(b) if b else None

    def list_benches(self):
        with self._lock:
            return sorted((dict(b) for b in self.benches.values()),
                          key=lambda b: b.get("created", 0), reverse=True)

    def delete_bench(self, bench_id):
        with self._lock:
            self.benches.pop(bench_id, None)
            self._save_benches()

    def set_model_status(self, bench_id, model_key, **fields):
        with self._lock:
            b = self.benches.get(bench_id)
            if not b:
                return
            res = b["results"].setdefault(model_key, {})
            res.update(fields)
            res["updated"] = time.time()
            b["done"] = sum(1 for r in b["results"].values()
                            if r.get("status") in ("success", "error",
                                                   "timeout", "cancelled"))
            self._save_benches()

    def mark_bench(self, bench_id, status):
        with self._lock:
            b = self.benches.get(bench_id)
            if b:
                b["status"] = status
                b["finished"] = time.time()
                self._save_benches()

    def add_output(self, out):
        with self._lock:
            self.outputs.append(out)
            self._save_outputs()

    def list_outputs(self, model_key=None, bench_id=None, workflow_id=None):
        with self._lock:
            rows = list(self.outputs)
        if model_key: rows = [o for o in rows if o["model_key"] == model_key]
        if bench_id: rows = [o for o in rows if o.get("bench_id") == bench_id]
        if workflow_id: rows = [o for o in rows if o.get("workflow_id") == workflow_id]
        return sorted(rows, key=lambda o: o.get("created", 0), reverse=True)


store = BenchStore()


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------
class BenchRunner:
    def __init__(self, bench_id, models, workflow, seed=None, prompt_text=None):
        self.bench_id = bench_id
        self.models = models
        self.workflow = workflow
        self.seed = seed
        self.prompt_text = prompt_text
        self.comfy = ComfyUI(config.get("comfy_base") or "http://127.0.0.1:8188")
        self._stop = threading.Event()

    def stop(self):
        self._stop.set()
        try:
            self.comfy.interrupt()
        except Exception:
            pass

    def _output_from_history(self, entry, model_name):
        out_root = config.get("output_root") or ""
        best = None
        best_size = -1
        for nid, out in (entry.get("outputs") or {}).items():
            for key in ("images", "gifs"):
                for im in (out.get(key) or []):
                    if im.get("type") != "output":
                        continue
                    sub = im.get("subfolder") or ""
                    fn = im.get("filename")
                    path = os.path.join(out_root, sub, fn) if sub \
                        else os.path.join(out_root, fn)
                    if os.path.isfile(path):
                        try:
                            size = os.path.getsize(path)
                        except OSError:
                            size = 0
                        if size > best_size:
                            best_size, best = size, path
        if best:
            return best
        return find_output_file(out_root, model_name)

    def _wait_model(self, pid, model_name, model_key, timeout_s):
        deadline = time.time() + timeout_s

        def _finish(status, output=None, error=None):
            store.set_model_status(self.bench_id, model_key, status=status,
                                   output=output, error=error)
            if pid:
                _forget_pid(pid)
            hub.publish({"type": "model_done", "bench_id": self.bench_id,
                         "model_key": model_key, "status": status,
                         "output": output})

        while time.time() < deadline:
            if self._stop.is_set():
                _finish("cancelled")
                return
            entry = self.comfy.history(pid)
            if entry:
                sstr = (entry.get("status") or {}).get("status_str")
                if sstr == "success":
                    out_file = self._output_from_history(entry, model_name)
                    _finish("success", output=out_file)
                    if out_file:
                        store.add_output({
                            "id": f"{self.bench_id}:{model_key}",
                            "bench_id": self.bench_id,
                            "model_key": model_key,
                            "model_name": model_name,
                            "workflow_id": self.workflow.get("id"),
                            "workflow_name": self.workflow.get("name"),
                            "seed": self.seed,
                            "output": out_file,
                            "created": time.time(),
                        })
                    return
                if sstr in ("error", "cancelled"):
                    err = None
                    for m in (entry.get("status") or {}).get("messages", []):
                        if m[0] == "execution_error":
                            err = m[1].get("exception_message") or str(m[1])
                    _finish("error" if sstr == "error" else "cancelled",
                            error=err)
                    return
            time.sleep(3)
        _finish("timeout")

    def run(self, timeout_s=900):
        # 1) queue all models
        for m in self.models:
            mk = m["key"]
            store.set_model_status(self.bench_id, mk, status="queued")
            mname = model_name_for(m, self.workflow.get("loader_type"))
            prompt = apply_overrides(self.workflow["prompt"], mname, self.workflow,
                                     seed=self.seed,
                                     prompt_text=self.prompt_text)
            r = self.comfy.queue_prompt(prompt)
            if not r.get("ok"):
                store.set_model_status(self.bench_id, mk, status="queue_error",
                                       error=str(r.get("error"))[:400])
                hub.publish({"type": "model_done", "bench_id": self.bench_id,
                             "model_key": mk, "status": "queue_error"})
                continue
            store.set_model_status(self.bench_id, mk, status="running",
                                   prompt_id=r.get("prompt_id"))
            if r.get("prompt_id"):
                _register_pid(r["prompt_id"], self.bench_id, mk)
            hub.publish({"type": "model_queued", "bench_id": self.bench_id,
                         "model_key": mk})
        # 2) wait for each (in order)
        for m in self.models:
            mk = m["key"]
            b = store.get_bench(self.bench_id) or {}
            st = (b.get("results") or {}).get(mk, {})
            if st.get("status") in ("queued", "running"):
                if self._stop.is_set():
                    store.set_model_status(self.bench_id, mk, status="cancelled")
                    continue
                self._wait_model(st.get("prompt_id"), m["name"], mk, timeout_s)


# ---------------------------------------------------------------------------
# Public API (FastAPI routes call these)
# ---------------------------------------------------------------------------
_active = {}
_active_lock = threading.Lock()


def start_bench(models, workflow, seed=None, prompt_text=None, timeout_s=900):
    bench = {
        "id": str(uuid.uuid4()),
        "created": time.time(),
        "finished": None,
        "status": "running",
        "workflow_id": workflow.get("id"),
        "workflow_name": workflow.get("name"),
        "seed": seed,
        "prompt": (prompt_text or "")[:2000],
        "total": len(models),
        "done": 0,
        "model_keys": [m["key"] for m in models],
        "results": {},
    }
    store.create_bench(bench)
    hub.set_active_bench(bench["id"])
    runner = BenchRunner(bench["id"], models, workflow, seed, prompt_text)
    with _active_lock:
        _active[bench["id"]] = runner
    t = threading.Thread(target=_worker, args=(runner, timeout_s),
                         name=f"bench-{bench['id'][:8]}", daemon=True)
    t.start()
    return bench


def _worker(runner, timeout_s):
    try:
        runner.run(timeout_s=timeout_s)
        store.mark_bench(runner.bench_id, "finished")
    except Exception as e:
        store.mark_bench(runner.bench_id, "error")
        store.update_bench(runner.bench_id, error=str(e)[:400])
    finally:
        hub.publish({"type": "bench_finished", "bench_id": runner.bench_id})
        with _active_lock:
            _active.pop(runner.bench_id, None)


def stop_bench(bench_id):
    with _active_lock:
        r = _active.get(bench_id)
    if r:
        r.stop()
        return True
    return False


def is_active(bench_id):
    with _active_lock:
        return bench_id in _active


def active_bench_ids():
    with _active_lock:
        return list(_active.keys())


# ---------------------------------------------------------------------------
# Fallback output-file scan (from the original script)
# ---------------------------------------------------------------------------
def find_output_file(out_root, model_name):
    base_name = os.path.basename(model_name)
    for ext in (".safetensors", ".ckpt"):
        base_name = base_name.replace(ext, "")
    base_name = base_name.replace(" ", "_")
    candidates = []
    if out_root and os.path.isdir(out_root):
        for entry in sorted(os.listdir(out_root)):
            d = os.path.join(out_root, entry)
            if not os.path.isdir(d):
                continue
            for fn in os.listdir(d):
                if fn.lower().endswith((".png", ".webp")) and base_name in fn.replace(" ", "_"):
                    candidates.append(os.path.join(d, fn))
    if candidates:
        return max(candidates, key=lambda p: os.path.getmtime(p))
    return None
