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
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c])); }
function fmtBytes(n) { if (!n) return "—";
  const u = ["B","KB","MB","GB","TB"]; let i=0; while (n>=1024 && i<u.length-1){n/=1024;i++;}
  return n.toFixed(n<10&&i>0?1:0)+" "+u[i]; }
function fmtTime(ts) { if (!ts) return "—";
  return new Date(ts*1000).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}); }
function stars(n) { n=Math.max(0,Math.min(5,n|0)); return "★".repeat(n)+"☆".repeat(5-n); }

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
  home: renderHome, models: renderModels, workflows: renderWorkflows,
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
function modal(html, { wide=false } = {}) {
  const root = document.getElementById("modal-root");
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal" + (wide ? " wide" : "");
  box.innerHTML = html;
  back.appendChild(box);
  back.addEventListener("click", e => { if (e.target === back) closeModal(); });
  root.appendChild(back);
  box.querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal);
  return box;
}
function closeModal() { document.getElementById("modal-root").innerHTML = ""; }

// ===========================================================================
// PAGE: Home (bench history) — event-delegated so re-renders don't kill clicks
// ===========================================================================
let homePoll = null;
async function renderHome() {
  clearInterval(homePoll);
  const view = document.getElementById("view");
  view.innerHTML = `
    <div class="row space wrap mb">
      <div><h1 style="margin:0">Bench history</h1>
      <div class="muted small" id="home-count"></div></div>
      <button class="btn primary" id="home-run">+ Run new bench</button>
    </div>
    <div id="home-list"></div>`;
  document.getElementById("home-run").onclick = () => location.hash = "#/bench";
  // Delegate all row interactions to the container (survives re-renders).
  if (!view._homeBound) { view.addEventListener("click", benchClickHandler); view._homeBound = true; }
  refreshHomeList();
  homePoll = setInterval(refreshHomeList, 2500);
  refreshIndicator();
}
function refreshHomeList() {
  API.get("/benches").then(d => {
    const el = document.getElementById("home-list");
    if (!el) return;
    el.innerHTML = d.benches.map(benchRow).join("") ||
      `<div class="empty">No benches yet. Run your first bench from "Run bench".</div>`;
    const c = document.getElementById("home-count");
    if (c) c.textContent = `${d.benches.length} run(s)`;
  }).catch(() => {});
}
function benchClickHandler(e) {
  const btn = e.target.closest("[data-act]");
  const row = e.target.closest(".benchrow");
  if (!row) return;
  const bid = row.dataset.bid;
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
      location.hash = "#/outputs?bench=" + encodeURIComponent(bid);
      return;
    }
    if (act === "stop") {
      e.stopPropagation();
      API.post(`/benches/${encodeURIComponent(bid)}/stop`)
        .then(() => { refreshHomeList(); toast("Stopped"); })
        .catch(err => toast(err.message));
      return;
    }
  }
  // row click -> outputs for this bench
  location.hash = "#/outputs?bench=" + encodeURIComponent(bid);
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
  return `<div class="benchrow" data-bid="${esc(b.id)}">
    <div style="min-width:150px">
      <div class="title">${esc(b.workflow_name||"bench")}</div>
      <div class="sub">${new Date(b.created*1000).toLocaleString()} · ${b.total} model(s) · seed ${esc(b.seed??"—")}</div>
    </div>
    <div class="progressbar"><div style="width:${pct}%"></div></div>
    <div class="pct">${b.done}/${b.total}</div>
    ${badge}
    ${stopBtn}
    <button class="btn small" data-act="view" data-bid="${esc(b.id)}">Outputs</button>
    <button class="btn small danger" data-act="del" data-bid="${esc(b.id)}">✕</button>
  </div>`;
}

// ===========================================================================
// PAGE: Models (nested folder tree + grid)
// ===========================================================================
let selModels = new Set();
let modelState = { root: "", folder: "", q: "", sort: "name", models: [] };

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
function renderTree(node, ctx) {
  // ctx === null  -> top level: each key is a full model-ROOT path.
  // ctx = {root, parts} -> nested folders; parts are RELATIVE folder segments.
  let out = "";
  const keys = Object.keys(node).sort((a, b) => a.localeCompare(b));
  for (const k of keys) {
    const child = node[k] || {};
    const hasKids = Object.keys(child).length > 0;
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
    const cnt = countLeaves(child);
    out += `<div class="node ${isRoot ? "root" : ""}" data-root="${esc(dataRoot)}" data-folder="${esc(folder)}">
      <span class="tw">${hasKids ? "▸" : ""}</span> ${esc(label)} <span class="cnt">${cnt}</span></div>`;
    if (hasKids) out += `<ul>${renderTree(child, { root: dataRoot, parts: childParts })}</ul>`;
  }
  return out;
}
function countLeaves(node) {
  const keys = Object.keys(node);
  if (!keys.length) return 1;
  return keys.reduce((s,k) => s + countLeaves(node[k]), 0);
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
    const thumb = m.preview
      ? `<img class="thumb" loading="lazy" src="${fileUrl(m.preview)}" onerror="this.outerHTML='<div class=&quot;thumb placeholder&quot;>no image</div>'">`
      : `<div class="thumb placeholder">no preview</div>`;
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
  if (!selModels.size) { bar.classList.add("hidden"); bar.innerHTML=""; return; }
  bar.classList.remove("hidden");
  bar.innerHTML = `<span class="grow"><b>${selModels.size}</b> selected</span>
    <button class="btn small" id="sel-all">Select all</button>
    <button class="btn small" id="sel-none">Clear</button>
    <button class="btn primary" id="sel-run">▶ Run bench</button>`;
  document.getElementById("sel-all").onclick = () => {
    modelState.models.forEach(m => selModels.add(m.key));
    renderModelGrid(modelState.models);
  };
  document.getElementById("sel-none").onclick = () => { selModels.clear(); renderModelGrid(modelState.models); };
  document.getElementById("sel-run").onclick = () => {
    localStorage.setItem("cb_pending_models", JSON.stringify([...selModels]));
    location.hash = "#/bench";
  };
}

async function openModelDetail(key) {
  const m = await API.get("/models/" + encodeURIComponent(key));
  const box = modal(`
    <div class="mh"><h2 style="margin:0">${esc(m.display_name || m.name)}</h2>
      <button class="btn small" data-close>Close ✕</button></div>
    <div class="mb2 model-detail">
      ${m.preview ? `<img src="${fileUrl(m.preview)}">` : `<div class="thumb placeholder" style="aspect-ratio:1/1">no preview</div>`}
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
      <img loading="lazy" src="${fileUrl(o.output)}">
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
// COMPARE (slider for 2, grid for 3+)
// ===========================================================================
function openCompare(items) {
  modal(`<div class="mh"><h2 style="margin:0">Compare ${items.length} output(s)</h2>
    <button class="btn small" data-close>Close ✕</button></div><div class="mb2" id="cmp-body"></div>`, { wide:true });
  const body = document.getElementById("cmp-body");
  if (items.length === 2) {
    const [a,b] = items;
    body.innerHTML = `
      <div class="slider-wrap" id="sl">
        <img src="${fileUrl(b.output)}" alt="B">
        <img class="clip" id="sl-clip" src="${fileUrl(a.output)}" alt="A">
        <div class="handle" id="sl-handle"></div>
        <div class="tag" style="left:12px">${esc(a.model_name||"A")}</div>
        <div class="tag" style="right:12px">${esc(b.model_name||"B")}</div>
      </div>
      <div class="row space mt muted small">
        <span>${esc(a.workflow_name||"")} · seed ${esc(a.seed??"—")}</span>
        <span>drag the handle to reveal A ↔ B</span>
        <span>seed ${esc(b.seed??"—")} · ${esc(b.workflow_name||"")}</span>
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
    body.innerHTML = `<div class="cmp-grid">` + items.map(o => `
      <figure><img loading="lazy" src="${fileUrl(o.output)}">
      <figcaption><b>${esc(o.model_name||"")}</b><br>${esc(o.workflow_name||"")} · seed ${esc(o.seed??"—")}<br>${new Date(o.created*1000).toLocaleString()}</figcaption>
      </figure>`).join("") + `</div>`;
  }
}

// ===========================================================================
// PAGE: Workflows (+ upload)
// ===========================================================================
async function renderWorkflows() {
  const view = document.getElementById("view");
  const d = await API.get("/workflows");
  view.innerHTML = `
    <div class="row space wrap mb">
      <div><h1 style="margin:0">Workflows</h1>
        <div class="muted small">Test workflows — each swaps the model + optional prompt/seed.</div></div>
      <div class="row">
        <label class="btn small" style="cursor:pointer">⬆ Upload .json
          <input type="file" id="wf-upload" accept=".json,application/json" class="hidden">
        </label>
        <button class="btn primary" id="wf-add">+ Add (paste JSON)</button>
      </div>
    </div>
    <div id="wf-list">${d.workflows.map(wfRow).join("") || `<div class="empty">No workflows. Upload or add one.</div>`}</div>
    <div id="wf-editor" class="card mt hidden"></div>
    <div class="card mt hidden" id="wf-addcard"><h3>Add a workflow</h3>
      <p class="muted small">Paste a ComfyUI <b>API-format</b> prompt (JSON, the <code>prompt</code> object from a workflow — not the UI graph). It must contain a <code>CheckpointLoaderSimple</code> or <code>UNETLoaderWithName</code> node.</p>
      <label class="field"><span class="lab">Name</span><input id="wf-name" placeholder="e.g. Text to Image (Anima)"></label>
      <label class="field"><span class="lab">Description</span><input id="wf-desc" placeholder="optional"></label>
      <label class="field"><span class="lab">API prompt (JSON)</span>
        <textarea id="wf-json" rows="10" placeholder='{"52":{"inputs":...,"class_type":"..."},...}'></textarea></label>
      <button class="btn primary" id="wf-submit">Add workflow</button>
    </div>`;
  bindWfList();
  document.getElementById("wf-add").onclick = () => {
    const card = document.getElementById("wf-addcard");
    card.classList.toggle("hidden");
    if (!card.classList.contains("hidden")) card.scrollIntoView({behavior:"smooth"});
  };
  document.getElementById("wf-upload").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("file", f);
    fd.append("name", f.name.replace(/\.(json)$/i, ""));
    toast("Uploading & converting…");
    try {
      const r = await API.upload("/workflows/upload", fd);
      toast(`Workflow added: ${r.workflow.name}`);
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
    try {
      await API.post("/workflows", { name, description: desc, prompt });
      toast("Workflow added"); renderWorkflows();
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
  const [wfs, models] = await Promise.all([
    API.get("/workflows"), API.get("/models?sort=name"),
  ]);
  const pendingModels = JSON.parse(localStorage.getItem("cb_pending_models") || "[]");
  const pendingWf = localStorage.getItem("cb_pending_wf");
  localStorage.removeItem("cb_pending_models"); localStorage.removeItem("cb_pending_wf");
  const wfSel = pendingWf || (wfs.workflows[0] && wfs.workflows[0].id) || "";

  view.innerHTML = `
    <h1 style="margin:0 0 4px">Run bench</h1>
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
        <div style="max-height:56vh;overflow:auto;border:1px solid var(--border);border-radius:var(--radius-s)" id="r-list"></div>
      </div>
    </div>`;

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
  const renderList = (filter="") => {
    const q = (filter||"").toLowerCase();
    const rows = models.models.filter(m => !q || m.name.toLowerCase().includes(q) || (m.display_name||"").toLowerCase().includes(q));
    rList.innerHTML = rows.map(m => `<label class="row" style="padding:6px 10px;border-bottom:1px solid var(--border)">
      <input type="checkbox" value="${esc(m.key)}" ${set.has(m.key)?"checked":""} style="width:auto">
      <span class="grow" style="font-size:13px">${esc(m.display_name||m.name)} <span class="faint small">· ${esc(m.folder||"/")}</span></span>
    </label>`).join("") || `<div class="empty">none</div>`;
    document.getElementById("r-cnt").textContent = `${set.size} selected`;
    rList.querySelectorAll("input[type=checkbox]").forEach(c => c.onchange = () => {
      if (c.checked) set.add(c.value); else set.delete(c.value);
      document.getElementById("r-cnt").textContent = `${set.size} selected`;
    });
  };
  document.getElementById("r-q").oninput = e => renderList(e.target.value);
  document.getElementById("r-all").onclick = () => { models.models.forEach(m => set.add(m.key)); renderList(document.getElementById("r-q").value); };
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
}

// ===========================================================================
// PAGE: Outputs (bench-filterable)
// ===========================================================================
let outSel = new Map(); // id -> output
async function renderOutputs() {
  const view = document.getElementById("view");
  const benchId = (route.query && route.query.bench) || "";
  const params = new URLSearchParams();
  if (benchId) params.set("bench_id", benchId);
  const d = await API.get("/outputs?" + params.toString());
  view.innerHTML = `
    <div class="row space wrap mb">
      <div><h1 style="margin:0">Outputs</h1>
        <div class="muted small">${d.count} image(s) · select 2 for a slider compare, 3+ for a grid</div></div>
      <div class="row">
        <select id="o-bench" style="width:auto">
          <option value="">All benches</option>
        </select>
        <button class="btn primary" id="o-cmp">Compare selected (${outSel.size})</button>
        <button class="btn small" id="o-clear">Clear</button>
      </div>
    </div>
    <div class="ogrid" id="o-grid"></div>`;
  const sel = document.getElementById("o-bench");
  const list = await API.get("/benches");
  sel.innerHTML = `<option value="">All benches</option>` +
    list.benches.map(b => `<option value="${esc(b.id)}" ${benchId===b.id?"selected":""}>${new Date(b.created*1000).toLocaleDateString()} · ${esc(b.workflow_name)} (${b.done}/${b.total})</option>`).join("");
  sel.onchange = () => { location.hash = sel.value ? "#/outputs?bench="+encodeURIComponent(sel.value) : "#/outputs"; };
  document.getElementById("o-cmp").onclick = () => {
    if (outSel.size < 2) { toast("Select at least 2"); return; }
    openCompare([...outSel.values()]);
  };
  document.getElementById("o-clear").onclick = () => { outSel.clear(); renderOutputs(); };
  const grid = document.getElementById("o-grid");
  grid.innerHTML = d.outputs.map(o => {
    const s = outSel.has(o.id);
    return `<div class="ocell ${s?"sel":""}" data-oid="${esc(o.id)}">
      <div class="tick">✓</div>
      <img loading="lazy" src="${fileUrl(o.output)}">
      <div class="lbl">${esc(o.model_name||"")} · ${esc(o.workflow_name||"")}</div>
      <div class="lbl faint">${new Date(o.created*1000).toLocaleDateString()}</div>
    </div>`;
  }).join("") || `<div class="empty" style="grid-column:1/-1">No outputs yet. Run a bench first.</div>`;
  grid.querySelectorAll(".ocell").forEach(c => c.onclick = () => {
    const id = c.dataset.oid;
    if (outSel.has(id)) outSel.delete(id);
    else outSel.set(id, d.outputs.find(o => o.id===id));
    c.classList.toggle("sel", outSel.has(id));
    document.getElementById("o-cmp").textContent = `Compare selected (${outSel.size})`;
  });
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
      </div>
      <div class="card">
        <h3>App</h3>
        <label class="field"><span class="lab">Default seed</span>
          <input id="s-seed" type="number" value="${esc(c.default_seed??42)}"></label>
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
  document.getElementById("s-copy").onclick = async () => {
    try { await navigator.clipboard.writeText(tok); toast("Copied"); }
    catch { toast("Copy failed"); }
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
    default_seed: parseInt(document.getElementById("s-seed").value)||42,
    dark_mode: document.getElementById("s-dark").checked,
  };
  await API.put("/config", body);
  auth.dark = body.dark_mode;
}

// go
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
