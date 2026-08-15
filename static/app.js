/* SSHDeck frontend */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let STATE = { folders: [], hosts: [], keys: [], identities: [], username: "" };
let FONT_SIZE = parseInt(localStorage.getItem("sshdeck.fontsize")) || 13;
let SCROLLBACK = parseInt(localStorage.getItem("sshdeck.scrollback")) || 50000;
const TABS = new Map();      // tabId -> {host, term, fit, ws, statsWs, el, tabEl, stats}
let activeTab = null;
let tabSeq = 0;
const wsProto = location.protocol === "https:" ? "wss://" : "ws://";

async function api(path, opts = {}) {
  if (opts.json !== undefined) {
    opts.method = opts.method || "POST";
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(opts.json);
    delete opts.json;
  }
  const r = await fetch(path, opts);
  if (r.status === 401) { location.href = "/login"; throw new Error("auth"); }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.detail || `HTTP ${r.status}`);
  }
  return r.json();
}

function fmtBytes(n) {
  if (n == null) return "–";
  const u = ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 2)) + " " + u[i];
}
function fmtRate(n) {
  const mbps = n * 8 / 1e6;
  return mbps >= 1 ? mbps.toFixed(2) + " Mb/s" : (n / 1024).toFixed(1) + " kB/s";
}
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}
function fmtDate(t) {
  if (!t) return "";
  return new Date(t * 1000).toLocaleString(undefined,
    { year: "2-digit", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}
/* natural sort: base name first, then numbers ascending (1,2,…,10 — not 1,10,2) */
function natKey(s) {
  return String(s).toLowerCase().split(/[\s\-_.]+/)
    .flatMap(part => part.match(/\d+|\D+/g) || []);
}
function natCompare(a, b) {
  const A = natKey(a), B = natKey(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i], y = B[i];
    if (x === undefined) return -1;               // shorter = base name → first
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = parseInt(x) - parseInt(y); if (d) return d; }
    else if (nx !== ny) return nx ? 1 : -1;       // "uu-mongo.osl" before "uu-mongo-1.osl"
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ================= state / sidebar ================= */

async function loadState() {
  STATE = await api("/api/state");
  STATE.folders.sort((a, b) => natCompare(a.name, b.name));
  STATE.hosts.sort((a, b) => natCompare(a.label, b.label));
  $("#whoami").textContent = STATE.username;
  renderTree();
  renderKeys();
  renderIdentities();
  renderPaneHostOptions();
}

const closedFolders = new Set(JSON.parse(localStorage.getItem("sshdeck.closed") || "[]"));

/* small custom context menu */
let ctxEl = null;
function closeCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
function ctxMenu(ev, items) {
  ev.preventDefault();
  closeCtx();
  ctxEl = document.createElement("div");
  ctxEl.className = "ctxmenu";
  for (const it of items) {
    const b = document.createElement("button");
    b.textContent = it.label;
    if (it.danger) b.classList.add("danger");
    b.onclick = () => { closeCtx(); it.fn(); };
    ctxEl.appendChild(b);
  }
  document.body.appendChild(ctxEl);
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(ev.clientX, innerWidth - r.width - 4) + "px";
  ctxEl.style.top = Math.min(ev.clientY, innerHeight - r.height - 4) + "px";
}
document.addEventListener("mousedown", e => { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); });
window.addEventListener("blur", closeCtx);

const HOST_DND = "application/x-sshdeck-host";
async function moveHost(hostId, folderId) {
  await api(`/api/hosts/${hostId}/move`, { json: { folder_id: folderId } });
  loadState();
}

const FOLDER_DND = "application/x-sshdeck-folder";

/* <option>s for every folder, depth-first, indented to show nesting */
function folderOptions(selectedId) {
  const out = [];
  const walk = (parentId, depth) => {
    for (const f of STATE.folders.filter(x => x.parent_id === parentId)) {
      out.push(`<option value="${f.id}"${f.id === selectedId ? " selected" : ""}>` +
        `${"&nbsp;&nbsp;".repeat(depth)}${depth ? "↳ " : ""}${esc(f.name)}</option>`);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out.join("");
}
async function moveFolder(folderId, parentId) {
  try {
    await api(`/api/folders/${folderId}/move`, { json: { parent_id: parentId } });
    loadState();
  } catch (e) { alert(e.message); }
}

/* does folder `id` (or any of its descendants) match the filter, via hosts inside? */
function folderHasMatch(id, match) {
  if (STATE.hosts.some(h => h.folder_id === id && match(h))) return true;
  return STATE.folders.some(f => f.parent_id === id && folderHasMatch(f.id, match));
}

function renderTree() {
  const filter = $("#filter").value.trim().toLowerCase();
  const tree = $("#tree");
  tree.innerHTML = "";
  const match = h => !filter ||
    h.label.toLowerCase().includes(filter) ||
    h.hostname.toLowerCase().includes(filter) ||
    h.username.toLowerCase().includes(filter);

  const hostRow = (h, depth) => {
    const ident = h.identity_id ? STATE.identities.find(i => i.id === h.identity_id) : null;
    const shownUser = h.auth_type === "identity" && ident ? ident.username : h.username;
    const he = document.createElement("div");
    he.className = "tree-host";
    he.style.paddingLeft = (22 + depth * 14) + "px";
    he.title = `${shownUser}@${h.hostname}:${h.port}`;
    he.innerHTML = `<span class="hicon">●</span><span class="hlabel">${esc(h.label)}</span>` +
      `<span class="hmeta">${esc(shownUser)}</span>` +
      `<button class="edit-btn" title="Edit">✎</button>`;
    he.onclick = e => {
      if (e.target.classList.contains("edit-btn")) { openHostModal(h); return; }
      openTerminal(h);
    };
    he.oncontextmenu = e => ctxMenu(e, [
      { label: "Connect", fn: () => openTerminal(h) },
      { label: "Edit", fn: () => openHostModal(h) },
      { label: "Duplicate", fn: async () => {
          const r = await api(`/api/hosts/${h.id}/duplicate`, { method: "POST" });
          await loadState();
          const copy = STATE.hosts.find(x => x.id === r.id);
          if (copy) openHostModal(copy);   // straight into edit — change what differs, save
        } },
      { label: "Delete", danger: true, fn: async () => {
          if (!confirm(`Delete host "${h.label}"?`)) return;
          await api(`/api/hosts/${h.id}`, { method: "DELETE" });
          loadState();
        } },
    ]);
    he.draggable = true;
    he.addEventListener("dragstart", ev => {
      ev.dataTransfer.setData(HOST_DND, String(h.id));
      ev.dataTransfer.effectAllowed = "move";
    });
    return he;
  };

  const folderRow = (f, depth) => {
    const fe = document.createElement("div");
    const closed = closedFolders.has(f.id) && !filter;
    fe.className = "tree-folder" + (closed ? " closed" : "");
    fe.style.paddingLeft = (10 + depth * 14) + "px";
    fe.innerHTML = `<span class="arrow">▼</span><span>${esc(f.name)}</span>`;
    fe.oncontextmenu = e => ctxMenu(e, [
      { label: "New sub-folder", fn: async () => {
          const name = prompt(`New folder inside "${f.name}":`);
          if (name && name.trim()) {
            await api("/api/folders", { json: { name, parent_id: f.id } });
            closedFolders.delete(f.id);
            loadState();
          }
        } },
      { label: "Rename", fn: async () => {
          const name = prompt("Folder name:", f.name);
          if (name && name.trim() && name !== f.name) {
            await api(`/api/folders/${f.id}`, { method: "PUT", json: { name } });
            loadState();
          }
        } },
      { label: "Move to root", fn: () => moveFolder(f.id, null) },
      { label: "Delete", danger: true, fn: () => {
          if (confirm(`Delete folder "${f.name}" and its sub-folders? (hosts move up one level)`))
            api(`/api/folders/${f.id}`, { method: "DELETE" }).then(loadState);
        } },
    ]);
    // drop a host or another folder onto this folder → move it inside
    fe.addEventListener("dragover", ev => {
      const t = ev.dataTransfer.types;
      if (t.includes(HOST_DND) || t.includes(FOLDER_DND)) { ev.preventDefault(); fe.classList.add("drop"); }
    });
    fe.addEventListener("dragleave", () => fe.classList.remove("drop"));
    fe.addEventListener("drop", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      fe.classList.remove("drop");
      const hid = parseInt(ev.dataTransfer.getData(HOST_DND));
      const fid = parseInt(ev.dataTransfer.getData(FOLDER_DND));
      if (hid) moveHost(hid, f.id);
      else if (fid && fid !== f.id) moveFolder(fid, f.id);
    });
    fe.draggable = true;
    fe.addEventListener("dragstart", ev => {
      ev.dataTransfer.setData(FOLDER_DND, String(f.id));
      ev.dataTransfer.effectAllowed = "move";
      ev.stopPropagation();
    });
    fe.onclick = () => {
      closedFolders.has(f.id) ? closedFolders.delete(f.id) : closedFolders.add(f.id);
      localStorage.setItem("sshdeck.closed", JSON.stringify([...closedFolders]));
      renderTree();
    };
    return fe;
  };

  // inside a folder: its hosts first, then its sub-folders (each recursing)
  const renderInside = (parentId, depth) => {
    for (const h of STATE.hosts.filter(h => h.folder_id === parentId && match(h)))
      tree.appendChild(hostRow(h, depth));
    for (const f of STATE.folders.filter(x => x.parent_id === parentId)) {
      if (filter && !folderHasMatch(f.id, match)) continue;
      tree.appendChild(folderRow(f, depth));
      if (closedFolders.has(f.id) && !filter) continue;
      renderInside(f.id, depth + 1);
    }
  };
  renderInside(null, 0);
}

// drop anywhere in the tree that's not a folder header → move host to root
{
  const treeEl = $("#tree");
  treeEl.addEventListener("dragover", ev => {
    const t = ev.dataTransfer.types;
    if (t.includes(HOST_DND) || t.includes(FOLDER_DND)) { ev.preventDefault(); treeEl.classList.add("drop"); }
  });
  treeEl.addEventListener("dragleave", ev => {
    if (!treeEl.contains(ev.relatedTarget)) treeEl.classList.remove("drop");
  });
  treeEl.addEventListener("drop", ev => {
    ev.preventDefault();
    treeEl.classList.remove("drop");
    const hid = parseInt(ev.dataTransfer.getData(HOST_DND));
    const fid = parseInt(ev.dataTransfer.getData(FOLDER_DND));
    if (hid) moveHost(hid, null);
    else if (fid) moveFolder(fid, null);
  });
}

// draggable sidebar width — terminals re-fit live, width remembered
{
  const sb = $("#sidebar"), rz = $("#side-resizer");
  const saved = parseInt(localStorage.getItem("sshdeck.sidew"));
  if (saved) sb.style.width = saved + "px";
  rz.addEventListener("mousedown", e => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const move = ev => {
      sb.style.width = Math.min(560, Math.max(150, ev.clientX)) + "px";
      fitActive();
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      localStorage.setItem("sshdeck.sidew", parseInt(sb.style.width) || 240);
      fitActive();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

$("#filter").addEventListener("input", renderTree);
$("#logout").onclick = () => api("/api/logout", { method: "POST" }).then(() => location.href = "/login");

/* ================= navigation ================= */

$$(".nav-btn").forEach(b => b.onclick = () => showView(b.dataset.view));
function showView(name) {
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "terms" && activeTab) setTimeout(() => fitActive(), 10);
  if (name === "tunnels") loadTunnels();
}

/* ================= terminals ================= */

/* ---- output highlighting (Moba-style, client-side) ---- */
let HL_ON = localStorage.getItem("sshdeck.hl") !== "0";
const HL_RE = new RegExp(
  "(?<ip4>\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:\\/\\d{1,2})?\\b)" +
  "|(?<mac>\\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\\b)" +
  "|(?<ip6>\\b(?:[0-9A-Fa-f]{1,4}:){4,7}[0-9A-Fa-f]{1,4}(?:\\/\\d{1,3})?\\b" +
    "|(?<![0-9A-Za-f:])[0-9A-Fa-f]{0,4}::[0-9A-Fa-f:]{1,32}(?:\\/\\d{1,3})?)" +
  "|(?<good>\\b(?:UP|RUNNING|LISTEN|ESTABLISHED|active|running|success|enabled|OK)\\b)" +
  "|(?<bad>\\b(?:DOWN|UNKNOWN|FAILED|ERROR|failed|error|inactive|dead|refused|denied)\\b)",
  "g");
function hlApply(s) {
  return s.replace(HL_RE, (...args) => {
    const g = args[args.length - 1];
    const m = args[0];
    const color = g.ip4 ? "36" : g.mac ? "33" : g.ip6 ? "35" : g.good ? "32" : "31";
    return `\x1b[${color}m${m}\x1b[39m`;
  });
}

/* ---- theming (JSON, shareable) ---- */
const TERM_THEME = {
  background: "#2b2b2b", foreground: "#e6e1dc",
  cursor: "#ffffff", selectionBackground: "#44705a",
  black: "#2b2b2b", red: "#e5534b", green: "#4cc38a", yellow: "#e2b93d",
  blue: "#3fa9f5", magenta: "#c678dd", cyan: "#56b6c2", white: "#e6e1dc",
  brightBlack: "#6b6b70", brightRed: "#ff6f66", brightGreen: "#6fe0a8",
  brightYellow: "#ffd75f", brightBlue: "#6fc3ff", brightMagenta: "#db94ff",
  brightCyan: "#7ee7f2", brightWhite: "#ffffff",
};

const DEFAULT_UI = {
  bg: "#1c1c1e", bg2: "#242426", bg3: "#2b2b2d", panel: "#202022",
  border: "#38383b", fg: "#e6e1dc", muted: "#8a8a90",
  accent: "#4cc38a", accent2: "#3fa9f5", danger: "#e5534b",
};
let ACTIVE_TERM_THEME = { ...TERM_THEME };
let GRAPH_COLORS = { cpu: "#4cc38a", rx: "#4cc38a", tx: "#3fa9f5" };

function applyTheme(theme, save = true) {
  const ui = { ...DEFAULT_UI, ...(theme.ui || {}) };
  for (const [k, v] of Object.entries(ui))
    document.documentElement.style.setProperty("--" + k, v);
  ACTIVE_TERM_THEME = { ...TERM_THEME, ...(theme.terminal || {}) };
  GRAPH_COLORS = { cpu: ui.accent, rx: ui.accent, tx: ui.accent2 };
  for (const tab of TABS.values()) for (const t of (tab.terms || [])) t.term.options.theme = ACTIVE_TERM_THEME;
  if (save) localStorage.setItem("sshdeck.theme", JSON.stringify(theme));
}
function currentTheme() {
  try { return JSON.parse(localStorage.getItem("sshdeck.theme")) || { ui: {}, terminal: {} }; }
  catch (e) { return { ui: {}, terminal: {} }; }
}
try { applyTheme(currentTheme(), false); } catch (e) {}

/* FLIP helper: mutate DOM order, then animate every child from its old spot */
function flipMove(container, mutate) {
  const before = new Map([...container.children].map(el => [el, el.getBoundingClientRect().left]));
  mutate();
  for (const el of container.children) {
    const old = before.get(el);
    if (old === undefined) continue;
    const dx = old - el.getBoundingClientRect().left;
    if (!dx) continue;
    el.style.transition = "none";
    el.style.transform = `translateX(${dx}px)`;
    requestAnimationFrame(() => {
      el.style.transition = "transform .18s cubic-bezier(.2,.8,.3,1)";
      el.style.transform = "";
    });
  }
}

let dragTabEl = null;
{
  const bar = $("#tabbar");
  bar.addEventListener("dragover", ev => {
    if (!dragTabEl) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    // find the tab whose midpoint the cursor is left of — that's the insert target
    const target = [...bar.children].filter(c => c !== dragTabEl)
      .find(c => ev.clientX < c.getBoundingClientRect().left + c.offsetWidth / 2) || null;
    const already = target ? dragTabEl.nextSibling === target
                           : bar.lastElementChild === dragTabEl;
    if (already) return;
    flipMove(bar, () => bar.insertBefore(dragTabEl, target));
  });
  bar.addEventListener("drop", ev => ev.preventDefault());
}

function openTerminal(host) {
  showView("terms");
  const id = "t" + (++tabSeq);
  $("#term-empty").classList.add("hidden");

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.innerHTML = `<span class="tlabel">${esc(host.label)}</span><button class="x" title="close">✕</button>`;
  tabEl.onclick = e => {
    if (e.target.classList.contains("x")) { closeTab(id); return; }
    activateTab(id);
  };
  // middle-click closes the tab, browser-style
  tabEl.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });
  tabEl.addEventListener("auxclick", e => {
    if (e.button === 1) { e.preventDefault(); closeTab(id); }
  });
  // drag to reorder — the tab goes translucent and the row re-flows live as a preview
  tabEl.draggable = true;
  tabEl.addEventListener("dragstart", ev => {
    dragTabEl = tabEl;
    ev.dataTransfer.setData("application/x-sshdeck-tab", id);
    ev.dataTransfer.effectAllowed = "move";
    setTimeout(() => tabEl.classList.add("dragging"), 0);
  });
  tabEl.addEventListener("dragend", () => {
    tabEl.classList.remove("dragging");
    dragTabEl = null;
  });
  $("#tabbar").appendChild(tabEl);

  const pane = document.createElement("div");
  pane.className = "pane";
  const root = document.createElement("div");
  root.className = "split root";
  root.style.flexDirection = "row";
  pane.appendChild(root);
  $("#panes").appendChild(pane);

  const tab = { id, tabEl, el: pane, root, terms: [], focused: null, broadcast: false };
  TABS.set(id, tab);

  const inst = createInst(tab, host);
  root.appendChild(inst.wrapEl);
  tab.terms.push(inst);
  activateTab(id);
}

/* one terminal instance (a split) inside a tab */
function createInst(tab, host) {
  const wrapEl = document.createElement("div");
  wrapEl.className = "tsplit";
  wrapEl.innerHTML = `<div class="term-el"></div>`;
  const termEl = wrapEl.querySelector(".term-el");

  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, monospace',
    fontSize: FONT_SIZE, theme: ACTIVE_TERM_THEME,
    cursorStyle: "bar", cursorBlink: false,   // blink off — CSS "phase" pulse instead
    scrollback: SCROLLBACK, allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(termEl);

  const inst = { host, term, fit, wrapEl, ws: null, statsWs: null, stats: null,
                 cpuHist: [], netHist: [], dead: false, sendResize: null };

  // VS Code-style zoom: Ctrl+scroll / Ctrl+= / Ctrl+-
  termEl.addEventListener("wheel", ev => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    setFontSize(FONT_SIZE + (ev.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  term.attachCustomKeyEventHandler(ev => {
    if (ev.ctrlKey && ev.type === "keydown" && ["=", "+", "-"].includes(ev.key)) {
      setFontSize(FONT_SIZE + (ev.key === "-" ? -1 : 1));
      return false;
    }
    // Ctrl+Shift+C / Ctrl+Shift+V — explicit copy/paste (right-click menu stays untouched)
    if (ev.ctrlKey && ev.shiftKey && ev.type === "keydown") {
      if (ev.code === "KeyC") {
        ev.preventDefault();
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (ev.code === "KeyV") {
        ev.preventDefault();
        pasteClipboard();
        return false;
      }
    }
    return true;
  });

  // Moba/PuTTY style: selecting text copies it immediately
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard.writeText(sel).catch(() => {});
  });

  // middle mouse button pastes
  function pasteClipboard() {
    navigator.clipboard.readText().then(text => {
      if (text) sendInput(tab, inst, text);
    }).catch(() => {});
  }
  termEl.addEventListener("mousedown", ev => { if (ev.button === 1) ev.preventDefault(); });
  termEl.addEventListener("auxclick", ev => {
    if (ev.button === 1) { ev.preventDefault(); pasteClipboard(); }
  });
  wrapEl.addEventListener("mousedown", () => focusInst(tab, inst));

  function connectTerm() {
    const decoder = new TextDecoder();
    const ws = new WebSocket(wsProto + location.host + "/ws/term/" + host.id);
    inst.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onmessage = ev => {
      let s = decoder.decode(ev.data, { stream: true });
      // highlight only on the normal buffer — full-screen apps (nano/vim/htop) untouched
      if (HL_ON && term.buffer.active.type === "normal") s = hlApply(s);
      term.write(s);
    };
    ws.onopen = () => { inst.dead = false; updateStatusConn(); sendResize(); };
    ws.onclose = () => {
      if (inst.disposed) return;
      inst.dead = true;
      term.write("\r\n\x1b[1;33m— disconnected — press Enter to reconnect —\x1b[0m\r\n");
      updateStatusConn();
    };
  }

  function connectStats() {
    const statsWs = new WebSocket(wsProto + location.host + "/ws/stats/" + host.id);
    inst.statsWs = statsWs;
    statsWs.onmessage = ev => {
      inst.stats = JSON.parse(ev.data);
      if (!inst.stats.error) {
        inst.cpuHist.push(inst.stats.cpu);
        if (inst.cpuHist.length > 120) inst.cpuHist.shift();   // 120 × 0.5s = last 60s
        inst.netHist.push({ rx: inst.stats.rx_rate, tx: inst.stats.tx_rate });
        if (inst.netHist.length > 120) inst.netHist.shift();
      }
      if (activeTab === tab.id && tab.focused === inst) renderStats(inst);
    };
  }

  // dead terminal + Enter = reconnect in place, scrollback intact
  term.onData(d => {
    if (inst.dead) {
      if (d.includes("\r")) {
        term.write("\x1b[36m… reconnecting …\x1b[0m\r\n");
        connectTerm();
        if (!inst.statsWs || inst.statsWs.readyState > 1) connectStats();
      }
      return;
    }
    sendInput(tab, inst, d);
  });

  function sendResize() {
    try { fit.fit(); } catch (e) {}
    if (inst.ws && inst.ws.readyState === 1)
      inst.ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
  }
  inst.sendResize = sendResize;
  const ro = new ResizeObserver(() => { if (tab.el.classList.contains("active")) sendResize(); });
  ro.observe(wrapEl);

  connectTerm();
  connectStats();
  return inst;
}

function sendInput(tab, inst, d) {
  if (inst.ws.readyState === 1) inst.ws.send(JSON.stringify({ t: "i", d }));
}

function focusInst(tab, inst) {
  if (!inst) return;
  tab.focused = inst;
  if (activeTab === tab.id) {
    $("#statusbar").classList.remove("hidden");
    $("#st-label").textContent = inst.host.label;
    $("#st-addr").textContent = ` · ${inst.host.hostname}:${inst.host.port}`;
    renderStats(inst);
    updateStatusConn();
  }
}

function disposeInst(inst) {
  inst.disposed = true;
  try { inst.ws.close(); } catch (e) {}
  try { inst.statsWs.close(); } catch (e) {}
  try { inst.term.dispose(); } catch (e) {}
}

function activateTab(id) {
  activeTab = id;
  for (const [tid, t] of TABS) {
    t.el.classList.toggle("active", tid === id);
    t.tabEl.classList.toggle("active", tid === id);
  }
  const tab = TABS.get(id);
  if (tab) {
    $("#statusbar").classList.remove("hidden");
    focusInst(tab, tab.focused || tab.terms[0]);
    setTimeout(() => {
      tab.terms.forEach(t => t.sendResize());
      (tab.focused || tab.terms[0]).term.focus();
    }, 10);
  }
}

function closeTab(id) {
  const tab = TABS.get(id);
  if (!tab) return;
  tab.terms.forEach(disposeInst);
  tab.el.remove();
  tab.tabEl.remove();
  TABS.delete(id);
  if (activeTab === id) {
    const last = [...TABS.keys()].pop();
    if (last) activateTab(last);
    else { activeTab = null; $("#statusbar").classList.add("hidden"); $("#term-empty").classList.remove("hidden"); }
  }
}

function fitActive() {
  const tab = TABS.get(activeTab);
  if (tab) tab.terms.forEach(t => t.sendResize());
}

function setFontSize(size) {
  FONT_SIZE = Math.min(28, Math.max(7, size));
  localStorage.setItem("sshdeck.fontsize", FONT_SIZE);
  for (const tab of TABS.values())
    for (const t of tab.terms) {
      t.term.options.fontSize = FONT_SIZE;
      t.sendResize();
    }
}
window.addEventListener("resize", fitActive);

function drawCpuGraph(hist) {
  const c = $("#st-cpugraph");
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const N = 120;
  const data = hist.slice(-N);
  if (data.length < 2) return;
  const step = c.width / (N - 1);
  const x0 = c.width - (data.length - 1) * step;   // right-aligned, scrolls left
  const y = v => c.height - 1 - Math.min(100, v) / 100 * (c.height - 2);
  ctx.beginPath();
  data.forEach((v, i) => i ? ctx.lineTo(x0 + i * step, y(v)) : ctx.moveTo(x0, y(v)));
  ctx.strokeStyle = GRAPH_COLORS.cpu;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.lineTo(x0 + (data.length - 1) * step, c.height);
  ctx.lineTo(x0, c.height);
  ctx.closePath();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = GRAPH_COLORS.cpu;
  ctx.fill();
  ctx.globalAlpha = 1;
}

function drawNetGraph(hist) {
  const c = $("#st-netgraph");
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const N = 120;
  const data = hist.slice(-N);
  if (data.length < 2) return;
  // autoscale to the window's peak, floor 10 kB/s so idle noise doesn't look wild
  const max = Math.max(10240, ...data.map(d => Math.max(d.rx, d.tx)));
  const step = c.width / (N - 1);
  const x0 = c.width - (data.length - 1) * step;
  const y = v => c.height - 1 - Math.min(v, max) / max * (c.height - 2);
  const line = (key, color) => {
    ctx.beginPath();
    data.forEach((d, i) => i ? ctx.lineTo(x0 + i * step, y(d[key])) : ctx.moveTo(x0, y(d[key])));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  };
  line("rx", GRAPH_COLORS.rx);   // download
  line("tx", GRAPH_COLORS.tx);   // upload
}

function meterSet(el, pct) {
  el.style.width = Math.min(100, pct) + "%";
  el.className = pct > 90 ? "crit" : pct > 70 ? "warn" : "";
}

function renderStats(t) {
  const s = t.stats;
  if (!s || s.error) {
    $("#st-cpu").textContent = $("#st-mem").textContent = $("#st-disk").textContent = "–";
    drawCpuGraph(t.cpuHist || []);
    drawNetGraph(t.netHist || []);
    return;
  }
  $("#st-cpu").textContent = s.cpu.toFixed(1) + "%";
  drawCpuGraph(t.cpuHist);
  const memPct = s.mem_total ? s.mem_used / s.mem_total * 100 : 0;
  $("#st-mem").textContent =
    (s.mem_used / 1073741824).toFixed(2) + " / " + (s.mem_total / 1073741824).toFixed(2) + " GB";
  meterSet($("#st-membar"), memPct);
  $("#st-disk").textContent = s.disk_pct + "%";
  meterSet($("#st-diskbar"), s.disk_pct);
  $("#st-tx").textContent = "↑" + fmtRate(s.tx_rate);
  $("#st-rx").textContent = "↓" + fmtRate(s.rx_rate);
  drawNetGraph(t.netHist);
  $("#st-up").textContent = fmtUptime(s.uptime);
  // per-user session counts: "ismail×2 devops" + hover detail like Moba
  const counts = {};
  for (const line of s.who || []) {
    const u = line.split(" ")[0];
    counts[u] = (counts[u] || 0) + 1;
  }
  // cap the inline list so 10+ distinct users can't blow up the bar — full detail on hover
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([u, n]) => n > 1 ? `${u}×${n}` : u);
  const shown = parts.slice(0, 3);
  if (parts.length > 3) shown.push(`+${parts.length - 3} more`);
  $("#st-users").textContent = parts.length ? `${s.users} · ${shown.join(" ")}` : "0";
  $("#who-pop").innerHTML = (s.who || []).map(l => `<div>${esc(l)}</div>`).join("") ||
    '<div class="muted">no sessions</div>';
}

function updateStatusConn() {
  const tab = TABS.get(activeTab);
  const inst = tab && (tab.focused || tab.terms[0]);
  if (!inst) return;
  const dead = inst.dead;
  $("#st-conn").textContent = dead ? "disconnected" : "connected";
  $("#st-conn").classList.toggle("err", dead);
  $(".st-host").classList.toggle("err", dead);
}

// drag a host from the sidebar onto the terminal area → open it
{
  const panesEl = $("#panes");
  panesEl.addEventListener("dragover", ev => {
    if (ev.dataTransfer.types.includes(HOST_DND)) ev.preventDefault();
  });
  panesEl.addEventListener("drop", ev => {
    const hid = parseInt(ev.dataTransfer.getData(HOST_DND));
    const host = STATE.hosts.find(h => h.id === hid);
    if (!host) return;
    ev.preventDefault();
    openTerminal(host);
  });
}

/* ================= host modal ================= */

let editingHost = null;

function openHostModal(host) {
  editingHost = host || null;
  $("#hm-title").textContent = host ? "Edit host" : "Add host";
  $("#hm-delete").classList.toggle("hidden", !host);
  const fsel = $("#hm-folder");
  fsel.innerHTML = '<option value="">(no folder)</option>' + folderOptions();
  const ksel = $("#hm-key");
  ksel.innerHTML = STATE.keys.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join("") ||
    '<option value="">(no keys saved)</option>';
  const isel = $("#hm-ident");
  isel.innerHTML = STATE.identities.map(i =>
    `<option value="${i.id}">${esc(i.name)} (${esc(i.username)})</option>`).join("") ||
    '<option value="">(no identities saved)</option>';
  delete $("#hm-user").dataset.own;
  $("#hm-label").value = host ? host.label : "";
  $("#hm-host").value = host ? host.hostname : "";
  $("#hm-port").value = host ? host.port : 22;
  $("#hm-user").value = host ? host.username : "";
  $("#hm-auth").value = host ? host.auth_type : "password";
  $("#hm-pw").value = "";
  $("#hm-pw").placeholder = host && host.has_password ? "(unchanged)" : "";
  fsel.value = host && host.folder_id ? host.folder_id : "";
  if (host && host.key_id) ksel.value = host.key_id;
  if (host && host.identity_id) isel.value = host.identity_id;
  authTypeChanged();
  $("#modal-bg").classList.remove("hidden");
  $("#hm-label").focus();
}

function syncIdentUser() {
  const u = $("#hm-user");
  if ($("#hm-auth").value === "identity") {
    if (u.dataset.own === undefined) u.dataset.own = u.value;  // stash what they typed
    const ident = STATE.identities.find(i => i.id === parseInt($("#hm-ident").value));
    u.value = ident ? ident.username : "";
  } else if (u.dataset.own !== undefined) {
    u.value = u.dataset.own;                                    // restore on switch back
    delete u.dataset.own;
  }
}

function authTypeChanged() {
  const mode = $("#hm-auth").value;
  $("#hm-pw-wrap").classList.toggle("hidden", mode !== "password");
  $("#hm-key-wrap").classList.toggle("hidden", mode !== "key");
  $("#hm-ident-wrap").classList.toggle("hidden", mode !== "identity");
  // identity carries its own username — mirror it into the field so it's never stale
  $("#hm-user").disabled = mode === "identity";
  $("#hm-user").placeholder = mode === "identity" ? "(from identity)" : "devops";
  syncIdentUser();
}
$("#hm-auth").onchange = authTypeChanged;
$("#hm-ident").onchange = syncIdentUser;
$("#hm-cancel").onclick = () => $("#modal-bg").classList.add("hidden");
$("#modal-bg").addEventListener("mousedown", e => {
  if (e.target.id === "modal-bg") $("#modal-bg").classList.add("hidden");
});

$("#hm-save").onclick = async () => {
  const mode = $("#hm-auth").value;
  const body = {
    label: $("#hm-label").value, hostname: $("#hm-host").value,
    port: parseInt($("#hm-port").value) || 22, username: $("#hm-user").value,
    auth_type: mode,
    password: $("#hm-pw").value || null,
    key_id: mode === "key" ? parseInt($("#hm-key").value) || null : null,
    identity_id: mode === "identity" ? parseInt($("#hm-ident").value) || null : null,
    folder_id: parseInt($("#hm-folder").value) || null,
  };
  if (!body.hostname) { alert("Hostname is required"); return; }
  if (mode === "identity" && !body.identity_id) { alert("Pick an identity (create one in the Keys tab)"); return; }
  if (mode !== "identity" && !body.username) { alert("Username is required"); return; }
  try {
    if (editingHost) await api(`/api/hosts/${editingHost.id}`, { method: "PUT", json: body });
    else await api("/api/hosts", { json: body });
    $("#modal-bg").classList.add("hidden");
    loadState();
  } catch (e) { alert(e.message); }
};

$("#hm-delete").onclick = async () => {
  if (!editingHost) return;
  if (!confirm(`Delete host "${editingHost.label}"?`)) return;
  await api(`/api/hosts/${editingHost.id}`, { method: "DELETE" });
  $("#modal-bg").classList.add("hidden");
  loadState();
};

$("#add-host").onclick = () => openHostModal(null);
$("#add-folder").onclick = async () => {
  const name = prompt("Folder name (root level — right-click a folder to add a sub-folder):");
  if (name && name.trim()) { await api("/api/folders", { json: { name, parent_id: null } }); loadState(); }
};

/* ================= tunnels (port forwarding) ================= */

async function loadTunnels() {
  const hsel = $("#tun-host");
  hsel.innerHTML = STATE.hosts.map(h => `<option value="${h.id}">${esc(h.label)}</option>`).join("");
  let r;
  try { r = await api("/api/tunnels"); } catch (e) { return; }
  const el = $("#tunlist");
  el.innerHTML = r.tunnels.length ? "" : '<p class="muted">No tunnels yet.</p>';
  for (const t of r.tunnels) {
    const item = document.createElement("div");
    item.className = "key-item";
    item.innerHTML =
      `<span class="tdot ${t.active ? "on" : ""}"></span>` +
      `<span class="kname">${esc(t.name)}</span>` +
      `<span class="muted">:${t.listen_port} → ${esc(t.dest_host)}:${t.dest_port} via ${esc(t.host_label)}</span>` +
      `<button class="btn-${t.active ? "danger" : "primary"} small tgl">${t.active ? "Stop" : "Start"}</button>` +
      `<button class="btn-ghost small del">Delete</button>`;
    item.querySelector(".tgl").onclick = async () => {
      try {
        await api(`/api/tunnels/${t.id}/${t.active ? "stop" : "start"}`, { method: "POST" });
        loadTunnels();
      } catch (e) { alert(e.message); }
    };
    item.querySelector(".del").onclick = async () => {
      if (!confirm(`Delete tunnel "${t.name}"?`)) return;
      await api(`/api/tunnels/${t.id}`, { method: "DELETE" });
      loadTunnels();
    };
    el.appendChild(item);
  }
}

$("#tun-add").onclick = async () => {
  const body = {
    name: $("#tun-name").value.trim(),
    host_id: parseInt($("#tun-host").value),
    listen_port: parseInt($("#tun-lport").value),
    dest_host: $("#tun-dhost").value.trim() || "localhost",
    dest_port: parseInt($("#tun-dport").value),
  };
  if (!body.host_id || !body.listen_port || !body.dest_port) {
    alert("SSH host, listen port and destination port are required");
    return;
  }
  try {
    await api("/api/tunnels", { json: body });
    $("#tun-name").value = $("#tun-lport").value = $("#tun-dport").value = "";
    loadTunnels();
  } catch (e) { alert(e.message); }
};

/* ================= identities & keys ================= */

function renderIdentities() {
  const el = $("#identlist");
  el.innerHTML = STATE.identities.length ? "" : '<p class="muted">No identities yet.</p>';
  for (const i of STATE.identities) {
    const item = document.createElement("div");
    item.className = "key-item";
    item.innerHTML = `<span class="kname">👤 ${esc(i.name)}</span>` +
      `<span class="muted">${esc(i.username)} / ••••••</span>` +
      `<button class="btn-ghost small upd">Change password</button>` +
      `<button class="btn-danger small del">Delete</button>`;
    item.querySelector(".upd").onclick = async () => {
      const pw = prompt(`New password for "${i.name}" (${i.username}):`);
      if (!pw) return;
      try {
        await api(`/api/identities/${i.id}`,
          { method: "PUT", json: { name: i.name, username: i.username, password: pw } });
        alert("Updated");
      } catch (e) { alert(e.message); }
    };
    item.querySelector(".del").onclick = async () => {
      if (!confirm(`Delete identity "${i.name}"?`)) return;
      try { await api(`/api/identities/${i.id}`, { method: "DELETE" }); loadState(); }
      catch (e) { alert(e.message); }
    };
    el.appendChild(item);
  }
}

$("#ident-add").onclick = async () => {
  const name = $("#ident-name").value.trim(), username = $("#ident-user").value.trim(),
        password = $("#ident-pass").value;
  if (!name || !username || !password) { alert("Name, username and password required"); return; }
  try {
    await api("/api/identities", { json: { name, username, password } });
    $("#ident-name").value = $("#ident-user").value = $("#ident-pass").value = "";
    loadState();
  } catch (e) { alert(e.message); }
};

function renderKeys() {
  const el = $("#keylist");
  el.innerHTML = STATE.keys.length ? "" : '<p class="muted">No keys yet.</p>';
  for (const k of STATE.keys) {
    const item = document.createElement("div");
    item.className = "key-item";
    item.innerHTML = `<span class="kname">🔑 ${esc(k.name)}</span><button class="btn-danger small">Delete</button>`;
    item.querySelector("button").onclick = async () => {
      if (!confirm(`Delete key "${k.name}"?`)) return;
      try { await api(`/api/keys/${k.id}`, { method: "DELETE" }); loadState(); }
      catch (e) { alert(e.message); }
    };
    el.appendChild(item);
  }
}

$("#key-add").onclick = async () => {
  const name = $("#key-name").value.trim(), priv = $("#key-priv").value.trim();
  if (!name || !priv) { alert("Name and private key required"); return; }
  await api("/api/keys", { json: { name, private_key: priv, passphrase: $("#key-pass").value || null } });
  $("#key-name").value = $("#key-priv").value = $("#key-pass").value = "";
  loadState();
};

/* ================= settings: import/export ================= */

$("#moba-import").onclick = async () => {
  const f = $("#moba-file").files[0];
  if (!f) { alert("Choose a .mobaconf file first"); return; }
  const fd = new FormData();
  fd.append("file", f);
  $("#moba-result").textContent = "importing…";
  try {
    const r = await api("/api/import/mobaconf", { method: "POST", body: fd });
    $("#moba-result").textContent = `Imported ${r.imported}, skipped ${r.skipped} duplicates.`;
    loadState();
  } catch (e) { $("#moba-result").textContent = "Failed: " + e.message; }
};

/* ================= files ================= */

const PANES = [
  { hostId: null, path: ".", entries: [], selIdx: new Set(), anchor: null },
  { hostId: null, path: ".", entries: [], selIdx: new Set(), anchor: null },
];

function renderPaneHostOptions() {
  $$(".fpane").forEach((paneEl, i) => {
    if (!paneEl.dataset.built) buildPane(paneEl, i);
    const P = PANES[i];
    const dl = paneEl.querySelector("datalist");
    P.optMap = {};
    // don't repeat the username if the label already carries it (moba imports do)
    dl.innerHTML = STATE.hosts.map(h => {
      const ident = h.identity_id ? STATE.identities.find(x => x.id === h.identity_id) : null;
      const u = h.auth_type === "identity" && ident ? ident.username : h.username;
      let text = h.label.includes(u) && u ? h.label : `${h.label} (${u})`;
      if (P.optMap[text]) text += ` #${h.id}`;
      P.optMap[text] = h.id;
      return `<option value="${esc(text)}">`;
    }).join("");
  });
}

function buildPane(paneEl, i) {
  paneEl.dataset.built = "1";
  paneEl.innerHTML = `
    <div class="fp-head">
      <input class="hostsel" list="hostlist${i}" placeholder="🔍 search host…" spellcheck="false" autocomplete="off">
      <datalist id="hostlist${i}"></datalist>
      <input class="path" value="." spellcheck="false" title="path — press Enter">
      <button class="btn-ghost small go" title="Go / refresh">⟳</button>
      <button class="btn-ghost small disc" title="Release SSH session for this host">⏻</button>
    </div>
    <div class="fp-tools">
      <button class="up">⬆ up</button>
      <button class="upload">Upload</button>
      <button class="mkdir">+ dir</button>
      <button class="rename">Rename</button>
      <button class="chmod">chmod</button>
      <button class="del">Delete</button>
      <button class="dl">Download</button>
      <input type="file" class="upfile hidden" multiple>
    </div>
    <div class="fp-list"><div class="fp-empty">Select a host to browse.</div></div>`;

  const P = PANES[i];
  const sel = paneEl.querySelector(".hostsel");
  const pathInput = paneEl.querySelector(".path");
  const listEl = paneEl.querySelector(".fp-list");

  function pickHost() {
    const id = P.optMap && P.optMap[sel.value];
    if (id) {
      P.hostId = id;
      P.path = ".";
      sel.title = sel.value;   // full name on hover even if the field is narrow
      load(".");
      sel.blur();
    }
  }
  sel.addEventListener("change", pickHost);
  sel.addEventListener("input", pickHost);
  sel.addEventListener("focus", () => sel.select());   // retype/search instantly

  async function load(path) {
    if (!P.hostId) return;
    listEl.innerHTML = '<div class="fp-empty">loading…</div>';
    try {
      const r = await api(`/api/sftp/${P.hostId}/list?path=${encodeURIComponent(path ?? P.path)}`);
      P.path = r.path;
      P.entries = r.entries.sort((a, b) => (b.is_dir - a.is_dir) || natCompare(a.name, b.name));
      P.selIdx = new Set();
      P.anchor = null;
      pathInput.value = r.path;
      renderList();
    } catch (e) {
      listEl.innerHTML = `<div class="fp-empty">✗ ${esc(e.message)}</div>`;
    }
  }
  P.load = load;

  function renderList() {
    if (!P.entries.length) { listEl.innerHTML = '<div class="fp-empty">(empty directory)</div>'; return; }
    const rows = P.entries.map((e, idx) => `
      <tr class="fp-row ${e.is_dir ? "dir" : ""}" draggable="true" data-i="${idx}">
        <td class="fname"><span class="ficon">${e.is_dir ? "📁" : "📄"}</span>${esc(e.name)}</td>
        <td class="fsize">${e.is_dir ? "" : fmtBytes(e.size)}</td>
        <td class="fperm">${e.perm}</td>
        <td class="fdate">${fmtDate(e.mtime)}</td>
      </tr>`).join("");
    listEl.innerHTML = `<table class="fp-table">
      <thead><tr><th>Name</th><th>Size</th><th>Perm</th><th>Modified</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    const syncSel = () => {
      listEl.querySelectorAll(".fp-row").forEach(r =>
        r.classList.toggle("sel", P.selIdx.has(+r.dataset.i)));
    };
    listEl.querySelectorAll(".fp-row").forEach(row => {
      const idx = +row.dataset.i;
      const entry = P.entries[idx];
      row.onclick = ev => {
        if (ev.ctrlKey || ev.metaKey) {
          P.selIdx.has(idx) ? P.selIdx.delete(idx) : P.selIdx.add(idx);
          P.anchor = idx;
        } else if (ev.shiftKey && P.anchor !== null) {
          P.selIdx = new Set();
          const [a, b] = [Math.min(P.anchor, idx), Math.max(P.anchor, idx)];
          for (let k = a; k <= b; k++) P.selIdx.add(k);
        } else {
          P.selIdx = new Set([idx]);
          P.anchor = idx;
        }
        syncSel();
      };
      row.ondblclick = () => {
        if (entry.is_dir) load(joinPath(P.path, entry.name));
        else window.open(`/api/sftp/${P.hostId}/download?path=${encodeURIComponent(joinPath(P.path, entry.name))}`);
      };
      row.ondragstart = ev => {
        // dragging an unselected row selects just it; otherwise drag the whole selection
        if (!P.selIdx.has(idx)) { P.selIdx = new Set([idx]); P.anchor = idx; syncSel(); }
        const items = selected().map(e =>
          ({ path: joinPath(P.path, e.name), is_dir: e.is_dir, name: e.name }));
        ev.dataTransfer.setData("application/x-sshdeck",
          JSON.stringify({ pane: i, hostId: P.hostId, items }));
        ev.dataTransfer.effectAllowed = "copy";
      };
    });
  }

  const selected = () => [...P.selIdx].sort((a, b) => a - b).map(k => P.entries[k]).filter(Boolean);

  pathInput.addEventListener("keydown", e => { if (e.key === "Enter") load(pathInput.value); });
  paneEl.querySelector(".go").onclick = () => load(pathInput.value);
  paneEl.querySelector(".disc").onclick = async () => {
    if (!P.hostId) return;
    try { await api(`/api/hosts/${P.hostId}/disconnect`, { method: "POST" }); } catch (e) {}
    sel.value = "";
    P.hostId = null;
    P.entries = [];
    P.selIdx = new Set();
    listEl.innerHTML = '<div class="fp-empty">File session released. Terminals untouched. Select a host to browse.</div>';
  };
  paneEl.querySelector(".up").onclick = () => load(parentPath(P.path));

  const upfile = paneEl.querySelector(".upfile");
  paneEl.querySelector(".upload").onclick = () => { if (P.hostId) upfile.click(); };
  upfile.onchange = async () => {
    for (const f of upfile.files) {
      const fd = new FormData();
      fd.append("path", P.path);
      fd.append("file", f);
      try { await api(`/api/sftp/${P.hostId}/upload`, { method: "POST", body: fd }); }
      catch (e) { alert(`Upload ${f.name} failed: ${e.message}`); }
    }
    upfile.value = "";
    load();
  };

  paneEl.querySelector(".mkdir").onclick = async () => {
    if (!P.hostId) return;
    const name = prompt("New directory name:");
    if (!name) return;
    try { await api(`/api/sftp/${P.hostId}/mkdir`, { json: { path: joinPath(P.path, name) } }); load(); }
    catch (e) { alert(e.message); }
  };
  paneEl.querySelector(".rename").onclick = async () => {
    const sel = selected();
    if (sel.length !== 1) return alert("Select exactly one item to rename");
    const name = prompt("Rename to:", sel[0].name);
    if (!name || name === sel[0].name) return;
    try {
      await api(`/api/sftp/${P.hostId}/rename`,
        { json: { path: joinPath(P.path, sel[0].name), new_path: joinPath(P.path, name) } });
      load();
    } catch (e) { alert(e.message); }
  };
  paneEl.querySelector(".chmod").onclick = async () => {
    const sel = selected();
    if (!sel.length) return alert("Select file(s) first");
    const label = sel.length === 1 ? sel[0].name : sel.length + " items";
    const mode = prompt(`chmod ${label} (octal):`, "644");
    if (!mode) return;
    try {
      for (const e of sel)
        await api(`/api/sftp/${P.hostId}/chmod`, { json: { path: joinPath(P.path, e.name), mode } });
      load();
    } catch (e) { alert(e.message); }
  };
  paneEl.querySelector(".del").onclick = async () => {
    const sel = selected();
    if (!sel.length) return alert("Select file(s) first");
    const label = sel.length === 1
      ? `${sel[0].is_dir ? "directory" : "file"} "${sel[0].name}"` : `${sel.length} items`;
    if (!confirm(`Delete ${label}?`)) return;
    try {
      for (const e of sel)
        await api(`/api/sftp/${P.hostId}/delete`,
          { json: { path: joinPath(P.path, e.name), is_dir: e.is_dir } });
      load();
    } catch (e) { alert(e.message); }
  };
  paneEl.querySelector(".dl").onclick = () => {
    const sel = selected().filter(e => !e.is_dir);
    if (!sel.length) return alert("Select file(s) first (directories: drag to the other pane instead)");
    sel.forEach((e, k) => setTimeout(() => {
      const a = document.createElement("a");
      a.href = `/api/sftp/${P.hostId}/download?path=${encodeURIComponent(joinPath(P.path, e.name))}`;
      a.download = e.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, k * 400));
  };

  // drag & drop target: host-to-host transfer, or upload from local machine
  paneEl.addEventListener("dragover", ev => {
    ev.preventDefault();
    paneEl.classList.add("dragover");
    ev.dataTransfer.dropEffect = "copy";
  });
  paneEl.addEventListener("dragleave", ev => {
    if (!paneEl.contains(ev.relatedTarget)) paneEl.classList.remove("dragover");
  });
  paneEl.addEventListener("drop", async ev => {
    ev.preventDefault();
    paneEl.classList.remove("dragover");
    if (!P.hostId) return;
    const raw = ev.dataTransfer.getData("application/x-sshdeck");
    if (raw) {
      const d = JSON.parse(raw);
      if (d.pane === i && d.hostId === P.hostId) return; // same pane
      try {
        for (const item of d.items)
          await api("/api/transfer", {
            json: { src_host_id: d.hostId, src_path: item.path, dst_host_id: P.hostId,
                    dst_path: P.path, is_dir: item.is_dir },
          });
        pollTransfers(load);
      } catch (e) { alert(e.message); }
      return;
    }
    // local files dropped from OS
    if (ev.dataTransfer.files.length) {
      for (const f of ev.dataTransfer.files) {
        const fd = new FormData();
        fd.append("path", P.path);
        fd.append("file", f);
        try { await api(`/api/sftp/${P.hostId}/upload`, { method: "POST", body: fd }); }
        catch (e) { alert(`Upload ${f.name} failed: ${e.message}`); }
      }
      load();
    }
  });
}

function joinPath(dir, name) { return dir.replace(/\/+$/, "") + "/" + name; }
function parentPath(p) {
  const parts = p.replace(/\/+$/, "").split("/");
  parts.pop();
  return parts.join("/") || "/";
}

/* transfers */
let trTimer = null;
function pollTransfers(onDone) {
  $("#transfers").classList.remove("hidden");
  if (trTimer) return;
  trTimer = setInterval(async () => {
    let r;
    try { r = await api("/api/transfers"); } catch (e) { return; }
    renderTransfers(r.transfers);
    if (!r.transfers.some(t => t.status === "running")) {
      clearInterval(trTimer);
      trTimer = null;
      if (onDone) onDone();
    }
  }, 800);
}

function renderTransfers(list) {
  const el = $("#tr-list");
  el.innerHTML = "";
  for (const t of list) {
    const item = document.createElement("div");
    item.className = "tr-item " + t.status;
    const pct = t.total ? Math.round(t.done / t.total * 100) : null;
    item.innerHTML = `
      <span class="desc" title="${esc(t.desc)}">${esc(t.desc)}</span>
      <span class="meter"><i style="width:${pct ?? (t.status === "done" ? 100 : 30)}%"></i></span>
      <span class="status">${t.status === "running"
        ? fmtBytes(t.done) + (t.total ? " / " + fmtBytes(t.total) : "")
        : t.status === "error" ? "✗ " + esc(t.error || "failed") : "✓ " + fmtBytes(t.done)}</span>`;
    el.appendChild(item);
  }
  if (!list.length) $("#transfers").classList.add("hidden");
}

$("#tr-clear").onclick = async () => {
  const r = await api("/api/transfers");
  for (const t of r.transfers)
    if (t.status !== "running") await api(`/api/transfers/${t.id}`, { method: "DELETE" });
  renderTransfers((await api("/api/transfers")).transfers);
};

/* ================= settings: highlight toggle, theme, eye buttons ================= */

$("#deck-import").onclick = async () => {
  const f = $("#deck-file").files[0];
  if (!f) { alert("Choose a sshdeck-backup.json first"); return; }
  const fd = new FormData();
  fd.append("file", f);
  $("#deck-result").textContent = "restoring…";
  try {
    const r = await api("/api/import/sshdeck", { method: "POST", body: fd });
    $("#deck-result").textContent =
      `✓ ${r.imported} hosts restored, ${r.skipped} already existed.`;
    loadState();
  } catch (e) { $("#deck-result").textContent = "✗ " + e.message; }
};

$("#hl-toggle").checked = HL_ON;
$("#hl-toggle").onchange = () => {
  HL_ON = $("#hl-toggle").checked;
  localStorage.setItem("sshdeck.hl", HL_ON ? "1" : "0");
};

$("#sb-lines").value = SCROLLBACK;
$("#sb-lines").onchange = () => {
  SCROLLBACK = Math.min(200000, Math.max(1000, parseInt($("#sb-lines").value) || 50000));
  $("#sb-lines").value = SCROLLBACK;
  localStorage.setItem("sshdeck.scrollback", SCROLLBACK);
  for (const tab of TABS.values())
    for (const t of tab.terms) t.term.options.scrollback = SCROLLBACK;
};

$("#theme-apply").onclick = () => {
  try {
    const theme = JSON.parse($("#theme-json").value || "{}");
    applyTheme(theme);
    $("#theme-msg").textContent = "✓ applied" + (theme.name ? `: ${theme.name}` : "");
  } catch (e) {
    $("#theme-msg").textContent = "✗ invalid JSON: " + e.message;
  }
};
$("#theme-current").onclick = () => {
  const t = currentTheme();
  $("#theme-json").value = JSON.stringify(
    { name: t.name || "my-theme", ui: { ...DEFAULT_UI, ...(t.ui || {}) },
      terminal: { ...TERM_THEME, ...(t.terminal || {}) } }, null, 2);
  $("#theme-msg").textContent = "current theme loaded — edit and apply";
};
$("#theme-reset").onclick = () => {
  localStorage.removeItem("sshdeck.theme");
  applyTheme({ ui: {}, terminal: {} }, false);
  $("#theme-json").value = "";
  $("#theme-msg").textContent = "reset to default";
};

// show/hide password inputs (only exists on create/edit forms — saved secrets never come back)
document.addEventListener("click", e => {
  const btn = e.target.closest(".eye");
  if (!btn) return;
  const input = document.getElementById(btn.dataset.for);
  if (!input) return;
  input.type = input.type === "password" ? "text" : "password";
  btn.classList.toggle("on", input.type === "text");
});

/* ================= boot ================= */
loadState().then(() => {
  api("/api/transfers").then(r => { if (r.transfers.length) { renderTransfers(r.transfers); pollTransfers(); } });
});
