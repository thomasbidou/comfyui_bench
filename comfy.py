"""Thin client for the running ComfyUI server (HTTP + WebSocket).

HTTP: /system_stats, /object_info, /prompt, /history, /interrupt, /queue.
WebSocket: /ws progress events, keyed by prompt_id (verified live).

Auth: ComfyUI-Login (custom node) fronts every endpoint with a login wall.
It accepts ``Authorization: Bearer <token>`` where ``token`` is the bcrypt
hash stored on line 1 of ``<comfy_dir>/login/PASSWORD`` (the node's own
``load_token()`` uses exactly this). We send that header on every HTTP call
and on the WebSocket. ``make_comfy(cfg)`` resolves the token: explicit
``comfy_token`` override wins, otherwise it is auto-read from that file, so
no manual entry is needed for a local ComfyUI.
"""
from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import Optional

import websockets


def http_json(method, url, payload=None, timeout=30, headers=None):
    data = None
    hdrs = {"Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
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


def _token_from_password_file(comfy_dir: str) -> str:
    """ComfyUI-Login API token = line 1 of <comfy_dir>/login/PASSWORD
    (the bcrypt hash the node itself uses as its Bearer/query token).
    Returns "" if the file/dir is absent or unreadable."""
    if not comfy_dir:
        return ""
    p = os.path.join(comfy_dir, "login", "PASSWORD")
    try:
        with open(p, "rb") as f:
            first = f.readline().strip()
        return first.decode("utf-8", "replace")
    except (OSError, UnicodeDecodeError):
        return ""


def make_comfy(cfg, base: Optional[str] = None) -> "ComfyUI":
    """Build a ComfyUI client with its auth token resolved from app config.

    Token resolution: explicit ``comfy_token`` (if set) wins; otherwise it is
    auto-derived from ``<comfy_dir>/login/PASSWORD`` line 1 (ComfyUI-Login).
    An empty token means "no auth" (the pre-login behaviour).
    """
    base = (base or cfg.get("comfy_base") or "http://127.0.0.1:8188").rstrip("/")
    token = (cfg.get("comfy_token") or "").strip()
    if not token:
        token = _token_from_password_file(cfg.get("comfy_dir") or "")
    return ComfyUI(base, token)


class ComfyUI:
    def __init__(self, base: str, token: str = ""):
        self.base = base.rstrip("/")
        self.token = (token or "").strip()

    def _auth_headers(self) -> dict:
        h = {}
        if self.token:
            h["Authorization"] = "Bearer " + self.token
        return h

    # -- status -------------------------------------------------------------
    def probe_code(self) -> int:
        """HTTP status of a lightweight GET /system_stats (0 = unreachable)."""
        code, _ = http_json("GET", self.base + "/system_stats", timeout=5,
                            headers=self._auth_headers())
        return code

    def alive(self) -> bool:
        return self.probe_code() == 200

    def system_stats(self) -> Optional[dict]:
        code, body = http_json("GET", self.base + "/system_stats", timeout=15,
                               headers=self._auth_headers())
        if code == 200 and isinstance(body, dict):
            return body
        return None

    def queue_info(self) -> dict:
        code, body = http_json("GET", self.base + "/queue", timeout=15,
                               headers=self._auth_headers())
        if code == 200 and isinstance(body, dict):
            return body
        return {}

    def object_info(self, node_type: str) -> Optional[dict]:
        code, body = http_json("GET", f"{self.base}/object_info/{node_type}", timeout=30,
                               headers=self._auth_headers())
        if code == 200 and isinstance(body, dict):
            return body
        return None

    # -- execution ----------------------------------------------------------
    def queue_prompt(self, prompt: dict):
        code, body = http_json("POST", self.base + "/prompt", {"prompt": prompt},
                               timeout=60, headers=self._auth_headers())
        if code == 200 and isinstance(body, dict):
            return {"ok": True, "prompt_id": body.get("prompt_id"), "number": body.get("number")}
        error_str = (body if isinstance(body, str) else str(body))[:500]
        # Also expose the STRUCTURED body (dict/list) so the caller can build a
        # human-readable summary before it is stringified. Callers that only
        # need r["error"] are unaffected.
        error_body = body if isinstance(body, (dict, list)) else None
        return {"ok": False, "error": error_str, "error_body": error_body}

    def history(self, prompt_id: str) -> Optional[dict]:
        code, body = http_json("GET", f"{self.base}/history/{prompt_id}", timeout=20,
                               headers=self._auth_headers())
        if code == 200 and isinstance(body, dict):
            entry = body.get(prompt_id)
            if entry:
                return entry
        return None

    def interrupt(self):
        http_json("POST", self.base + "/interrupt", timeout=15,
                  headers=self._auth_headers())

    def clear_queue(self):
        http_json("POST", self.base + "/queue", {"clear": True}, timeout=15,
                  headers=self._auth_headers())

    def delete_output(self, filename, subfolder="", folder_type="output"):
        payload = {"filename": filename, "subfolder": subfolder, "type": folder_type}
        return http_json("POST", self.base + "/delete-file", payload, timeout=20,
                         headers=self._auth_headers())[0]

    # -- websocket progress (async) -----------------------------------------
    async def listen_events(self, handler, stop_event: asyncio.Event):
        """Connect to /ws and call handler(event, data) for each message.

        Reconnects with backoff until stop_event is set.
        """
        url = self.base.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
        ws_headers = self._auth_headers()  # ComfyUI-Login walls /ws too
        backoff = 1
        while not stop_event.is_set():
            try:
                # websockets>=11: the connect keyword for extra headers is
                # `additional_headers` (was `extra_headers` in older versions).
                connect_kwargs = {"max_size": None}
                if ws_headers:
                    connect_kwargs["additional_headers"] = ws_headers
                async with websockets.connect(url, **connect_kwargs) as ws:
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
def ws_loop_listen(base: str, handler, stop_event: asyncio.Event, token: str = ""):
    comfy = ComfyUI(base, token)
    return asyncio.run(comfy.listen_events(handler, stop_event))
