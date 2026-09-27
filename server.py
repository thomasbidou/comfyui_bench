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
from workflows import (workflow_summary, detect_model_loader,
                       detect_seed_nodes, detect_prompt_node,
                       convert_ui_to_api)
from bench import (store, hub, start_bench, stop_bench, is_active,
                   active_bench_ids, start_ws_listener_on_loop,
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


@app.get("/api/models/tree")
def api_models_tree(request: Request):
    require_auth(request)
    models = _all_models()
    tree = {}
    for m in models:
        parts = [m["root"]] + (m["folder"].split("/") if m["folder"] else [])
        cur = tree
        for p in parts:
            if not p:
                continue
            cur = cur.setdefault(p, {})
    return {"tree": tree}


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
# Workflows
# ---------------------------------------------------------------------------
def _workflows():
    return read_json(WORKFLOWS_PATH, [])


def _save_workflows(wf):
    atomic_write_json(WORKFLOWS_PATH, wf)


@app.get("/api/workflows")
def api_workflows(request: Request):
    require_auth(request)
    out = []
    for w in _workflows():
        d = dict(w)
        d["summary"] = workflow_summary(w.get("prompt", {}))
        out.append(d)
    return {"workflows": out, "count": len(out)}


class WorkflowIn(BaseModel):
    name: str
    description: str = ""
    prompt: dict


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
    w = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "description": body.description,
        "prompt": body.prompt,
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
        raise HTTPException(400,
                            "no model loader node found "
                            "(CheckpointLoaderSimple / UNETLoaderWithName)")
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


class WorkflowRename(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    base_seed: Optional[int] = None
    prompt_node_id: Optional[str] = None


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
                if cands and body.prompt_node_id not in cands:
                    raise HTTPException(status_code=400,
                                        detail="prompt_node_id not in this workflow's candidates")
                w["prompt_node_id"] = body.prompt_node_id
            break
    _save_workflows(wfs)
    return {"ok": True}


@app.delete("/api/workflows/{wid}")
def api_workflow_del(request: Request, wid: str):
    require_auth(request)
    wfs = [w for w in _workflows() if w["id"] != wid]
    _save_workflows(wfs)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Benches
# ---------------------------------------------------------------------------
@app.get("/api/benches")
def api_benches(request: Request):
    require_auth(request)
    benches = store.list_benches()
    active = active_bench_ids()
    for b in benches:
        b["active"] = b["id"] in active
    return {"benches": benches, "active": active}


@app.get("/api/benches/{bid}")
def api_bench_get(request: Request, bid: str):
    require_auth(request)
    b = store.get_bench(bid)
    if not b:
        raise HTTPException(status_code=404, detail="bench not found")
    b["active"] = is_active(bid)
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
    bench = start_bench(models, wf, seed=seed, prompt_text=body.prompt,
                        prompt_node_id=target_node,
                        timeout_s=body.timeout or 900)
    return {"ok": True, "bench": bench}


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
                workflow_id: Optional[str] = None):
    require_auth(request)
    rows = store.list_outputs(model_key=model_key, bench_id=bench_id,
                              workflow_id=workflow_id)
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
    output_root: Optional[str] = None
    host: Optional[str] = None
    port: Optional[int] = None
    default_seed: Optional[int] = None
    dark_mode: Optional[bool] = None
    comfy_dir: Optional[str] = None


@app.put("/api/config")
async def api_config_put(request: Request, body: ConfigIn):
    require_auth(request)
    upd = {k: v for k, v in body.dict().items() if v is not None}
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
