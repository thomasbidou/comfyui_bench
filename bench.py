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
from workflows import apply_overrides, apply_lora_overrides, model_name_for


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
        # mark benches that were in-flight/queued when we last shut down:
        #  running -> interrupted, queued -> stopped (in-memory queue is gone)
        changed = False
        for b in self.benches.values():
            if b.get("status") == "running":
                b["status"] = "interrupted"
                changed = True
            elif b.get("status") == "queued":
                b["status"] = "stopped"
                b["results"] = {}
                b["done"] = 0
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

    def mark_running(self, bench_id):
        """Transition a queued bench to running (don't set finished yet)."""
        with self._lock:
            b = self.benches.get(bench_id)
            if b:
                b["status"] = "running"
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
    def __init__(self, bench_id, models, workflow, seed=None, prompt_text=None,
                 prompt_node_id=None):
        self.bench_id = bench_id
        self.models = models
        self.workflow = workflow
        self.seed = seed
        self.prompt_text = prompt_text
        self.prompt_node_id = prompt_node_id
        self.comfy = ComfyUI(config.get("comfy_base") or "http://127.0.0.1:8188")
        self._stop = threading.Event()
        self._stopped = False

    def stop(self):
        """Request an abort: stop queuing more models, abort the one running
        in ComfyUI, AND clear ComfyUI's pending queue so the GPU actually goes
        idle. (interrupt() alone only aborts the current prompt and leaves the
        rest of the bench still generating.)"""
        self._stopped = True
        self._stop.set()
        try:
            self.comfy.interrupt()
        except Exception:
            pass
        try:
            self.comfy.clear_queue()
        except Exception:
            pass

    def was_stopped(self):
        return self._stopped

    def _prompt_in_queue(self, pid):
        """True if a prompt_id is still queued/running inside ComfyUI
        (neither finished nor dropped). Used to detect a hung generation."""
        if not pid:
            return False
        try:
            q = self.comfy.queue_info()
        except Exception:
            return True  # can't tell — assume still queued (don't drop it)
        for grp in ("queue_running", "queue_pending"):
            for entry in (q.get(grp) or []):
                if isinstance(entry, (list, tuple)) and len(entry) > 1 \
                        and entry[1] == pid:
                    return True
        return False

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

    def _wait_model(self, pid, model_name, model_key, timeout_s, stall_s=0,
                    extra=None):
        deadline = time.time() + timeout_s
        last_progress = time.time()

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
                last_progress = time.time()
                if sstr == "success":
                    out_file = self._output_from_history(entry, model_name)
                    _finish("success", output=out_file)
                    if out_file:
                        row = {
                            "id": f"{self.bench_id}:{model_key}",
                            "bench_id": self.bench_id,
                            "model_key": model_key,
                            "model_name": model_name,
                            "workflow_id": self.workflow.get("id"),
                            "workflow_name": self.workflow.get("name"),
                            "seed": self.seed,
                            "output": out_file,
                            "created": time.time(),
                        }
                        if extra is not None:
                            row.update(extra)
                        store.add_output(row)
                    return
                if sstr in ("error", "cancelled"):
                    err = None
                    for m in (entry.get("status") or {}).get("messages", []):
                        if m[0] == "execution_error":
                            err = m[1].get("exception_message") or str(m[1])
                    _finish("error" if sstr == "error" else "cancelled",
                            error=err)
                    return
            else:
                # No history yet. If the prompt was dropped from ComfyUI's
                # queue (interrupted, OOM-killed, or otherwise abandoned) and
                # never produced a result, don't wait until the full timeout —
                # fail this model and move on.
                if stall_s and pid and not self._prompt_in_queue(pid) \
                        and (time.time() - last_progress) > stall_s:
                    _finish("timeout",
                            error="dropped from ComfyUI queue (interrupted/hung)")
                    return
            time.sleep(3)
        _finish("timeout")

    def run(self, timeout_s=900, stall_s=180):
        # 1) queue all models. Each model is independent: a failure here
        #    (bad filename, loader mismatch, ComfyUI rejecting the prompt,
        #    a network blip) marks THAT model failed and moves to the next —
        #    it never aborts the whole bench. If a stop is requested mid-loop we
        #    stop queuing immediately and mark the rest cancelled.
        for m in self.models:
            mk = m["key"]
            if self._stop.is_set():
                store.set_model_status(self.bench_id, mk, status="cancelled")
                continue
            store.set_model_status(self.bench_id, mk, status="queued")
            try:
                mname = model_name_for(m, self.workflow.get("loader_type"))
                prompt = apply_overrides(self.workflow["prompt"], mname,
                                         self.workflow, seed=self.seed,
                                         prompt_text=self.prompt_text,
                                         prompt_node_id=self.prompt_node_id)
                r = self.comfy.queue_prompt(prompt)
            except Exception as e:
                store.set_model_status(self.bench_id, mk, status="queue_error",
                                       error=str(e)[:400])
                hub.publish({"type": "model_done", "bench_id": self.bench_id,
                             "model_key": mk, "status": "queue_error"})
                continue
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
                self._wait_model(st.get("prompt_id"), m["name"], mk, timeout_s,
                                 stall_s=stall_s)


class LoraBenchRunner(BenchRunner):
    """Strength-sweep runner: one base model + one LoRA, stepped through a
    ladder of strength values (each step = one generation).

    Subclasses BenchRunner (inheriting stop/was_stopped/_wait_model/
    _output_from_history/_prompt_in_queue) but does NOT call super().__init__
    — it carries lora/steps/model instead of a models list.
    """

    def __init__(self, bench_id, lora, steps, workflow, model, seed=None,
                 prompt_text=None, prompt_node_id=None, strength_clip=None):
        self.bench_id = bench_id
        self.lora = lora
        self.steps = list(steps)
        self.workflow = workflow
        self.model = model
        self.seed = seed
        self.prompt_text = prompt_text
        self.prompt_node_id = prompt_node_id
        self.strength_clip = strength_clip
        self.comfy = ComfyUI(config.get("comfy_base") or "http://127.0.0.1:8188")
        self._stop = threading.Event()
        self._stopped = False

    @staticmethod
    def _step_key(i, s):
        return "step_{i:03d}_{s:.4f}".format(i=i, s=float(s))

    def run(self, timeout_s=900, stall_s=180):
        model_name = model_name_for(self.model, self.workflow.get("loader_type"))
        lora_name = self.lora.get("rel") or self.lora.get("name")

        def mk(i, s):
            return self._step_key(i, s)

        # 1) queue all steps. Each step is independent: a failure marks THAT
        #    step failed and moves on; a stop request cancels the rest.
        for i, s in enumerate(self.steps):
            key = mk(i, s)
            if self._stop.is_set():
                store.set_model_status(self.bench_id, key, status="cancelled")
                continue
            store.set_model_status(self.bench_id, key, status="queued")
            try:
                prompt = apply_lora_overrides(
                    self.workflow["prompt"], self.workflow, model_name,
                    lora_name, float(s), seed=self.seed,
                    prompt_text=self.prompt_text,
                    prompt_node_id=self.prompt_node_id,
                    strength_clip=self.strength_clip,
                    lora_node_id=self.workflow.get("lora_node_id"))
                r = self.comfy.queue_prompt(prompt)
            except Exception as e:
                store.set_model_status(self.bench_id, key, status="queue_error",
                                       error=str(e)[:400])
                hub.publish({"type": "model_done", "bench_id": self.bench_id,
                             "model_key": key, "status": "queue_error"})
                continue
            if not r.get("ok"):
                store.set_model_status(self.bench_id, key, status="queue_error",
                                       error=str(r.get("error"))[:400])
                hub.publish({"type": "model_done", "bench_id": self.bench_id,
                             "model_key": key, "status": "queue_error"})
                continue
            store.set_model_status(self.bench_id, key, status="running",
                                   prompt_id=r.get("prompt_id"))
            if r.get("prompt_id"):
                _register_pid(r["prompt_id"], self.bench_id, key)
            hub.publish({"type": "model_queued", "bench_id": self.bench_id,
                         "model_key": key})

        # 2) wait for each step (in order), tagging the output row with the
        #    lora/strength context via _wait_model's extra.
        for i, s in enumerate(self.steps):
            key = mk(i, s)
            b = store.get_bench(self.bench_id) or {}
            st = (b.get("results") or {}).get(key, {})
            if st.get("status") in ("queued", "running"):
                if self._stop.is_set():
                    store.set_model_status(self.bench_id, key, status="cancelled")
                    continue
                extra = {
                    "kind": "lora",
                    "lora_key": self.lora.get("key"),
                    "lora_name": lora_name,
                    "strength": float(s),
                }
                display = f"{self.model.get('name') or model_name}@{s}"
                self._wait_model(st.get("prompt_id"), display, key, timeout_s,
                                 stall_s=stall_s, extra=extra)


# ---------------------------------------------------------------------------
# Public API (FastAPI routes call these)
#
# Runs are SERIALIZED: only one bench executes at a time. start_bench enqueues
# the run (status "queued"); a single dispatcher thread pops from the FIFO and
# runs it. This protects ComfyUI's single queue and the UI's one-active model,
# and means "prepare a run while one is running" simply lines it up.
# ---------------------------------------------------------------------------
_active = {}                       # bench_id -> runner (currently running only)
_active_lock = threading.Lock()
_queue = []                        # FIFO of (runner, timeout_s) waiting to start
_queue_lock = threading.Condition()


def _dispatch_loop():
    """Pop the next queued run and execute it. One at a time, FIFO order."""
    while True:
        with _queue_lock:
            while not _queue:
                _queue_lock.wait()
            runner, timeout_s = _queue.pop(0)
        try:
            _run_one(runner, timeout_s)
        except Exception:
            pass  # _run_one handles its own error bookkeeping


def _run_one(runner, timeout_s):
    with _active_lock:
        _active[runner.bench_id] = runner
    hub.set_active_bench(runner.bench_id)
    store.mark_running(runner.bench_id)
    try:
        runner.run(timeout_s=timeout_s)
        store.mark_bench(runner.bench_id, "stopped" if runner.was_stopped() else "finished")
    except Exception as e:
        store.mark_bench(runner.bench_id, "error")
        store.update_bench(runner.bench_id, error=str(e)[:400])
    finally:
        with _active_lock:
            _active.pop(runner.bench_id, None)
        hub.publish({"type": "bench_finished", "bench_id": runner.bench_id})


def start_bench(models, workflow, seed=None, prompt_text=None,
                prompt_node_id=None, timeout_s=900):
    bench = {
        "id": str(uuid.uuid4()),
        "created": time.time(),
        "finished": None,
        "status": "queued",
        "workflow_id": workflow.get("id"),
        "workflow_name": workflow.get("name"),
        "seed": seed,
        "prompt": (prompt_text or "")[:2000],
        "prompt_node_id": prompt_node_id,
        "total": len(models),
        "done": 0,
        "model_keys": [m["key"] for m in models],
        "results": {},
    }
    store.create_bench(bench)
    runner = BenchRunner(bench["id"], models, workflow, seed, prompt_text,
                         prompt_node_id)
    with _queue_lock:
        _queue.append((runner, timeout_s))
        _queue_lock.notify()
    # if nothing is running right now, tell the UI it will start imminently
    with _active_lock:
        will_start_now = not _active
    if will_start_now:
        hub.publish({"type": "bench_queued", "bench_id": bench["id"],
                     "starting": True})
    else:
        hub.publish({"type": "bench_queued", "bench_id": bench["id"],
                     "starting": False,
                     "position": queue_position(bench["id"])})
    return bench


def start_lora_bench(lora, steps, workflow, model, seed=None, prompt_text=None,
                     prompt_node_id=None, strength_clip=None, timeout_s=900):
    """Create + enqueue a LoRA strength-sweep bench (one model + one LoRA).

    Mirrors start_bench's bench-dict shape + enqueue block, but with kind
    'lora', a single lora_key, and per-step model_keys.
    """
    steps = list(steps)
    bench = {
        "id": str(uuid.uuid4()),
        "created": time.time(),
        "finished": None,
        "status": "queued",
        "kind": "lora",
        "workflow_id": workflow.get("id"),
        "workflow_name": workflow.get("name"),
        "base_model": (model or {}).get("display_name")
                       or (model or {}).get("name"),
        "base_model_key": (model or {}).get("key"),
        "lora_key": lora.get("key"),
        "lora_name": lora.get("display_name") or lora.get("name"),
        "strength_min": steps[0],
        "strength_max": steps[-1],
        "strengths": list(steps),
        "seed": seed,
        "prompt": (prompt_text or "")[:2000],
        "prompt_node_id": prompt_node_id,
        "total": len(steps),
        "done": 0,
        "model_keys": ["step_{i:03d}_{s:.4f}".format(i=i, s=float(s))
                       for i, s in enumerate(steps)],
        "results": {},
    }
    store.create_bench(bench)
    runner = LoraBenchRunner(bench["id"], lora, steps, workflow, model,
                             seed, prompt_text, prompt_node_id, strength_clip)
    with _queue_lock:
        _queue.append((runner, timeout_s))
        _queue_lock.notify()
    # if nothing is running right now, tell the UI it will start imminently
    with _active_lock:
        will_start_now = not _active
    if will_start_now:
        hub.publish({"type": "bench_queued", "bench_id": bench["id"],
                     "starting": True})
    else:
        hub.publish({"type": "bench_queued", "bench_id": bench["id"],
                     "starting": False,
                     "position": queue_position(bench["id"])})
    return bench


def queue_position(bench_id):
    """0-indexed position of a bench in the pending queue (or None)."""
    with _queue_lock:
        for i, (r, _t) in enumerate(_queue):
            if r.bench_id == bench_id:
                return i
    return None


def pending_queue():
    """Ordered list of bench ids currently waiting to start."""
    with _queue_lock:
        return [r.bench_id for (r, _t) in _queue]


def stop_bench(bench_id):
    """Stop a run: if queued, drop it; if running, signal the runner to abort."""
    with _queue_lock:
        for i, (r, _t) in enumerate(_queue):
            if r.bench_id == bench_id:
                del _queue[i]
                store.mark_bench(bench_id, "stopped")
                hub.publish({"type": "bench_stopped", "bench_id": bench_id,
                            "reason": "removed from queue"})
                return True
    with _active_lock:
        r = _active.get(bench_id)
    if r:
        r.stop()
        return True
    return False


def is_active(bench_id):
    with _active_lock:
        return bench_id in _active


def is_queued(bench_id):
    return queue_position(bench_id) is not None


def active_bench_ids():
    with _active_lock:
        return list(_active.keys())


# Start the dispatcher now that every function it references is defined.
_dispatcher = threading.Thread(target=_dispatch_loop, name="bench-dispatcher",
                               daemon=True)
_dispatcher.start()


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
