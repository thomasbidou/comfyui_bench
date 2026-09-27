"""Thin client for the running ComfyUI server (HTTP + WebSocket).

HTTP: /system_stats, /object_info, /prompt, /history, /interrupt, /queue.
WebSocket: /ws progress events, keyed by prompt_id (verified live).
"""
from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Optional

import websockets


def http_json(method, url, payload=None, timeout=30):
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read()
            return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            return e.code, json.loads(body)
        except Exception:
            return e.code, body.decode("utf-8", "replace")
    except Exception as e:  # URLError, ConnectionRefused, timeout, ...
        return 0, str(e)


class ComfyUI:
    def __init__(self, base: str):
        self.base = base.rstrip("/")

    # -- status -------------------------------------------------------------
    def alive(self) -> bool:
        code, _ = http_json("GET", self.base + "/system_stats", timeout=5)
        return code == 200

    def system_stats(self) -> Optional[dict]:
        code, body = http_json("GET", self.base + "/system_stats", timeout=15)
        if code == 200 and isinstance(body, dict):
            return body
        return None

    def queue_info(self) -> dict:
        code, body = http_json("GET", self.base + "/queue", timeout=15)
        if code == 200 and isinstance(body, dict):
            return body
        return {}

    def object_info(self, node_type: str) -> Optional[dict]:
        code, body = http_json("GET", f"{self.base}/object_info/{node_type}", timeout=30)
        if code == 200 and isinstance(body, dict):
            return body
        return None

    # -- execution ----------------------------------------------------------
    def queue_prompt(self, prompt: dict):
        code, body = http_json("POST", self.base + "/prompt", {"prompt": prompt}, timeout=60)
        if code == 200 and isinstance(body, dict):
            return {"ok": True, "prompt_id": body.get("prompt_id"), "number": body.get("number")}
        return {"ok": False, "error": (body if isinstance(body, str) else str(body))[:500]}

    def history(self, prompt_id: str) -> Optional[dict]:
        code, body = http_json("GET", f"{self.base}/history/{prompt_id}", timeout=20)
        if code == 200 and isinstance(body, dict):
            entry = body.get(prompt_id)
            if entry:
                return entry
        return None

    def interrupt(self):
        http_json("POST", self.base + "/interrupt", timeout=15)

    def clear_queue(self):
        http_json("POST", self.base + "/queue", {"clear": True}, timeout=15)

    def delete_output(self, filename, subfolder="", folder_type="output"):
        payload = {"filename": filename, "subfolder": subfolder, "type": folder_type}
        return http_json("POST", self.base + "/delete-file", payload, timeout=20)[0]

    # -- websocket progress (async) -----------------------------------------
    async def listen_events(self, handler, stop_event: asyncio.Event):
        """Connect to /ws and call handler(event, data) for each message.

        Reconnects with backoff until stop_event is set.
        """
        url = self.base.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
        backoff = 1
        while not stop_event.is_set():
            try:
                async with websockets.connect(url, max_size=None) as ws:
                    backoff = 1
                    while not stop_event.is_set():
                        try:
                            raw = await asyncio.wait_for(ws.recv(), timeout=3)
                        except asyncio.TimeoutError:
                            continue
                        except Exception:
                            break
                        try:
                            msg = json.loads(raw)
                        except Exception:
                            continue
                        handler(msg)
            except Exception:
                pass
            if stop_event.is_set():
                break
            await asyncio.sleep(min(backoff, 15))
            backoff = min(backoff * 2, 30)


# Convenience for the synchronous worker thread (it runs its own event loop).
def ws_loop_listen(base: str, handler, stop_event: asyncio.Event):
    comfy = ComfyUI(base)
    return asyncio.run(comfy.listen_events(handler, stop_event))
