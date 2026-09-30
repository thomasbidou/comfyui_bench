/* ComfyUI Bench — SPA (vanilla JS, no build step) */
"use strict";

// ---------------------------------------------------------------------------
// API helper (cookie auth)
// ---------------------------------------------------------------------------
const API = {
  async req(method, path, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) {
      opt.headers["Content-Type"] = "application/json";
      opt.body = JSON.stringify(body);
    }
    const r = await fetch("/api" + path, opt);
    if (r.status === 401) throw new AuthError();
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) throw new ApiError(r.status, (data && data.detail) || data || r.statusText);
    return data;
  },
  // multipart upload (no Content-Type header; browser sets the boundary)
  async upload(path, formdata) {
    const r = await fetch("/api" + path, { method: "POST", body: formdata });
    if (r.status === 401) throw new AuthError();
    const text = await r.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!r.ok) throw new ApiError(r.status, (data && data.detail) || data || r.statusText);
    return data;
  },
  get: (p) => API.req("GET", p),
  post: (p, b) => API.req("POST", p, b),
  put: (p, b) => API.req("PUT", p, b),
  patch: (p, b) => API.req("PATCH", p, b),
  del: (p) => API.req("DELETE", p),
};
class AuthError extends Error {}
class ApiError extends Error { constructor(s, d) { super(d); this.status = s; this.detail = d; } }

function fileUrl(p) { return "/api/files?path=" + encodeURIComponent(p); }
function thumbUrl(p, size) { return "/api/thumb?path=" + encodeURIComponent(p) + "&size=" + (size || 400); }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c])); }
function fmtBytes(n) { if (!n) return "—";
  const u = ["B","KB","MB","GB","TB"]; let i=0; while (n>=1024 && i<u.length-1){n/=1024;i++;}
  return n.toFixed(n<10&&i>0?1:0)+" "+u[i]; }
function fmtTime(ts) { if (!ts) return "—";
  return new Date(ts*1000).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}); }
function stars(n) { n=Math.max(0,Math.min(5,n|0)); return "★".repeat(n)+"☆".repeat(5-n); }

// ---------------------------------------------------------------------------
// Hover preview box (Run-bench lists): one shared floating box on
// document.body that shows a model/LoRA's preview thumb near the cursor.
// Delegated to the three persistent list containers (they only swap innerHTML
// on re-render, so their listeners survive), and pointer-events:none so it
// never steals a row click/checkbox. Markup mirrors the grid thumb (image vs
// video). hoverHide() is called from navigate() to clear it on page/tab change.
// ---------------------------------------------------------------------------
let hoverBox = null;
let hoverMedia = null;
let hoverKey = null; // the row currently shown (avoids re-loading the image while moving within one row)
function ensureHoverBox() {
  if (hoverBox) return hoverBox;
  hoverBox = document.createElement("div");
  hoverBox.className = "hoverthumb";
  hoverMedia = document.createElement("div");
  hoverBox.appendChild(hoverMedia);
  document.body.appendChild(hoverBox);
  return hoverBox;
}
function hoverHide() {
  if (hoverBox) hoverBox.style.display = "none";
  hoverKey = null;
}
function hoverShow(key, m) {
  if (key === hoverKey && hoverMedia.innerHTML) return; // same row -> no flicker
  hoverKey = key;
  ensureHoverBox(); // must create hoverMedia before touching it
  let html;
  if (m && m.preview) {
    if (m.preview_kind === "video") {
      // static first frame (matches the grid cards: muted, no autoplay)
      html = `<video class="thumb" muted playsinline preload="metadata" src="${fileUrl(m.preview)}"></video>`;
    } else {
      // 360 = 2x the 180px box for crisp retina rendering (server caches webp)
      html = `<img class="thumb" loading="lazy" src="${thumbUrl(m.preview, 360)}">`;
    }
  } else {
    html = `<div class="thumb placeholder">no preview</div>`;
  }
  hoverMedia.innerHTML = html;
  hoverBox.style.display = "block";
}
function hoverMove(e) {
  if (!hoverBox || hoverBox.style.display === "none") return;
  const pad = 14, w = hoverBox.offsetWidth, h = hoverBox.offsetHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  const vw = window.innerWidth, vh = window.innerHeight;
  if (x + w > vw - 8) x = e.clientX - w - pad; // overflow right  -> flip to the left
  if (y + h > vh - 8) y = e.clientY - h - pad; // overflow bottom -> flip up
  if (x < 8) x = 8; if (y < 8) y = 8;
  hoverBox.style.left = x + "px"; hoverBox.style.top = y + "px";
}
function attachHoverPreview(container, resolveFn) {
  if (!container || container.__hoverBound) return;
  container.__hoverBound = true;
  container.addEventListener("mouseover", (e) => {
    const row = e.target.closest(".row");
    if (!row || !row.dataset.key) { hoverHide(); return; }
    const m = resolveFn(row.dataset.key);
    if (!m) { hoverHide(); return; }
    hoverShow(row.dataset.key, m);
    hoverMove(e);
  });
  container.addEventListener("mousemove", hoverMove);
  container.addEventListener("mouseout", (e) => {
    if (!container.contains(e.relatedTarget)) hoverHide(); // left the list -> hide
  });
  container.addEventListener("mouseleave", hoverHide);
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function toast(msg, ms=3200) {
  const el = document.createElement("div");
  el.className = "toast"; el.textContent = msg;
  document.getElementById("toast-root").appendChild(el);
  setTimeout(()=>{ el.style.opacity="0"; el.style.transition="opacity .4s";
    setTimeout(()=>el.remove(),400); }, ms);
}
// Clipboard that works in secure AND non-secure contexts (the app is served
// over http:// on the LAN/Tailscale IP, where navigator.clipboard is undefined).
// Tries the modern API first, then falls back to document.execCommand.
async function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  ta.remove();
  return ok;
}

// ---------------------------------------------------------------------------
// Live WS + bench indicator (lingers ~60s after completion)
// ---------------------------------------------------------------------------
let ws = null, wsTimer = null;
function connectWS() {
  if (ws && ws.readyState <= 1) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { wsTimer = null; };
  ws.onmessage = (e) => { try { onLive(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function scheduleReconnect() { if (!wsTimer) wsTimer = setTimeout(connectWS, 2000); }

const INDICATOR_GRACE_MS = 120_000; // keep showing 100% for ~2 min
let indActive = new Map(); // benchId -> {done,total,last}
let indHideTimer = null;

function onLive(msg) {
  if (["progress","model_progress","bench_finished","bench_queued","bench_stopped",
       "model_done","model_queued"].includes(msg.type)) {
    refreshIndicator();
    if (route.name === "home") refreshHomeList();
  }
}

async function refreshIndicator() {
  const el = document.getElementById("bench-indicator");
  if (!el) return;
  try {
    const b = await API.get("/benches");
    const now = Date.now();
    // drop finished ones older than grace
    for (const [id, v] of [...indActive]) {
      if (v.done >= v.total && (now - v.last) > INDICATOR_GRACE_MS) indActive.delete(id);
    }
    for (const x of b.benches) {
      if (x.active) indActive.set(x.id, { done: x.done, total: x.total, last: now });
      else if (indActive.has(x.id)) {
        const v = indActive.get(x.id);
        v.done = x.done; v.total = x.total; v.last = now;
      }
    }
    if (!indActive.size) {
      el.classList.add("hidden"); el.innerHTML = "";
      if (indHideTimer) { clearTimeout(indHideTimer); indHideTimer = null; }
      return;
    }
    // pick the most recently active
    let cur = null;
    for (const v of indActive.values()) if (!cur || v.last > cur.last) cur = v;
    const pct = cur.total ? Math.min(100, Math.round(100 * cur.done / cur.total)) : 0;
    const done = cur.done >= cur.total;
    el.classList.remove("hidden");
    el.innerHTML = done
      ? `<span class="badge ok">✓</span> Bench ${cur.done}/${cur.total} · 100%`
      : `<span class="spin"></span> Bench ${cur.done}/${cur.total} · ${pct}%`;
    el.onclick = () => { location.hash = "#/home"; };
    // schedule auto-hide
    if (done && !indHideTimer) {
      indHideTimer = setTimeout(() => {
        indActive.clear(); indHideTimer = null; refreshIndicator();
      }, INDICATOR_GRACE_MS);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Router (supports #/page, #/page/a/b, and #/page?k=v)
// ---------------------------------------------------------------------------
const route = { name: "home", params: {}, query: {} };
const PAGES = {
  home: renderHome, models: renderModels, loras: renderLoras, workflows: renderWorkflows,
  bench: renderBench, outputs: renderOutputs, setup: renderSetup,
};
function parseRoute() {
  const raw = location.hash.replace(/^#\//, "") || "home";
  const [namepart, querypart] = raw.split("?");
  const name = PAGES[namepart] ? namepart : "home";
  const path = namepart.split("/").slice(1);
  const query = {};
  if (querypart) new URLSearchParams(querypart).forEach((v,k) => query[k]=v);
  return { name, path, query };
}
async function navigate() {
  const r = parseRoute();
  route.name = r.name; route.params = { path: r.path.join("/") }; route.query = r.query;
  document.querySelectorAll("#nav a").forEach(a => {
    a.classList.toggle("active", a.getAttribute("href") === "#/" + route.name);
  });
  hoverHide(); // clear any hover-preview box before tearing down the page
  const view = document.getElementById("view");
  view.innerHTML = `<div class="empty"><span class="spin2"></span>&nbsp; loading…</div>`;
  try {
    await PAGES[route.name]();
  } catch (e) {
    if (e instanceof AuthError) return showLogin();
    view.innerHTML = `<div class="empty">⚠ ${esc(e.message||e)}</div>`;
  }
}
window.addEventListener("hashchange", navigate);

// ---------------------------------------------------------------------------
// Auth / boot
// ---------------------------------------------------------------------------
let auth = { dark:true, default_seed:42 };
async function boot() {
  applyTheme();
  try { auth = await API.get("/auth"); }
  catch (e) { if (e instanceof AuthError) { showLogin(); return; } }
  if (auth.authenticated) showApp(); else showLogin();
}
function showLogin() {
  document.getElementById("login").classList.remove("hidden");
  document.getElementById("shell").classList.add("hidden");
  document.getElementById("login-token").focus();
}
function showApp() {
  document.getElementById("login").classList.add("hidden");
  document.getElementById("shell").classList.remove("hidden");
  connectWS();
  refreshIndicator();
  if (!location.hash) location.hash = "#/home";
  navigate(); // always render the current route on entry
}
async function doLogin() {
  const tok = document.getElementById("login-token").value.trim();
  if (!tok) return;
  try {
    auth = await API.post("/auth/login", { token: tok });
    localStorage.setItem("cb_theme", document.documentElement.dataset.theme);
    showApp();
  } catch {
    toast("Invalid token", 2500);
    document.getElementById("login-token").value = "";
    document.getElementById("login-token").focus();
  }
}
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("login-btn").onclick = doLogin;
  document.getElementById("login-token").addEventListener("keydown", e => {
    if (e.key === "Enter") doLogin(); });
  document.getElementById("theme-btn").onclick = toggleTheme;
  boot();
});

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function applyTheme() {
  const t = localStorage.getItem("cb_theme") || (auth.dark ? "dark" : "light");
  document.documentElement.dataset.theme = t;
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = cur;
  localStorage.setItem("cb_theme", cur);
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------
let modalZ = 80; // base .modal-back z-index; each new modal stacks strictly above the previous
function modal(html, { wide=false, full=false } = {}) {
  const root = document.getElementById("modal-root");
  const back = document.createElement("div");
  back.className = "modal-back" + (full ? " full" : "");
  back.style.zIndex = ++modalZ; // topmost backdrop is always the highest (defensive)
  const box = document.createElement("div");
  box.className = "modal" + (wide ? " wide" : "") + (full ? " full" : "");
  box.innerHTML = html;
  back.appendChild(box);
  back.addEventListener("click", e => { if (e.target === back) closeModal(); });
  root.appendChild(back);
  box.querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal);
  return box;
}
function closeModal() {
  // Close ONLY the topmost modal (last appended backdrop), and run only ITS
  // __onclose. Backwards-compatible: with a single modal this is identical
  // to the old "wipe the whole root" behavior.
  const root = document.getElementById("modal-root");
  if (!root) return;
  const backs = root.querySelectorAll(":scope > .modal-back");
  const top = backs[backs.length - 1];
  if (!top) return;
  const box = top.querySelector(".modal");
  if (box && typeof box.__onclose === "function") {
    try { box.__onclose(); } catch (e) { console.warn("modal __onclose failed", e); }
  }
  top.remove();
}

// ===========================================================================
// PAGE: Home (bench history) — event-delegated so re-renders don't kill clicks
// ===========================================================================
let homePoll = null;
const expandedBenches = new Set();   // bench ids whose settings panel is open (survives re-renders)
let homeFilter = "";                 // search — matches workflow/model/lora names (case-insensitive)
let homeSort = "date";               // date | name | status | kind

function applyHomeSort(benches) {
  const q = homeFilter.trim().toLowerCase();
  const filtered = q ? benches.filter(b => {
    const hay = [b.workflow_name, b.base_model, b.lora_name]
      .concat(Array.isArray(b.model_keys) ? b.model_keys : [])
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  }) : benches;
  const keymap = {
    date:   b => -(b.created || 0),
    name:   b => (b.workflow_name || "").toLowerCase(),
    status: b => (b.status || ""),
    kind:   b => (b.kind || "model"),
  };
  const key = keymap[homeSort] || keymap.date;
  return [...filtered].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (typeof ka === "number" && typeof kb === "number") return ka - kb;
    return String(ka).localeCompare(String(kb));
  });
}
async function renderHome() {
  clearInterval(homePoll);
  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="row space wrap mb">
      <div><h1 style="margin:0">Bench history</h1>
      <div class="muted small" id="home-count"></div></div>
      <button class="btn primary" id="home-run">+ Run new bench</button>
    </div>
    <div class="toolbar home-bar mb">
      <input class="search" id="hf-q" placeholder="Filter by workflow, model, or LoRA name…" value="">
      <select id="hf-sort" style="width:auto">
        <option value="date">Sort: newest first</option>
        <option value="name">Sort: name A→Z</option>
        <option value="status">Sort: status</option>
        <option value="kind">Sort: kind</option>
      </select>
    </div>
    <div id="home-list"></div>`;
  document.getElementById("home-run").onclick = () => location.hash = "#/bench";
  // Delegate all row interactions to the container (survives re-renders).
  if (!view._homeBound) { view.addEventListener("click", benchClickHandler); view._homeBound = true; }
  // Filter / sort bar
  const hfq = document.getElementById("hf-q");
  if (hfq) hfq.oninput = e => { homeFilter = e.target.value.trim(); refreshHomeList(); };
  const hfs = document.getElementById("hf-sort");
  if (hfs) hfs.onchange = e => { homeSort = e.target.value; refreshHomeList(); };
  refreshHomeList();
  homePoll = setInterval(refreshHomeList, 2500);
  refreshIndicator();
}
function refreshHomeList() {
  API.get("/benches").then(d => {
    const el = document.getElementById("home-list");
    if (!el) return;
    const rows = applyHomeSort(d.benches);
    el.innerHTML = rows.map(benchRow).join("") ||
      `<div class="empty">No benches${homeFilter ? " match \"" + esc(homeFilter) + "\"" : " yet"}.</div>`;
    const c = document.getElementById("home-count");
    if (c) c.textContent = `${rows.length} run(s)`;
    // Attach the full bench object to each row so the Rerun / settings
    // handlers can read the run's real settings without a second fetch.
    const byId = new Map(d.benches.map(b => [b.id, b]));
    el.querySelectorAll(".benchrow").forEach(row => { row.__bench = byId.get(row.dataset.bid); });
    // Re-apply expanded state (survives innerHTML rebuild)
    el.querySelectorAll(".benchwrap").forEach(wrap => {
      const bid = wrap.querySelector(".benchrow")?.dataset.bid;
      if (bid && expandedBenches.has(bid)) {
        wrap.classList.add("open");
        const panel = wrap.querySelector(".benchsettings");
        if (panel) panel.classList.remove("hidden");
      }
    });
  }).catch(() => {});
}
function benchClickHandler(e) {
  const btn = e.target.closest("[data-act]");
  const row = e.target.closest(".benchrow");
  if (!row) return;
  const bid = row.dataset.bid;
  const bench = row.__bench;
  if (btn) {
    const act = btn.dataset.act;
    if (act === "del") {
      e.stopPropagation();
      if (!confirm("Delete this bench record? (Images are kept on disk.)")) return;
      API.del("/benches/" + encodeURIComponent(bid))
        .then(() => { refreshHomeList(); toast("Deleted"); })
        .catch(err => toast(err.message));
      return;
    }
    if (act === "view") {
      e.stopPropagation();
      location.hash = btn.dataset.out || ("#/outputs?bench=" + encodeURIComponent(bid));
      return;
    }
    if (act === "stop") {
      e.stopPropagation();
      API.post(`/benches/${encodeURIComponent(bid)}/stop`)
        .then(() => { refreshHomeList(); toast("Stopped"); })
        .catch(err => toast(err.message));
      return;
    }
    if (act === "settings") {
      e.stopPropagation();
      toggleBenchSettings(row);
      return;
    }
    if (act === "rerun") {
      e.stopPropagation();
      if (!bench) return;
      startBenchRerun(bench);
      return;
    }
  }
  // row click -> outputs for this bench (LoRA benches land on the LoRA tab)
  const bk = row.dataset.bk || "model";
  location.hash = "#/outputs?bench=" + encodeURIComponent(bid) + (bk === "lora" ? "&kind=lora" : "");
}
function startBenchRerun(b) {
  const isLora = (b.kind || "model") === "lora";
  // Reuse the existing bench-card prefill mechanism: stash the run's settings
  // and land on the correct tab (model vs lora) with values pre-selected.
  const payload = {
    kind: isLora ? "lora" : "model",
    workflow_id: b.workflow_id || null,
    seed: b.seed != null ? b.seed : null,
    prompt: b.prompt || null,
    prompt_node_id: b.prompt_node_id || null,
    model_keys: (b.model_keys && !isLora) ? b.model_keys.slice(0) : null,
    base_model_key: isLora ? (b.base_model_key || null) : null,
    lora_key: isLora ? (b.lora_key || null) : null,
    strength_min: isLora ? (b.strength_min != null ? b.strength_min : null) : null,
    strength_max: isLora ? (b.strength_max != null ? b.strength_max : null) : null,
    strengths: isLora && Array.isArray(b.strengths) ? b.strengths.slice() : null,
  };
  try { localStorage.setItem("cb_pending_rerun", JSON.stringify(payload)); } catch {}
  // Same-tab hash (e.g. bench -> bench?tab=lora) does NOT re-fire hashchange,
  // so navigate explicitly to guarantee the bench page renders on the right tab.
  if (location.hash === "#/bench?tab=" + (isLora ? "lora" : "model")) { navigate(); }
  else { location.hash = "#/bench?tab=" + (isLora ? "lora" : "model"); }
}
function toggleBenchSettings(row) {
  const wrap = row.closest(".benchwrap") || row;
  const panel = wrap.querySelector(".benchsettings");
  if (!panel) return;
  const bid = wrap.querySelector(".benchrow")?.dataset.bid;
  const open = wrap.classList.toggle("open");
  panel.classList.toggle("hidden", !open);
  if (bid) { if (open) expandedBenches.add(bid); else expandedBenches.delete(bid); }
}
function benchSettingsHTML(b, isLora) {
  const rows = [];
  const add = (k, v) => { if (v !== null && v !== undefined && v !== "") rows.push(`<span class="k">${k}</span><span class="v">${v}</span>`); };
  add("Workflow", esc(b.workflow_name || "—"));
  if (isLora) {
    add("Base model", esc(b.base_model || b.base_model_key || "—"));
    add("LoRA", esc(b.lora_name || b.lora_key || "—"));
    if (b.strength_min != null && b.strength_max != null) add("Strength", `${Number(b.strength_min).toFixed(2)} → ${Number(b.strength_max).toFixed(2)}`);
    if (Array.isArray(b.strengths) && b.strengths.length) add("Steps", b.strengths.map(s => Number(s).toFixed(2)).join(", "));
  } else {
    if (Array.isArray(b.model_keys) && b.model_keys.length) add("Models", b.model_keys.map(esc).join(", "));
  }
  add("Seed", esc(b.seed != null ? b.seed : "—"));
  if (b.prompt) add("Prompt", `<span style="white-space:pre-wrap">${esc(b.prompt)}</span>`);
  if (b.prompt_node_id != null && b.prompt_node_id !== "") add("Prompt node", esc(b.prompt_node_id));
  add("Status", esc(b.status || "—") + (b.active ? " (running)" : ""));
  add("Progress", `${b.done}/${b.total}`);
  add("Created", new Date(b.created*1000).toLocaleString());
  if (b.finished) add("Finished", new Date(b.finished*1000).toLocaleString());
  return `<div class="kv">${rows.join("")}</div>`;
}
function benchRow(b) {
  const pct = b.total ? Math.min(100, Math.round(100*b.done/b.total)) : 0;
  let badge;
  if (b.active) badge = `<span class="badge run"><span class="spin2"></span> running</span>`;
  else if (b.queued || b.status === "queued") {
    const pos = (typeof b.queue_position === "number") ? (b.queue_position + 1) : null;
    badge = `<span class="badge wait"><span class="spin2"></span> queued${pos ? ` · #${pos}` : ""}</span>`;
  }
  else if (b.status === "finished") badge = `<span class="badge ok">finished</span>`;
  else if (b.status === "error") badge = `<span class="badge err">error</span>`;
  else if (b.status === "stopped") badge = `<span class="badge mut">stopped</span>`;
  else if (b.status === "interrupted") badge = `<span class="badge wait">interrupted</span>`;
  else badge = `<span class="badge mut">${esc(b.status)}</span>`;
  const stopBtn = (b.active || b.queued)
    ? `<button class="btn small danger" data-act="stop" data-bid="${esc(b.id)}" title="Stop the run (aborts remaining models in ComfyUI)${b.queued ? ' (drop from queue)' : ''}">■ stop</button>`
    : "";
  const isLora = (b.kind || "model") === "lora";
  const kindBadge = isLora
    ? `<span class="badge lora" title="LoRA strength sweep">LoRA${(b.strength_min!=null && b.strength_max!=null) ? ` ${Number(b.strength_min).toFixed(2)}–${Number(b.strength_max).toFixed(2)}` : ""}</span>`
    : "";
  const outHref = "#/outputs?bench=" + encodeURIComponent(b.id) + (isLora ? "&kind=lora" : "");
  return `<div class="benchwrap">
  <div class="benchrow" data-bid="${esc(b.id)}" data-bk="${isLora ? "lora" : "model"}">
    <div style="min-width:150px">
      <div class="title">${esc(b.workflow_name||"bench")} ${kindBadge}</div>
      <div class="sub">${new Date(b.created*1000).toLocaleString()} · ${isLora ? b.total + " strength step(s)" : b.total + " model(s)"} · seed ${esc(b.seed??"—")}</div>
    </div>
    <div class="progressbar"><div style="width:${pct}%"></div></div>
    <div class="pct">${b.done}/${b.total}</div>
    ${badge}
    ${stopBtn}
    <button class="btn small" data-act="settings" data-bid="${esc(b.id)}" title="Show / hide the run's settings"><span class="caret">▾</span> settings</button>
    <button class="btn small primary" data-act="rerun" data-bid="${esc(b.id)}" title="Re-open the bench form with this run's settings">Rerun</button>
    <button class="btn small" data-act="view" data-bid="${esc(b.id)}" data-out="${esc(outHref)}">Outputs</button>
    <button class="btn small danger" data-act="del" data-bid="${esc(b.id)}">✕</button>
  </div>
  <div class="benchsettings hidden" data-bid="${esc(b.id)}">
    ${benchSettingsHTML(b, isLora)}
  </div>
  </div>`;
}

// ===========================================================================
// PAGE: Models (nested folder tree + grid)
// ===========================================================================
let selModels = new Set();
let modelState = { root: "", folder: "", q: "", sort: "name", models: [] };
let selLoras = new Set();
let loraState = { root: "", folder: "", q: "", sort: "name", loras: [], rendered: 0 };
// Bench-card-local LoRA picker state (separate from loraState so the
// LoRAs page and the bench card can coexist without clobbering each other).
let lbLora = { root: "", folder: "", q: "", sort: "name", loras: [], rendered: 0, selected: "", total: 0 };
let lbBase = { root: "", folder: "", q: "", sort: "name", models: [], rendered: 0, selected: "", total: 0 };
const LORA_CHUNK = 200; // render in chunks — a LoRA folder can hold thousands of files
const BASE_CHUNK = 200;
let lbBaseQTimer = null;

async function renderModels() {
  const view = document.getElementById("view");
  view.innerHTML = `<div class="grid2">
      <div class="card"><div class="row space mb">
        <h2 style="margin:0">Folders</h2>
        <button class="btn small" id="m-refresh" title="Re-scan model roots">⟳ refresh</button>
      </div><div class="tree" id="m-tree"><span class="spin2"></span>&nbsp; loading…</div></div>
      <div>
        <div class="card">
          <div class="toolbar">
            <input class="search" id="m-q" placeholder="Search models…" value="${esc(modelState.q)}">
            <select id="m-sort" style="width:auto">
              <option value="name">Sort: name</option>
              <option value="display">Sort: display name</option>
              <option value="stars">Sort: stars</option>
              <option value="date">Sort: newest</option>
              <option value="size">Sort: size</option>
            </select>
            <span class="muted small" id="m-count"></span>
          </div>
          <div id="m-selbar" class="selcount hidden"></div>
          <div class="mgrid" id="m-grid"></div>
        </div>
      </div>
    </div>`;
  document.getElementById("m-sort").value = modelState.sort;
  document.getElementById("m-q").oninput = (e) => { modelState.q = e.target.value; loadModels(); };
  document.getElementById("m-sort").onchange = (e) => { modelState.sort = e.target.value; loadModels(); };
  document.getElementById("m-refresh").onclick = async () => {
    toast("Re-scanning…");
    try { const r = await API.post("/models/refresh"); toast(`Found ${r.count} models`); loadTree(); loadModels(); }
    catch (e) { toast(e.message); }
  };
  loadTree();
  loadModels();
}
async function loadTree() {
  const tree = await API.get("/models/tree");
  const el = document.getElementById("m-tree");
  el.innerHTML = renderTree(tree.tree, null);
  el.querySelectorAll(".node").forEach(n => n.onclick = () => {
    el.querySelectorAll(".node").forEach(x => x.classList.remove("sel"));
    n.classList.add("sel");
    modelState.root = n.dataset.root || "";
    modelState.folder = n.dataset.folder || "";
    loadModels();
  });
  // default-select the first root
  const first = el.querySelector(".node.root");
  if (first) { first.classList.add("sel"); modelState.root = first.dataset.root; loadModels(); }
}
const CNT = "_cnt"; // must match server TREE_CNT
function renderTree(node, ctx) {
  // ctx === null  -> top level: each key is a full ROOT path.
  // ctx = {root, parts} -> nested folders; parts are RELATIVE folder segments.
  let out = "";
  const keys = Object.keys(node).filter((k) => k !== CNT).sort((a, b) => a.localeCompare(b));
  for (const k of keys) {
    const child = node[k] || {};
    const hasKids = Object.keys(child).filter((x) => x !== CNT).length > 0;
    let isRoot, label, dataRoot, folder, childParts;
    if (ctx === null) {
      isRoot = true; label = k.split("/").pop() || k;
      dataRoot = k; folder = ""; childParts = [];
    } else {
      isRoot = false; label = k;
      dataRoot = ctx.root;
      folder = ctx.parts.concat([k]).join("/");
      childParts = folder.split("/");
    }
    const cnt = (child[CNT] != null) ? child[CNT] : countLeaves(child);
    out += `<div class="node ${isRoot ? "root" : ""}" data-root="${esc(dataRoot)}" data-folder="${esc(folder)}">
      <span class="tw">${hasKids ? "▸" : ""}</span> ${esc(label)} <span class="cnt">${cnt}</span></div>`;
    if (hasKids) out += `<ul>${renderTree(child, { root: dataRoot, parts: childParts })}</ul>`;
  }
  return out;
}
function countLeaves(node) { // backward-compat fallback (used when a node lacks CNT)
  const keys = Object.keys(node).filter((k) => k !== CNT);
  if (!keys.length) return 1;
  return keys.reduce((s, k) => s + countLeaves(node[k]), 0);
}
async function loadModels() {
  const params = new URLSearchParams();
  if (modelState.root) params.set("root", modelState.root);
  if (modelState.folder) params.set("folder", modelState.folder);
  if (modelState.q) params.set("q", modelState.q);
  params.set("sort", modelState.sort);
  const d = await API.get("/models?" + params.toString());
  modelState.models = d.models;
  renderModelGrid(d.models);
}
function renderModelGrid(models) {
  const el = document.getElementById("m-grid");
  document.getElementById("m-count").textContent = `${models.length} model(s)`;
  el.innerHTML = models.map(m => {
    const sel = selModels.has(m.key) ? "sel" : "";
    let thumb;
    if (m.preview) {
      if (m.preview_kind === "video") {
        thumb = `<video class="thumb" muted playsinline preload="metadata"
          src="${fileUrl(m.preview)}"
          onerror="this.outerHTML='<div class=&quot;thumb placeholder&quot;>no preview</div>'"></video>`;
      } else {
        thumb = `<img class="thumb" loading="lazy" src="${thumbUrl(m.preview)}" onerror="this.outerHTML='<div class=&quot;thumb placeholder&quot;>no image</div>'">`;
      }
    } else {
      thumb = `<div class="thumb placeholder">no preview</div>`;
    }
    return `<div class="mcard ${sel}" data-key="${esc(m.key)}">
      <div class="cb">${sel ? "✓" : ""}</div>
      ${thumb}
      <div class="body">
        <div class="name">${esc(m.display_name || m.name)}</div>
        <div class="meta"><span class="stars">${stars(m.stars)}</span><span>${fmtBytes(m.size)}</span></div>
        <div class="meta"><span class="faint">${esc(m.folder||"/")}</span></div>
      </div>
    </div>`;
  }).join("") || `<div class="empty" style="grid-column:1/-1">No models in this folder.</div>`;
  el.querySelectorAll(".mcard").forEach(c => c.onclick = (e) => {
    if (e.target.classList.contains("cb") || e.target.closest(".cb")) toggleSel(c.dataset.key);
    else openModelDetail(c.dataset.key);
  });
  updateSelbar();
}
function toggleSel(key) {
  if (selModels.has(key)) selModels.delete(key); else selModels.add(key);
  const card = document.querySelector(`.mcard[data-key="${CSS.escape(key)}"]`);
  if (card) {
    card.classList.toggle("sel", selModels.has(key));
    const cb = card.querySelector(".cb");
    if (cb) cb.textContent = selModels.has(key) ? "✓" : "";
  }
  updateSelbar();
}
function updateSelbar() {
  const bar = document.getElementById("m-selbar");
  if (!bar) return;
  // Always show the bar so "Select all" is reachable with nothing selected yet.
  // "Clear" / "Run bench" only make sense once something is selected.
  bar.classList.remove("hidden");
  const hasSel = selModels.size > 0;
  bar.innerHTML = `<span class="grow"><b>${selModels.size}</b> selected</span>
    <button class="btn small" id="sel-all">Select all</button>
    ${hasSel ? `<button class="btn small" id="sel-none">Clear</button>
    <button class="btn primary" id="sel-run">▶ Run bench</button>` : ""}`;
  document.getElementById("sel-all").onclick = () => {
    modelState.models.forEach(m => selModels.add(m.key));
    renderModelGrid(modelState.models);
  };
  if (hasSel) {
    document.getElementById("sel-none").onclick = () => { selModels.clear(); renderModelGrid(modelState.models); };
    document.getElementById("sel-run").onclick = () => {
      localStorage.setItem("cb_pending_models", JSON.stringify([...selModels]));
      location.hash = "#/bench";
    };
  }
}

async function openModelDetail(key) {
  const m = await API.get("/models/" + encodeURIComponent(key));
  const box = modal(`
    <div class="mh"><h2 style="margin:0">${esc(m.display_name || m.name)}</h2>
      <button class="btn small" data-close>Close ✕</button></div>
    <div class="mb2 model-detail">
      ${m.preview
        ? (m.preview_kind === "video"
            ? `<video src="${fileUrl(m.preview)}" controls muted loop playsinline></video>`
            : `<img src="${fileUrl(m.preview)}">`)
        : `<div class="thumb placeholder" style="aspect-ratio:1/1">no preview</div>`}
      <div>
        <div class="tabs">
          <button class="active" data-tab="info">Info</button>
          <button data-tab="outputs">Outputs (${(m.recent_outputs||[]).length})</button>
        </div>
        <div id="tab-info">
          <div class="kv">
            <span class="k">Name</span><span class="v">${esc(m.name)}</span>
            <span class="k">Display</span><span class="v">${esc(m.display_name)}</span>
            <span class="k">Location</span><span class="v"><code>${esc(m.path)}</code></span>
            <span class="k">Size</span><span class="v">${fmtBytes(m.size)}</span>
            <span class="k">Base model</span><span class="v">${esc(m.base_model||"—")}</span>
            <span class="k">Civitai</span><span class="v">${m.civitai?.name ? esc(m.civitai.name)+" · "+(m.civitai.author||"") : "—"}</span>
            <span class="k">Stars</span><span class="v"><span class="stars" id="md-stars">${stars(m.stars)}</span></span>
          </div>
          <label class="field mt"><span class="lab">Notes</span>
            <textarea id="md-notes" rows="3">${esc(m.notes||"")}</textarea></label>
          <div class="row wrap">
            <div class="row" id="md-star-btns"></div>
            <span class="grow"></span>
            <button class="btn" id="md-save">Save</button>
            <button class="btn primary" id="md-run">▶ Run</button>
          </div>
        </div>
        <div id="tab-outputs" class="hidden"></div>
      </div>
    </div>`);
  const sb = document.getElementById("md-star-btns");
  // On close, push the (possibly) updated stars back into the live grid so
  // the change shows without a full re-scan. Only if Save actually happened —
  // otherwise the user's unsaved fiddling is discarded and the grid reverts.
  let saved = false;
  const origNotes = document.getElementById("md-notes").value;
  box.__onclose = () => {
    if (route.name !== "models" || !document.getElementById("m-grid")) return;
    const hit = modelState.models.find(x => x.key === key);
    if (!hit) return;
    if (saved) {
      let s = 0; sb.querySelectorAll("button").forEach((b,i) => { if (b.textContent === "★") s = i+1; });
      hit.stars = s;
      hit.notes = document.getElementById("md-notes").value;
    } else {
      // revert to last-saved state
      hit.notes = origNotes;
    }
    renderModelGrid(modelState.models);
  };
  sb.innerHTML = [0,1,2,3,4].map(i =>
    `<button class="iconbtn" data-star="${i+1}" style="width:28px;height:28px">${i < (m.stars||0) ? "★" : "☆"}</button>`).join("");
  sb.querySelectorAll("button").forEach(b => b.onclick = () => {
    const v = +b.dataset.star;
    sb.querySelectorAll("button").forEach((x,i) => x.textContent = (i < v) ? "★" : "☆");
  });
  box.querySelectorAll("[data-tab]").forEach(t => t.onclick = () => {
    box.querySelectorAll("[data-tab]").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("tab-info").classList.toggle("hidden", t.dataset.tab !== "info");
    const o = document.getElementById("tab-outputs");
    o.classList.toggle("hidden", t.dataset.tab !== "outputs");
    if (t.dataset.tab === "outputs" && !o.dataset.loaded) { renderModelOutputs(o, m); o.dataset.loaded="1"; }
  });
  document.getElementById("md-save").onclick = async () => {
    const notes = document.getElementById("md-notes").value;
    let s = 0; sb.querySelectorAll("button").forEach((b,i) => { if (b.textContent === "★") s = i+1; });
    try {
      await API.patch("/models/" + encodeURIComponent(key), { notes, stars: s });
      saved = true;
      toast("Saved");
      // reflect
      document.getElementById("md-stars").textContent = stars(s);
    } catch (e) { toast(e.message); }
  };
  document.getElementById("md-run").onclick = () => {
    localStorage.setItem("cb_pending_models", JSON.stringify([key]));
    location.hash = "#/bench";
  };
}
async function renderModelOutputs(el, m) {
  const outs = m.recent_outputs || [];
  if (!outs.length) { el.innerHTML = `<div class="empty">No outputs for this model yet.</div>`; return; }
  el.innerHTML = `<div class="ogrid">` + outs.map(o => `
    <div class="ocell" data-out="${esc(o.id)}">
      <img loading="lazy" src="${thumbUrl(o.output)}">
      <div class="lbl">${esc(o.workflow_name||"")} · ${new Date(o.created*1000).toLocaleDateString()}</div>
    </div>`).join("") + `</div>
    <div class="row mt"><button class="btn" data-cmp>Compare selected</button>
    <span class="muted small">select 2 for slider, 3+ for grid</span></div>`;
  let picked = [];
  el.querySelectorAll(".ocell").forEach(c => c.onclick = () => {
    const id = c.dataset.out;
    const idx = picked.indexOf(id);
    if (idx>=0) { picked.splice(idx,1); c.classList.remove("sel"); }
    else { picked.push(id); c.classList.add("sel"); }
  });
  el.querySelector("[data-cmp]").onclick = () => {
    if (picked.length < 2) { toast("Select at least 2 outputs"); return; }
    openCompare(outs.filter(o => picked.includes(o.id)));
  };
}

// ===========================================================================
// Shared Models/LoRAs kind tabs (Workflows, Outputs, Run Bench)
// Driven by the HASH QUERY so tab state is back-button-able & shareable.
// ===========================================================================
function kindTabsHTML(active) {
  return `<div class="tabs" id="kind-tabs">
    <button data-kind="model" class="${active === "model" ? "active" : ""}">Models</button>
    <button data-kind="lora" class="${active === "lora" ? "active" : ""}">LoRAs</button>
  </div>`;
}
function bindKindTabs(active, onSwitch) {
  const bar = document.getElementById("kind-tabs");
  if (!bar) return;
  bar.querySelectorAll("button").forEach(b => {
    b.onclick = () => { const k = b.dataset.kind; if (k !== active) onSwitch(k); };
  });
}

// ===========================================================================
// PAGE: LoRAs (mirrors Models — different endpoint + l- prefixed ids)
// ===========================================================================
async function renderLoras() {
  const view = document.getElementById("view");
  view.innerHTML = `<div class="grid2">
      <div class="card"><div class="row space mb">
        <h2 style="margin:0">Folders</h2>
        <button class="btn small" id="l-refresh" title="Re-scan LoRA roots">⟳ refresh</button>
      </div><div class="tree" id="l-tree"><span class="spin2"></span>&nbsp; loading…</div></div>
      <div>
        <div class="card">
          <div class="toolbar">
            <input class="search" id="l-q" placeholder="Search LoRAs…" value="${esc(loraState.q)}">
            <select id="l-sort" style="width:auto">
              <option value="name">Sort: name</option>
              <option value="display">Sort: display name</option>
              <option value="stars">Sort: stars</option>
              <option value="date">Sort: newest</option>
              <option value="size">Sort: size</option>
            </select>
            <span class="muted small" id="l-count"></span>
          </div>
          <div id="l-selbar" class="selcount hidden"></div>
          <div class="mgrid" id="l-grid"></div>
          <div class="row mt" id="l-more-row"></div>
        </div>
      </div>
    </div>`;
  document.getElementById("l-sort").value = loraState.sort;
  document.getElementById("l-q").oninput = (e) => { loraState.q = e.target.value; loadLoras(); };
  document.getElementById("l-sort").onchange = (e) => { loraState.sort = e.target.value; loadLoras(); };
  document.getElementById("l-refresh").onclick = async () => {
    toast("Re-scanning…");
    try { const r = await API.post("/loras/refresh"); toast(`Found ${r.count} LoRAs`); loadLoraTree(); loadLoras(); }
    catch (e) { toast(e.message); }
  };
  loadLoraTree();
  loadLoras();
}
async function loadLoraTree() {
  const tree = await API.get("/loras/tree");
  const el = document.getElementById("l-tree");
  el.innerHTML = renderTree(tree.tree, null);
  el.querySelectorAll(".node").forEach(n => n.onclick = () => {
    el.querySelectorAll(".node").forEach(x => x.classList.remove("sel"));
    n.classList.add("sel");
    loraState.root = n.dataset.root || "";
    loraState.folder = n.dataset.folder || "";
    loadLoras();
  });
  // default-select the first root
  const first = el.querySelector(".node.root");
  if (first) { first.classList.add("sel"); loraState.root = first.dataset.root; loadLoras(); }
}

// ---------------------------------------------------------------------------
// Base-model picker (bench LoRA tab): folder tree (left) + server-filtered
// chunked list (right), same box size as the LoRA picker. Feeds a hidden
// #lb-base input (single selection) — same pattern as the LoRA picker.
// ---------------------------------------------------------------------------
function lbBaseSelectTreeNode(el, n) {
  el.querySelectorAll(".node").forEach(x => x.classList.remove("sel"));
  n.classList.add("sel");
  lbBase.root = n.dataset.root || "";
  lbBase.folder = n.dataset.folder || "";
  loadLbBaseModels();
}
async function lbBaseLoadTree() {
  const el = document.getElementById("lb-base-tree");
  if (!el) return;
  let tree;
  try { tree = await API.get("/models/tree"); }
  catch (e) { el.innerHTML = `<span class="muted">${esc(e.message)}</span>`; return; }
  el.innerHTML = renderTree(tree.tree, null);
  el.querySelectorAll(".node").forEach(n => n.onclick = () => lbBaseSelectTreeNode(el, n));
  const first = el.querySelector(".node.root");
  if (first) { first.classList.add("sel"); lbBase.root = first.dataset.root; }
  await loadLbBaseModels();
  // restore selection highlight + chip for any pre-filled key
  if (lbBase.selected) {
    const list = document.getElementById("lb-base-list");
    if (list) list.querySelectorAll(".row[data-key]").forEach(r =>
      r.classList.toggle("sel", r.dataset.key === lbBase.selected));
    renderLbBaseChips();
  }
}
async function loadLbBaseModels() {
  const params = new URLSearchParams();
  if (lbBase.root) params.set("root", lbBase.root);
  if (lbBase.folder) params.set("folder", lbBase.folder);
  if (lbBase.q) params.set("q", lbBase.q);
  params.set("sort", lbBase.sort || "name");
  let d;
  try { d = await API.get("/models?" + params.toString()); }
  catch (e) { lbBase.models = []; lbBase.total = 0; lbBase.rendered = 0; renderLbBaseList(); return; }
  lbBase.models = d.models || [];
  lbBase.total = d.total != null ? d.total : (d.count != null ? d.count : lbBase.models.length);
  lbBase.rendered = BASE_CHUNK;
  renderLbBaseList();
}
function lbSelectBaseModel(key) {
  lbBase.selected = key;
  const hidden = document.getElementById("lb-base");
  if (hidden) {
    hidden.value = key;
    setTimeout(() => { try { hidden.dispatchEvent(new Event("change")); } catch (e) {} }, 0);
  }
  const list = document.getElementById("lb-base-list");
  if (list) list.querySelectorAll(".row[data-key]").forEach(r =>
    r.classList.toggle("sel", r.dataset.key === key));
  renderLbBaseChips();
}
function renderLbBaseChips() {
  const box = document.getElementById("lb-base-chips");
  if (!box) return;
  if (!lbBase.selected) {
    box.innerHTML = `<span class="chips-empty">No base model selected — pick one from the tree + list above.</span>`;
    return;
  }
  const hit = (lbBase.models || []).find(m => m.key === lbBase.selected) || {};
  const label = hit.display_name || hit.name || lbBase.selected.split("/").pop() || lbBase.selected;
  box.innerHTML = `<span class="chip" data-key="${esc(lbBase.selected)}" title="${esc(lbBase.selected)}">
    <span class="chip-label">🧩 ${esc(label)}</span>
    <button class="chip-x" data-x="${esc(lbBase.selected)}" title="Remove" aria-label="Remove ${esc(label)}">×</button>
  </span>`;
  box.querySelectorAll(".chip-x").forEach(b => b.onclick = () => {
    lbBase.selected = "";
    const hidden = document.getElementById("lb-base");
    if (hidden) { hidden.value = ""; hidden.dispatchEvent(new Event("change")); }
    const list = document.getElementById("lb-base-list");
    if (list) list.querySelectorAll(".row[data-key]").forEach(r => r.classList.remove("sel"));
    renderLbBaseChips();
  });
}
function renderLbBaseList() {
  const list = document.getElementById("lb-base-list");
  if (!list) return;
  const slice = lbBase.models.slice(0, lbBase.rendered);
  list.innerHTML = slice.map(m => `<label class="row" style="cursor:pointer;padding:4px 8px;border-radius:4px" data-key="${esc(m.key)}">
    <span class="grow" style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(m.key)}">${esc(m.display_name || m.name)}</span>
    <span class="faint small" style="white-space:nowrap">${esc(m.folder || "/")}</span>
  </label>`).join("") || `<div class="empty">No models match.</div>`;
  list.querySelectorAll(".row[data-key]").forEach(r =>
    r.classList.toggle("sel", r.dataset.key === lbBase.selected));
  const cnt = document.getElementById("lb-base-cnt");
  if (cnt) cnt.textContent = `${lbBase.total} model(s)`;
  const more = document.getElementById("lb-base-more");
  if (more) {
    if (lbBase.rendered < lbBase.total) {
      const remaining = lbBase.total - lbBase.rendered;
      more.innerHTML = `<span class="grow"></span><button class="btn small" id="lb-base-more-btn">Load ${Math.min(BASE_CHUNK, remaining)} more…</button><span class="grow"></span>`;
      // /api/models returns the full filtered list (limit/offset ignored), so
      // "Load more" just renders the next slice of what we already hold.
      document.getElementById("lb-base-more-btn").onclick = () => {
        lbBase.rendered = Math.min(lbBase.total, lbBase.rendered + BASE_CHUNK);
        renderLbBaseList();
      };
    } else {
      more.innerHTML = "";
    }
  }
  list.querySelectorAll(".row[data-key]").forEach(r =>
    r.onclick = (e) => { e.preventDefault(); lbSelectBaseModel(r.dataset.key); });
  renderLbBaseChips();
}
function bindLbBaseFilter() {
  const q = document.getElementById("lb-base-q");
  if (!q) return;
  q.oninput = (e) => {
    if (lbBaseQTimer) clearTimeout(lbBaseQTimer);
    lbBaseQTimer = setTimeout(() => {
      lbBase.q = e.target.value.trim();
      lbBase.rendered = BASE_CHUNK;
      loadLbBaseModels();
    }, 300);
  };
}
function lbSelectTreeNode(el, n) {
  el.querySelectorAll(".node").forEach(x => x.classList.remove("sel"));
  n.classList.add("sel");
  lbLora.root = n.dataset.root || "";
  lbLora.folder = n.dataset.folder || "";
  loadLbLoras();
}
async function loadLbLoraTree() {
  const el = document.getElementById("lb-ltree");
  let tree;
  try { tree = await API.get("/loras/tree"); }
  catch (e) { el.innerHTML = `<span class="muted">${esc(e.message)}</span>`; return; }
  el.innerHTML = renderTree(tree.tree, null);
  el.querySelectorAll(".node").forEach(n => n.onclick = () => lbSelectTreeNode(el, n));
  // default-select the first root (loads its list)
  const first = el.querySelector(".node.root");
  if (first) { first.classList.add("sel"); lbLora.root = first.dataset.root; }
  await loadLbLoras();
}
async function loadLbLoras() {
  const params = new URLSearchParams();
  if (lbLora.root) params.set("root", lbLora.root);
  if (lbLora.folder) params.set("folder", lbLora.folder);
  if (lbLora.q) params.set("q", lbLora.q);
  params.set("sort", lbLora.sort || "name");
  params.set("limit", String(LORA_CHUNK));
  params.set("offset", "0");
  let d;
  try { d = await API.get("/loras?" + params.toString()); }
  catch (e) { lbLora.loras = []; lbLora.total = 0; lbLora.rendered = 0; renderLbLoraList(); return; }
  lbLora.loras = d.loras || [];
  lbLora.total = d.total != null ? d.total : lbLora.loras.length;
  lbLora.rendered = LORA_CHUNK;
  renderLbLoraList();
}
function lbSetSelectedLora(key) {
  lbLora.selected = key;
  const hidden = document.getElementById("lb-lora");
  if (hidden) {
    hidden.value = key;
    // renderBench() binds a "change" listener on this hidden input that
    // calls the card-local updateLbPreview — reuse that path (deferred so
    // it's safe even when called before the bench tab finishes wiring up).
    setTimeout(() => {
      try { hidden.dispatchEvent(new Event("change")); } catch (e) {}
    }, 0);
  }
  // highlight the chosen row (if it is in the rendered slice)
  const list = document.getElementById("lb-lora-list");
  if (list) {
    list.querySelectorAll(".row[data-key]").forEach(r => {
      r.classList.toggle("sel", r.dataset.key === key);
    });
  }
  renderLbChip();
}
function renderLbChip() {
  const box = document.getElementById("lb-chips");
  if (!box) return;
  const key = lbLora.selected;
  if (!key) {
    box.innerHTML = `<span class="chips-empty">No LoRA selected — pick one from the tree + list above.</span>`;
    return;
  }
  const hit = (lbLora.loras || []).find(m => m.key === key) || {};
  const label = hit.display_name || hit.name || key.split("/").pop() || key;
  box.innerHTML = `<span class="chip" data-key="${esc(key)}" title="${esc(key)}">
    <span class="chip-label">🔁 ${esc(label)}</span>
    <button class="chip-x" data-x="${esc(key)}" title="Remove" aria-label="Remove ${esc(label)}">×</button>
  </span>`;
  box.querySelectorAll(".chip-x").forEach(b => b.onclick = () => {
    lbLora.selected = "";
    const hidden = document.getElementById("lb-lora");
    if (hidden) { hidden.value = ""; hidden.dispatchEvent(new Event("change")); }
    const list = document.getElementById("lb-lora-list");
    if (list) list.querySelectorAll(".row[data-key]").forEach(r => r.classList.remove("sel"));
    renderLbChip();
  });
}

function renderLbLoraList() {
  const list = document.getElementById("lb-lora-list");
  if (!list) return;
  const slice = lbLora.loras.slice(0, lbLora.rendered);
  list.innerHTML = slice.map(m => `<label class="row" style="cursor:pointer;padding:4px 8px;border-radius:4px" data-key="${esc(m.key)}">
    <span class="grow" style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.display_name || m.name)}</span>
    <span class="faint small" style="white-space:nowrap">${esc(m.folder || "/")}</span>
  </label>`).join("") || `<div class="empty">No LoRAs match.</div>`;
  // apply the selection highlight
  list.querySelectorAll(".row[data-key]").forEach(r => {
    r.classList.toggle("sel", r.dataset.key === lbLora.selected);
  });
  const cnt = document.getElementById("lb-lora-cnt");
  if (cnt) cnt.textContent = `${lbLora.total} LoRA(s)`;
  const more = document.getElementById("lb-lora-more");
  if (more) {
    if (lbLora.rendered < lbLora.total) {
      more.innerHTML = `<span class="grow"></span><button class="btn small" id="lb-lora-more-btn">Load ${lbLora.total - lbLora.rendered} more…</button><span class="grow"></span>`;
      document.getElementById("lb-lora-more-btn").onclick = async () => {
        // append the next chunk (server-side chunking)
        const params = new URLSearchParams();
        if (lbLora.root) params.set("root", lbLora.root);
        if (lbLora.folder) params.set("folder", lbLora.folder);
        if (lbLora.q) params.set("q", lbLora.q);
        params.set("sort", lbLora.sort || "name");
        params.set("limit", String(LORA_CHUNK));
        params.set("offset", String(lbLora.rendered));
        try {
          const d = await API.get("/loras?" + params.toString());
          lbLora.loras = lbLora.loras.concat(d.loras || []);
          lbLora.rendered = Math.min(lbLora.total, lbLora.rendered + LORA_CHUNK);
          renderLbLoraList();
        } catch (e) { toast(e.message); }
      };
    } else {
      more.innerHTML = "";
    }
  }
  list.querySelectorAll(".row[data-key]").forEach(r => {
    r.onclick = (e) => { e.preventDefault(); lbSetSelectedLora(r.dataset.key); };
  });
  renderLbChip();
}
let lbLoraQTimer = null;
function bindLbLoraFilter() {
  const q = document.getElementById("lb-lora-q");
  if (!q) return;
  q.oninput = (e) => {
    if (lbLoraQTimer) clearTimeout(lbLoraQTimer);
    lbLoraQTimer = setTimeout(() => {
      lbLora.q = e.target.value.trim();
      lbLora.rendered = LORA_CHUNK;
      loadLbLoras();
    }, 300);
  };
}
// Pre-select a pending lora (from "Bench LoRA" on the LoRAs page):
// find its folder, select the matching tree node, load that folder, and
// mark the row selected. Silently ignored on 404 (current behavior).
async function lbApplyPendingLora(pendingLora) {
  if (!pendingLora) return;
  let m;
  try { m = await API.get("/loras/" + encodeURIComponent(pendingLora)); }
  catch (e) { return; }
  const el = document.getElementById("lb-ltree");
  if (!el) return;
  lbLora.root = m.root || "";
  lbLora.folder = m.folder || "";
  // select the deepest matching tree node
  const node = el.querySelector(
    `.node[data-root="${CSS.escape(m.root || "")}"][data-folder="${CSS.escape(m.folder || "")}"]`)
    || el.querySelector(`.node[data-root="${CSS.escape(m.root || "")}"]`)
    || el.querySelector(".node.root");
  if (node) lbSelectTreeNode(el, node);
  // re-load that folder (folder scope) then mark the row selected
  lbLora.q = "";
  const qEl = document.getElementById("lb-lora-q");
  if (qEl) qEl.value = "";
  await loadLbLoras();
  lbSetSelectedLora(pendingLora);
  renderLbChip();
}
async function loadLoras() {
  const params = new URLSearchParams();
  if (loraState.root) params.set("root", loraState.root);
  if (loraState.folder) params.set("folder", loraState.folder);
  if (loraState.q) params.set("q", loraState.q);
  params.set("sort", loraState.sort);
  const d = await API.get("/loras?" + params.toString());
  loraState.loras = d.loras;
  loraState.rendered = 0;
  renderLoraGrid();
}
function renderLoraGrid() {
  const el = document.getElementById("l-grid");
  const all = loraState.loras;
  document.getElementById("l-count").textContent = `${all.length} LoRA(s)`;
  // Performance: only render the first CHUNK of cards; "Load more" appends.
  if (loraState.rendered === 0) loraState.rendered = Math.min(LORA_CHUNK, all.length);
  const slice = all.slice(0, loraState.rendered);
  el.innerHTML = slice.map(m => {
    const sel = selLoras.has(m.key) ? "sel" : "";
    let thumb;
    if (m.preview) {
      if (m.preview_kind === "video") {
        thumb = `<video class="thumb" muted playsinline preload="metadata"
          src="${fileUrl(m.preview)}"
          onerror="this.outerHTML='<div class=&quot;thumb placeholder&quot;>no preview</div>'"></video>`;
      } else {
        thumb = `<img class="thumb" loading="lazy" src="${thumbUrl(m.preview)}" onerror="this.outerHTML='<div class=&quot;thumb placeholder&quot;>no image</div>'">`;
      }
    } else {
      thumb = `<div class="thumb placeholder">no preview</div>`;
    }
    return `<div class="mcard ${sel}" data-key="${esc(m.key)}">
      <div class="cb">${sel ? "✓" : ""}</div>
      ${thumb}
      <div class="body">
        <div class="name">${esc(m.display_name || m.name)}</div>
        <div class="meta"><span class="stars">${stars(m.stars)}</span><span>${fmtBytes(m.size)}</span></div>
        <div class="meta"><span class="faint">${esc(m.folder||"/")}</span></div>
      </div>
    </div>`;
  }).join("") || `<div class="empty" style="grid-column:1/-1">No LoRAs in this folder.</div>`;
  // "Load more" row (hidden when everything is rendered)
  const moreRow = document.getElementById("l-more-row");
  if (loraState.rendered < all.length) {
    moreRow.innerHTML = `<span class="grow"></span><button class="btn" id="l-more">Load ${all.length - loraState.rendered} more…</button><span class="grow"></span>`;
    document.getElementById("l-more").onclick = () => {
      loraState.rendered = Math.min(LORA_CHUNK, all.length);
      renderLoraGrid();
    };
  } else {
    moreRow.innerHTML = "";
  }
  el.querySelectorAll(".mcard").forEach(c => c.onclick = (e) => {
    if (e.target.classList.contains("cb") || e.target.closest(".cb")) toggleLoraSel(c.dataset.key);
    else openLoraDetail(c.dataset.key);
  });
  updateLoraSelbar();
}
function toggleLoraSel(key) {
  if (selLoras.has(key)) selLoras.delete(key); else selLoras.add(key);
  const card = document.querySelector(`#l-grid .mcard[data-key="${CSS.escape(key)}"]`);
  if (card) {
    card.classList.toggle("sel", selLoras.has(key));
    const cb = card.querySelector(".cb");
    if (cb) cb.textContent = selLoras.has(key) ? "✓" : "";
  }
  updateLoraSelbar();
}
function updateLoraSelbar() {
  const bar = document.getElementById("l-selbar");
  if (!bar) return;
  bar.classList.remove("hidden");
  const hasSel = selLoras.size > 0;
  bar.innerHTML = `<span class="grow"><b>${selLoras.size}</b> selected</span>
    ${hasSel ? `<button class="btn primary small" id="l-sel-bench">▶ Bench</button>` : ""}
    <button class="btn small" id="l-sel-all">Select all</button>
    ${hasSel ? `<button class="btn small" id="l-sel-none">Clear</button>` : ""}`;
  document.getElementById("l-sel-all").onclick = () => {
    loraState.loras.forEach(m => selLoras.add(m.key));
    loraState.rendered = Math.min(LORA_CHUNK, loraState.loras.length);
    renderLoraGrid();
  };
  if (hasSel) {
    document.getElementById("l-sel-none").onclick = () => { selLoras.clear(); renderLoraGrid(); };
    // LoRA bench takes a single LoRA — bench the first selected one.
    document.getElementById("l-sel-bench").onclick = () => {
      const first = [...selLoras][0];
      if (selLoras.size > 1) toast(`Benching the first of ${selLoras.size} selected LoRAs`);
      localStorage.setItem("cb_pending_lora", first);
      location.hash = "#/bench?tab=lora";
    };
  }
}

async function openLoraDetail(key) {
  const m = await API.get("/loras/" + encodeURIComponent(key));
  const box = modal(`
    <div class="mh"><h2 style="margin:0">${esc(m.display_name || m.name)}</h2>
      <button class="btn small" data-close>Close ✕</button></div>
    <div class="mb2 model-detail">
      ${m.preview
        ? (m.preview_kind === "video"
            ? `<video src="${fileUrl(m.preview)}" controls muted loop playsinline></video>`
            : `<img src="${fileUrl(m.preview)}">`)
        : `<div class="thumb placeholder" style="aspect-ratio:1/1">no preview</div>`}
      <div>
        <div class="tabs">
          <button class="active" data-tab="info">Info</button>
          <button data-tab="outputs">Outputs (${(m.recent_outputs||[]).length})</button>
        </div>
        <div id="l-tab-info">
          <div class="kv">
            <span class="k">Name</span><span class="v">${esc(m.name)}</span>
            <span class="k">Display</span><span class="v">${esc(m.display_name)}</span>
            <span class="k">ComfyUI lora_name</span><span class="v"><code>${esc(m.rel)}</code></span>
            <span class="k">Location</span><span class="v"><code>${esc(m.path)}</code></span>
            <span class="k">Size</span><span class="v">${fmtBytes(m.size)}</span>
            <span class="k">Civitai</span><span class="v">${m.civitai?.name ? esc(m.civitai.name)+" · "+(m.civitai.author||"") : "—"}</span>
            <span class="k">Stars</span><span class="v"><span class="stars" id="ld-stars">${stars(m.stars)}</span></span>
          </div>
          <label class="field mt"><span class="lab">Notes</span>
            <textarea id="ld-notes" rows="3">${esc(m.notes||"")}</textarea></label>
          <div class="row wrap">
            <div class="row" id="ld-star-btns"></div>
            <span class="grow"></span>
            <button class="btn" id="ld-save">Save</button>
            <button class="btn primary" id="ld-bench">▶ Bench LoRA</button>
          </div>
        </div>
        <div id="l-tab-outputs" class="hidden"></div>
      </div>
    </div>`);
  const sb = document.getElementById("ld-star-btns");
  // On close, push the (possibly) updated stars back into the live grid.
  let saved = false;
  const origNotes = document.getElementById("ld-notes").value;
  box.__onclose = () => {
    if (route.name !== "loras" || !document.getElementById("l-grid")) return;
    const hit = loraState.loras.find(x => x.key === key);
    if (!hit) return;
    if (saved) {
      let s = 0; sb.querySelectorAll("button").forEach((b,i) => { if (b.textContent === "★") s = i+1; });
      hit.stars = s;
      hit.notes = document.getElementById("ld-notes").value;
    } else {
      hit.notes = origNotes;
    }
    renderLoraGrid();
  };
  sb.innerHTML = [0,1,2,3,4].map(i =>
    `<button class="iconbtn" data-star="${i+1}" style="width:28px;height:28px">${i < (m.stars||0) ? "★" : "☆"}</button>`).join("");
  sb.querySelectorAll("button").forEach(b => b.onclick = () => {
    const v = +b.dataset.star;
    sb.querySelectorAll("button").forEach((x,i) => x.textContent = (i < v) ? "★" : "☆");
  });
  box.querySelectorAll("[data-tab]").forEach(t => t.onclick = () => {
    box.querySelectorAll("[data-tab]").forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    document.getElementById("l-tab-info").classList.toggle("hidden", t.dataset.tab !== "info");
    const o = document.getElementById("l-tab-outputs");
    o.classList.toggle("hidden", t.dataset.tab !== "outputs");
    if (t.dataset.tab === "outputs" && !o.dataset.loaded) { renderModelOutputs(o, m); o.dataset.loaded="1"; }
  });
  document.getElementById("ld-save").onclick = async () => {
    const notes = document.getElementById("ld-notes").value;
    let s = 0; sb.querySelectorAll("button").forEach((b,i) => { if (b.textContent === "★") s = i+1; });
    try {
      await API.patch("/loras/" + encodeURIComponent(key), { notes, stars: s });
      saved = true;
      toast("Saved");
      document.getElementById("ld-stars").textContent = stars(s);
    } catch (e) { toast(e.message); }
  };
  document.getElementById("ld-bench").onclick = () => {
    localStorage.setItem("cb_pending_lora", key);
    location.hash = "#/bench?tab=lora";
  };
}

// ===========================================================================
// COMPARE (slider for 2, grid for 3+)
// ===========================================================================
function openCompare(items) {
  modal(`<div class="mh"><h2 style="margin:0">Compare ${items.length} output(s)</h2>
    <button class="btn small" data-close>Close ✕</button></div><div class="mb2" id="cmp-body"></div>`, { full:true });
  const body = document.getElementById("cmp-body");
  if (items.length === 2) {
    const [a,b] = items;
    body.innerHTML = `
      <div class="slider-wrap" id="sl">
        <img src="${fileUrl(b.output)}" alt="B">
        <img class="clip" id="sl-clip" src="${fileUrl(a.output)}" alt="A">
        <div class="handle" id="sl-handle"></div>
      </div>
      <div class="row space mt small">
        <span><b>${esc(a.model_name||"A")}</b> <span class="muted">· ${esc(a.workflow_name||"")} · seed ${esc(a.seed??"—")}</span></span>
        <span class="muted">drag the handle to reveal A ↔ B</span>
        <span><b>${esc(b.model_name||"B")}</b> <span class="muted">· ${esc(b.workflow_name||"")} · seed ${esc(b.seed??"—")}</span></span>
      </div>`;
    const wrap = document.getElementById("sl"), clip = document.getElementById("sl-clip");
    let dragging = false;
    const setPos = (pct) => {
      pct = Math.max(0, Math.min(100, pct));
      clip.style.clipPath = `inset(0 ${100-pct}% 0 0)`;
      document.getElementById("sl-handle").style.left = pct + "%";
    };
    setPos(50);
    const move = (clientX) => {
      const r = wrap.getBoundingClientRect();
      setPos((clientX - r.left) / r.width * 100);
    };
    wrap.addEventListener("pointerdown", e => { dragging = true; wrap.setPointerCapture(e.pointerId); move(e.clientX); });
    wrap.addEventListener("pointermove", e => { if (dragging) move(e.clientX); });
    wrap.addEventListener("pointerup", () => dragging = false);
    wrap.addEventListener("pointercancel", () => dragging = false);
  } else {
    body.innerHTML = `<div class="cmp-grid">` + items.map((o, i) => `
      <figure data-i="${i}">
        <button class="eye" type="button" title="View full size" aria-label="View full size">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zM12 17a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z"/>
          </svg>
        </button>
        <img loading="lazy" src="${fileUrl(o.output)}">
        <figcaption><b>${esc(o.model_name||"")}</b><br>${esc(o.workflow_name||"")} · seed ${esc(o.seed??"—")}<br>${new Date(o.created*1000).toLocaleString()}</figcaption>
      </figure>`).join("") + `</div>`;
    // 👁 eye per figure: open that single image full-window ON TOP of the
    // still-open compare (closeModal() now removes only the topmost).
    body.querySelectorAll(".cmp-grid figure .eye").forEach(b => {
      b.onclick = (e) => {
        e.stopPropagation();
        const i = +b.closest("figure").dataset.i;
        const o = items[i];
        if (o) openSingle(o, items, i);
      };
    });
  }
}

// Single-output full-window viewer (opened from a thumbnail's 👁 eye button)
function openSingle(o, list = [o], index = 0) {
  const n = list.length;
  const box = modal(`<div class="mh"><h2 style="margin:0">${esc(o.model_name||"Image")}</h2>
    <button class="btn small" data-close>Close ✕</button></div>
    <div class="mb2 single">
      <img id="single-img" src="${fileUrl(o.output)}" alt="">
      <div class="cap">
        <span id="single-idx" class="muted"></span>
        <span><b id="single-model">${esc(o.model_name||"")}</b></span>
        <span class="muted" id="single-wf">${esc(o.workflow_name||"")}</span>
        <span class="muted" id="single-seed">seed ${esc(o.seed??"—")}</span>
        <span class="muted" id="single-date">${new Date(o.created*1000).toLocaleString()}</span>
      </div>
    </div>
    <button class="nav-arrow nav-prev" type="button" aria-label="Previous image" title="Previous (←)">
      <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <button class="nav-arrow nav-next" type="button" aria-label="Next image" title="Next (→)">
      <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`, { full:true });
  box.__list = list;
  box.__idx = Math.max(0, Math.min(index, n - 1));
  if (n <= 1) box.classList.add("solo");

  // Re-render the CURRENT item in place — never calls modal()/closeModal(), so
  // any modal stacked behind (e.g. the compare grid) stays byte-for-byte intact.
  const render = () => {
    const cur = box.__list[box.__idx];
    if (!cur) return;
    box.querySelector("#single-img").src = fileUrl(cur.output);
    box.querySelector("#single-model").textContent = cur.model_name || "";
    box.querySelector("#single-wf").textContent = cur.workflow_name || "";
    box.querySelector("#single-seed").textContent = "seed " + (cur.seed ?? "—");
    box.querySelector("#single-date").textContent = new Date(cur.created * 1000).toLocaleString();
    box.querySelector("#single-idx").textContent = n > 1 ? (box.__idx + 1) + " / " + n : "";
    box.querySelector(".mh h2").textContent = cur.model_name || "Image";
  };
  const go = (dir) => {
    if (n <= 1) return;                       // single-item: no-op
    box.__idx = (box.__idx + dir + n) % n;    // wrap-around
    render();
  };

  box.querySelector(".nav-prev").onclick = () => go(-1);
  box.querySelector(".nav-next").onclick = () => go(1);
  render(); // normalize the counter for the initial item

  // Keyboard nav: active ONLY while this viewer is the topmost modal, and never
  // while typing in a field. Detached on close via __onclose (the viewer set
  // none before, so this overwrites nothing).
  const back = box.parentElement;             // the .modal-back backdrop
  const onKey = (e) => {
    const root = document.getElementById("modal-root");
    if (!root || root.lastElementChild !== back) return; // topmost guard
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
  };
  window.addEventListener("keydown", onKey);
  box.__onclose = () => window.removeEventListener("keydown", onKey);
}

// ===========================================================================
// PAGE: Workflows (+ upload)
// ===========================================================================
async function renderWorkflows() {
  const view = document.getElementById("view");
  const kind = (route.query && route.query.kind) || "model";
  const d = await API.get("/workflows");
  // Scope the list to the active tab (default 'model' = today's behavior;
  // pre-kind rows lack .kind and are treated as 'model').
  const wfs = d.workflows.filter(w => (w.kind || "model") === kind);
  view.innerHTML = `
    ${kindTabsHTML(kind)}
    <div class="row space wrap mb">
      <div><h1 style="margin:0">Workflows</h1>
        <div class="muted small">${kind === "lora" ? "LoRA workflows — each must contain a LoraLoader node." : "Test workflows — each swaps the model + optional prompt/seed."}</div></div>
      <div class="row">
        <label class="btn small" style="cursor:pointer">⬆ Upload .json
          <input type="file" id="wf-upload" accept=".json,application/json" class="hidden">
        </label>
        <button class="btn primary" id="wf-add">+ Add (paste JSON)</button>
      </div>
    </div>
    ${kind === "lora" ? `<div class="card mb" style="border-left:3px solid var(--acc)">
      <div class="small"><b>How to build a LoRA-bench workflow</b></div>
      <ol class="muted small" style="margin:6px 0 0 18px;padding:0;line-height:1.55">
        <li>Build it in ComfyUI with a <code>Load LoRA (Model and CLIP)</code> node (<code>LoraLoader</code>) — this is the node the strength-sweep bench edits.</li>
        <li>Keep any <code>Lora Loader (LoraManager)</code> LoRAs you want <b>fixed</b> on a LoraManager node — the bench leaves those untouched and only changes the designated node.</li>
        <li>Export the workflow as <b>API-format</b> JSON (Workflow → Save (API), or the <code>prompt</code> object) and upload it here.</li>
        <li>On upload the app asks <b>which node the bench should target</b> — confirm the <code>LoraLoader</code> node (it's pre-selected). You can re-designate any time with the <b>🎯 Bench node</b> button on the row.</li>
        <li>Run it from <b>Run Bench → Lora Bench</b>: pick this workflow + a LoRA + the strength range — one image per strength step.</li>
      </ol></div>` : ``}
    <div id="wf-list">${wfs.map(wfRow).join("") || (kind === "lora"
      ? `<div class="empty">No LoRA workflows yet — upload one (a workflow containing a LoraLoader node)</div>`
      : `<div class="empty">No workflows. Upload or add one.</div>`)}</div>
    <div id="wf-editor" class="card mt hidden"></div>
    <div class="card mt hidden" id="wf-addcard"><h3>Add a workflow</h3>
      <p class="muted small">Paste a ComfyUI <b>API-format</b> prompt (JSON, the <code>prompt</code> object from a workflow — not the UI graph). It must contain a <code>CheckpointLoaderSimple</code> or <code>UNETLoaderWithName</code> node (or a <code>LoraLoader</code> node for LoRA workflows).</p>
      <label class="field"><span class="lab">Name</span><input id="wf-name" placeholder="e.g. Text to Image (Anima)"></label>
      <label class="field"><span class="lab">Description</span><input id="wf-desc" placeholder="optional"></label>
      <label class="field"><span class="lab">API prompt (JSON)</span>
        <textarea id="wf-json" rows="10" placeholder='{"52":{"inputs":...,"class_type":"..."},...}'></textarea></label>
      <button class="btn primary" id="wf-submit">Add workflow</button>
    </div>`;
  bindKindTabs(kind, (k) => { location.hash = "#/workflows?kind=" + k; });
  bindWfList();
  document.getElementById("wf-add").onclick = () => {
    const card = document.getElementById("wf-addcard");
    card.classList.toggle("hidden");
    if (!card.classList.contains("hidden")) card.scrollIntoView({behavior:"smooth"});
  };
  document.getElementById("wf-upload").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    // OPTIONAL lora-node designation (asked at upload time): parse the
    // file client-side, and if it contains LoRA loader nodes let the user
    // pick which one the bench targets. Untouched -> backend auto-detects
    // (standard LoraLoader preferred) — same as before.
    let benchNodeId = null;
    let wfKind = null; // null = auto (backend derives from nodes)
    const nodes = loraNodesFromText(await fileTextSafe(f));
    if (nodes.length) {
      // INTENT first: model workflow vs LoRA-bench workflow. Only the
      // LoRA-bench path asks which node to target.
      const intent = await askWorkflowIntent(f.name);
      if (intent === false) { toast("Cancelled"); e.target.value = ""; return; }
      wfKind = intent;
      if (intent === "lora") {
        benchNodeId = await askLoraBenchNode(nodes, f.name);
        // false = user cancelled the node step → still proceed, let backend
        // auto-detect (do not abort the upload).
      }
    }
    const fd = new FormData();
    fd.append("file", f);
    fd.append("name", f.name.replace(/\.(json)$/i, ""));
    if (wfKind) fd.append("kind", wfKind);
    if (benchNodeId) fd.append("bench_node_id", benchNodeId);
    toast("Uploading & converting…");
    try {
      const r = await API.upload("/workflows/upload", fd);
      toast(`Workflow added: ${r.workflow.name}` +
            (r.workflow.lora_bench_supported ? "" :
              (r.workflow.kind === "lora" ? " (LoRA node is LoraManager — not strength-sweepable)" : "")));
      renderWorkflows();
    } catch (err) { toast(err.message); }
    e.target.value = "";
  };
  document.getElementById("wf-submit").onclick = async () => {
    const name = document.getElementById("wf-name").value.trim();
    const desc = document.getElementById("wf-desc").value.trim();
    const raw = document.getElementById("wf-json").value.trim();
    if (!name || !raw) { toast("Name and JSON required"); return; }
    let prompt; try { prompt = JSON.parse(raw); } catch { toast("Invalid JSON"); return; }
    // OPTIONAL lora-node designation (asked at add time) — same picker as
    // upload; the user can skip it and the backend auto-detects.
    let benchNodeId = null;
    let wfKind = null; // null = auto (backend derives from nodes)
    const nodes = loraNodesFromPrompt(prompt);
    if (nodes.length) {
      // INTENT first: model workflow vs LoRA-bench workflow. Only the
      // LoRA-bench path asks which node to target.
      const intent = await askWorkflowIntent(name);
      if (intent === false) { toast("Cancelled"); return; }
      wfKind = intent;
      if (intent === "lora") {
        benchNodeId = await askLoraBenchNode(nodes, name);
        if (benchNodeId === false) benchNodeId = null; // skipped → auto-detect
      }
    }
    try {
      await API.post("/workflows", { name, description: desc, prompt,
        kind: wfKind || undefined,
        bench_node_id: benchNodeId || undefined });
      toast("Workflow added"); renderWorkflows();
    } catch (e) { toast(e.message); }
  };
}
// ---- LoRA bench-node picker (upload/add time) ---------------------------
const LORA_LOADER_TYPES = ["LoraLoader", "LoraLoaderModelOnly", "Lora Loader (LoraManager)"];
const SWEEPABLE_TYPES = ["LoraLoader", "LoraLoaderModelOnly"];
function loraNodesFromPrompt(prompt) {
  // API prompt: {id: {class_type, inputs}}
  if (!prompt || typeof prompt !== "object" || !Array.isArray(prompt.nodes)) {
    const out = [];
    for (const [nid, n] of Object.entries(prompt || {})) {
      if (n && LORA_LOADER_TYPES.includes(n.class_type)) out.push({ id: nid, class_type: n.class_type });
    }
    return out;
  }
  return [];
}
function loraNodesFromText(raw) {
  if (!raw) return [];
  let d; try { d = JSON.parse(raw); } catch { return []; }
  // UI graph: nodes[] with a `type` field
  if (Array.isArray(d.nodes)) {
    return d.nodes
      .filter(n => n && LORA_LOADER_TYPES.includes(n.type))
      .map(n => { try { return { id: String(n.id), class_type: n.type }; } catch { return null; } })
      .filter(Boolean);
  }
  return loraNodesFromPrompt(d);
}
async function fileTextSafe(f) {
  try { return f.size > 4 * 1024 * 1024 ? "" : await f.text(); } catch { return ""; }
}
// Modal asking the user's INTENT for a workflow that contains LoRA nodes:
// is it a MODEL workflow (kept as-is, appears in the Model tab, LoRA nodes
// present but not bench-targeted) or a LoRA-BENCH workflow (target a node
// for the strength-sweep)? Returns "model" | "lora" | false (cancelled).
function askWorkflowIntent(wfName) {
  const box = modal(`
    <div class="mh"><h2 style="margin:0">How will you use this workflow?</h2>
      <button class="btn small" data-close>Cancel ✕</button></div>
    <div class="mb2">
      <p class="muted small">"${esc(wfName)}" contains LoRA loader node(s).
        Pick how the app should treat it — this sets which tab it appears in
        and whether it can run the LoRA strength-sweep bench.
        A workflow can keep its LoRA nodes and still be a model workflow.</p>
      <div class="row" style="gap:10px;margin-top:14px">
        <button class="btn" id="wfi-model" style="flex:1;padding:12px 10px">
          📦 Model workflow<br>
          <span class="muted small">Runs the model bench. LoRA nodes are kept
          but not bench-targeted.</span>
        </button>
        <button class="btn primary" id="wfi-lora" style="flex:1;padding:12px 10px">
          🔁 LoRA-bench workflow<br>
          <span class="muted small">Target a LoRA node for the
          strength-sweep bench (asks which node next).</span>
        </button>
      </div>
    </div>`);
  return new Promise(resolve => {
    let settled = false;
    const finish = (v) => {
      if (settled) return; settled = true;
      box.__onclose = null; closeModal(); resolve(v);
    };
    box.__onclose = () => finish(false); // ✕ / backdrop
    box.querySelector("#wfi-model").onclick = () => finish("model");
    box.querySelector("#wfi-lora").onclick = () => finish("lora");
  });
}
// Modal asking "which node should the LoRA bench target?".
// Returns the chosen node id, null (user skipped), or false (cancelled).
function askLoraBenchNode(nodes, wfName) {
  const pre = nodes.find(n => SWEEPABLE_TYPES.includes(n.class_type));
  const box = modal(`
    <div class="mh"><h2 style="margin:0">LoRA bench node</h2>
      <button class="btn small" data-close>Cancel ✕</button></div>
    <div class="mb2">
      <p class="muted small">"${esc(wfName)}" contains ${nodes.length} LoRA loader node(s).
        The strength-sweep bench edits <code>lora_name</code> + <code>strength_*</code> on ONE node.
        Pick which one to target — or skip to let the app auto-detect
        (prefers a standard LoraLoader).</p>
      <label class="field"><span class="lab">Target node</span>
        <select id="lbn-sel">
          ${nodes.map(n => `<option value="${esc(n.id)}" ${pre && pre.id === n.id ? "selected" : ""}>node ${esc(n.id)} · ${esc(n.class_type)}${SWEEPABLE_TYPES.includes(n.class_type) ? "" : " (NOT sweepable)"}</option>`).join("")}
        </select></label>
      <label class="row" style="cursor:pointer"><input type="checkbox" id="lbn-use" checked style="width:auto">
        <span class="small">Designate this node for the LoRA bench</span></label>
      <div class="row mt">
        <span class="grow"></span>
        <button class="btn" id="lbn-skip">Skip (auto-detect)</button>
        <button class="btn primary" id="lbn-ok">Confirm</button>
      </div>
    </div>`);
  return new Promise(resolve => {
    const sel = box.querySelector("#lbn-sel");
    const use = box.querySelector("#lbn-use");
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      box.__onclose = null; // don't let closeModal re-resolve with `false`
      closeModal();
      resolve(val);
    };
    box.__onclose = () => finish(false); // cancelled via ✕ / backdrop
    box.querySelector("#lbn-ok").onclick = () => finish(use.checked ? sel.value : null);
    box.querySelector("#lbn-skip").onclick = () => finish(null);
  });
}
// Re-designate the bench node on an EXISTING workflow (per-row button).
async function redesignateLoraBenchNode(w) {
  // The list rows don't carry the full prompt — fetch the workflow first.
  let full = w;
  try { full = await API.get("/workflows/" + w.id); } catch { /* keep row data */ }
  const nodes = loraNodesFromPrompt(full.prompt || {});
  if (!nodes.length) { toast("No LoRA loader nodes in this workflow"); return; }
  const cur = full.lora_node_id || (nodes.find(n => SWEEPABLE_TYPES.includes(n.class_type)) || {}).id;
  const box = modal(`
    <div class="mh"><h2 style="margin:0">LoRA bench node — ${esc(full.name || w.name || "")}</h2>
      <button class="btn small" data-close>Close ✕</button></div>
    <div class="mb2">
      <p class="muted small">Currently targeting <b>${esc(full.lora_node_id || "(none — auto-detect)")}</b>
        ${full.lora_bench_supported ? "(strength-sweepable)" : "(NOT strength-sweepable)"}.
        ${nodes.length} LoRA loader node(s) available.</p>
      <label class="field"><span class="lab">Target node</span>
        <select id="lbn-sel">
          ${nodes.map(n => `<option value="${esc(n.id)}" ${String(cur) === String(n.id) ? "selected" : ""}>node ${esc(n.id)} · ${esc(n.class_type)}${SWEEPABLE_TYPES.includes(n.class_type) ? "" : " (NOT sweepable)"}</option>`).join("")}
        </select></label>
      <div class="row mt"><span class="grow"></span>
        <button class="btn primary" id="lbn-save">Save designation</button></div>
    </div>`);
  box.querySelector("#lbn-save").onclick = async () => {
    const nid = box.querySelector("#lbn-sel").value;
    try {
      await API.put("/workflows/" + w.id, { lora_node_id: nid });
      toast(`LoRA bench node for "${w.name}" → ${nid}`);
      closeModal(); renderWorkflows();
    } catch (e) { toast(e.message); }
  };
}
function wfRow(w) {
  const s = w.summary || {};
  return `<div class="card mb">
    <div class="row space wrap">
      <div>
        <h3 style="margin:0">${esc(w.name)}</h3>
        <div class="muted small">${esc(w.description||"")}</div>
        <div class="mt">
          <span class="pill">loader: ${esc(s.loader_type||"—")}</span>
          <span class="pill">model node: ${esc(s.model_node_id||"—")}</span>
          <span class="pill">${(s.seed_node_ids||[]).length} seed nodes</span>
          <span class="pill">prompt node: ${esc(s.prompt_node_id||"—")}</span>
          <span class="pill">${s.node_count||0} nodes</span>
        </div>
      </div>
      <div class="row wrap">
        <button class="btn small primary" data-wf-edit="${esc(w.id)}">✎ Edit nodes</button>
        ${w.kind === "lora" ? `<button class="btn small" data-wf-benchnode="${esc(w.id)}" title="Choose which LoRA loader node the bench targets">🎯 Bench node${w.lora_node_id ? " (" + esc(w.lora_node_id) + ")" : ""}</button>` : ""}
        <button class="btn small" data-wf-use="${esc(w.id)}">Use</button>
        <button class="btn small" data-wf-rename="${esc(w.id)}">Rename</button>
        <button class="btn small danger" data-wf-del="${esc(w.id)}">Delete</button>
      </div>
    </div>
  </div>`;
}
function bindWfList() {
  document.querySelectorAll("[data-wf-use]").forEach(b => b.onclick = () => {
    localStorage.setItem("cb_pending_wf", b.dataset.wfUse);
    location.hash = "#/bench";
  });
  document.querySelectorAll("[data-wf-edit]").forEach(b => b.onclick = () => openNodeEditor(b.dataset.wfEdit));
  document.querySelectorAll("[data-wf-benchnode]").forEach(b => b.onclick = () => {
    // Row data is enough for the button; redesignateLoraBenchNode fetches
    // the full workflow (incl. prompt) by id before building the picker.
    redesignateLoraBenchNode({ id: b.dataset.wfBenchnode });
  });
  document.querySelectorAll("[data-wf-rename]").forEach(b => b.onclick = async () => {
    const name = prompt("New workflow name:");
    if (name) { try { await API.put("/workflows/"+b.dataset.wfRename,{name}); renderWorkflows(); } catch(e){toast(e.message);} }
  });
  document.querySelectorAll("[data-wf-del]").forEach(b => b.onclick = async () => {
    if (!confirm("Delete this workflow?")) return;
    try { await API.del("/workflows/"+b.dataset.wfDel); renderWorkflows(); } catch(e){toast(e.message);}
  });
}

// ===========================================================================
// Node editor: pick a node, see its value, edit + save (prompt text nodes)
// ===========================================================================
async function openNodeEditor(wid) {
  const view = document.getElementById("view");
  const editor = document.getElementById("wf-editor");
  editor.classList.remove("hidden");
  editor.innerHTML = `<h3 style="margin:0 0 6px">Edit nodes <span class="faint small">— ${esc(wid)}</span></h3>
    <p class="muted small">Pick a node to inspect &amp; edit its value. Text/prompt nodes (★) can be edited and saved back into this workflow.</p>
    <div class="row wrap" style="gap:8px">
      <select id="ne-node" style="min-width:340px;flex:1"></select>
      <button class="btn" id="ne-default">★ Set as prompt node</button>
    </div>
    <div id="ne-body" class="mt"></div>`;
  editor.scrollIntoView({ behavior: "smooth" });
  let nodes = [];
  try {
    ({ nodes } = await API.get(`/workflows/${wid}/nodes`));
  } catch (e) {
    editor.innerHTML = `<h3>Edit nodes</h3><div class="error">${esc(e.message)}</div>`;
    return;
  }
  const sel = document.getElementById("ne-node");
  sel.innerHTML = nodes.map(n =>
    `<option value="${esc(n.id)}" data-editable="${n.editable?1:0}">${n.editable?"★ ":""}node ${esc(n.id)} · ${esc(n.class_type||"")}</option>`
  ).join("");
  // Default-select the current prompt node if present.
  try {
    const wf = (await API.get("/workflows")).workflows.find(w => w.id === wid);
    if (wf && wf.prompt_node_id) {
      const opt = [...sel.options].find(o => o.value === String(wf.prompt_node_id));
      if (opt) sel.value = opt.value;
    }
  } catch {}
  const body = document.getElementById("ne-body");
  const renderBody = async () => {
    const id = sel.value;
    const meta = nodes.find(n => n.id === id);
    if (!meta) { body.innerHTML = ""; return; }
    body.innerHTML = `<div class="pill mt">class: ${esc(meta.class_type||"—")}</div>
      <div class="muted small mt" style="white-space:pre-wrap;font-family:ui-monospace,monospace">${esc(meta.preview||"(no scalar inputs)")}</div>`;
    const editable = !!meta.editable;
    if (editable) {
      body.insertAdjacentHTML("beforeend", `
        <label class="field mt"><span class="lab">Node value <span class="faint small">(edit &amp; save)</span></span>
          <textarea id="ne-text" rows="6" placeholder="(empty)"></textarea></label>
        <button class="btn primary" id="ne-save">Save value</button>`);
      // Load the current value for this node.
      try {
        const r = await API.get(`/workflows/${wid}/nodes/${encodeURIComponent(id)}/value`);
        const ta2 = document.getElementById("ne-text");
        if (ta2) ta2.value = r.value || "";
      } catch {
        const ta2 = document.getElementById("ne-text");
        if (ta2) ta2.placeholder = "(no text value)";
      }
      document.getElementById("ne-save").onclick = async () => {
        const val = document.getElementById("ne-text").value;
        try {
          await API.put(`/workflows/${wid}/node`, { node_id: id, value: val });
          toast(`Saved node ${id}`);
          renderBody();
        } catch (e) { toast(e.message); }
      };
    }
  };
  sel.onchange = renderBody;
  document.getElementById("ne-default").onclick = async () => {
    try {
      await API.put(`/workflows/${wid}`, { prompt_node_id: sel.value });
      toast(`Default prompt node set to ${sel.value}`);
    } catch (e) { toast(e.message); }
  };
  renderBody();
}

// ===========================================================================
// PAGE: Run bench (with prompt-target node picker)
// ===========================================================================
async function renderBench() {
  const view = document.getElementById("view");
  const tab = (route.query && route.query.tab) || "model";
  const [wfs, models, cfg] = await Promise.all([
    API.get("/workflows"), API.get("/models?sort=name"),
    API.get("/config").catch(() => ({})),
  ]);
  const pendingModels = JSON.parse(localStorage.getItem("cb_pending_models") || "[]");
  const pendingWf = localStorage.getItem("cb_pending_wf");
  const pendingLora = localStorage.getItem("cb_pending_lora");
  localStorage.removeItem("cb_pending_models"); localStorage.removeItem("cb_pending_wf"); localStorage.removeItem("cb_pending_lora");
  // Rerun payload (from a home-page Rerun button): full settings of an existing
  // bench to pre-fill this form. Cleared here so a manual re-open of the bench
  // page never re-applies it.
  let rerun = null;
  try { const rr = localStorage.getItem("cb_pending_rerun"); if (rr) rerun = JSON.parse(rr); } catch {}
  localStorage.removeItem("cb_pending_rerun");
  const wfSel = pendingWf || (wfs.workflows[0] && wfs.workflows[0].id) || "";

  view.innerHTML = `
    <h1 style="margin:0 0 4px">Run bench</h1>
    <div class="tabs" id="bench-tabs">
      <button data-btab="model" class="${tab === "model" ? "active" : ""}">Model Bench</button>
      <button data-btab="lora" class="${tab === "lora" ? "active" : ""}">Lora Bench</button>
    </div>
    <div id="bench-model-tab" class="${tab === "model" ? "" : "hidden"}">
    <div class="muted small mb">Pick a workflow, the models to run, and optional prompt/seed overrides.</div>
    <div class="grid2">
      <div class="card">
        <label class="field"><span class="lab">Workflow</span>
          <select id="r-wf">${wfs.workflows.map(w=>`<option value="${esc(w.id)}" ${w.id===wfSel?"selected":""}>${esc(w.name)}</option>`).join("")}</select></label>
        <label class="field"><span class="lab">Seed <span class="faint">(fixed for comparability)</span></span>
          <input id="r-seed" type="number" value="${auth.default_seed||42}"></label>
        <label class="field"><span class="lab">Prompt override <span class="faint">(optional)</span></span>
          <textarea id="r-prompt" rows="4" placeholder="leave blank to use the workflow's default prompt"></textarea></label>
        <label class="field"><span class="lab">Prompt target node <span class="faint">(which node your override replaces)</span></span>
          <select id="r-pnode"></select>
          <div class="row wrap mt" id="r-pnode-actions"></div></label>
        <label class="field"><span class="lab">Per-model timeout (s)</span>
          <input id="r-timeout" type="number" value="900"></label>
        <button class="btn primary" id="r-start" style="width:100%">▶ Start bench</button>
        <div id="r-warn" class="mt"></div>
      </div>
      <div class="card">
        <div class="row space mb wrap">
          <h2 style="margin:0">Models</h2>
          <div class="row"><input class="search" id="r-q" placeholder="filter…" style="max-width:180px">
          <span class="muted small" id="r-cnt"></span></div>
        </div>
        <div class="row wrap mb">
          <button class="btn small" id="r-all">Select all</button>
          <button class="btn small" id="r-none">Clear</button>
          <span class="muted small">or pick from the Models page</span>
        </div>
        <div class="chips" id="r-chips"></div>
        <div style="max-height:56vh;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-s)" id="r-list"></div>
      </div>
    </div>
    </div>
    <div id="bench-lora-tab" class="${tab === "lora" ? "" : "hidden"}">
    <div class="muted small mb">Sweep one LoRA across strength values on a single base model — same seed for every step.</div>
    <div>
      <div class="card">
        <label class="field"><span class="lab">LoRA workflow</span>
          <select id="lb-wf"></select>
          <div id="lb-wf-hint" class="mt small muted"></div></label>
        <label class="field"><span class="lab">Base model <span class="faint">— pick a folder, then a model</span></span>
          <div class="grid2" style="gap:12px">
            <div class="tree" id="lb-base-tree" style="max-height:38vh;overflow:auto;border:1px solid var(--border);border-radius:6px"><span class="spin2"></span>&nbsp; loading…</div>
            <div>
              <div class="row" style="margin-bottom:6px;gap:8px"><input class="search" id="lb-base-q" placeholder="filter…" style="max-width:180px">
              <select id="lb-base-sort" style="width:auto">
                <option value="name">Sort: name</option>
                <option value="display">Sort: display name</option>
                <option value="stars">Sort: stars</option>
                <option value="date">Sort: newest</option>
                <option value="size">Sort: size</option>
              </select></div>
              <div style="max-height:38vh;overflow:auto;border:1px solid var(--border);border-radius:6px;background:var(--bg2)" id="lb-base-list"></div>
              <span class="muted small" id="lb-base-cnt"></span>
              <div class="row mt" id="lb-base-more"></div>
            </div>
          </div>
          <div class="chips" id="lb-base-chips"></div>
          <input type="hidden" id="lb-base">
        </label>
        <div class="field"><span class="lab">LoRA <span class="faint">(pick a folder, then a LoRA)</span></span>
          <div class="grid2" style="gap:12px">
            <div class="tree" id="lb-ltree" style="max-height:38vh;overflow:auto;border:1px solid var(--border);border-radius:6px"><span class="spin2"></span>&nbsp; loading…</div>
            <div>
              <div class="row" style="margin-bottom:6px;gap:8px"><input class="search" id="lb-lora-q" placeholder="filter…" style="max-width:180px">
              <select id="lb-lora-sort" style="width:auto">
                <option value="name">Sort: name</option>
                <option value="display">Sort: display name</option>
                <option value="stars">Sort: stars</option>
                <option value="date">Sort: newest</option>
                <option value="size">Sort: size</option>
              </select></div>
              <div style="max-height:38vh;overflow:auto;border:1px solid var(--border);border-radius:6px" id="lb-lora-list"></div>
              <span class="muted small" id="lb-lora-cnt"></span>
              <div class="row mt" id="lb-lora-more"></div>
            </div>
          </div>
          <input type="hidden" id="lb-lora"></div>
        <div class="chips" id="lb-chips"></div>
        <div class="grid2" style="gap:12px">
          <label class="field"><span class="lab">Strength min</span>
            <input id="lb-min" type="number" step="0.01" min="-100" max="100" value="0.0"></label>
          <label class="field"><span class="lab">Strength max</span>
            <input id="lb-max" type="number" step="0.01" value="1.0"></label>
        </div>
        <div class="grid2" style="gap:12px">
          <label class="field"><span class="lab">Increment <span class="faint">(&gt; 0)</span></span>
            <input id="lb-inc" type="number" step="0.01" value="0.1"></label>
          <label class="field"><span class="lab">Seed <span class="faint">(same for every step)</span></span>
            <input id="lb-seed" type="number" value="${auth.default_seed||42}"></label>
        </div>
        <label class="field"><span class="lab">Prompt override <span class="faint">(optional)</span></span>
          <textarea id="lb-prompt" rows="3" placeholder="leave blank to use the workflow's default prompt"></textarea></label>
        <div id="lb-preview" class="token-box mb"></div>
        <button class="btn primary" id="lb-start" style="width:100%">▶ Start LoRA sweep</button>
      </div>
    </div>
    </div>`;

  // ---- hover preview: show each model/LoRA's preview thumb near the cursor.
  //      One shared box + delegated listeners on the persistent containers, so
  //      it survives innerHTML re-renders and never steals row click handlers. ----
  attachHoverPreview(document.getElementById("r-list"),
    (k) => models.models.find(x => x.key === k));
  attachHoverPreview(document.getElementById("lb-base-list"),
    (k) => lbBase.models.find(x => x.key === k));
  attachHoverPreview(document.getElementById("lb-lora-list"),
    (k) => lbLora.loras.find(x => x.key === k));

  // ---- prompt-target node picker ----
  const pnodeSel = document.getElementById("r-pnode");
  const curWf = () => wfs.workflows.find(w => w.id === document.getElementById("r-wf").value);
  const renderPnode = () => {
    const wf = curWf();
    const cands = (wf && wf.summary && wf.summary.prompt_candidates) || [];
    const current = wf && wf.prompt_node_id;
    if (!cands.length) {
      pnodeSel.innerHTML = `<option value="">(none detected)</option>`;
      pnodeSel.disabled = true;
      document.getElementById("r-pnode-actions").innerHTML = "";
      return;
    }
    pnodeSel.disabled = false;
    pnodeSel.innerHTML = cands.map(c =>
      `<option value="${esc(c.id)}" ${c.id===current?"selected":""}>node ${esc(c.id)} · ${esc(c.class_type||"")} · ${esc(c.preview||"")}</option>`
    ).join("");
    document.getElementById("r-pnode-actions").innerHTML =
      `<button class="btn small" id="r-pnode-default">Set as default for this workflow</button>`;
    document.getElementById("r-pnode-default").onclick = async () => {
      const wf = curWf(); if (!wf) return;
      const val = pnodeSel.value;
      try {
        await API.put("/workflows/" + wf.id, { prompt_node_id: val });
        toast(`Default prompt node for "${wf.name}" set to ${val}`);
      } catch (e) { toast(e.message); }
    };
  };
  renderPnode();
  document.getElementById("r-wf").onchange = renderPnode;

  // ---- model list ----
  const rList = document.getElementById("r-list");
  const set = new Set(pendingModels);
  const filteredRows = (filter="") => {
    const q = (filter||"").toLowerCase();
    return models.models.filter(m => !q || m.name.toLowerCase().includes(q) || (m.display_name||"").toLowerCase().includes(q));
  };
  const renderList = (filter="") => {
    const rows = filteredRows(filter);
    rList.innerHTML = rows.map(m => `<label class="row" data-key="${esc(m.key)}" style="padding:6px 10px;border-bottom:1px solid var(--border)">
      <input type="checkbox" value="${esc(m.key)}" ${set.has(m.key)?"checked":""} style="width:auto">
      <span class="grow" style="font-size:13px">${esc(m.display_name||m.name)} <span class="faint small">· ${esc(m.folder||"/")}</span></span>
    </label>`).join("") || `<div class="empty">none</div>`;
    document.getElementById("r-cnt").textContent = `${set.size} selected`;
    renderModelChips();
    rList.querySelectorAll("input[type=checkbox]").forEach(c => c.onchange = () => {
      if (c.checked) set.add(c.value); else set.delete(c.value);
      document.getElementById("r-cnt").textContent = `${set.size} selected`;
      renderModelChips();
    });
  };
  // Selected-model chips — a live summary of the selection, independent of the
  // list filter (a filtered-out model stays selected & visible as a chip).
  const renderModelChips = () => {
    const box = document.getElementById("r-chips");
    if (!box) return;
    const byKey = new Map(models.models.map(m => [m.key, m]));
    const keys = [...set];
    if (!keys.length) { box.innerHTML = `<span class="chips-empty">No models selected yet — check the list below.</span>`; return; }
    box.innerHTML = keys.map(k => {
      const m = byKey.get(k) || {};
      const label = m.display_name || m.name || k.split("/").pop() || k;
      return `<span class="chip" data-key="${esc(k)}" title="${esc(k)}">
        <span class="chip-label">${esc(label)}</span>
        <button class="chip-x" data-x="${esc(k)}" title="Remove" aria-label="Remove ${esc(label)}">×</button>
      </span>`;
    }).join("");
    box.querySelectorAll(".chip-x").forEach(b => b.onclick = () => {
      const k = b.dataset.x;
      set.delete(k);
      const cb = rList.querySelector(`input[value="${CSS.escape(k)}"]`);
      if (cb) cb.checked = false;
      document.getElementById("r-cnt").textContent = `${set.size} selected`;
      renderModelChips();
      showWarn();
    });
  };
  document.getElementById("r-q").oninput = e => renderList(e.target.value);
  document.getElementById("r-all").onclick = () => { filteredRows(document.getElementById("r-q").value).forEach(m => set.add(m.key)); renderList(document.getElementById("r-q").value); };
  document.getElementById("r-none").onclick = () => { set.clear(); renderList(document.getElementById("r-q").value); };
  renderList();

  // ---- loader-type warning ----
  const showWarn = () => {
    const wf = curWf();
    const warnEl = document.getElementById("r-warn");
    if (!wf) { warnEl.innerHTML=""; return; }
    const loader = wf.summary?.loader_type;
    const unetModels = models.models.filter(m => set.has(m.key) && m.root.endsWith("diffusion_models"));
    const ckptModels = models.models.filter(m => set.has(m.key) && m.root.endsWith("checkpoints"));
    let w = "";
    if (loader === "UNETLoaderWithName" && ckptModels.length) w += `⚠ ${ckptModels.length} checkpoint model(s) selected but this workflow uses UNETLoader (expects diffusion_models UNETs).<br>`;
    if (loader === "CheckpointLoaderSimple" && unetModels.length) w += `⚠ ${unetModels.length} UNET model(s) selected but this workflow uses CheckpointLoader (expects checkpoint files).<br>`;
    warnEl.innerHTML = w;
  };
  document.getElementById("r-wf").onchange = () => { renderPnode(); showWarn(); };
  showWarn();

  // ---- Rerun prefill (model tab): restore this bench's workflow, seed,
  //      prompt, prompt node, and the originally selected models. ----
  if (rerun && rerun.kind === "model") {
    if (rerun.workflow_id) {
      const wf = document.getElementById("r-wf");
      if ([...wf.options].some(o => o.value === rerun.workflow_id)) {
        wf.value = rerun.workflow_id;
        renderPnode(); // rebuild the prompt-node options for this workflow
        showWarn();
      }
    }
    if (rerun.seed != null) document.getElementById("r-seed").value = rerun.seed;
    if (rerun.prompt) document.getElementById("r-prompt").value = rerun.prompt;
    if (rerun.prompt_node_id) {
      const pn = document.getElementById("r-pnode");
      if ([...pn.options].some(o => o.value === String(rerun.prompt_node_id))) pn.value = String(rerun.prompt_node_id);
    }
    if (Array.isArray(rerun.model_keys)) {
      rerun.model_keys.forEach(k => { if (models.models.some(m => m.key === k)) set.add(k); });
      renderList();
    }
  }

  document.getElementById("r-start").onclick = async () => {
    if (!set.size) { toast("Select at least one model"); return; }
    const body = {
      model_keys: [...set],
      workflow_id: document.getElementById("r-wf").value,
      seed: parseInt(document.getElementById("r-seed").value),
      prompt: document.getElementById("r-prompt").value.trim() || null,
      prompt_node_id: pnodeSel.value || null,
      timeout: parseInt(document.getElementById("r-timeout").value) || 900,
    };
    try {
      const r = await API.post("/benches/run", body);
      toast(r.queued
        ? `Queued bench (${r.bench.total} models) — will start when the current one finishes`
        : `Started bench (${r.bench.total} models)`);
      // remember the chosen prompt node as the workflow default
      if (body.prompt_node_id) {
        API.put("/workflows/" + body.workflow_id, { prompt_node_id: body.prompt_node_id }).catch(()=>{});
      }
      location.hash = "#/home";
      refreshIndicator();
    } catch (e) { toast(e.message); }
  };

  // ---- bench tab switching (hash-driven; both cards stay in the DOM so an
  //      in-progress form is never lost when switching tabs) ----
  document.querySelectorAll("#bench-tabs button").forEach(b => {
    b.onclick = () => { const k = b.dataset.btab; if (k !== tab) location.hash = "#/bench?tab=" + k; };
  });

  // ---- Lora bench (strength sweep) ----
  // Only standard-LoraLoader workflows can be strength-swept; LoraManager
  // workflows (loras baked in) are excluded via lora_bench_supported.
  const loraWfs = wfs.workflows.filter(
    w => (w.kind || "model") === "lora" && w.lora_bench_supported);
  const lbWf = document.getElementById("lb-wf");
  lbWf.innerHTML = loraWfs.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join("");
  if (!loraWfs.length) {
    document.getElementById("lb-wf-hint").innerHTML =
      `No standard-LoraLoader workflow — the lora strength bench needs a workflow with a single <code>LoraLoader</code> node. See the <a href="#/workflows?kind=lora">Workflows</a> page (LoRAs tab) for LoRA-tagged workflows.`;
  }
  const lbBaseInput = document.getElementById("lb-base");
  // Base-model picker: folder tree + server-filtered chunked list, mirroring
  // the LoRA picker (same box size, same chip pattern). The hidden #lb-base
  // input holds the selected key so updateLbPreview / the lb-start body keep
  // reading it unchanged.
  const loraBaseDefault = (cfg && cfg.lora_bench_default_model) || "";
  if (loraBaseDefault) {
    lbBase.selected = loraBaseDefault;
    lbBaseInput.value = loraBaseDefault;
  }
  // LoRA picker: folder tree (left) + server-filtered chunked list (right).
  // The hidden #lb-lora input holds the selected key so updateLbPreview /
  // the lb-start submit body keep reading it unchanged. (Named lbLoraInput
  // to avoid shadowing the module-level lbLora *state* object.)
  const lbLoraInput = document.getElementById("lb-lora");
  // A rerun of a LoRA bench also carries its LoRA key — apply whichever is set.
  const applyLoraKey = pendingLora
    || (rerun && rerun.kind === "lora" ? rerun.lora_key : null);
  loadLbLoraTree().then(() => lbApplyPendingLora(applyLoraKey));
  bindLbLoraFilter();
  const lbSort = document.getElementById("lb-lora-sort");
  if (lbSort) {
    lbSort.value = lbLora.sort || "name";
    lbSort.onchange = (e) => { lbLora.sort = e.target.value; loadLbLoras(); };
  }

  // Base-model picker: folder tree + server-filtered chunked list, mirroring
  // the LoRA picker. Same box size, same chip pattern.
  const baseSort = document.getElementById("lb-base-sort");
  if (baseSort) {
    baseSort.value = lbBase.sort || "name";
    baseSort.onchange = (e) => { lbBase.sort = e.target.value; loadLbBaseModels(); };
  }
  bindLbBaseFilter();
  const lbBaseReady = lbBaseLoadTree();
  renderLbBaseChips();

  // Step preview — SAME clamp rule as the backend: steps = min, min+inc, …
  // up to max, final step clamped to max (so the last value == max);
  // min==max -> just [min]. One image per strength step.
  const fmtStep = (v) => String(parseFloat(v.toFixed(4)));
  const computeSteps = (min, max, inc) => {
    const steps = [];
    if (min === max) return [min];
    for (let i = 0; ; i++) {
      const v = min + i * inc;
      if (v >= max - inc * 1e-6) break;
      steps.push(v);
    }
    steps.push(max);
    return steps;
  };
  const updateLbPreview = () => {
    const min = parseFloat(document.getElementById("lb-min").value);
    const max = parseFloat(document.getElementById("lb-max").value);
    const inc = parseFloat(document.getElementById("lb-inc").value);
    const pv = document.getElementById("lb-preview");
    const start = document.getElementById("lb-start");
    if (!isFinite(min) || !isFinite(max) || !isFinite(inc) || inc <= 0 || min > max) {
      pv.textContent = "⚠ Invalid range: need min ≤ max and increment > 0.";
      pv.style.color = "var(--err)";
      start.disabled = true;
      return null;
    }
    const steps = computeSteps(min, max, inc);
    pv.style.color = "";
    start.disabled = !lbWf.value || !lbBaseInput.value || !lbLoraInput.value;
    pv.textContent = `${steps.length} steps → ${steps.length} images: ${steps.map(fmtStep).join(", ")}`;
    return steps;
  };
  ["lb-min", "lb-max", "lb-inc"].forEach(id => document.getElementById(id).addEventListener("input", updateLbPreview));
  [lbWf, lbBaseInput, lbLoraInput].forEach(sel => sel.addEventListener("change", updateLbPreview));
  updateLbPreview();

  // ---- Rerun prefill (LoRA tab): restore the run's workflow, base model,
  //      strength range, increment, seed and prompt. ----
  if (rerun && rerun.kind === "lora") {
    if (rerun.workflow_id) {
      if ([...lbWf.options].some(o => o.value === rerun.workflow_id)) lbWf.value = rerun.workflow_id;
    }
    if (rerun.base_model_key) {
      lbBase.selected = rerun.base_model_key;
      lbBaseInput.value = rerun.base_model_key;
    }
    if (rerun.strength_min != null) document.getElementById("lb-min").value = rerun.strength_min;
    if (rerun.strength_max != null) document.getElementById("lb-max").value = rerun.strength_max;
    // Increment isn't stored on the record; derive it from the step ladder
    // (uniform steps) when possible, otherwise leave the 0.1 default.
    if (Array.isArray(rerun.strengths) && rerun.strengths.length >= 2) {
      const inc = parseFloat((rerun.strengths[1] - rerun.strengths[0]).toFixed(4));
      if (isFinite(inc) && inc > 0) document.getElementById("lb-inc").value = inc;
    }
    if (rerun.seed != null) document.getElementById("lb-seed").value = rerun.seed;
    if (rerun.prompt) document.getElementById("lb-prompt").value = rerun.prompt;
    updateLbPreview(); // recompute the step preview from the restored range
  }

  document.getElementById("lb-start").onclick = async () => {
    const min = parseFloat(document.getElementById("lb-min").value);
    const max = parseFloat(document.getElementById("lb-max").value);
    const inc = parseFloat(document.getElementById("lb-inc").value);
    if (inc <= 0 || min > max) { toast("Need min ≤ max and increment > 0"); return; }
    if (!lbWf.value) { toast("No LoRA workflow available — upload one first"); return; }
    const body = {
      workflow_id: lbWf.value,
      base_model_key: lbBaseInput.value,
      lora_key: lbLoraInput.value,
      strength_min: min,
      strength_max: max,
      increment: inc,
      seed: parseInt(document.getElementById("lb-seed").value),
      prompt: document.getElementById("lb-prompt").value.trim() || null,
    };
    try {
      const r = await API.post("/benches/run-lora", body);
      toast(r.queued
        ? `Queued LoRA sweep (${r.bench.total} steps) — will start when the current bench finishes`
        : `Started LoRA sweep (${r.bench.total} steps)`);
      refreshIndicator();
      // Land on the home page (bench history), matching the model bench —
      // not the outputs page. The new run appears there with its progress.
      location.hash = "#/home";
    } catch (e) {
      // 400/404 -> the ApiError message carries the backend `detail`
      toast(e.message);
    }
  };
}

// ===========================================================================
// PAGE: Outputs (bench-filterable)
// ===========================================================================
let outSel = new Map(); // id -> output
let outState = { q: "" }; // free-text search, scoped to the active kind tab
async function renderOutputs() {
  const view = document.getElementById("view");
  const kind = (route.query && route.query.kind) || "model";
  const benchId = (route.query && route.query.bench) || "";
  // Switching kind tabs must NOT carry over a search or selection from the
  // other tab — reset the transients up-front (hash change re-renders this).
  outState.q = ""; outSel.clear();
  const params = new URLSearchParams();
  params.set("kind", kind);
  if (benchId) params.set("bench_id", benchId);
  const d = await API.get("/outputs?" + params.toString());
  const rows = (d.outputs || []).filter(o => (o.kind || "model") === kind);
  view.innerHTML = `
    ${kindTabsHTML(kind)}
    <div class="row space wrap mb">
      <div><h1 style="margin:0">Outputs</h1>
        <div class="muted small">${rows.length} image(s) · select 2 for a slider compare, 3+ for a grid</div></div>
      <div class="row">
        <select id="o-bench" style="width:auto">
          <option value="">All ${kind === "lora" ? "LoRA" : ""} benches</option>
        </select>
        <input class="search" id="o-q" placeholder="Search outputs…" style="max-width:200px">
        <button class="btn small" id="o-all">Select all</button>
        <button class="btn primary" id="o-cmp">Compare selected (0)</button>
        <button class="btn small" id="o-clear">Clear</button>
      </div>
    </div>
    <div class="ogrid" id="o-grid"></div>`;
  bindKindTabs(kind, (k) => { location.hash = "#/outputs?kind=" + k; });
  const sel = document.getElementById("o-bench");
  const list = await API.get("/benches");
  const benches = list.benches.filter(b => (b.kind || "model") === kind);
  sel.innerHTML = `<option value="">All ${kind === "lora" ? "LoRA" : ""} benches</option>` +
    benches.map(b => `<option value="${esc(b.id)}" ${benchId===b.id?"selected":""}>${new Date(b.created*1000).toLocaleDateString()} · ${esc(b.workflow_name)} (${b.done}/${b.total})</option>`).join("");
  sel.onchange = () => {
    const q = sel.value ? "bench=" + encodeURIComponent(sel.value) : "";
    location.hash = "#/outputs?" + [q, "kind=" + kind].filter(Boolean).join("&");
  };
  const grid = document.getElementById("o-grid");
  const qEl = document.getElementById("o-q");
  qEl.oninput = () => { outState.q = qEl.value; drawGrid(); };
  const cmpBtn = document.getElementById("o-cmp");
  const cmpCount = () => { cmpBtn.textContent = `Compare selected (${outSel.size})`; };
  const cellHTML = (o) => {
    const s = outSel.has(o.id);
    const loraLine = (o.kind === "lora")
      ? `<div class="lbl"><span class="badge lora">LoRA ${o.strength != null ? Number(o.strength).toFixed(2) : "—"}×</span> ${esc(o.lora_name||"")}</div>`
      : "";
    return `<div class="ocell ${s?"sel":""}" data-oid="${esc(o.id)}">
      <div class="tick">✓</div>
      <button class="eye" type="button" title="View full size" aria-label="View full size">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zM12 17a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z"/>
        </svg>
      </button>
      <img loading="lazy" src="${thumbUrl(o.output)}">
      <div class="lbl">${esc(o.model_name||"")} · ${esc(o.workflow_name||"")}</div>
      ${loraLine}
      <div class="lbl faint">${new Date(o.created*1000).toLocaleDateString()}</div>
    </div>`;
  };
  const visible = () => {
    const q = outState.q.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(o =>
      (o.workflow_name||"").toLowerCase().includes(q) ||
      (o.model_name||"").toLowerCase().includes(q) ||
      (o.lora_name||"").toLowerCase().includes(q));
  };
  const drawGrid = () => {
    const v = visible();
    grid.innerHTML = v.map(cellHTML).join("") ||
      `<div class="empty" style="grid-column:1/-1">${outState.q ? "No outputs match your search." : "No outputs yet. Run a bench first."}</div>`;
    grid.querySelectorAll(".ocell").forEach(c => c.onclick = () => {
      const id = c.dataset.oid;
      if (outSel.has(id)) outSel.delete(id);
      else outSel.set(id, rows.find(o => o.id===id));
      c.classList.toggle("sel", outSel.has(id));
      cmpCount();
    });
    // 👁 eye button: open that single output full-window (scoped to the
    // visible, search-filtered set). stopPropagation so it does NOT also
    // toggle the cell's selection.
    grid.querySelectorAll(".eye").forEach(b => b.onclick = (e) => {
      e.stopPropagation();
      const id = b.closest(".ocell").dataset.oid;
      const v2 = visible();
      const index = v2.findIndex(x => x.id === id);
      if (index >= 0) openSingle(v2[index], v2, index);
    });
  };
  drawGrid();
  cmpBtn.onclick = () => {
    if (outSel.size < 2) { toast("Select at least 2"); return; }
    openCompare([...outSel.values()]);
  };
  document.getElementById("o-clear").onclick = () => { outSel.clear(); outState.q = ""; qEl.value = ""; drawGrid(); cmpCount(); };
  document.getElementById("o-all").onclick = () => {
    // Select exactly the currently-visible (search-filtered) outputs,
    // additively — matches the Models (#sel-all) and Run-bench (#r-all) convention.
    visible().forEach(o => outSel.set(o.id, o));
    drawGrid(); cmpCount();
  };
}

// ===========================================================================
// PAGE: Setup
// ===========================================================================
async function renderSetup() {
  const view = document.getElementById("view");
  const c = await API.get("/config");
  view.innerHTML = `
    <h1 style="margin:0 0 4px">Setup</h1>
    <div class="muted small mb">Connection, model roots, and app settings.</div>
    <div class="grid2">
      <div class="card">
        <h3>ComfyUI connection</h3>
        <label class="field"><span class="lab">Base URL</span>
          <input id="s-comfy" value="${esc(c.comfy_base||"")}"></label>
        <label class="field"><span class="lab">Output root</span>
          <input id="s-out" value="${esc(c.output_root||"")}"></label>
        <button class="btn" id="s-test">Test connection</button>
        <div id="s-testout" class="mt small"></div>
        <div class="mt"></div>
        <h3>Model roots <span class="faint small">(one per line)</span></h3>
        <textarea id="s-roots" rows="4">${esc((c.model_roots||[]).join("\n"))}</textarea>
        <div class="mt"></div>
        <h3>LoRA roots <span class="faint small">(one per line)</span></h3>
        <textarea id="s-lora-roots" rows="4">${esc((c.lora_roots||[]).join("\n"))}</textarea>
      </div>
      <div class="card">
        <h3>App</h3>
        <label class="field"><span class="lab">Default seed</span>
          <input id="s-seed" type="number" value="${esc(c.default_seed??42)}"></label>
        <label class="field"><span class="lab">Default base model <span class="faint">(LoRA bench)</span></span>
          <select id="s-lora-base"></select>
          <div class="faint small mt">Pre-selected as the base model when starting a LoRA bench.</div></label>
        <label class="row" style="margin-bottom:12px"><input type="checkbox" id="s-dark" ${c.dark_mode?"checked":""} style="width:auto">
          <span class="grow">Dark mode (default)</span></label>
        <div class="row space">
          <span class="muted small">Bind: ${esc(c.host||"0.0.0.0")}:${esc(c.port||7860)}</span>
          <button class="btn primary" id="s-save">Save settings</button>
        </div>
        <div class="mt" style="border-top:1px solid var(--border);padding-top:14px">
          <h3>Access token</h3>
          <p class="muted small">Share this token with anyone who should access the app over the LAN.</p>
          <div class="token-box" id="s-token"></div>
          <div class="row mt"><button class="btn" id="s-copy">Copy</button>
            <button class="btn danger" id="s-regen">Regenerate token</button></div>
        </div>
      </div>
    </div>`;
  const tok = await getToken();
  document.getElementById("s-token").textContent = tok || "(hidden)";
  // Populate the default base-model select (Setup → App) from /api/models,
  // grouped by folder. Value = model key (absolute path).
  (async () => {
    const sel = document.getElementById("s-lora-base");
    if (!sel) return;
    sel.innerHTML = `<option value="">(no default)</option>`;
    try {
      const models = await API.get("/models?sort=name");
      const byFolder = new Map();
      (models.models || []).forEach(m => {
        const f = m.folder || "/";
        if (!byFolder.has(f)) byFolder.set(f, []);
        byFolder.get(f).push(m);
      });
      [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([folder, ms]) => {
        const og = document.createElement("optgroup");
        og.label = folder;
        ms.forEach(m => {
          const o = document.createElement("option");
          o.value = m.key;
          o.textContent = m.display_name || m.name;
          og.appendChild(o);
        });
        sel.appendChild(og);
      });
      sel.value = c.lora_bench_default_model || "";
    } catch (e) { /* keep "(no default)" */ }
  })();
  document.getElementById("s-copy").onclick = async () => {
    if (!tok) { toast("No token to copy"); return; }
    const ok = await copyToClipboard(tok);
    toast(ok ? "Copied" : "Copy failed — select the text and press Ctrl/Cmd+C");
  };
  document.getElementById("s-regen").onclick = async () => {
    if (!confirm("Regenerate the token? Existing sessions will be logged out.")) return;
    try { const r = await API.post("/config/regenerate-token");
      document.getElementById("s-token").textContent = r.token; toast("New token generated"); }
    catch(e){toast(e.message);}
  };
  document.getElementById("s-test").onclick = async () => {
    await saveSetup();
    const out = document.getElementById("s-testout");
    out.innerHTML = `<span class="spin2"></span>&nbsp; testing…`;
    try {
      const r = await API.post("/config/test-connection");
      if (r.ok) {
        const dev = (r.device||[])[0];
        out.innerHTML = `<span class="badge ok">connected</span> ${dev?`<span class="pill">${esc(dev.name||"GPU")}</span>`:""}`;
      } else out.innerHTML = `<span class="badge err">not reachable</span>`;
    } catch (e) { out.innerHTML = `<span class="badge err">error: ${esc(e.message)}</span>`; }
  };
  document.getElementById("s-save").onclick = async () => {
    try { await saveSetup(); toast("Saved"); } catch (e) { toast(e.message); }
  };
}
async function getToken() {
  try { const r = await API.get("/config/token"); return r.token || null; }
  catch { return null; }
}
async function saveSetup() {
  const body = {
    comfy_base: document.getElementById("s-comfy").value.trim(),
    output_root: document.getElementById("s-out").value.trim(),
    model_roots: document.getElementById("s-roots").value.split("\n").map(s=>s.trim()).filter(Boolean),
    lora_roots: document.getElementById("s-lora-roots").value.split("\n").map(s=>s.trim()).filter(Boolean),
    default_seed: parseInt(document.getElementById("s-seed").value)||42,
    dark_mode: document.getElementById("s-dark").checked,
    lora_bench_default_model: document.getElementById("s-lora-base")?.value || "",
  };
  await API.put("/config", body);
  auth.dark = body.dark_mode;
}

// go
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
