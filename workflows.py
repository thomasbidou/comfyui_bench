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
    """
    lora_nodes = []
    any_text = []
    for nid, node in prompt.items():
        text = (node.get("inputs") or {}).get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        any_text.append((nid, text))
        if "<lora:" in text:
            lora_nodes.append((nid, text))
    pool = lora_nodes or any_text
    if not pool:
        return None, ""
    nid, text = min(pool, key=lambda c: len(c[1]))
    return nid, text


def workflow_summary(prompt):
    loader = detect_model_loader(prompt)
    seeds = detect_seed_nodes(prompt)
    pnode = detect_prompt_node(prompt)
    return {
        "model_node_id": loader[0],
        "loader_type": loader[1],
        "model_field": loader[2],
        "seed_node_ids": seeds,
        "prompt_node_id": pnode[0],
        "base_prompt": (pnode[1] or "")[:2000],
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


def apply_overrides(prompt, model_name, workflow, seed=None, prompt_text=None):
    """Return a deep copy of prompt with the model swapped + optional
    seed/prompt overrides applied."""
    p = copy.deepcopy(prompt)
    mnode, mfield = workflow.get("model_node_id"), workflow.get("model_field")
    if mnode and mfield and mnode in p:
        p[mnode]["inputs"][mfield] = model_name
    if seed is not None:
        for nid in workflow.get("seed_node_ids", []):
            if nid in p and "seed" in p[nid].get("inputs", {}):
                p[nid]["inputs"]["seed"] = int(seed)
    if prompt_text is not None and workflow.get("prompt_node_id") and workflow["prompt_node_id"] in p:
        p[workflow["prompt_node_id"]]["inputs"]["text"] = prompt_text
    return p


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
