"""Scan model roots to build the model list + per-model metadata.

A "model" is a weight file (.safetensors / .ckpt / .pt). Beside it we look
for a preview image (<base>.jpeg/.jpg/.png/.webp) and a .metadata.json /
.civitai.info for identity + Civitai stats. Notes and stars are user-managed
and live in state/user_meta.json (keyed by model key), so re-scanning never
wipes them.
"""
from __future__ import annotations

import json
import os
import time

WEIGHT_EXTS = {".safetensors", ".ckpt", ".pt"}
PREVIEW_EXTS = {".jpeg", ".jpg", ".png", ".webp"}


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return json.load(f)
    except Exception:
        return None


def model_key(abs_path: str) -> str:
    """Stable key for a model = path relative to the model root's parent.

    e.g. checkpoints/foo/bar.ckpt or diffusion_models/Anima/toon/x.safetensors.
    """
    return os.path.abspath(abs_path)


def discover_models(roots):
    found = []
    for root in roots:
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for fn in sorted(filenames):
                ext = os.path.splitext(fn)[1].lower()
                if ext not in WEIGHT_EXTS:
                    continue
                model = build_model(os.path.join(dirpath, fn), root)
                if model:
                    found.append(model)
    found.sort(key=lambda m: m["key"])
    return found


def build_model(abs_path, root):
    base = os.path.splitext(os.path.basename(abs_path))[0]
    d = os.path.dirname(abs_path)
    preview = None
    for ext in PREVIEW_EXTS:
        cand = os.path.join(d, base + ext)
        if os.path.isfile(cand):
            preview = cand
            break
    meta = _read_json(os.path.join(d, base + ".metadata.json")) or {}
    civ = _read_json(os.path.join(d, base + ".civitai.info")) or {}
    # .metadata.json sometimes nests the civitai block
    civ = civ or meta.get("civitai", {}) or {}

    display_name = meta.get("model_name") or civ.get("name") or base
    base_model = meta.get("base_model") or civ.get("baseModel")
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
        "base_model": base_model,
        "civitai": civitai,
        "notes": "",
        "stars": 0,
    }


def merge_user_meta(models, user_meta):
    """Apply user-managed notes/stars (keyed by model key) onto fresh models."""
    if not isinstance(user_meta, dict):
        user_meta = {}
    for m in models:
        um = user_meta.get(m["key"]) or {}
        m["notes"] = um.get("notes", "")
        m["stars"] = um.get("stars", 0)
    return models


def refresh(roots, user_meta):
    models = discover_models(roots)
    return merge_user_meta(models, user_meta)
