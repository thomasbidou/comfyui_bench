"""Scan lora roots to build the lora list + per-lora metadata + a cache.

A "lora" is a .safetensors file. Beside it we look for a preview image
(<base>.jpeg/.jpg/.png/.webp or a short video) and a .metadata.json /
.civitai.info for identity + Civitai stats. Notes and stars are user-managed
and live in state/user_meta.json (keyed by lora key = abs path), so
re-scanning never wipes them.

Unlike models (re-scanned on every read), the lora list is CACHED in
state/loras.json: a full walk of ~7k files takes ~5s, so we scan once and
serve from cache. `get()` returns the cached list, triggering a one-time
synchronous scan only when the cache is missing or empty. `refresh()`
forces a re-scan (the /api/loras/refresh endpoint).
"""
from __future__ import annotations

import json
import os
import threading
import time

from config import LORAS_PATH, atomic_write_json, read_json

LORA_EXTS = {".safetensors"}
# A preview may be an image (preferred) or a short video.
PREVIEW_EXTS = {".jpeg", ".jpg", ".png", ".webp"}
VIDEO_EXTS = {".mp4", ".webm", ".gif", ".mov", ".m4v"}

# Guards the one-time synchronous scan inside get() so concurrent first reads
# don't each trigger a full walk.
_scan_lock = threading.Lock()


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            import json
            return json.load(f)
    except Exception:
        return None


def discover_loras(roots):
    """Walk lora roots; return a sorted list of lora dicts (.safetensors only)."""
    found = []
    for root in roots:
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for fn in sorted(filenames):
                ext = os.path.splitext(fn)[1].lower()
                if ext not in LORA_EXTS:
                    continue
                lora = build_lora(os.path.join(dirpath, fn), root)
                if lora:
                    found.append(lora)
    found.sort(key=lambda m: m["key"])
    return found


def build_lora(abs_path, root):
    """Build one lora item from its abs path (mirror of models.build_model,
    minus the weight-specific `base_model` field — LoRAs don't carry one)."""
    base = os.path.splitext(os.path.basename(abs_path))[0]
    d = os.path.dirname(abs_path)
    preview = None
    for ext in PREVIEW_EXTS:
        cand = os.path.join(d, base + ext)
        if os.path.isfile(cand):
            preview = cand
            break
    preview_kind = "video" if (preview and preview.lower().endswith(tuple(VIDEO_EXTS))) else "image"
    if preview is None:
        for ext in VIDEO_EXTS:
            cand = os.path.join(d, base + ext)
            if os.path.isfile(cand):
                preview = cand
                preview_kind = "video"
                break
    meta = _read_json(os.path.join(d, base + ".metadata.json")) or {}
    civ = _read_json(os.path.join(d, base + ".civitai.info")) or {}
    # .metadata.json sometimes nests the civitai block
    civ = civ or meta.get("civitai", {}) or {}

    display_name = meta.get("model_name") or civ.get("name") or base
    size = meta.get("size")
    if not size:
        try:
            size = os.path.getsize(abs_path)
        except OSError:
            size = None
    modified = meta.get("modified")
    if not modified:
        try:
            modified = os.path.getmtime(abs_path)
        except OSError:
            modified = None

    # Civitai stats block
    stats = civ.get("stats", {}) or {}
    civitai = {
        "id": civ.get("id"),
        "modelId": civ.get("modelId"),
        "name": civ.get("name"),
        "author": (civ.get("model") or {}).get("name") or civ.get("name"),
        "downloads": stats.get("downloadCount"),
        "likes": stats.get("thumbsUpCount"),
        "created": civ.get("createdAt"),
    }

    rel = os.path.relpath(abs_path, os.path.abspath(root)).replace(os.sep, "/")
    return {
        "key": os.path.abspath(abs_path),
        "name": os.path.basename(abs_path),
        "display_name": display_name,
        "rel": rel,
        "path": abs_path,
        "folder": os.path.dirname(rel),  # '' for root-level
        "root": root,
        "size": size,
        "modified": modified,
        "preview": preview,
        "preview_kind": preview_kind if preview else None,
        "civitai": civitai,
        "notes": "",
        "stars": 0,
    }


def merge_user_meta(loras, user_meta):
    """Apply user-managed notes/stars (keyed by lora key = abs path) onto
    fresh loras. Same pattern as models.merge_user_meta — lora keys (abs
    paths under the loras root) don't collide with model keys."""
    if not isinstance(user_meta, dict):
        user_meta = {}
    for m in loras:
        um = user_meta.get(m["key"]) or {}
        m["notes"] = um.get("notes", "")
        m["stars"] = um.get("stars", 0)
    return loras


# ---------------------------------------------------------------------------
# Cache (state/loras.json = {"scanned_at": ts, "loras": [ ... ]})
# ---------------------------------------------------------------------------
def load_cache():
    """Return (scanned_at, loras) from the cache file, or (None, [])."""
    cache = read_json(LORAS_PATH, {})
    if not isinstance(cache, dict):
        return None, []
    items = cache.get("loras")
    if not isinstance(items, list):
        items = []
    return cache.get("scanned_at"), items


def save_cache(items, scanned_at=None):
    atomic_write_json(LORAS_PATH, {"scanned_at": scanned_at if scanned_at is not None else time.time(),
                                   "loras": items})


def refresh(roots, user_meta):
    """Re-scan lora roots, merge user meta, write the cache, return items."""
    items = discover_loras(roots or [])
    merge_user_meta(items, user_meta)
    save_cache(items)
    return items


def get(roots, user_meta):
    """Return the cached lora list (with user meta applied).

    If the cache is missing/empty, do a one-time synchronous scan under a
    lock (so concurrent first reads don't each walk ~7k files).
    """
    with _scan_lock:
        scanned_at, items = load_cache()
        if items:
            merge_user_meta(items, user_meta)
            return items
        # Cold cache: scan once, cache, serve.
        return refresh(roots, user_meta)


def _clear_cache():
    save_cache([])


def clear():
    """Drop the cache (forces a re-scan on the next get())."""
    with _scan_lock:
        _clear_cache()
