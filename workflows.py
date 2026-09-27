"""Workflow analysis + per-model prompt assembly.

A workflow is a ComfyUI API-format prompt (dict of nodes). We detect:
  * the model loader node (CheckpointLoaderSimple -> ckpt_name, or
    UNETLoaderWithName -> unet_name) and which field to swap per model
  * the base prompt text node (the main CLIPTextEncode feeding the sampler)
  * every seed node (KSampler* and any node with a 'seed' input) so a fixed
    seed can be applied to the whole graph

The user can override the prompt (base text node) and the seed at run time.
"""
from __future__ import annotations

import copy
import os
import re

CHECKPOINT_LOADER = "CheckpointLoaderSimple"
UNET_LOADER = "UNETLoaderWithName"
LOADER_FIELDS = {
    CHECKPOINT_LOADER: "ckpt_name",
    UNET_LOADER: "unet_name",
}


def detect_model_loader(prompt):
    """Return (node_id, class_type, field) or (None, None, None)."""
    for nid, node in prompt.items():
        ct = node.get("class_type")
        if ct in LOADER_FIELDS:
            return nid, ct, LOADER_FIELDS[ct]
    return None, None, None


def detect_seed_nodes(prompt):
    """Node ids that carry a 'seed' input (KSamplers + detailers/hires-fix)."""
    out = []
    for nid, node in prompt.items():
        inputs = node.get("inputs", {})
        if "seed" in inputs and not isinstance(inputs["seed"], list):
            out.append(nid)
    return sorted(out)


def detect_prompt_node(prompt):
    """Find the node that holds the base prompt text.

    Works across node types: the canonical base prompt is a `text` input
    (a plain string) that contains the `<lora:...>` markers. We pick the
    shortest such string (the base prompt, not an already-expanded one);
    if none carry lora markers, fall back to the shortest non-empty `text`
    string input that is a literal (not a link).

    CAUTION: on multi-LoRA pipelines the `<lora:...>` holder is a *LoRA
    loader* (e.g. "Lora Loader (LoraManager)") whose `text` carries the lora
    tags — NOT the real subject prompt. The actual subject often lives in a
    separate custom node (e.g. PixaromaShowText) feeding a CLIPTextEncode.
    So we also expose `prompt_candidates` (all text nodes) so the UI can let
    the user pick the real target; the auto default stays the lora node for
    backward compatibility.
    """
    lora_nodes = []
    any_text = []
    for nid, node in prompt.items():
        text = (node.get("inputs") or {}).get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        any_text.append((nid, text, node.get("class_type")))
        if "<lora:" in text:
            lora_nodes.append((nid, text, node.get("class_type")))
    pool = lora_nodes or any_text
    if not pool:
        return None, "", []
    nid, text, _ = min(pool, key=lambda c: len(c[1]))
    candidates = [
        {"id": n, "class_type": ct,
         "preview": (t[:120].replace("\n", " "))}
        for (n, t, ct) in sorted(any_text, key=lambda c: len(c[1]))
    ]
    return nid, text, candidates


def workflow_summary(prompt):
    loader = detect_model_loader(prompt)
    seeds = detect_seed_nodes(prompt)
    pnode, ptext, candidates = detect_prompt_node(prompt)
    return {
        "model_node_id": loader[0],
        "loader_type": loader[1],
        "model_field": loader[2],
        "seed_node_ids": seeds,
        "prompt_node_id": pnode,
        "prompt_candidates": candidates,
        "base_prompt": (ptext or "")[:2000],
        "node_count": len(prompt),
    }


def model_name_for(model, loader_type):
    """The model identifier a loader node expects.

    UNETLoaderWithName  -> name relative to the diffusion_models root,
                           e.g. "Anima/toon/x.safetensors"
    CheckpointLoaderSimple -> the bare checkpoint filename, e.g. "x.ckpt"
    """
    if loader_type == UNET_LOADER:
        root = model.get("root", "")
        if root and model.get("path", "").startswith(root):
            rel = os.path.relpath(model["path"], root).replace(os.sep, "/")
            return rel
        return model.get("rel") or model["name"]
    return model["name"]


def apply_overrides(prompt, model_name, workflow, seed=None, prompt_text=None,
                    prompt_node_id=None):
    """Return a deep copy of prompt with the model swapped + optional
    seed/prompt overrides applied.

    ``prompt_node_id`` (if given) overrides ``workflow['prompt_node_id']`` —
    this lets the UI target the *real* subject node on multi-LoRA pipelines
    where the auto-detected node is a LoRA loader.
    """
    p = copy.deepcopy(prompt)
    mnode, mfield = workflow.get("model_node_id"), workflow.get("model_field")
    if mnode and mfield and mnode in p:
        p[mnode]["inputs"][mfield] = model_name
    if seed is not None:
        for nid in workflow.get("seed_node_ids", []):
            if nid in p and "seed" in p[nid].get("inputs", {}):
                p[nid]["inputs"]["seed"] = int(seed)
    target = prompt_node_id or workflow.get("prompt_node_id")
    if prompt_text is not None and target and target in p:
        p[target]["inputs"]["text"] = prompt_text
    return p


def _input_order(class_def):
    """Ordered input names (required, then optional) — ComfyUI's
    declaration order, which is the slot order for both widgets and
    node-to-node links."""
    inputs = (class_def or {}).get("input") or {}
    ordered = []
    for grp in ("required", "optional"):
        for name in (inputs.get(grp) or {}):
            ordered.append(name)
    return ordered


def convert_ui_to_api(ui_graph, comfy_base="http://127.0.0.1:8188"):
    """Convert a ComfyUI **UI** graph (the `workflow` blob from a
    prompt-exported .json, with `nodes`/`links`) into an **API** prompt
    (`{node_id: {class_type, inputs}}`).

    Uses ComfyUI's own `/object_info` to learn each node class's input
    schema, so `widgets_values` map to the right input names. Inputs that
    are connected (have a `link` in the UI graph) are dropped from the
    widget mapping and instead filled from the global link table.

    Returns (api_prompt, warnings).
    """
    import json
    import urllib.request

    nodes = ui_graph.get("nodes") or []
    by_id = {}
    for n in nodes:
        try:
            nid = str(int(n.get("id")))
        except Exception:
            nid = str(n.get("id"))
        by_id[nid] = n

    object_info = {}
    try:
        with urllib.request.urlopen(
                comfy_base.rstrip("/") + "/object_info", timeout=15) as r:
            object_info = json.load(r)
    except Exception:
        object_info = {}

    api = {}
    for nid, n in by_id.items():
        ct = n.get("type")
        if not ct:
            continue
        order = _input_order(object_info.get(ct))
        linked_slots = set((n.get("links") or {}).keys())  # slot indices
        widgets = n.get("widgets_values")
        if not isinstance(widgets, list):
            widgets = []
        inputs = {}
        widx = 0
        for si, name in enumerate(order):
            if si in linked_slots:
                continue  # connection, filled from the link table below
            if widx < len(widgets):
                inputs[name] = widgets[widx]
                widx += 1
        api[nid] = {"class_type": ct, "inputs": inputs}

    # Connections: link = [id, src, src_slot, tgt, tgt_slot, type]
    for l in (ui_graph.get("links") or []):
        if not isinstance(l, list) or len(l) < 5:
            continue
        src, src_slot, tgt, tgt_slot = str(int(l[1])), int(l[2]), str(int(l[3])), int(l[4])
        tgt_node = api.get(tgt)
        tgt_meta = by_id.get(tgt)
        if tgt_node is None or not tgt_meta:
            continue
        order = _input_order(object_info.get(tgt_meta.get("type")))
        if 0 <= tgt_slot < len(order):
            tgt_node["inputs"][order[tgt_slot]] = [src, src_slot]

    return api, []


def validate_model_name_for_loader(model_name, loader_type):
    """A checkpoint file name vs a UNET relative name are different formats.

    Returns a warning string (or None) if the model looks wrong for the
    workflow's loader type. Non-fatal: we still try to run it.
    """
    if loader_type == CHECKPOINT_LOADER:
        if model_name.startswith(("Anima/",)) and model_name.endswith(".safetensors"):
            return None
        return None
    if loader_type == UNET_LOADER and not model_name.endswith(".safetensors"):
        return "workflow uses UNETLoaderWithName (expects a .safetensors UNET name)"
    return None
