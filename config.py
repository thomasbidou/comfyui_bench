"""Config + on-disk state for ComfyUI Bench.

All mutable state lives in a single ``state/`` directory (git-ignored). The
server is the source of truth: models, workflows, benches, outputs and the
auth token are persisted here so state survives restarts and works from any
device on the LAN.
"""
from __future__ import annotations

import json
import os
import secrets
import threading
import time

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(APP_DIR, "state")
CONFIG_PATH = os.path.join(STATE_DIR, "config.json")
MODELS_PATH = os.path.join(STATE_DIR, "models.json")
WORKFLOWS_PATH = os.path.join(STATE_DIR, "workflows.json")
BENCHES_PATH = os.path.join(STATE_DIR, "benches.json")
OUTPUTS_PATH = os.path.join(STATE_DIR, "outputs.json")
USER_META_PATH = os.path.join(STATE_DIR, "user_meta.json")

# Default ComfyUI install + model roots (both editable in Setup).
DEFAULTS = {
    "comfy_base": "http://127.0.0.1:8188",
    "comfy_dir": os.path.expanduser("~/ComfyUI2"),
    "model_roots": [
        os.path.expanduser("~/ComfyUI2/models/checkpoints"),
        os.path.expanduser("~/ComfyUI2/models/diffusion_models"),
    ],
    "output_root": os.path.expanduser("~/ComfyUI2/output"),
    "host": "0.0.0.0",
    "port": 7860,
    "default_seed": 42,
    "nsfw_banner": False,
    "dark_mode": True,
}


def ensure_state():
    os.makedirs(STATE_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_PATH):
        cfg = dict(DEFAULTS)
        cfg["token"] = secrets.token_urlsafe(24)
        atomic_write_json(CONFIG_PATH, cfg)
    for p in (MODELS_PATH, WORKFLOWS_PATH, BENCHES_PATH, OUTPUTS_PATH, USER_META_PATH):
        if not os.path.exists(p):
            default = {} if ("benches" in p or "meta" in p) else []
            atomic_write_json(p, default)
    # Repair a user_meta.json that was ever written as a list (older versions
    # seeded it with []). merge_user_meta() expects a dict keyed by model key.
    try:
        with open(USER_META_PATH, "r", encoding="utf-8") as f:
            cur = json.load(f)
        if not isinstance(cur, dict):
            atomic_write_json(USER_META_PATH, {})
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        atomic_write_json(USER_META_PATH, {})


def atomic_write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


# ---------------------------------------------------------------------------
# Config (thread-safe, small)
# ---------------------------------------------------------------------------
class Config:
    def __init__(self):
        ensure_state()
        self._lock = threading.Lock()
        self._data = read_json(CONFIG_PATH, dict(DEFAULTS))
        self._data.setdefault("token", secrets.token_urlsafe(24))

    def all(self):
        with self._lock:
            return dict(self._data)

    def get(self, key, default=None):
        with self._lock:
            return self._data.get(key, default)

    def set(self, key, value):
        with self._lock:
            self._data[key] = value
            atomic_write_json(CONFIG_PATH, dict(self._data))

    def update(self, mapping):
        with self._lock:
            self._data.update(mapping)
            atomic_write_json(CONFIG_PATH, dict(self._data))

    def regenerate_token(self):
        with self._lock:
            self._data["token"] = secrets.token_urlsafe(24)
            atomic_write_json(CONFIG_PATH, dict(self._data))
            return self._data["token"]

    def check_token(self, candidate):
        return bool(candidate) and secrets.compare_digest(
            str(candidate), str(self._data.get("token", ""))
        )


config = Config()
