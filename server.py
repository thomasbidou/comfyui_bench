"""ComfyUI Bench — FastAPI app.

Routes:
  /                       SPA (static/index.html)
  /ws                     app WebSocket (live events; auth via ?token=)
  /api/auth               {status, nsfw, dark, default_seed}
  /api/auth/login         set token cookie
  /api/config             get / put / regenerate-token / test-connection
  /api/models             list (filter/sort) ; /api/models/refresh
  /api/models/{key}       get ; PATCH notes/stars
  /api/workflows          list ; POST add
  /api/workflows/{id}     get / PUT rename+edit / DELETE
  /api/benches            list ; GET one ; POST run ; POST stop ; DELETE
  /api/outputs            list ; GET one
  /api/stats              ComfyUI system_stats
  /api/files?path=        serve a preview/output image (path-allowlisted)
"""
from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Optional

from fastapi import (FastAPI, Request, Response, WebSocket,
                     WebSocketDisconnect, HTTPException, Query)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import (config, ensure_state, MODELS_PATH, WORKFLOWS_PATH,
                    USER_META_PATH, atomic_write_json, read_json)
from models import refresh as scan_models, discover_models
from loras import refresh as scan_loras, get as get_loras
from workflows import (workflow_summary, detect_model_loader,
                       detect_lora_loader, detect_seed_nodes,
                       detect_prompt_node, convert_ui_to_api, strength_steps,
                       is_sweepable_loader, LORA_LOADERS)
from bench import (store, hub, start_bench, start_lora_bench, stop_bench, is_active, is_queued,
                   queue_position, pending_queue, active_bench_ids,
                   start_ws_listener_on_loop,
                   stop_ws_listener)
from comfy import ComfyUI

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
ensure_state()

app = FastAPI(title="ComfyUI Bench", version="1.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"],
                   allow_methods=["*"], allow_headers=["*"])

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def _token_from_request(request: Request) -> Optional[str]:
    tok = request.cookies.get("cb_token")
    if tok:
        return tok
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    q = request.query_params.get("token")
    return q


def require_auth(request: Request):
    tok = _token_from_request(request)
    if not tok or not config.check_token(tok):
        raise HTTPException(status_code=401, detail="unauthorized")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
def _all_models():
    roots = config.get("model_roots") or []
    user_meta = read_json(USER_META_PATH, {})
    return scan_models(roots, user_meta)


def _save_user_meta():
    meta = {}
    for m in _all_models():
        if m.get("notes") or m.get("stars"):
            meta[m["key"]] = {"notes": m["notes"], "stars": m["stars"]}
    atomic_write_json(USER_META_PATH, meta)


def _all_loras():
    """Cached lora list (synchronous scan on cold cache)."""
    roots = config.get("lora_roots") or []
    user_meta = read_json(USER_META_PATH, {})
    return get_loras(roots, user_meta)


@app.get("/api/models")
def api_models(request: Request, q: Optional[str] = None,
               sort: str = "name", folder: Optional[str] = None,
               root: Optional[str] = None):
    require_auth(request)
    models = _all_models()
    if folder:
        models = [m for m in models
                  if m["folder"] == folder
                  or m["folder"].startswith(folder + "/")]
    if root:
        models = [m for m in models if m["root"] == root]
    if q:
        qq = q.lower()
        models = [m for m in models
                  if qq in m["name"].lower()
                  or qq in (m.get("display_name") or "").lower()
                  or qq in m["folder"].lower()
                  or qq in (m.get("base_model") or "").lower()]
    keymap = {
        "name": lambda m: m["name"].lower(),
        "display": lambda m: (m.get("display_name") or "").lower(),
        "stars": lambda m: -m.get("stars", 0),
        "size": lambda m: -(m.get("size") or 0),
        "date": lambda m: -(m.get("modified") or 0),
        "folder": lambda m: m["folder"],
    }
    models.sort(key=keymap.get(sort, keymap["name"]))
    # attach latest output per model (cheap: index outputs)
    latest = {}
    for o in store.list_outputs():
        latest.setdefault(o["model_key"], o)
    for m in models:
        m["latest_output"] = latest.get(m["key"])
    return {"models": models, "count": len(models)}


@app.post("/api/models/refresh")
def api_models_refresh(request: Request):
    require_auth(request)
    roots = config.get("model_roots") or []
    user_meta = read_json(USER_META_PATH, {})
    models = scan_models(roots, user_meta)
    return {"count": len(models), "roots": roots}


TREE_CNT = "_cnt"  # reserved key holding the INCLUSIVE item count on each node


def _build_folder_tree(items):
    """Build a nested folder tree whose nodes carry INCLUSIVE item counts.

    Each node is a dict where the reserved key ``_cnt`` holds the number of items in that folder AND all its subfolders, and every other key is a subfolder (a node of the same shape). The top-level dict maps each ROOT path to its node, plus its own ``_cnt`` = the grand total (harmless; the client filters it out).
    """
    tree: dict = {TREE_CNT: 0}
    for m in items:
        tree[TREE_CNT] = tree.get(TREE_CNT, 0) + 1
        cur: dict = tree
        parts = [m["root"]] + (m["folder"].split("/") if m["folder"] else [])
        for p in parts:
            if not p:
                continue
            cur = cur.setdefault(p, {TREE_CNT: 0})  # type: ignore[assignment]
            cur[TREE_CNT] = cur.get(TREE_CNT, 0) + 1
    return tree


@app.get("/api/models/tree")
def api_models_tree(request: Request):
    require_auth(request)
    models = _all_models()
    return {"tree": _build_folder_tree(models)}


class ModelMeta(BaseModel):
    notes: Optional[str] = None
    stars: Optional[int] = None


@app.get("/api/models/{key:path}")
def api_model_get(request: Request, key: str):
    require_auth(request)
    for m in _all_models():
        if m["key"] == key:
            outs = store.list_outputs(model_key=key)[:12]
            m["recent_outputs"] = outs
            return m
    raise HTTPException(status_code=404, detail="model not found")


@app.patch("/api/models/{key:path}")
def api_model_patch(request: Request, key: str, body: ModelMeta):
    require_auth(request)
    if body.notes is None and body.stars is None:
        return {"ok": True}
    # Capture the model once; read current notes/stars and apply the change.
    # (Bug we're avoiding: re-scanning in a second loop returned fresh objects,
    # so the persisted values were always the empty defaults.)
    for m in _all_models():
        if m["key"] == key:
            notes = body.notes if body.notes is not None else (m.get("notes") or "")
            stars = max(0, min(5, int(body.stars))) if body.stars is not None \
                else (m.get("stars") or 0)
            meta = read_json(USER_META_PATH, {})
            if not isinstance(meta, dict):
                meta = {}
            meta[key] = {"notes": notes, "stars": stars}
            atomic_write_json(USER_META_PATH, meta)
            return {"ok": True, "notes": notes, "stars": stars}
    raise HTTPException(status_code=404, detail="model not found")


# ---------------------------------------------------------------------------
# Loras (cached list; LoRA strength-sweep bench)
# ---------------------------------------------------------------------------
def _lora_keymap():
    return {
        "name": lambda m: m["name"].lower(),
        "display": lambda m: (m.get("display_name") or "").lower(),
        "stars": lambda m: -m.get("stars", 0),
        "size": lambda m: -(m.get("size") or 0),
        "date": lambda m: -(m.get("modified") or 0),
        "folder": lambda m: m["folder"],
    }


@app.get("/api/loras")
def api_loras(request: Request, q: Optional[str] = None,
              sort: str = "name", folder: Optional[str] = None,
              root: Optional[str] = None, limit: Optional[int] = None,
              offset: Optional[int] = 0):
    require_auth(request)
    loras = _all_loras()
    if folder:
        loras = [m for m in loras
                 if m["folder"] == folder
                 or m["folder"].startswith(folder + "/")]
    if root:
        loras = [m for m in loras if m["root"] == root]
    if q:
        qq = q.lower()
        loras = [m for m in loras
                 if qq in m["name"].lower()
                 or qq in (m.get("display_name") or "").lower()
                 or qq in m["folder"].lower()]
    keymap = _lora_keymap()
    loras.sort(key=keymap.get(sort, keymap["name"]))
    total = len(loras)
    if limit is not None:
        off = offset or 0
        loras = loras[off:off + limit]
    return {"loras": loras, "count": len(loras), "total": total}


@app.get("/api/loras/tree")
def api_loras_tree(request: Request):
    require_auth(request)
    loras = _all_loras()
    return {"tree": _build_folder_tree(loras)}


@app.post("/api/loras/refresh")
def api_loras_refresh(request: Request):
    require_auth(request)
    roots = config.get("lora_roots") or []
    user_meta = read_json(USER_META_PATH, {})
    loras = scan_loras(roots, user_meta)
    return {"count": len(loras), "roots": roots}


class LoraMeta(BaseModel):
    notes: Optional[str] = None
    stars: Optional[int] = None


@app.get("/api/loras/{key:path}")
def api_lora_get(request: Request, key: str):
    require_auth(request)
    for m in _all_loras():
        if m["key"] == key:
            rows = [o for o in store.list_outputs()
                    if o.get("lora_key") == key][:12]
            m["recent_outputs"] = rows
            return m
    raise HTTPException(status_code=404, detail="lora not found")


@app.patch("/api/loras/{key:path}")
def api_lora_patch(request: Request, key: str, body: LoraMeta):
    require_auth(request)
    if body.notes is None and body.stars is None:
        return {"ok": True}
    for m in _all_loras():
        if m["key"] == key:
            notes = body.notes if body.notes is not None else (m.get("notes") or "")
            stars = max(0, min(5, int(body.stars))) if body.stars is not None \
                else (m.get("stars") or 0)
            meta = read_json(USER_META_PATH, {})
            if not isinstance(meta, dict):
                meta = {}
            meta[key] = {"notes": notes, "stars": stars}
            atomic_write_json(USER_META_PATH, meta)
            return {"ok": True, "notes": notes, "stars": stars}
    raise HTTPException(status_code=404, detail="lora not found")


# ---------------------------------------------------------------------------
# Workflows
# ---------------------------------------------------------------------------
def _workflows():
    return read_json(WORKFLOWS_PATH, [])


def _save_workflows(wf):
    atomic_write_json(WORKFLOWS_PATH, wf)


def _resolve_lora_target(prompt, bench_node_id=None):
    """Pick the LoRA bench target node for a workflow.

    Returns (node_id, class_type) or (None, None) when the workflow has
    no lora loader nodes.

    Order of precedence:
      1. explicit bench_node_id (user-picked at upload time) — accepted
         only if the node exists in the prompt AND is a LORA_LOADERS type
         (rejecting a non-loader node id keeps the record honest)
      2. auto-detect: first standard LoraLoader / LoraLoaderModelOnly
         (is_sweepable_loader) — the strength-sweep-capable node
      3. auto-detect: first LORA_LOADERS match (may be LoraManager —
         stored but NOT sweepable)
    """
    lora_nodes = [
        (nid, node.get("class_type")) for nid, node in prompt.items()
        if isinstance(node, dict) and node.get("class_type") in LORA_LOADERS
    ]
    if not lora_nodes:
        return None, None
    if bench_node_id:
        for nid, ct in lora_nodes:
            if str(nid) == str(bench_node_id):
                return nid, ct
    for nid, ct in lora_nodes:
        if is_sweepable_loader(ct):
            return nid, ct
    return lora_nodes[0]


def _resolve_workflow_kind(prompt, kind=None, bench_node_id=None):
    """Resolve (kind, lora_node_id, lora_bench_supported) for a new workflow.

    ``kind`` is the user's explicit intent: 'model' | 'lora'. When it is one
    of those, it is authoritative (a 'model' workflow keeps kind='model' even
    if it contains LoRA nodes; a 'lora' workflow gets its designation). When
    ``kind`` is None/absent (legacy/auto), fall back to deriving from node
    presence: any LORA_LOADERS node makes it a lora workflow.
    """
    has_lora = any(
        isinstance(node, dict) and node.get("class_type") in LORA_LOADERS
        for node in prompt.values())
    if kind == "model":
        return "model", None, False
    if kind == "lora":
        did, dct = _resolve_lora_target(prompt, bench_node_id)
        supported = bool(did and dct and is_sweepable_loader(dct))
        return "lora", did, supported
    # auto (kind is None / unrecognized): derive from node presence
    if has_lora:
        did, dct = _resolve_lora_target(prompt, bench_node_id)
        supported = bool(did and dct and is_sweepable_loader(dct))
        return "lora", did, supported
    return "model", None, False


@app.get("/api/workflows")
def api_workflows(request: Request):
    require_auth(request)
    wfs = _workflows()
    out = []
    dirty = False
    for w in wfs:
        d = dict(w)
        prompt = w.get("prompt", {})
        d["summary"] = workflow_summary(prompt)
        has_lora = any(
            isinstance(node, dict) and node.get("class_type") in LORA_LOADERS
            for node in prompt.values())
        # Honor an explicit stored kind (user intent: 'model' | 'lora') —
        # never re-derive from node presence for those. A workflow the user
        # marked 'model' stays 'model' even though it contains LoRA nodes,
        # and one marked 'lora' keeps its designation.
        explicit = w.get("kind")
        if explicit in ("model", "lora"):
            dk = explicit
        else:
            # Legacy rows (no stored kind): auto-derive as before — any
            # LORA_LOADERS node makes it a lora workflow.
            dk = "lora" if has_lora else "model"
        if dk == "model":
            did = None
            dct = None
        else:
            # lora_node_id: the STORED designation is authoritative (the user
            # picked it at upload time). Re-derive from detection only when the
            # record has none (legacy rows) — preferring a standard
            # LoraLoader/LoraLoaderModelOnly node over a LoraManager one.
            stored = w.get("lora_node_id")
            if stored and str(stored) in prompt \
                    and isinstance(prompt.get(str(stored)), dict):
                did = str(stored)
                dct = prompt[did].get("class_type")
            else:
                did, dct = _resolve_lora_target(prompt)
        d["kind"] = dk
        d["lora_node_id"] = did
        d["lora_bench_supported"] = (
            did is not None and dct is not None and is_sweepable_loader(dct))
        if dk != w.get("kind") or did != w.get("lora_node_id") \
                or d["lora_bench_supported"] != w.get("lora_bench_supported"):
            # Fill in / normalize records (legacy rows lack kind/designation).
            # Never overwrites a valid stored designation.
            w["kind"] = dk
            w["lora_node_id"] = did
            w["lora_bench_supported"] = d["lora_bench_supported"]
            dirty = True
        out.append(d)
    if dirty:
        _save_workflows(wfs)
    return {"workflows": out, "count": len(out)}


class WorkflowIn(BaseModel):
    name: str
    description: str = ""
    prompt: dict
    # OPTIONAL: node id the user designated as the LoRA bench target
    # (picked in the upload-time lora-node picker). When absent, the
    # backend auto-detects (standard LoraLoader preferred).
    bench_node_id: Optional[str] = None
    # OPTIONAL: user intent for the workflow kind — 'model' | 'lora'.
    # None = auto-derive from node presence (current behavior).
    kind: Optional[str] = None


@app.post("/api/workflows")
async def api_workflow_add(request: Request, body: WorkflowIn):
    require_auth(request)
    import uuid
    wfs = _workflows()
    summary = workflow_summary(body.prompt)
    if not summary["model_node_id"]:
        raise HTTPException(status_code=400,
                            detail="no model loader node found "
                                   "(CheckpointLoaderSimple / UNETLoaderWithName)")
    # Honor the user's explicit kind ('model' | 'lora'); auto-derive when
    # absent. A 'model' workflow keeps kind='model' even with LoRA nodes.
    dk, dnode, dsupported = _resolve_workflow_kind(
        body.prompt, kind=body.kind, bench_node_id=body.bench_node_id)
    w = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "description": body.description,
        "prompt": body.prompt,
        "kind": dk,
        "lora_node_id": dnode,
        "lora_bench_supported": dsupported,
        "model_node_id": summary["model_node_id"],
        "loader_type": summary["loader_type"],
        "model_field": summary["model_field"],
        "seed_node_ids": summary["seed_node_ids"],
        "prompt_node_id": summary["prompt_node_id"],
        "base_prompt": summary["base_prompt"],
        "created": __import__("time").time(),
    }
    wfs.append(w)
    _save_workflows(wfs)
    return {"ok": True, "workflow": w}


@app.post("/api/workflows/upload")
async def api_workflow_upload(request: Request):
    """Upload a ComfyUI-exported .json (UI graph with nodes/links, or an
    API prompt) and register it as a workflow.

    Accepts either:
      * a UI graph  {"nodes": [...], "links": [...], "extra": {...}}
        (what you get from ComfyUI → Save / prompt-export)
      * an API prompt {"52": {"inputs":..., "class_type":...}, ...}
    If it's a UI graph we convert it server-side using ComfyUI's own
    object_info, so widget/link mapping is correct.
    """
    require_auth(request)
    form = await request.form()
    file = form.get("file")
    if file is None:
        raise HTTPException(400, "missing 'file' field")
    raw = await file.read()
    try:
        data = json.loads(raw)
    except Exception as e:
        raise HTTPException(400, f"invalid JSON: {e}")

    is_ui = isinstance(data, dict) and ("nodes" in data or "links" in data)
    if is_ui:
        comfy_base = config.get("comfy_base") or "http://127.0.0.1:8188"
        prompt, _warn = convert_ui_to_api(data, comfy_base)
    else:
        if not isinstance(data, dict) or not any(
                isinstance(v, dict) and "class_type" in v for v in data.values()):
            raise HTTPException(400,
                                "not a recognizable ComfyUI workflow "
                                "(no nodes/links or class_type nodes)")
        prompt = data

    summary = workflow_summary(prompt)
    if not summary["model_node_id"]:
        raise HTTPException(status_code=400,
                            detail="no model loader node found "
                                   "(CheckpointLoaderSimple / UNETLoaderWithName)")
    # Optional 'kind' form field (values 'model'/'lora'/''). Empty or absent
    # → auto-derive from node presence (current behavior).
    kind = str(form.get("kind") or "").strip() or None
    dk, dnode, dsupported = _resolve_workflow_kind(
        prompt, kind=kind, bench_node_id=(form.get("bench_node_id") or None))
    name = (form.get("name") or file.filename or "Uploaded workflow")
    desc = (form.get("description") or "")

    import uuid
    import time
    wfs = _workflows()
    w = {
        "id": str(uuid.uuid4()),
        "name": name,
        "description": desc,
        "prompt": prompt,
        "kind": dk,
        "lora_node_id": dnode,
        "lora_bench_supported": dsupported,
        "model_node_id": summary["model_node_id"],
        "loader_type": summary["loader_type"],
        "model_field": summary["model_field"],
        "seed_node_ids": summary["seed_node_ids"],
        "prompt_node_id": summary["prompt_node_id"],
        "base_prompt": summary["base_prompt"],
        "created": time.time(),
    }
    wfs.append(w)
    _save_workflows(wfs)
    return {"ok": True, "workflow": w}


@app.get("/api/workflows/{wid}")
def api_workflow_get(request: Request, wid: str):
    require_auth(request)
    for w in _workflows():
        if w["id"] == wid:
            d = dict(w)
            d["summary"] = workflow_summary(w.get("prompt", {}))
            return d
    raise HTTPException(status_code=404, detail="workflow not found")


@app.get("/api/workflows/{wid}/nodes")
def api_workflow_nodes(request: Request, wid: str):
    """List every node in a workflow for the node picker.

    Returns [{id, class_type, editable, preview}] ordered by node id.
    `editable` is True when the node carries a text or PromptState value.
    `preview` is a short human-readable snippet of its inputs.
    """
    require_auth(request)
    for w in _workflows():
        if w["id"] == wid:
            prompt = w.get("prompt") or {}
            from workflows import read_node_text, _is_editable
            nodes = []
            for nid, n in prompt.items():
                if not isinstance(n, dict):
                    continue
                inputs = n.get("inputs") or {}
                # Build a compact preview: list the first few inputs with
                # their values (truncate long strings).
                parts = []
                for k, v in list(inputs.items())[:6]:
                    if isinstance(v, (list, tuple)) and len(v) == 2:
                        continue  # link reference [src_id, src_idx]
                    if isinstance(v, str) and len(v) > 60:
                        v = v[:57] + "..."
                    if isinstance(v, (dict, list)):
                        v = f"<{type(v).__name__}>"
                    parts.append(f"{k}={v!r}")
                preview = "  ".join(parts)
                if len(preview) > 140:
                    preview = preview[:137] + "..."
                nodes.append({
                    "id": nid,
                    "class_type": n.get("class_type"),
                    "editable": _is_editable(n),
                    "preview": preview,
                })
            nodes.sort(key=lambda x: int(x["id"]) if x["id"].isdigit() else 10**9)
            return {"nodes": nodes}
    raise HTTPException(status_code=404, detail="workflow not found")


class WorkflowRename(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    base_seed: Optional[int] = None
    prompt_node_id: Optional[str] = None
    # OPTIONAL: re-designate the LoRA bench target node (must be a
    # LORA_LOADERS node in this workflow). Refreshes lora_bench_supported.
    lora_node_id: Optional[str] = None
    # OPTIONAL: re-declare the workflow kind — 'model' | 'lora'. When set,
    # it is authoritative (a 'model' workflow stays 'model' even with LoRA
    # nodes) and refreshes lora_node_id / lora_bench_supported.
    kind: Optional[str] = None


@app.get("/api/workflows/{wid}/nodes/{nid}/value")
def api_workflow_node_value(request: Request, wid: str, nid: str):
    """Return the editable text value of a node (plain text or PromptState)."""
    require_auth(request)
    from workflows import read_node_text
    for w in _workflows():
        if w["id"] == wid:
            node = (w.get("prompt") or {}).get(str(nid))
            if node is None:
                raise HTTPException(404, f"node {nid} not found")
            return {"node_id": nid, "value": read_node_text(node)}
    raise HTTPException(status_code=404, detail="workflow not found")


class NodeEdit(BaseModel):
    node_id: str
    value: Optional[str] = None


@app.put("/api/workflows/{wid}")
def api_workflow_put(request: Request, wid: str, body: WorkflowRename):
    require_auth(request)
    wfs = _workflows()
    for w in wfs:
        if w["id"] == wid:
            if body.name is not None:
                w["name"] = body.name
            if body.description is not None:
                w["description"] = body.description
            if body.base_seed is not None:
                w["base_seed"] = int(body.base_seed)
            if body.prompt_node_id is not None:
                cands = (workflow_summary(w.get("prompt", {})) or {}).get("prompt_candidates") or []
                cand_ids = {str(c.get("id")) for c in cands if isinstance(c, dict)}
                if cand_ids and str(body.prompt_node_id) not in cand_ids:
                    raise HTTPException(status_code=400,
                                        detail="prompt_node_id not in this workflow's candidates")
                w["prompt_node_id"] = body.prompt_node_id
            if body.lora_node_id is not None:
                prompt = w.get("prompt") or {}
                nid = str(body.lora_node_id)
                node = prompt.get(nid)
                if not (isinstance(node, dict)
                        and node.get("class_type") in LORA_LOADERS):
                    raise HTTPException(
                        status_code=400,
                        detail="lora_node_id must be a LoRA loader node "
                               "in this workflow (LoraLoader / "
                               "LoraLoaderModelOnly / Lora Loader "
                               "(LoraManager))")
                w["lora_node_id"] = nid
                w["kind"] = "lora"
                w["lora_bench_supported"] = is_sweepable_loader(
                    node.get("class_type"))
            if body.kind in ("model", "lora"):
                # Re-declare the workflow kind. Authoritative: a 'model'
                # workflow stays 'model' even with LoRA nodes; a 'lora'
                # workflow gets its designation. Applies the same resolution
                # as add/upload.
                prompt = w.get("prompt") or {}
                # Respect an explicit lora_node_id redesignation in the same
                # request when present; otherwise fall back to auto-detect.
                bnode = body.lora_node_id if body.lora_node_id is not None \
                    else None
                dk, dnode, dsupported = _resolve_workflow_kind(
                    prompt, kind=body.kind, bench_node_id=bnode)
                w["kind"] = dk
                w["lora_node_id"] = dnode
                w["lora_bench_supported"] = dsupported
            break
    _save_workflows(wfs)
    return {"ok": True}


@app.delete("/api/workflows/{wid}")
def api_workflow_del(request: Request, wid: str):
    require_auth(request)
    wfs = [w for w in _workflows() if w["id"] != wid]
    _save_workflows(wfs)
    return {"ok": True}


@app.put("/api/workflows/{wid}/node")
def api_workflow_node_edit(request: Request, wid: str, body: NodeEdit):
    """Persist an edited node value (prompt text) into the workflow's stored
    prompt. Uses the shape-aware writer so plain-text nodes and PromptState
    (Pixaroma) nodes are both handled. Also refreshes base_prompt."""
    require_auth(request)
    from workflows import write_node_text, read_node_text
    wfs = _workflows()
    for w in wfs:
        if w["id"] == wid:
            prompt = w.get("prompt") or {}
            nid = str(body.node_id)
            if nid not in prompt:
                raise HTTPException(400, f"node {nid} not in this workflow")
            if body.value is not None:
                write_node_text(prompt[nid], body.value)
                if read_node_text(prompt[nid]):
                    w["base_prompt"] = read_node_text(prompt[nid])[:2000]
            w["prompt"] = prompt
            _save_workflows(wfs)
            return {"ok": True}
    raise HTTPException(status_code=404, detail="workflow not found")


# ---------------------------------------------------------------------------
# Benches
# ---------------------------------------------------------------------------
@app.get("/api/benches")
def api_benches(request: Request, kind: Optional[str] = None):
    require_auth(request)
    benches = store.list_benches()
    if kind:
        benches = [b for b in benches if (b.get("kind") or "model") == kind]
    active = active_bench_ids()
    queue = pending_queue()
    for b in benches:
        b["active"] = b["id"] in active
        b["queued"] = b["id"] in queue
        b["queue_position"] = queue.index(b["id"]) if b["id"] in queue else None
    return {"benches": benches, "active": active, "queue": queue}


@app.get("/api/benches/{bid}")
def api_bench_get(request: Request, bid: str):
    require_auth(request)
    b = store.get_bench(bid)
    if not b:
        raise HTTPException(status_code=404, detail="bench not found")
    b["active"] = is_active(bid)
    b["queued"] = is_queued(bid)
    b["queue_position"] = queue_position(bid)
    return b


class RunIn(BaseModel):
    model_keys: list
    workflow_id: str
    seed: Optional[int] = None
    prompt: Optional[str] = None
    prompt_node_id: Optional[str] = None
    timeout: Optional[int] = None


@app.post("/api/benches/run")
async def api_bench_run(request: Request, body: RunIn):
    require_auth(request)
    wfs = _workflows()
    wf = next((w for w in wfs if w["id"] == body.workflow_id), None)
    if not wf:
        raise HTTPException(status_code=404, detail="workflow not found")
    if not body.model_keys:
        raise HTTPException(status_code=400, detail="no models selected")
    all_models = _all_models()
    by_key = {m["key"]: m for m in all_models}
    models = [by_key[k] for k in body.model_keys if k in by_key]
    if not models:
        raise HTTPException(status_code=400, detail="no valid models")
    seed = body.seed
    if seed is None:
        seed = wf.get("base_seed", config.get("default_seed", 42))
    # Prompt-target node: explicit override > workflow's own setting > auto-detect.
    target_node = body.prompt_node_id or wf.get("prompt_node_id")
    was_running = bool(active_bench_ids())
    bench = start_bench(models, wf, seed=seed, prompt_text=body.prompt,
                        prompt_node_id=target_node,
                        timeout_s=body.timeout or 900)
    return {"ok": True, "bench": bench, "started": not was_running,
            "queued": was_running}


class LoraRunIn(BaseModel):
    workflow_id: str
    base_model_key: str
    lora_key: str
    strength_min: float
    strength_max: float
    increment: float
    seed: Optional[int] = None
    prompt: Optional[str] = None
    prompt_node_id: Optional[str] = None
    timeout: Optional[int] = None


@app.post("/api/benches/run-lora")
async def api_bench_run_lora(request: Request, body: LoraRunIn):
    require_auth(request)
    wfs = _workflows()
    wf = next((w for w in wfs if w["id"] == body.workflow_id), None)
    if not wf:
        raise HTTPException(status_code=404, detail="workflow not found")
    # Validate the bench target using the workflow's STORED designation as
    # authoritative (user-picked at upload time). Only re-detect (standard
    # LoraLoader preferred) when the record has none.
    prompt = wf.get("prompt") or {}
    lnode = wf.get("lora_node_id")
    _lct = None
    if lnode and str(lnode) in prompt and isinstance(prompt.get(str(lnode)), dict):
        lnode = str(lnode)
        _lct = prompt[lnode].get("class_type")
    else:
        lnode, _lct = _resolve_lora_target(prompt)
    if lnode is None:
        raise HTTPException(status_code=400,
                            detail="workflow has no LoraLoader node "
                                   "(use a LoRA workflow)")
    if not is_sweepable_loader(_lct):
        raise HTTPException(
            status_code=400,
            detail=f"the designated LoRA node ({lnode}) is a "
                   f"'{_lct}' with loras already baked in — it can't be "
                   f"strength-swept. Pick a standard LoraLoader node for "
                   f"this workflow (re-upload with the node picker, or edit "
                   f"the workflow's lora_node_id) or use a different "
                   f"workflow.")
    if body.increment <= 0 or body.strength_min > body.strength_max:
        raise HTTPException(status_code=400,
                            detail="invalid strength range "
                                   "(need increment > 0 and min <= max)")
    try:
        steps = strength_steps(body.strength_min, body.strength_max,
                               body.increment)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    all_models = _all_models()
    model = next((m for m in all_models if m["key"] == body.base_model_key),
                 None)
    if model is None:
        raise HTTPException(status_code=404, detail="base model not found")
    lora = next((l for l in _all_loras() if l["key"] == body.lora_key), None)
    if lora is None:
        raise HTTPException(status_code=404, detail="lora not found")
    seed = body.seed
    if seed is None:
        seed = wf.get("base_seed", config.get("default_seed", 42))
    target_node = body.prompt_node_id or wf.get("prompt_node_id")
    was_running = bool(active_bench_ids())
    bench = start_lora_bench(lora, steps, wf, model, seed=seed,
                             prompt_text=body.prompt,
                             prompt_node_id=target_node,
                             timeout_s=body.timeout or 900)
    return {"ok": True, "bench": bench, "started": not was_running,
            "queued": was_running}


@app.post("/api/benches/{bid}/stop")
def api_bench_stop(request: Request, bid: str):
    require_auth(request)
    stop_bench(bid)
    return {"ok": True}


@app.delete("/api/benches/{bid}")
def api_bench_del(request: Request, bid: str):
    require_auth(request)
    if is_active(bid):
        stop_bench(bid)
    store.delete_bench(bid)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------
@app.get("/api/outputs")
def api_outputs(request: Request, model_key: Optional[str] = None,
                bench_id: Optional[str] = None,
                workflow_id: Optional[str] = None,
                kind: Optional[str] = None):
    require_auth(request)
    rows = store.list_outputs(model_key=model_key, bench_id=bench_id,
                              workflow_id=workflow_id)
    if kind:
        rows = [o for o in rows if (o.get("kind") or "model") == kind]
    return {"outputs": rows, "count": len(rows)}


# ---------------------------------------------------------------------------
# Config / auth
# ---------------------------------------------------------------------------
@app.get("/api/auth")
def api_auth(request: Request):
    return {
        "authenticated": bool(_token_from_request(request)
                              and config.check_token(_token_from_request(request))),
        "dark": config.get("dark_mode", True),
        "default_seed": config.get("default_seed", 42),
    }


class LoginIn(BaseModel):
    token: str


@app.post("/api/auth/login")
def api_login(request: Request, body: LoginIn):
    if not config.check_token(body.token):
        raise HTTPException(status_code=401, detail="invalid token")
    resp = JSONResponse({"ok": True,
                         "dark": config.get("dark_mode", True),
                         "default_seed": config.get("default_seed", 42)})
    resp.set_cookie("cb_token", body.token, httponly=True, samesite="lax",
                    max_age=60 * 60 * 24 * 30)
    return resp


@app.get("/api/config")
def api_config_get(request: Request):
    require_auth(request)
    c = config.all()
    c.pop("token", None)
    return c


class ConfigIn(BaseModel):
    comfy_base: Optional[str] = None
    model_roots: Optional[list] = None
    lora_roots: Optional[list] = None
    output_root: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    default_seed: Optional[int] = None
    dark_mode: Optional[bool] = None
    comfy_dir: Optional[str] = None
    # Default base model for LoRA strength-sweep benches (model key, or
    # None/"" to clear).
    lora_bench_default_model: Optional[str] = None


@app.put("/api/config")
async def api_config_put(request: Request, body: ConfigIn):
    require_auth(request)
    upd = {k: v for k, v in body.dict().items() if v is not None}
    # An empty string means "clear the default" — normalize it to None so the
    # user can unset lora_bench_default_model (None would already be dropped).
    if upd.get("lora_bench_default_model") == "":
        upd["lora_bench_default_model"] = None
    if "port" in upd or "host" in upd:
        upd.pop("port"); upd.pop("host")  # apply on restart; note to user
    config.update(upd)
    return {"ok": True, "note": "host/port changes apply on next restart"}


@app.post("/api/config/regenerate-token")
def api_config_regen(request: Request):
    require_auth(request)
    tok = config.regenerate_token()
    return {"ok": True, "token": tok}


@app.get("/api/config/token")
def api_config_token(request: Request):
    require_auth(request)
    return {"token": config.get("token") or ""}


@app.post("/api/config/test-connection")
def api_config_test(request: Request):
    require_auth(request)
    base = config.get("comfy_base")
    comfy = ComfyUI(base)
    alive = comfy.alive()
    stats = comfy.system_stats() if alive else None
    return {"ok": alive, "base": base,
            "device": (stats or {}).get("devices"),
            "system": (stats or {}).get("system")}


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------
@app.get("/api/stats")
def api_stats(request: Request):
    require_auth(request)
    comfy = ComfyUI(config.get("comfy_base") or "http://127.0.0.1:8188")
    return {"stats": comfy.system_stats(), "queue": comfy.queue_info()}


# ---------------------------------------------------------------------------
# File serving (path-allowlisted)
# ---------------------------------------------------------------------------
@app.get("/api/files")
def api_files(request: Request, path: str):
    require_auth(request)
    allowed_roots = list(config.get("model_roots") or []) + \
                    list(config.get("lora_roots") or []) + \
                    [(config.get("output_root") or "")]
    ap = os.path.abspath(path)
    for root in allowed_roots:
        if root and (ap == os.path.abspath(root) or
                     ap.startswith(os.path.abspath(root) + os.sep)):
            if os.path.isfile(ap):
                return FileResponse(ap)
            break
    raise HTTPException(status_code=403, detail="path not allowed")


# ---------------------------------------------------------------------------
# App WebSocket (live events)
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def app_ws(ws: WebSocket):
    tok = ws.query_params.get("token") or (
        ws.cookies.get("cb_token") if hasattr(ws, "cookies") else None)
    if not tok or not config.check_token(tok):
        await ws.close(code=4001)
        return
    await ws.accept()
    q = hub.subscribe()
    try:
        while True:
            msg = await q.get()
            await ws.send_json(msg)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        hub.unsubscribe(q)


# ---------------------------------------------------------------------------
# Static SPA
# ---------------------------------------------------------------------------
@app.get("/")
def spa(request: Request):
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


# mount static assets (js/css) — but keep /api and /ws above
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ---------------------------------------------------------------------------
# Lifespan: start ComfyUI WS listener on the main loop
# ---------------------------------------------------------------------------
from contextlib import asynccontextmanager


@asynccontextmanager
async def lifespan(app: FastAPI):
    loop = asyncio.get_running_loop()
    comfy = ComfyUI(config.get("comfy_base") or "http://127.0.0.1:8188")
    start_ws_listener_on_loop(comfy, loop)
    yield
    await stop_ws_listener()


app.router.lifespan_context = lifespan


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=str(config.get("host", "0.0.0.0")),
                port=int(config.get("port", 7860)), log_level="info")
