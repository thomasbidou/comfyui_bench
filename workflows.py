"""Workflow analysis + per-model prompt assembly.

A workflow is a ComfyUI API-format prompt (dict of nodes). We detect:
  * the model loader node (CheckpointLoaderSimple -> ckpt_name, or a UNET
    loader — UNETLoader / UNETLoaderWithName -> unet_name) and which field
    to swap per model
  * the base prompt text node (the main CLIPTextEncode feeding the sampler)
  * every seed node (KSampler* and any node with a 'seed' input) so a fixed
    seed can be applied to the whole graph

The user can override the prompt (base text node) and the seed at run time.
"""
from __future__ import annotations

import copy
import json
import os
import re

CHECKPOINT_LOADER = "CheckpointLoaderSimple"
# Canonical UNET loader type reported in workflow summaries. ComfyUI ships
# two node classes that load a bare diffusion model into the same `unet_name`
# field — `UNETLoaderWithName` (the newer node) and `UNETLoader` (the
# "Load Diffusion Model" node, the one in the Anima presets) — and we treat
# both as the same thing downstream, so we normalize to this canonical name.
UNET_LOADER = "UNETLoaderWithName"
UNET_LOADER_VARIANTS = ("UNETLoaderWithName", "UNETLoader")
LOADER_FIELDS = {
    CHECKPOINT_LOADER: "ckpt_name",
    "UNETLoaderWithName": "unet_name",
    "UNETLoader": "unet_name",
}
# LoRA loader nodes: a strength-sweep bench targets one of these. LoraLoader
# has strength_model + strength_clip; LoraLoaderModelOnly has strength_model
# only (NO strength_clip). "Lora Loader (LoraManager)" carries its loras as
# a baked-in widget list (no lora_name/strength_* fields) — it marks a
# workflow as kind='lora' but is NOT strength-sweepable.
LORA_LOADERS = ("LoraLoader", "LoraLoaderModelOnly", "Lora Loader (LoraManager)")
# Only the standard loaders expose lora_name/strength_model (+strength_clip),
# so only these support the strength-sweep bench.
SWEEPABLE_LORA_LOADERS = ("LoraLoader", "LoraLoaderModelOnly")


def is_sweepable_loader(class_type):
    """True if a detected lora loader node supports a strength sweep."""
    return class_type in SWEEPABLE_LORA_LOADERS


def detect_model_loader(prompt):
    """Return (node_id, class_type, field) or (None, None, None)."""
    for nid, node in prompt.items():
        ct = node.get("class_type")
        if ct in LOADER_FIELDS:
            return nid, ct, LOADER_FIELDS[ct]
    return None, None, None


def detect_lora_loader(prompt):
    """Return (node_id, class_type) of the first LoraLoader* node, or
    (None, None). First match in dict order wins."""
    for nid, node in prompt.items():
        ct = node.get("class_type")
        if ct in LORA_LOADERS:
            return nid, ct
    return None, None


def detect_seed_nodes(prompt):
    """Node ids that carry a 'seed' input (KSamplers + detailers/hires-fix)."""
    out = []
    for nid, node in prompt.items():
        inputs = node.get("inputs", {})
        if "seed" in inputs and not isinstance(inputs["seed"], list):
            out.append(nid)
    return sorted(out)


def _is_editable(node):
    if not isinstance(node, dict):
        return False
    inputs = node.get("inputs") or {}
    if isinstance(inputs.get("text"), str) and inputs["text"].strip():
        return True
    if isinstance(inputs.get("PromptState"), str) and inputs["PromptState"].strip():
        return True
    return False


def read_node_text(node):
    """Read a node's editable text, handling plain `text` and Pixaroma-style
    `PromptState` (a JSON string like {"text":"...","order":"mine","sep":", "}")."""
    if not isinstance(node, dict):
        return ""
    inputs = node.get("inputs") or {}
    t = inputs.get("text")
    if isinstance(t, str) and t.strip():
        return t
    state = inputs.get("PromptState")
    if isinstance(state, str) and state.strip():
        try:
            obj = json.loads(state)
            if isinstance(obj, dict) and isinstance(obj.get("text"), str):
                return obj["text"]
        except (ValueError, TypeError):
            pass
    return ""


def write_node_text(node, text):
    """Write prompt text into a node in whatever shape it actually uses —
    plain `text` (PixaromaShowText) or a JSON `PromptState` (PixaromaPrompt).
    Preserves order/sep on PromptState.
    """
    if not isinstance(node, dict):
        return
    inputs = node.get("inputs")
    if inputs is None:
        inputs = node.setdefault("inputs", {})
    if isinstance(inputs.get("PromptState"), str) or "PromptState" in inputs:
        obj = None
        cur = inputs.get("PromptState")
        if isinstance(cur, str):
            try:
                obj = json.loads(cur)
            except (ValueError, TypeError):
                obj = None
        if not isinstance(obj, dict):
            obj = {"text": text, "order": "mine", "sep": ", "}
        else:
            obj["text"] = text
        inputs["PromptState"] = json.dumps(obj)
    else:
        inputs["text"] = text


def detect_prompt_node(prompt):
    """Find the node that holds the base prompt text, across node types.

    A node is *editable* if it has a plain `text` string input or a
    Pixaroma-style `PromptState` (JSON `{"text":...}`). We pick the
    shortest such node (the base subject prompt, not an already-expanded
    one); the LoRA-tag holder is preferred only when nothing else matches.

    `prompt_candidates` is returned so the UI can let the user pick the
    real target on multi-LoRA pipelines.
    """
    lora_nodes = []
    editable = []
    for nid, node in prompt.items():
        text = read_node_text(node)
        if not text.strip():
            continue
        editable.append((nid, text, node.get("class_type")))
        if "<lora:" in text:
            lora_nodes.append((nid, text, node.get("class_type")))
    # Prefer the SUBJECT text node (non-LoRA holder) over the LoRA-tag
    # holder, since on multi-LoRA pipelines the lora node only carries
    # <lora:...> tags — the real prompt is the other editable node.
    non_lora = [c for c in editable if c not in lora_nodes]
    pool = non_lora or lora_nodes or editable
    if not pool:
        return None, "", []
    nid, text, _ = min(pool, key=lambda c: len(c[1]))
    candidates = [
        {"id": n, "class_type": ct,
         "preview": (t[:120].replace("\n", " "))}
        for (n, t, ct) in sorted(editable, key=lambda c: len(c[1]))
    ]
    return nid, text, candidates


def workflow_summary(prompt):
    loader = detect_model_loader(prompt)
    # Normalize UNETLoader / UNETLoaderWithName to the canonical name so
    # downstream comparisons (model_name_for, UI warnings) treat both the
    # same — they share the `unet_name` field and the diffusion_models root.
    loader_type = loader[1]
    if loader_type in UNET_LOADER_VARIANTS:
        loader_type = UNET_LOADER
    seeds = detect_seed_nodes(prompt)
    pnode, ptext, candidates = detect_prompt_node(prompt)
    return {
        "model_node_id": loader[0],
        "loader_type": loader_type,
        "model_field": loader[2],
        "seed_node_ids": seeds,
        "prompt_node_id": pnode,
        "prompt_candidates": candidates,
        "base_prompt": (ptext or "")[:2000],
        "node_count": len(prompt),
    }


def model_name_for(model, loader_type):
    """The model identifier a loader node expects.

    UNET loader (UNETLoader / UNETLoaderWithName)
                           -> name relative to the diffusion_models root,
                              e.g. "Anima/toon/x.safetensors"
    CheckpointLoaderSimple -> the bare checkpoint filename, e.g. "x.ckpt"
    """
    if loader_type in UNET_LOADER_VARIANTS:
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
    if prompt_text is not None:
        if target is not None and str(target) in p:
            write_node_text(p[str(target)], prompt_text)
        else:
            # Fall back to the first editable node in numeric order.
            cands = [
                nid for nid, n in p.items() if _is_editable(n)
            ]
            if cands:
                pick = min(cands, key=lambda s: int(s) if str(s).isdigit() else 10**9)
                write_node_text(p[pick], prompt_text)
    return p


def strength_steps(min_s, max_s, inc):
    """LoRA strength-sweep ladder: min_s, min_s+inc, ... clamped so the last
    step lands exactly on max_s (the clamp rule).

    Rules (all enforced):
      * inc <= 0                          -> ValueError("increment must be > 0")
      * min_s > max_s                     -> ValueError("min strength must be <= max strength")
      * steps built upward from min_s by inc, each value round(v, 4)
      * stop when a generated value >= max_s; if the last value is still
        < max_s, append round(max_s, 4) as the final step
      * min_s == max_s -> [round(min_s, 4)] (exactly one step)
      * dedupe consecutive duplicates
      * more than 100 steps               -> ValueError("too many strength steps (max 100)")
    """
    if inc <= 0:
        raise ValueError("increment must be > 0")
    if min_s > max_s:
        raise ValueError("min strength must be <= max strength")

    steps = []
    v = float(min_s)
    while True:
        rv = round(v, 4)
        if rv >= max_s:
            break  # stop here; do NOT append an overshoot — clamp below
        if not steps or steps[-1] != rv:
            steps.append(rv)
        v += inc
    # Clamp: guarantee the final step is exactly max_s (last image at max).
    # Covers min==max (steps still empty) and any non-aligned increment.
    if not steps or steps[-1] < round(max_s, 4):
        steps.append(round(max_s, 4))

    if len(steps) > 100:
        raise ValueError("too many strength steps (max 100)")
    return steps


def apply_lora_overrides(prompt, workflow, model_name, lora_name, strength,
                         seed=None, prompt_text=None, prompt_node_id=None,
                         strength_clip=None, lora_node_id=None):
    """Return a deep copy of `prompt` with:
      * the fixed base model set on the model loader node
      * the LoRA (name + strength_model [+ strength_clip for LoraLoader])
        set on the target LoraLoader node
      * the seed + prompt overrides applied exactly like apply_overrides

    `strength_clip` defaults to `strength` when None. LoraLoaderModelOnly
    gets NO strength_clip field (it doesn't have one).

    `lora_node_id` (if given and present in the prompt) is the AUTHORITATIVE
    target node — the workflow's stored designation (user-picked at
    upload time). When None/absent, falls back to detect_lora_loader
    (first match in dict order).
    """
    p = copy.deepcopy(prompt)

    # Fixed base model on the loader node.
    mnode = workflow.get("model_node_id")
    mfield = workflow.get("model_field")
    if mnode and mfield and mnode in p:
        p[mnode]["inputs"][mfield] = model_name

    # LoRA node: stored designation first, auto-detect as fallback.
    lnode, lct = detect_lora_loader(p)
    if lora_node_id is not None and str(lora_node_id) in p \
            and isinstance(p.get(str(lora_node_id)), dict):
        lnode = str(lora_node_id)
        lct = p[lnode].get("class_type")
    if lnode is not None and lct is not None:
        if not is_sweepable_loader(lct):
            raise ValueError(
                "lora node type %r is not a standard LoraLoader; "
                "strength sweep unsupported" % lct)
        ins = p[lnode].setdefault("inputs", {})
        ins["lora_name"] = lora_name
        ins["strength_model"] = float(strength)
        sc = float(strength_clip) if strength_clip is not None else float(strength)
        if lct == "LoraLoader":
            ins["strength_clip"] = sc
        # LoraLoaderModelOnly: no strength_clip.

    # Seed (same as apply_overrides).
    if seed is not None:
        for nid in workflow.get("seed_node_ids", []):
            if nid in p and "seed" in p[nid].get("inputs", {}):
                p[nid]["inputs"]["seed"] = int(seed)

    # Prompt text (same as apply_overrides).
    target = prompt_node_id or workflow.get("prompt_node_id")
    if prompt_text is not None:
        if target is not None and str(target) in p:
            write_node_text(p[str(target)], prompt_text)
        else:
            cands = [nid for nid, n in p.items() if _is_editable(n)]
            if cands:
                pick = min(cands, key=lambda s: int(s) if str(s).isdigit() else 10**9)
                write_node_text(p[pick], prompt_text)
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
        # A slot is "linked" (carries a node-to-node connection) when its
        # `inputs[].link` is set. The slot index is the position in the
        # node's `inputs` array (ComfyUI convention). These slots are filled
        # from the link table below, NOT from widgets_values.
        linked_slots = set()
        for idx, inp in enumerate(n.get("inputs") or []):
            if isinstance(inp, dict) and inp.get("link") is not None:
                linked_slots.add(idx)
        for slot, _lk in (n.get("links") or {}).items():  # {slot: link_id}
            try:
                linked_slots.add(int(slot))
            except (TypeError, ValueError):
                pass
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
    if loader_type in UNET_LOADER_VARIANTS and not model_name.endswith(".safetensors"):
        return ("workflow uses a UNET loader (UNETLoader / UNETLoaderWithName) — "
                "expects a .safetensors UNET name")
    return None
