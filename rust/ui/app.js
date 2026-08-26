/* SSHDeck desktop — M2: SSH terminals + local terminals + monitoring + themes */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let STATE = { folders: [], hosts: [], identities: [], keys: [] };
const TABS = new Map();
let seq = 0;
let activeTab = null;
let FONT_SIZE = parseInt(localStorage.getItem("deck.fontsize")) || 13;
const HOST_DND = "application/x-deck-host";

/* ---------- themes ---------- */

const PRESETS = {
  zeegly: {
    name: "zeegly",
    ui: { bg: "#1c1c1e", bg2: "#242426", bg3: "#2b2b2d", panel: "#202022", border: "#38383b",
          fg: "#e6e1dc", muted: "#8a8a90", accent: "#4cc38a", accent2: "#3fa9f5", danger: "#e5534b", termbg: "#2b2b2b" },
    terminal: { background: "#2b2b2b", foreground: "#e6e1dc", cursor: "#ffffff", selectionBackground: "#44705a",
      black: "#2b2b2b", red: "#e5534b", green: "#4cc38a", yellow: "#e2b93d", blue: "#3fa9f5",
      magenta: "#c678dd", cyan: "#56b6c2", white: "#e6e1dc", brightBlack: "#6b6b70", brightRed: "#ff6f66",
      brightGreen: "#6fe0a8", brightYellow: "#ffd75f", brightBlue: "#6fc3ff", brightMagenta: "#db94ff",
      brightCyan: "#7ee7f2", brightWhite: "#ffffff" },
  },
  dracula: {
    name: "dracula",
    ui: { bg: "#21222c", bg2: "#282a36", bg3: "#343746", panel: "#1e1f29", border: "#44475a",
          fg: "#f8f8f2", muted: "#6272a4", accent: "#50fa7b", accent2: "#8be9fd", danger: "#ff5555", termbg: "#282a36" },
    terminal: { background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", selectionBackground: "#44475a",
      black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#bd93f9",
      magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2", brightBlack: "#6272a4", brightRed: "#ff6e6e",
      brightGreen: "#69ff94", brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
      brightCyan: "#a4ffff", brightWhite: "#ffffff" },
  },
  nord: {
    name: "nord",
    ui: { bg: "#242933", bg2: "#2e3440", bg3: "#3b4252", panel: "#272c36", border: "#434c5e",
          fg: "#d8dee9", muted: "#7b88a1", accent: "#a3be8c", accent2: "#88c0d0", danger: "#bf616a", termbg: "#2e3440" },
    terminal: { background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", selectionBackground: "#434c5e",
      black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1",
      magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0", brightBlack: "#4c566a", brightRed: "#bf616a",
      brightGreen: "#a3be8c", brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb", brightWhite: "#eceff4" },
  },
  onedark: {
    name: "onedark",
    ui: { bg: "#21252b", bg2: "#282c34", bg3: "#31353f", panel: "#23272e", border: "#3e4451",
          fg: "#abb2bf", muted: "#5c6370", accent: "#98c379", accent2: "#61afef", danger: "#e06c75", termbg: "#282c34" },
    terminal: { background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", selectionBackground: "#3e4451",
      black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#e5c07b", blue: "#61afef",
      magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf", brightBlack: "#5c6370", brightRed: "#e06c75",
      brightGreen: "#98c379", brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
      brightCyan: "#56b6c2", brightWhite: "#ffffff" },
  },
  gruvbox: {
    name: "gruvbox",
    ui: { bg: "#1d2021", bg2: "#282828", bg3: "#3c3836", panel: "#242424", border: "#504945",
          fg: "#ebdbb2", muted: "#928374", accent: "#b8bb26", accent2: "#83a598", danger: "#fb4934", termbg: "#282828" },
    terminal: { background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2", selectionBackground: "#504945",
      black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921", blue: "#458588",
      magenta: "#b16286", cyan: "#689d6a", white: "#a89984", brightBlack: "#928374", brightRed: "#fb4934",
      brightGreen: "#b8bb26", brightYellow: "#fabd2f", brightBlue: "#83a598", brightMagenta: "#d3869b",
      brightCyan: "#8ec07c", brightWhite: "#ebdbb2" },
  },
};

let ACTIVE_THEME = PRESETS.zeegly;
let GRAPH = { cpu: "#4cc38a", tx: "#3fa9f5" };

function applyTheme(theme, save = true) {
  ACTIVE_THEME = { ...PRESETS.zeegly, ...theme,
    ui: { ...PRESETS.zeegly.ui, ...(theme.ui || {}) },
    terminal: { ...PRESETS.zeegly.terminal, ...(theme.terminal || {}) } };
  for (const [k, v] of Object.entries(ACTIVE_THEME.ui))
    document.documentElement.style.setProperty("--" + k, v);
  GRAPH = { cpu: ACTIVE_THEME.ui.accent, tx: ACTIVE_THEME.ui.accent2 };
  document.documentElement.style.setProperty("--cursor", ACTIVE_THEME.terminal.cursor || "#ffffff");
  for (const tab of TABS.values()) for (const i of (tab.insts || [])) i.term.options.theme = ACTIVE_THEME.terminal;
  renderThemeChips();
  if (save) localStorage.setItem("deck.theme", JSON.stringify(theme));
}

function renderThemeChips() {
  const box = $("#theme-presets");
  box.innerHTML = "";
  for (const [key, p] of Object.entries(PRESETS)) {
    const b = document.createElement("button");
    b.className = "theme-chip" + (ACTIVE_THEME.name === p.name ? " on" : "");
    b.innerHTML = `<span class="sw" style="background:${p.ui.accent}"></span>` +
                  `<span class="sw" style="background:${p.ui.termbg}"></span>${key}`;
    b.onclick = () => applyTheme(p);
    box.appendChild(b);
  }
}

$("#theme-apply").onclick = () => {
  try {
    applyTheme(JSON.parse($("#theme-json").value || "{}"));
    $("#theme-msg").textContent = "✓ applied";
  } catch (e) { $("#theme-msg").textContent = "✗ " + e.message; }
};

/* ---------- helpers ---------- */

/* username to display for a host — identity-based hosts carry theirs on the identity */
function hostUser(h) {
  const ident = h.identity_id ? STATE.identities.find(i => i.id === h.identity_id) : null;
  return (h.auth_type === "identity" && ident ? ident.username : h.username) || "";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtRate(n) {
  const mbps = n * 8 / 1e6;
  return mbps >= 1 ? mbps.toFixed(2) + " Mb/s" : (n / 1024).toFixed(1) + " kB/s";
}
/* disk throughput reads in bytes/s — MB/s, unlike the bit-based network rate */
function fmtDiskRate(n) {
  if (!n) return "0 kB/s";
  return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB/s" : (n / 1024).toFixed(0) + " kB/s";
}
function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}
function natKey(s) {
  return String(s).toLowerCase().split(/[\s\-_.]+/).flatMap(p => p.match(/\d+|\D+/g) || []);
}
function natCompare(a, b) {
  const A = natKey(a), B = natKey(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i], y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = parseInt(x) - parseInt(y); if (d) return d; }
    else if (nx !== ny) return nx ? 1 : -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/* small choice dialog: resolves to the clicked button's value (null on cancel) */
function choose(title, message, buttons) {
  return new Promise(resolve => {
    const bg = document.createElement("div");
    bg.id = "choice-bg";
    bg.innerHTML = `<div class="modal choice"><h3>${esc(title)}</h3><p>${message}</p><div class="modal-actions"></div></div>`;
    const acts = bg.querySelector(".modal-actions");
    const done = v => { bg.remove(); resolve(v); };
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = b.cls || "btn-ghost";
      btn.textContent = b.label;
      btn.onclick = () => done(b.value);
      acts.appendChild(btn);
    }
    bg.addEventListener("mousedown", e => { if (e.target === bg) done(null); });
    document.body.appendChild(bg);
  });
}
async function confirmCredDelete(kind, name, id) {
  const hosts = await invoke("cred_usage", { kind, id });
  const n = hosts.length;
  const msg = n
    ? `<b>${n} host${n > 1 ? "s" : ""}</b> use this ${kind}: <span class="muted mono">${hosts.slice(0, 8).map(esc).join(", ")}${n > 8 ? ` … +${n - 8}` : ""}</span><br><br>` +
      `They will switch to <b>password auth with no saved credential</b> — edit them later to set a new one. Hosts are not deleted.`
    : `No hosts use this ${kind}.`;
  return (await choose(`Delete ${kind} "${name}"?`, msg,
    [{ label: "Cancel", value: null }, { label: "Delete", value: "yes", cls: "btn-danger" }])) === "yes";
}

/* context menu */
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

/* ---------- state / sidebar ---------- */

async function loadState() {
  STATE = await invoke("state_get");
  STATE.folders.sort((a, b) => natCompare(a.name, b.name));
  STATE.hosts.sort((a, b) => natCompare(a.label, b.label));
  renderTree();
  renderIdentities();
  renderKeys();
}

const closedFolders = new Set(JSON.parse(localStorage.getItem("deck.closed") || "[]"));

const FOLDER_DND = "application/x-deck-folder";

async function moveHost(hostId, folderId) {
  await invoke("host_move", { id: hostId, folderId });
  loadState();
}
async function moveFolder(folderId, parentId) {
  try { await invoke("folder_move", { id: folderId, parentId }); loadState(); }
  catch (e) { logUi("ui", e); alert(e); }
}
function folderHasMatch(id, match) {
  if (STATE.hosts.some(h => h.folder_id === id && match(h))) return true;
  return STATE.folders.some(f => f.parent_id === id && folderHasMatch(f.id, match));
}
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

function renderTree() {
  const filter = $("#filter").value.trim().toLowerCase();
  const tree = $("#tree");
  tree.innerHTML = "";
  const match = h => !filter || h.label.toLowerCase().includes(filter) ||
    h.hostname.toLowerCase().includes(filter) || h.username.toLowerCase().includes(filter);

  const hostRow = (h, depth) => {
    const shownUser = hostUser(h);
    const he = document.createElement("div");
    he.className = "tree-host";
    he.style.paddingLeft = (22 + depth * 14) + "px";
    he.title = `${shownUser}@${h.hostname}:${h.port}`;
    he.innerHTML = `<span class="hicon">●</span><span class="hlabel">${esc(h.label)}</span>` +
      `<span class="hmeta">${esc(shownUser)}</span>` +
      `<button class="edit-btn" title="Edit">✎</button>`;
    he.onclick = e => {
      if (e.target.classList.contains("edit-btn")) { openHostModal(h); return; }
      openSshTerminal(h);
    };
    he.oncontextmenu = e => ctxMenu(e, [
      { label: "Connect", fn: () => openSshTerminal(h) },
      { label: "Edit", fn: () => openHostModal(h) },
      { label: "Duplicate", fn: async () => {
          const newId = await invoke("host_duplicate", { id: h.id });
          await loadState();
          const copy = STATE.hosts.find(x => x.id === newId);
          if (copy) openHostModal(copy);
        } },
      { label: "Delete", danger: true, fn: async () => {
          if (!confirm(`Delete host "${h.label}"?`)) return;
          await invoke("host_delete", { id: h.id });
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
            await invoke("folder_save", { name: name.trim(), parentId: f.id });
            closedFolders.delete(f.id);
            loadState();
          }
        } },
      { label: "Rename", fn: async () => {
          const name = prompt("Folder name:", f.name);
          if (name && name.trim() && name !== f.name) {
            await invoke("folder_rename", { id: f.id, name: name.trim() });
            loadState();
          }
        } },
      { label: "Move to root", fn: () => moveFolder(f.id, null) },
      { label: "Delete", danger: true, fn: async () => {
          const u = await invoke("folder_usage", { id: f.id });
          const n = u.hosts.length;
          const detail = n
            ? `<b>${n} host${n > 1 ? "s" : ""}</b> inside${u.subfolders ? ` (${u.subfolders} sub-folder${u.subfolders > 1 ? "s" : ""})` : ""}:<br>` +
              `<span class="muted mono">${u.hosts.slice(0, 8).map(esc).join(", ")}${n > 8 ? ` … +${n - 8}` : ""}</span>`
            : `Folder is empty${u.subfolders ? ` (${u.subfolders} empty sub-folder${u.subfolders > 1 ? "s" : ""})` : ""}.`;
          const choice = await choose(`Delete folder "${f.name}"?`, detail, n
            ? [{ label: "Cancel", value: null },
               { label: "Delete folder, keep hosts", value: "keep", cls: "btn-primary" },
               { label: `Delete folder + ${n} host${n > 1 ? "s" : ""}`, value: "all", cls: "btn-danger" }]
            : [{ label: "Cancel", value: null }, { label: "Delete", value: "keep", cls: "btn-danger" }]);
          if (!choice) return;
          await invoke("folder_delete", { id: f.id, deleteHosts: choice === "all" });
          loadState();
        } },
    ]);
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
      localStorage.setItem("deck.closed", JSON.stringify([...closedFolders]));
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

// drop on empty tree space → move host / folder to root
{
  const treeEl = $("#tree");
  treeEl.addEventListener("dragover", ev => {
    const t = ev.dataTransfer.types;
    if (t.includes(HOST_DND) || t.includes(FOLDER_DND)) { ev.preventDefault(); treeEl.classList.add("drop"); }
  });
  treeEl.addEventListener("dragleave", ev => { if (!treeEl.contains(ev.relatedTarget)) treeEl.classList.remove("drop"); });
  treeEl.addEventListener("drop", ev => {
    ev.preventDefault();
    treeEl.classList.remove("drop");
    const hid = parseInt(ev.dataTransfer.getData(HOST_DND));
    const fid = parseInt(ev.dataTransfer.getData(FOLDER_DND));
    if (hid) moveHost(hid, null);
    else if (fid) moveFolder(fid, null);
  });
}

$("#filter").addEventListener("input", renderTree);

/* sidebar resize */
{
  const sb = $("#sidebar"), rz = $("#side-resizer");
  const saved = parseInt(localStorage.getItem("deck.sidew"));
  if (saved) sb.style.width = saved + "px";
  rz.addEventListener("mousedown", e => {
    e.preventDefault();
    document.body.classList.add("resizing");
    const move = ev => { sb.style.width = Math.min(560, Math.max(150, ev.clientX)) + "px"; fitActive(); };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      localStorage.setItem("deck.sidew", parseInt(sb.style.width) || 240);
      fitActive();
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
}

/* ---------- terminals ---------- */

/* ---------- output highlighting (Moba-style, client-side) — parity with web ---------- */
let HL_ON = localStorage.getItem("deck.hl") !== "0";
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

/* ---------- tab drag reorder with live FLIP preview — parity with web ---------- */
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
    const target = [...bar.children].filter(c => c !== dragTabEl)
      .find(c => ev.clientX < c.getBoundingClientRect().left + c.offsetWidth / 2) || null;
    const already = target ? dragTabEl.nextSibling === target : bar.lastElementChild === dragTabEl;
    if (already) return;
    flipMove(bar, () => bar.insertBefore(dragTabEl, target));
  });
  bar.addEventListener("drop", ev => ev.preventDefault());
}
function makeTabDraggable(tabEl) {
  tabEl.draggable = true;
  tabEl.addEventListener("dragstart", ev => {
    dragTabEl = tabEl;
    ev.dataTransfer.setData("application/x-deck-tab", "1");
    ev.dataTransfer.effectAllowed = "move";
    setTimeout(() => tabEl.classList.add("dragging"), 0);
  });
  tabEl.addEventListener("dragend", () => {
    tabEl.classList.remove("dragging");
    dragTabEl = null;
  });
}

/* ================= terminals: tabs → split instances (local or SSH) ================= */

const PREFS = {
  cursorStyle: localStorage.getItem("deck.cursorStyle") || "bar",       // bar | block | underline
  cursorMotion: localStorage.getItem("deck.cursorMotion") || "phase",
  scrollback: parseInt(localStorage.getItem("deck.scrollback")) || 50000,   // phase | blink | steady
  warnCloseTab: localStorage.getItem("deck.warnCloseTab") !== "0",
  warnQuit: localStorage.getItem("deck.warnQuit") !== "0",
  // OFF by default: the streaming path can lose the tail of a transfer, and a
  // database dump that is silently 2 MB short is far worse than a slow one.
  fastTransfer: localStorage.getItem("deck.fastTransfer") === "1",
  fastMinMb: parseInt(localStorage.getItem("deck.fastMinMb")) || 64,
};
// passed to every transfer command so the Rust side knows which path to pick
function fastOpts() {
  return { fastEnabled: PREFS.fastTransfer, fastMinMb: PREFS.fastMinMb };
}
function savePref(k, v) {
  PREFS[k] = v;
  localStorage.setItem("deck." + k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
}
function applyCursorPrefs() {
  document.body.dataset.cursorMotion = PREFS.cursorMotion;
  for (const tab of TABS.values())
    for (const i of tab.insts) {
      i.term.options.cursorStyle = PREFS.cursorStyle;
      i.term.options.cursorBlink = PREFS.cursorMotion === "blink";
    }
}

/* one terminal instance inside a tab (a split) */
function createInst(tab, source) {
  // source: { kind: "local" } | { kind: "ssh", host }
  const wrapEl = document.createElement("div");
  wrapEl.className = "tsplit";
  const title = source.kind === "local" ? "PowerShell" : source.host.label;
  wrapEl.innerHTML =
    `<div class="tsplit-bar"><span class="tname">${esc(title)}</span>` +
    `<button class="tb-copy" title="copy this pane's output">⧉</button>` +
    `<button class="tb-bc on" title="include this split in MultiExec broadcast">⌨</button>` +
    `<button class="tb-x" title="close split">✕</button></div>` +
    `<div class="term-el"></div>`;
  const el = wrapEl.querySelector(".term-el");

  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: FONT_SIZE,
    theme: ACTIVE_THEME.terminal, cursorStyle: PREFS.cursorStyle,
    cursorBlink: PREFS.cursorMotion === "blink", scrollback: PREFS.scrollback,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const inst = { id: ++seq, tab, source, host: source.host || null, wrapEl, term, fit,
                 unsubs: [], dead: false, bcast: true, stats: null, prev: {}, cpuHist: [], netHist: [], diskHist: [] };

  el.addEventListener("wheel", ev => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    setFontSize(FONT_SIZE + (ev.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard.writeText(sel).catch(() => {});
  });
  // Moba-style paste: middle-click and Ctrl+Shift+V; Ctrl+Shift+C copies
  const pasteClipboard = () => navigator.clipboard.readText()
    .then(text => { if (text) sendTo(inst, text); }).catch(() => {});
  term.attachCustomKeyEventHandler(ev => {
    if (ev.ctrlKey && ev.type === "keydown" && ["=", "+", "-"].includes(ev.key)) {
      setFontSize(FONT_SIZE + (ev.key === "-" ? -1 : 1));
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && ev.type === "keydown") {
      if (ev.code === "KeyC") {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        return false;
      }
      if (ev.code === "KeyV") { pasteClipboard(); return false; }
    }
    return true;
  });
  el.addEventListener("mousedown", ev => { if (ev.button === 1) ev.preventDefault(); });
  el.addEventListener("auxclick", ev => { if (ev.button === 1) { ev.preventDefault(); pasteClipboard(); } });
  wrapEl.addEventListener("mousedown", () => focusInst(tab, inst));

  inst.sendResize = () => {
    try { fit.fit(); } catch (e) {}
    if (source.kind === "local") invoke("pty_resize", { id: inst.id, cols: term.cols, rows: term.rows });
    else if (!inst.dead) invoke("ssh_resize", { id: inst.id, cols: term.cols, rows: term.rows });
  };
  new ResizeObserver(() => { if (tab.pane.classList.contains("active")) inst.sendResize(); }).observe(wrapEl);

  // typing → this instance, or every broadcast-enabled instance of the tab in MultiExec
  term.onData(d => {
    if (tab.broadcast) {
      for (const i of tab.insts) if (i.bcast) sendTo(i, d);
    } else sendTo(inst, d);
  });

  wrapEl.querySelector(".tb-copy").onclick = e => { e.stopPropagation(); copyTerminal(inst, null); };
  wrapEl.querySelector(".tb-x").onclick = e => { e.stopPropagation(); closeInst(tab, inst); };
  wrapEl.querySelector(".tb-bc").onclick = e => {
    e.stopPropagation();
    inst.bcast = !inst.bcast;
    e.currentTarget.classList.toggle("on", inst.bcast);
  };
  return inst;
}

function sendTo(inst, d) {
  if (inst.source.kind === "local") { invoke("pty_write", { id: inst.id, data: d }); return; }
  if (inst.dead) {
    if (d.includes("\r")) {
      inst.dead = false;
      inst.term.write("\x1b[36m… reconnecting …\x1b[0m\r\n");
      invoke("ssh_spawn", { id: inst.id, hostId: inst.host.id })
        .then(() => setTimeout(inst.sendResize, 400))
        .catch(e => { inst.dead = true; inst.term.write(`\r\n\x1b[1;31m✗ ${e}\x1b[0m\r\n`); });
    }
    return;
  }
  invoke("ssh_write", { id: inst.id, data: d });
}

async function connectInst(inst) {
  const t = inst.term;
  const dec = new TextDecoder();
  inst.unsubs.push(await listen(`pty-out-${inst.id}`, ev => {
    let str = dec.decode(new Uint8Array(ev.payload), { stream: true });
    // highlight only on the normal buffer — nano/vim/htop (alt screen) untouched
    if (HL_ON && t.buffer.active.type === "normal") str = hlApply(str);
    t.write(str);
  }));
  if (inst.source.kind === "local") {
    inst.unsubs.push(await listen(`pty-exit-${inst.id}`, () => t.write("\r\n\x1b[1;33m— process exited —\x1b[0m\r\n")));
    await invoke("pty_spawn", { id: inst.id, shell: null });
    setTimeout(inst.sendResize, 50);
    return;
  }
  inst.unsubs.push(await listen(`pty-exit-${inst.id}`, () => {
    inst.dead = true;
    t.write("\r\n\x1b[1;33m— disconnected — press Enter to reconnect —\x1b[0m\r\n");
    if (isFocused(inst)) updateConn(inst);
  }));
  inst.unsubs.push(await listen(`stats-${inst.id}`, ev => {
    const s = parseStats(ev.payload, inst.prev);
    if (!s) return;
    inst.stats = s;
    inst.cpuHist.push(s.cpu); if (inst.cpuHist.length > 60) inst.cpuHist.shift();
    inst.netHist.push({ rx: s.rx_rate, tx: s.tx_rate }); if (inst.netHist.length > 60) inst.netHist.shift();
    inst.diskHist.push({ rd: s.disk_rd || 0, wr: s.disk_wr || 0 });
    if (inst.diskHist.length > 60) inst.diskHist.shift();
    if (isFocused(inst)) { renderStats(inst); updateConn(inst); }
  }));
  try {
    await invoke("ssh_spawn", { id: inst.id, hostId: inst.host.id });
    setTimeout(inst.sendResize, 400);
  } catch (e) {
    inst.dead = true;
    t.write(`\r\n\x1b[1;31m✗ ${e}\x1b[0m\r\n`);
  }
}

function isFocused(inst) {
  const tab = TABS.get(activeTab);
  return tab && (tab.focused || tab.insts[0]) === inst;
}

function disposeInst(inst) {
  inst.unsubs.forEach(u => u());
  if (inst.source.kind === "local") invoke("pty_kill", { id: inst.id });
  else invoke("ssh_kill", { id: inst.id });
  try { inst.term.dispose(); } catch (e) {}
}

function instAlive(inst) {
  return inst.source.kind === "local" ? true : !inst.dead;
}


/* ---- resizable splits: a draggable gutter between every pair of panes ---- */

function stripGutters(tab) {
  tab.root.querySelectorAll(".gutter").forEach(g => g.remove());
}

function makeGutter(container, tab) {
  const horiz = container.style.flexDirection === "row";
  const g = document.createElement("div");
  g.className = "gutter " + (horiz ? "v" : "h");
  g.title = "drag to resize · double-click to even out";

  g.addEventListener("mousedown", ev => {
    ev.preventDefault();
    const prev = g.previousElementSibling, next = g.nextElementSibling;
    if (!prev || !next) return;
    const pr = prev.getBoundingClientRect(), nr = next.getBoundingClientRect();
    const startPrev = horiz ? pr.width : pr.height;
    const startNext = horiz ? nr.width : nr.height;
    const total = startPrev + startNext;
    const startPos = horiz ? ev.clientX : ev.clientY;
    const MIN = 80;                       // never let a pane collapse to nothing
    g.classList.add("dragging");
    document.body.classList.add("resizing-split");

    let raf = 0;
    const move = e => {
      const delta = (horiz ? e.clientX : e.clientY) - startPos;
      const p = Math.max(MIN, Math.min(total - MIN, startPrev + delta));
      prev.style.flex = `${p} 1 0`;
      next.style.flex = `${total - p} 1 0`;
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        tab.insts.forEach(i => i.sendResize());
      });
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      g.classList.remove("dragging");
      document.body.classList.remove("resizing-split");
      tab.insts.forEach(i => i.sendResize());
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  // double-click: share the space evenly again
  g.addEventListener("dblclick", () => {
    [...container.children].forEach(c => {
      if (!c.classList.contains("gutter")) c.style.flex = "1 1 0";
    });
    tab.insts.forEach(i => i.sendResize());
  });
  return g;
}

/// Rebuild every gutter in the tab (call after any structural change).
function installGutters(tab) {
  stripGutters(tab);
  const walk = container => {
    const kids = [...container.children];
    kids.forEach((k, i) => {
      if (i > 0) container.insertBefore(makeGutter(container, tab), k);
      if (k.classList.contains("split")) walk(k);
    });
  };
  walk(tab.root);
}


/* ---- copy the whole terminal buffer (scrollback included) ---- */

const NEWLINE = String.fromCharCode(10);

function terminalText(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : "");
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();   // drop trailing blanks
  return lines.join(NEWLINE);
}

async function copyTerminal(inst, btn) {
  if (!inst) return;
  const text = terminalText(inst.term);
  try {
    await navigator.clipboard.writeText(text);
    flashOk(btn, `✓ ${text ? text.split(NEWLINE).length : 0} lines`);
  } catch (e) {
    flashOk(btn, "✗ copy failed");
  }
}

/* brief inline confirmation on a button, then restore its label */
function flashOk(btn, msg) {
  if (!btn) return;
  if (btn.dataset.busy) return;
  btn.dataset.busy = "1";
  const old = btn.textContent, w = btn.getBoundingClientRect().width;
  btn.style.minWidth = w + "px";
  btn.textContent = msg;
  btn.classList.add("ok");
  setTimeout(() => {
    btn.textContent = old;
    btn.classList.remove("ok");
    btn.style.minWidth = "";
    delete btn.dataset.busy;
  }, 1200);
}

/* ---- rename a tab (session-only, resets when the tab closes) ----
   Right-click → Rename only: a dblclick binding also fires the tab's click
   handler, which re-focuses the terminal and blurs the editor immediately. */

function renameTab(tab) {
  const labelEl = tab.tabEl.querySelector(".tlabel");
  if (!labelEl) return;
  const input = document.createElement("input");
  input.className = "tab-rename";
  input.value = labelEl.textContent;
  const wasDraggable = tab.tabEl.draggable;
  tab.tabEl.draggable = false;                 // an input inside a draggable is uneditable
  labelEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = save => {
    if (done) return;
    done = true;
    if (save) {
      const v = input.value.trim();
      tab.customName = v || null;              // empty → back to the automatic name
    }
    const span = document.createElement("span");
    span.className = "tlabel";
    input.replaceWith(span);
    tab.tabEl.draggable = wasDraggable;
    updateTabChrome(tab);
  };
  input.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  ["click", "dblclick", "mousedown", "auxclick"].forEach(ev =>
    input.addEventListener(ev, e => e.stopPropagation()));
}

/* ---- tabs ---- */

function makeTab(title) {
  const id = ++seq;
  $("#empty").style.display = "none";
  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.innerHTML = `<span class="tlabel">${esc(title)}</span><span class="tbadge hidden"></span><button class="x" title="close">✕</button>`;
  $("#tabbar").appendChild(tabEl);
  const pane = document.createElement("div");
  pane.className = "pane";
  const root = document.createElement("div");
  root.className = "split root";
  root.style.flexDirection = "row";
  pane.appendChild(root);
  $("#panes").appendChild(pane);
  const tab = { id, tabEl, pane, root, insts: [], focused: null, broadcast: false };
  TABS.set(id, tab);
  tabEl.onclick = e => {
    if (e.target.classList.contains("x")) { closeTab(tab); return; }
    activateTab(id);
  };
  tabEl.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });
  tabEl.addEventListener("auxclick", e => { if (e.button === 1) { e.preventDefault(); closeTab(tab); } });
  tabEl.oncontextmenu = e => ctxMenu(e, [
    // opens another session on the same host — no hunting through the sidebar
    { label: "Duplicate tab", fn: () => {
        const src = (tab.focused || tab.insts[0]).source;
        openTab(src.kind === "ssh"
          ? { kind: "ssh", host: STATE.hosts.find(h => h.id === src.host.id) || src.host }
          : { kind: "local" });
      } },
    { label: "Rename tab", fn: () => renameTab(tab) },
    ...(tab.customName ? [{ label: "Reset name", fn: () => { tab.customName = null; updateTabChrome(tab); } }] : []),
    { label: "Copy all output", fn: () => copyTerminal(tab.focused || tab.insts[0], null) },
    { label: "Close tab", danger: true, fn: () => closeTab(tab) },
  ]);
  makeTabDraggable(tabEl);
  return tab;
}

async function openTab(source) {
  showView("terms");
  const tab = makeTab(source.kind === "local" ? "PowerShell" : source.host.label);
  const inst = createInst(tab, source);
  tab.root.appendChild(inst.wrapEl);
  tab.insts.push(inst);
  updateTabChrome(tab);
  activateTab(tab.id);
  await connectInst(inst);
}
const openLocalTerm = () => openTab({ kind: "local" });
const openSshTerminal = host => openTab({ kind: "ssh", host });
$("#new-local").onclick = openLocalTerm;

/* split the focused instance of the active tab with a new source */
async function splitActive(source, dir) {
  const tab = TABS.get(activeTab);
  if (!tab) { openTab(source); return; }
  const focused = tab.focused || tab.insts[0];
  stripGutters(tab);                     // structural edit — rebuild them after
  const w = focused.wrapEl;
  const parent = w.parentElement;
  let container;
  if (parent.classList.contains("split") && parent.style.flexDirection === dir) container = parent;
  else {
    container = document.createElement("div");
    container.className = "split";
    container.style.flexDirection = dir;
    // the wrapper takes over the pane's share, otherwise a previously resized
    // pane would jump back to an even split when you split it again
    container.style.flex = w.style.flex || "1 1 0";
    parent.insertBefore(container, w);
    container.appendChild(w);
  }
  const inst = createInst(tab, source);
  container.appendChild(inst.wrapEl);
  tab.insts.push(inst);
  // a fresh pane starts at an even share of its container
  [...container.children].forEach(c => { c.style.flex = "1 1 0"; });
  installGutters(tab);
  updateTabChrome(tab);
  focusInst(tab, inst);
  setTimeout(() => tab.insts.forEach(i => i.sendResize()), 10);
  await connectInst(inst);
  inst.term.focus();
}

/* the split-source picker: local terminal or any saved host */
function pickSplitSource(dir) {
  return new Promise(resolve => {
    const bg = document.createElement("div");
    bg.id = "choice-bg";
    bg.innerHTML = `<div class="modal choice picker"><h3>Split ${dir === "row" ? "right" : "down"}</h3>
      <button class="btn-primary pick-local">Local terminal (PowerShell)</button>
      <input class="pick-filter" placeholder="🔍 search host…" spellcheck="false" autocomplete="off">
      <div class="pick-list"></div>
      <div class="modal-actions"><button class="btn-ghost cancel">Cancel</button></div></div>`;
    const done = v => { bg.remove(); resolve(v); };
    const listEl = bg.querySelector(".pick-list");
    const filterEl = bg.querySelector(".pick-filter");
    let shown = [];

    const render = () => {
      const q = filterEl.value.trim().toLowerCase();
      shown = STATE.hosts.filter(h => {
        const u = hostUser(h);
        return !q || h.label.toLowerCase().includes(q) ||
          h.hostname.toLowerCase().includes(q) || u.toLowerCase().includes(q);
      });
      listEl.innerHTML = shown.length
        ? shown.map((h, i) => {
            const u = hostUser(h);
            return `<button class="pick-row${i === 0 ? " sel" : ""}" data-i="${i}">` +
              `<span class="pl">${esc(h.label)}</span>` +
              `<span class="pu">${esc(u ? u + "@" : "")}${esc(h.hostname)}</span></button>`;
          }).join("")
        : '<div class="fp-empty">no host matches</div>';
      listEl.querySelectorAll(".pick-row").forEach(b => {
        b.onclick = () => done({ kind: "ssh", host: shown[+b.dataset.i] });
      });
    };
    const move = d => {
      const rows = [...listEl.querySelectorAll(".pick-row")];
      if (!rows.length) return;
      let i = rows.findIndex(r => r.classList.contains("sel"));
      i = Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + d));
      rows.forEach(r => r.classList.remove("sel"));
      rows[i].classList.add("sel");
      rows[i].scrollIntoView({ block: "nearest" });
    };
    filterEl.addEventListener("input", render);
    filterEl.addEventListener("keydown", ev => {
      if (ev.key === "ArrowDown") { ev.preventDefault(); move(1); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); move(-1); }
      else if (ev.key === "Enter") {
        ev.preventDefault();
        const sel = listEl.querySelector(".pick-row.sel");
        if (sel) done({ kind: "ssh", host: shown[+sel.dataset.i] });
      } else if (ev.key === "Escape") done(null);
    });
    bg.querySelector(".pick-local").onclick = () => done({ kind: "local" });
    bg.querySelector(".cancel").onclick = () => done(null);
    bg.addEventListener("mousedown", e => { if (e.target === bg) done(null); });
    document.body.appendChild(bg);
    render();
    filterEl.focus();
  });
}
$("#split-h").onclick = async () => { const s = await pickSplitSource("row"); if (s) splitActive(s, "row"); };
$("#split-v").onclick = async () => { const s = await pickSplitSource("column"); if (s) splitActive(s, "column"); };
$("#copy-all").onclick = e => {
  const tab = TABS.get(activeTab);
  if (!tab) return flashOk(e.currentTarget, "no terminal");
  copyTerminal(tab.focused || tab.insts[0], e.currentTarget);
};

$("#bcast").onclick = () => {
  const tab = TABS.get(activeTab);
  if (!tab) return;
  tab.broadcast = !tab.broadcast;
  $("#bcast").classList.toggle("on", tab.broadcast);
  tab.pane.classList.toggle("bc", tab.broadcast);
};

function focusInst(tab, inst) {
  if (!inst) return;
  tab.focused = inst;
  for (const i of tab.insts) i.wrapEl.classList.toggle("focused", i === inst);
  if (activeTab === tab.id) {
    if (inst.host) {
      $("#statusbar").classList.remove("hidden");
      $("#st-label").textContent = inst.host.label;
      $("#st-addr").textContent = ` · ${inst.host.hostname}:${inst.host.port}`;
      renderStats(inst);
      updateConn(inst);
    } else $("#statusbar").classList.add("hidden");
  }
}

async function closeInst(tab, inst) {
  if (PREFS.warnCloseTab && instAlive(inst) && inst.source.kind === "ssh") {
    const c = await choose("Close this session?", `Live SSH session to <b>${esc(inst.host.label)}</b> will be disconnected.`,
      [{ label: "Cancel", value: null }, { label: "Close", value: "yes", cls: "btn-danger" }]);
    if (c !== "yes") return;
  }
  disposeInst(inst);
  tab.insts = tab.insts.filter(i => i !== inst);
  stripGutters(tab);                     // children counts below must exclude them
  const parent = inst.wrapEl.parentElement;
  inst.wrapEl.remove();
  let p = parent;
  while (p && p.classList.contains("split") && !p.classList.contains("root")) {
    if (p.children.length === 0) { const up = p.parentElement; p.remove(); p = up; }
    else if (p.children.length === 1) { p.replaceWith(p.firstElementChild); break; }
    else break;
  }
  if (!tab.insts.length) { removeTab(tab); return; }
  installGutters(tab);
  if (tab.focused === inst) focusInst(tab, tab.insts[0]);
  updateTabChrome(tab);
  setTimeout(() => tab.insts.forEach(i => i.sendResize()), 10);
}

function updateTabChrome(tab) {
  const multi = tab.insts.length > 1;
  tab.pane.classList.toggle("multi", multi);
  const first = tab.insts[0];
  const base = tab.customName ||
    (first.source.kind === "local" ? "PowerShell" : first.host.label);
  tab.tabEl.querySelector(".tlabel").textContent = base;
  const badge = tab.tabEl.querySelector(".tbadge");
  badge.textContent = multi ? String(tab.insts.length) : "";
  badge.title = multi ? `${tab.insts.length} splits in this tab` : "";
  badge.classList.toggle("hidden", !multi);
}

async function closeTab(tab) {
  const live = tab.insts.filter(i => i.source.kind === "ssh" && instAlive(i));
  if (PREFS.warnCloseTab && live.length) {
    const c = await choose("Close this tab?",
      `${live.length} live SSH session${live.length > 1 ? "s" : ""} will be disconnected: <span class="muted mono">${live.map(i => esc(i.host.label)).join(", ")}</span>`,
      [{ label: "Cancel", value: null }, { label: "Close", value: "yes", cls: "btn-danger" }]);
    if (c !== "yes") return;
  }
  removeTab(tab);
}

function removeTab(tab) {
  tab.insts.forEach(disposeInst);
  tab.pane.remove();
  tab.tabEl.remove();
  TABS.delete(tab.id);
  if (activeTab === tab.id) {
    const last = [...TABS.keys()].pop();
    if (last) activateTab(last);
    else { activeTab = null; $("#statusbar").classList.add("hidden"); $("#empty").style.display = ""; }
  }
}

function activateTab(id) {
  activeTab = id;
  for (const [tid, t] of TABS) {
    t.pane.classList.toggle("active", tid === id);
    t.tabEl.classList.toggle("active", tid === id);
  }
  const tab = TABS.get(id);
  if (tab) {
    $("#bcast").classList.toggle("on", tab.broadcast);
    focusInst(tab, tab.focused || tab.insts[0]);
    setTimeout(() => {
      tab.insts.forEach(i => i.sendResize());
      (tab.focused || tab.insts[0]).term.focus();
    }, 10);
  }
}

function fitActive() {
  const tab = TABS.get(activeTab);
  if (tab) tab.insts.forEach(i => i.sendResize());
}
window.addEventListener("resize", fitActive);

function setFontSize(size) {
  FONT_SIZE = Math.min(28, Math.max(7, size));
  localStorage.setItem("deck.fontsize", FONT_SIZE);
  for (const tab of TABS.values())
    for (const i of tab.insts) { i.term.options.fontSize = FONT_SIZE; i.sendResize(); }
}

/* live SSH sessions across all tabs (for the quit warning) */
function liveSessionCount() {
  let n = 0;
  for (const tab of TABS.values()) for (const i of tab.insts) if (i.source.kind === "ssh" && instAlive(i)) n++;
  return n;
}

function updateConn(inst) {
  $("#st-conn").textContent = inst.dead ? "disconnected" : "connected";
  $("#st-conn").classList.toggle("err", inst.dead);
  $(".st-host").classList.toggle("err", inst.dead);
}

/* ---------- stats parsing (port of app/ws.py) ---------- */

function parseStats(out, prev) {
  const parts = out.split("@@").map(p => p.trim());
  if (parts.length < 7) return null;
  const res = {};
  const cpu = parts[0].split(/\s+/).slice(1).map(Number);
  const total = cpu.reduce((a, b) => a + b, 0);
  const idle = cpu[3] + (cpu[4] || 0);
  if (prev.total) {
    const dt = total - prev.total, di = idle - prev.idle;
    res.cpu = dt > 0 ? Math.max(0, (1 - di / dt) * 100) : 0;
  } else res.cpu = 0;
  prev.total = total; prev.idle = idle;
  const mem = {};
  for (const line of parts[1].split("\n")) {
    const [k, v] = line.split(":");
    if (v) mem[k.trim()] = parseInt(v);
  }
  res.mem_total = (mem.MemTotal || 0) * 1024;
  res.mem_used = ((mem.MemTotal || 0) - (mem.MemAvailable || 0)) * 1024;
  const df = parts[2].split(/\s+/);
  res.disk_pct = df.length >= 5 ? parseInt(df[4]) || 0 : 0;
  // Count PHYSICAL interfaces only. Summing everything but `lo` triples the
  // numbers on a hypervisor: one packet to a guest shows up on the NIC, on the
  // bridge and on the tap. Only real hardware has /sys/class/net/<if>/device,
  // so the host tells us which those are; if it cannot, fall back to the old
  // behaviour rather than reporting nothing.
  const physical = new Set((parts[8] || "").split(NEWLINE).map(x => x.trim()).filter(Boolean));
  let rx = 0, tx = 0;
  for (const line of parts[3].split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!rest) continue;
    const nic = name.trim();
    if (nic === "lo") continue;
    if (physical.size && !physical.has(nic)) continue;
    const f = rest.trim().split(/\s+/);
    if (f.length >= 9) { rx += parseInt(f[0]); tx += parseInt(f[8]); }
  }
  const up = parseFloat(parts[4]);
  if (prev.rx !== undefined && prev.up) {
    const dt = Math.max(0.001, up - prev.up);
    res.rx_rate = Math.max(0, (rx - prev.rx) / dt);
    res.tx_rate = Math.max(0, (tx - prev.tx) / dt);
  } else { res.rx_rate = res.tx_rate = 0; }
  prev.rx = rx; prev.tx = tx; prev.up = up;

  // disk I/O: /proc/diskstats sectors (512 B each) on whole disks only —
  // partitions and dm-/loop devices would double-count the same traffic
  let drd = 0, dwr = 0;
  if (parts[7]) {
    const rows = parts[7].split(NEWLINE).map(l => l.trim().split(/\s+/)).filter(f => f.length >= 10);
    const names = rows.map(f => f[2]);
    const isPartition = n => names.some(par =>
      par !== n && n.startsWith(par) && /^p?\d+$/.test(n.slice(par.length)));
    for (const f of rows) {
      const name = f[2];
      // zd* are ZFS zvols and nbd/drbd are network block devices: their traffic
      // is already counted again on the physical disks underneath them
      if (/^(loop|ram|zram|sr|fd|dm-|md|zd|nbd|drbd)/.test(name) || isPartition(name)) continue;
      drd += parseInt(f[5]) * 512;      // sectors read
      dwr += parseInt(f[9]) * 512;      // sectors written
    }
  }
  if (prev.drd !== undefined && prev.dup) {
    const dt = Math.max(0.001, up - prev.dup);
    res.disk_rd = Math.max(0, (drd - prev.drd) / dt);
    res.disk_wr = Math.max(0, (dwr - prev.dwr) / dt);
  } else { res.disk_rd = res.disk_wr = 0; }
  prev.drd = drd; prev.dwr = dwr; prev.dup = up;

  res.uptime = up;
  res.who = parts[6].split("\n").map(l => l.trim().replace(/\s+/g, " ")).filter(Boolean);
  res.users = res.who.length;
  return res;
}

function meterSet(el, pct) {
  el.style.width = Math.min(100, pct) + "%";
  el.className = pct > 90 ? "crit" : pct > 70 ? "warn" : "";
}

function drawGraph(canvas, series) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const N = 60;
  for (const { data, color, max } of series) {
    const d = data.slice(-N);
    if (d.length < 2) continue;
    const step = canvas.width / (N - 1);
    const x0 = canvas.width - (d.length - 1) * step;
    const y = v => canvas.height - 1 - Math.min(v, max) / max * (canvas.height - 2);
    ctx.beginPath();
    d.forEach((v, i) => i ? ctx.lineTo(x0 + i * step, y(v)) : ctx.moveTo(x0, y(v)));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function renderStats(t) {
  const s = t.stats;
  if (!s) return;
  $("#st-cpu").textContent = s.cpu.toFixed(1) + "%";
  drawGraph($("#st-cpugraph"), [{ data: t.cpuHist, color: GRAPH.cpu, max: 100 }]);
  const memPct = s.mem_total ? s.mem_used / s.mem_total * 100 : 0;
  $("#st-mem").textContent = (s.mem_used / 1073741824).toFixed(2) + " / " + (s.mem_total / 1073741824).toFixed(2) + " GB";
  meterSet($("#st-membar"), memPct);
  $("#st-disk").textContent = s.disk_pct + "%";
  meterSet($("#st-diskbar"), s.disk_pct);
  const nmax = Math.max(10240, ...t.netHist.map(d => Math.max(d.rx, d.tx)));
  drawGraph($("#st-netgraph"), [
    { data: t.netHist.map(d => d.rx), color: GRAPH.cpu, max: nmax },
    { data: t.netHist.map(d => d.tx), color: GRAPH.tx, max: nmax },
  ]);
  const dh = t.diskHist || [];
  const dmax = Math.max(1048576, ...dh.map(d => Math.max(d.rd, d.wr)));   // 1 MB/s floor
  drawGraph($("#st-diskiograph"), [
    { data: dh.map(d => d.rd), color: GRAPH.cpu, max: dmax },
    { data: dh.map(d => d.wr), color: GRAPH.tx, max: dmax },
  ]);
  $("#st-drd").textContent = "R " + fmtDiskRate(s.disk_rd || 0);
  $("#st-dwr").textContent = "W " + fmtDiskRate(s.disk_wr || 0);
  $("#st-tx").textContent = "↑" + fmtRate(s.tx_rate);
  $("#st-rx").textContent = "↓" + fmtRate(s.rx_rate);
  $("#st-up").textContent = fmtUptime(s.uptime);
  const counts = {};
  for (const line of s.who) { const u = line.split(" ")[0]; counts[u] = (counts[u] || 0) + 1; }
  const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([u, n]) => n > 1 ? `${u}×${n}` : u);
  const shown = parts.slice(0, 3);
  if (parts.length > 3) shown.push(`+${parts.length - 3} more`);
  $("#st-users").textContent = parts.length ? `${s.users} · ${shown.join(" ")}` : "0";
  $("#who-pop").innerHTML = s.who.map(l => `<div>${esc(l)}</div>`).join("") || '<div class="muted">no sessions</div>';
}

/* ---------- views ---------- */

$$(".nav-btn").forEach(b => b.onclick = () => showView(b.dataset.view));
function showView(name) {
  $$(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "terms" && activeTab) setTimeout(fitActive, 10);
  if (name === "tunnels") loadTunnels();
  if (name === "files") renderPaneHostOptions();
  if (name === "logs") {
    logUnseen = 0;
    logBadge();
    // never let a rendering fault take the window with it
    try { renderLogs(); } catch (e) { $("#loglist").textContent = "log view failed: " + e; }
  }
}


/* ---------- log panel ----------
 *
 * Every part of the app reports here: Rust pushes `log` events, the frontend
 * funnels its own failures through logUi(). Errors used to surface as an alert
 * or a red transfer row and then vanish, so anything you did not catch live was
 * lost — which is exactly the position we were in chasing the transfer stalls.
 */
const LOG = [];
const LOG_CAP = 3000;
let logLevel = "all";
let logQuery = "";
let logUnseen = 0;

function logMatches(e) {
  if (logLevel !== "all" && e.level !== logLevel) return false;
  if (!logQuery) return true;
  const q = logQuery.toLowerCase();
  return e.msg.toLowerCase().includes(q) || e.src.toLowerCase().includes(q);
}

function logTime(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function logRow(e) {
  const el = document.createElement("div");
  el.className = "log-row " + e.level;
  el.innerHTML = `<span class="log-ts">${logTime(e.ts)}</span>` +
    `<span class="log-lvl">${esc(e.level)}</span>` +
    `<span class="log-src">${esc(e.src)}</span>` +
    `<span class="log-msg">${esc(e.msg)}</span>`;
  return el;
}

const LOG_ROWS_MAX = 500;

function renderLogs() {
  const list = $("#loglist");
  const rows = LOG.filter(logMatches);
  $("#log-empty").classList.toggle("hidden", rows.length > 0);
  // build off-document, then swap in once — a thousand appendChild calls into a
  // live scrolling container is a lot of layout work for no reason
  const frag = document.createDocumentFragment();
  for (const e of rows.slice(-LOG_ROWS_MAX)) frag.appendChild(logRow(e));
  list.replaceChildren(frag);
  if ($("#log-follow").checked) list.scrollTop = list.scrollHeight;
}

function logBadge() {
  const b = $("#log-badge");
  b.classList.toggle("hidden", logUnseen === 0);
  b.textContent = logUnseen > 99 ? "99+" : String(logUnseen);
}

/* Repainting per event would mean one forced layout per arrival; a burst of
   them while the panel is open would crawl. Coalesce into one frame instead. */
let logPending = false;
function scheduleLogRender() {
  if (logPending) return;
  logPending = true;
  requestAnimationFrame(() => {
    logPending = false;
    if ($("#view-logs").classList.contains("active")) renderLogs();
  });
}

function addLog(e) {
  LOG.push(e);
  if (LOG.length > LOG_CAP) LOG.shift();
  if ($("#view-logs").classList.contains("active")) scheduleLogRender();
  else if (e.level === "error") { logUnseen++; logBadge(); }
}

/* The frontend's own problems go to the same place, in the same order.
 *
 * The guard matters: reporting an error round-trips through Rust and comes back
 * as a `log` event, which renders. If rendering ever threw, that would raise
 * another error, report it, render again — a feedback loop that would spin
 * forever and freeze the window. Reporting can never trigger reporting. */
let logReporting = false;
const logRate = { since: 0, n: 0, last: "" };
const LOG_UI_PER_SEC = 20;

function logUi(src, e) {
  if (logReporting) return;
  const msg = e && e.message ? e.message : String(e);
  const now = Date.now();
  if (now - logRate.since > 1000) { logRate.since = now; logRate.n = 0; }
  // A fault that repeats every frame would otherwise flood the buffer and the
  // IPC channel with the same line. Drop repeats and cap the rate; the first
  // occurrence is the one worth keeping anyway.
  if (msg === logRate.last && logRate.n > 0) return;
  if (++logRate.n > LOG_UI_PER_SEC) return;
  logRate.last = msg;
  logReporting = true;
  try {
    invoke("log_add", { level: "error", src, msg }).catch(() => {});
  } catch (_) { /* the logger must never be the thing that breaks */ }
  logReporting = false;
}
window.addEventListener("error", ev => logUi("ui", ev.message || ev.error));
window.addEventListener("unhandledrejection", ev => logUi("ui", ev.reason));

listen("log", ev => addLog(ev.payload));
listen("logs-reset", () => { LOG.length = 0; logUnseen = 0; logBadge(); renderLogs(); });

$$(".log-lv").forEach(b => b.onclick = () => {
  $$(".log-lv").forEach(x => x.classList.toggle("active", x === b));
  logLevel = b.dataset.lv;
  renderLogs();
});
$("#log-find").oninput = e => { logQuery = e.target.value.trim(); renderLogs(); };
$("#log-clear").onclick = () => invoke("logs_clear");
$("#log-copy").onclick = async () => {
  const text = LOG.filter(logMatches)
    .map(e => `${logTime(e.ts)} [${e.level}] ${e.src}: ${e.msg}`).join(NEWLINE);
  try { await navigator.clipboard.writeText(text); flashOk($("#log-copy")); }
  catch (err) { logUi("ui", err); }
};
$("#log-save").onclick = async () => {
  try {
    const path = await window.__TAURI__.dialog.save({
      title: "Save log", defaultPath: "sshdeck-log.txt",
      filters: [{ name: "Text", extensions: ["txt", "log"] }],
    });
    if (!path) return;
    await invoke("logs_save", { path });
    flashOk($("#log-save"));
  } catch (e) { logUi("ui", e); }
};

async function loadLogs() {
  try {
    const rows = await invoke("logs_list");
    LOG.length = 0;
    LOG.push(...rows);
    renderLogs();
  } catch (e) { /* the panel is a diagnostic, never a blocker */ }
}

/* ---------- host modal ---------- */

let editingHost = null;

function openHostModal(host) {
  editingHost = host || null;
  $("#hm-title").textContent = host ? "Edit host" : "Add host";
  $("#hm-delete").classList.toggle("hidden", !host);
  $("#hm-folder").innerHTML = '<option value="">(no folder)</option>' + folderOptions();
  $("#hm-key").innerHTML = STATE.keys.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join("") ||
    '<option value="">(no keys)</option>';
  $("#hm-ident").innerHTML = STATE.identities.map(i => `<option value="${i.id}">${esc(i.name)} (${esc(i.username)})</option>`).join("") ||
    '<option value="">(no identities)</option>';
  delete $("#hm-user").dataset.own;
  $("#hm-label").value = host ? host.label : "";
  $("#hm-host").value = host ? host.hostname : "";
  $("#hm-port").value = host ? host.port : 22;
  $("#hm-user").value = host ? host.username : "";
  $("#hm-auth").value = host ? host.auth_type : "password";
  $("#hm-pw").value = "";
  $("#hm-pw").placeholder = host && host.has_password ? "(unchanged)" : "";
  $("#hm-folder").value = host && host.folder_id ? host.folder_id : "";
  if (host && host.key_id) $("#hm-key").value = host.key_id;
  if (host && host.identity_id) $("#hm-ident").value = host.identity_id;
  authTypeChanged();
  $("#modal-bg").classList.remove("hidden");
  $("#hm-label").focus();
}

function syncIdentUser() {
  const u = $("#hm-user");
  if ($("#hm-auth").value === "identity") {
    if (u.dataset.own === undefined) u.dataset.own = u.value;
    const ident = STATE.identities.find(i => i.id === parseInt($("#hm-ident").value));
    u.value = ident ? ident.username : "";
  } else if (u.dataset.own !== undefined) {
    u.value = u.dataset.own;
    delete u.dataset.own;
  }
}

function authTypeChanged() {
  const mode = $("#hm-auth").value;
  $("#hm-pw-wrap").classList.toggle("hidden", mode !== "password");
  $("#hm-key-wrap").classList.toggle("hidden", mode !== "key");
  $("#hm-ident-wrap").classList.toggle("hidden", mode !== "identity");
  $("#hm-user").disabled = mode === "identity";
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
  const args = {
    id: editingHost ? editingHost.id : null,
    folderId: parseInt($("#hm-folder").value) || null,
    label: $("#hm-label").value.trim() || $("#hm-host").value.trim(),
    hostname: $("#hm-host").value.trim(),
    port: parseInt($("#hm-port").value) || 22,
    username: $("#hm-user").value.trim(),
    authType: mode,
    password: $("#hm-pw").value || null,
    keyId: mode === "key" ? parseInt($("#hm-key").value) || null : null,
    identityId: mode === "identity" ? parseInt($("#hm-ident").value) || null : null,
  };
  if (!args.hostname) { alert("Hostname required"); return; }
  try {
    await invoke("host_save", args);
    $("#modal-bg").classList.add("hidden");
    loadState();
  } catch (e) { logUi("ui", e); alert(e); }
};

$("#hm-delete").onclick = async () => {
  if (!editingHost || !confirm(`Delete host "${editingHost.label}"?`)) return;
  await invoke("host_delete", { id: editingHost.id });
  $("#modal-bg").classList.add("hidden");
  loadState();
};

$("#add-host").onclick = () => openHostModal(null);
$("#add-folder").onclick = async () => {
  const name = prompt("Folder name (root level — right-click a folder to add a sub-folder):");
  if (name && name.trim()) { await invoke("folder_save", { name: name.trim(), parentId: null }); loadState(); }
};

/* ---------- identities & keys ---------- */

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
        await invoke("identity_save", { id: i.id, name: i.name, username: i.username, password: pw });
        alert("Updated");
      } catch (e) { logUi("ui", e); alert(e); }
    };
    item.querySelector(".del").onclick = async () => {
      if (!await confirmCredDelete("identity", i.name, i.id)) return;
      try { await invoke("identity_delete", { id: i.id }); loadState(); } catch (e) { logUi("ui", e); alert(e); }
    };
    el.appendChild(item);
  }
}

$("#ident-add").onclick = async () => {
  const name = $("#ident-name").value.trim(), username = $("#ident-user").value.trim(),
        password = $("#ident-pass").value;
  if (!name || !username || !password) { alert("All fields required"); return; }
  await invoke("identity_save", { id: null, name, username, password });
  $("#ident-name").value = $("#ident-user").value = $("#ident-pass").value = "";
  loadState();
};

function renderKeys() {
  const el = $("#keylist");
  el.innerHTML = STATE.keys.length ? "" : '<p class="muted">No keys yet.</p>';
  for (const k of STATE.keys) {
    const item = document.createElement("div");
    item.className = "key-item";
    item.innerHTML = `<span class="kname">🔑 ${esc(k.name)}</span><button class="btn-danger small">Delete</button>`;
    item.querySelector("button").onclick = async () => {
      if (!await confirmCredDelete("key", k.name, k.id)) return;
      try { await invoke("key_delete", { id: k.id }); loadState(); } catch (e) { logUi("ui", e); alert(e); }
    };
    el.appendChild(item);
  }
}

$("#key-add").onclick = async () => {
  const name = $("#key-name").value.trim(), pk = $("#key-priv").value.trim();
  if (!name || !pk) { alert("Name and key required"); return; }
  await invoke("key_save", { name, privateKey: pk, passphrase: $("#key-pass").value || null });
  $("#key-name").value = $("#key-priv").value = $("#key-pass").value = "";
  loadState();
};

/* ---------- files (SFTP dual pane) ---------- */

const PANES = [
  { hostId: null, path: ".", entries: [], selIdx: new Set(), anchor: null, optMap: {} },
  { hostId: null, path: ".", entries: [], selIdx: new Set(), anchor: null, optMap: {} },
];

function fmtBytes(n) {
  if (n == null) return "–";
  const u = ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n >= 100 ? 0 : 2)) + " " + u[i];
}
function fmtDate(t) {
  if (!t) return "";
  return new Date(t * 1000).toLocaleString(undefined,
    { year: "2-digit", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function joinPath(dir, name) { return dir.replace(/\/+$/, "") + "/" + name; }
function parentPath(p) {
  const parts = p.replace(/\/+$/, "").split("/");
  parts.pop();
  return parts.join("/") || "/";
}
function hostById(id) { return STATE.hosts.find(h => h.id === id); }

/* Files dropped from the OS have no path (dragDropEnabled:false), so stream their
   bytes into a temp spool file in Rust and upload that with the normal SFTP path. */
const STASH_CHUNK = 256 * 1024;
function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(s);
}
/* Dropping a FOLDER hands us a File entry with size 0 and no contents, which
   used to upload as an empty file of the same name. The directory tree is only
   reachable through the entries API, and webkitGetAsEntry() must be called
   synchronously in the drop handler before any await, or the items are gone. */
function dropEntries(dt) {
  return [...(dt.items || [])]
    .map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
}

function readBatch(reader) {
  return new Promise((res, rej) => reader.readEntries(res, rej));
}

async function walkEntry(entry, prefix, out, dirs) {
  if (entry.isFile) {
    out.push({ file: await new Promise((res, rej) => entry.file(res, rej)), rel: prefix });
    return;
  }
  if (!entry.isDirectory) return;
  const dir = prefix ? prefix + "/" + entry.name : entry.name;
  dirs.push(dir);
  const reader = entry.createReader();
  // readEntries hands back at most 100 per call, so keep going until it is dry
  for (;;) {
    const batch = await readBatch(reader);
    if (!batch.length) break;
    for (const e of batch) await walkEntry(e, dir, out, dirs);
  }
}

/// Flatten dropped entries into files tagged with their sub-path, plus the list
/// of directories to create first (so empty ones survive the trip too).
async function expandDrop(entries) {
  const out = [], dirs = [];
  // start every entry together: resolving them one after another let the drag
  // data store go stale, so only the first dropped file ever came through
  await Promise.all(entries.map(e => walkEntry(e, "", out, dirs)));
  return { items: out, dirs };
}

async function uploadLocalFiles(P, files, reload, dirs) {
  const host = hostById(P.hostId);
  $("#transfers").classList.remove("hidden");
  // shallowest first, so parents exist before their children
  for (const d of (dirs || []).slice().sort((a, b) => a.split("/").length - b.split("/").length)) {
    await invoke("sftp_mkdir", { hostId: P.hostId, path: joinPath(P.path, d) }).catch(() => {});
  }
  // Build every row before doing any work. Creating them one at a time meant a
  // multi-file drop showed a single row until that file had finished, which
  // looked like only one file had been accepted.
  const queue = files.map(entry => {
    const file = entry.file || entry;
    const rel = entry.rel || "";
    const destDir = rel ? joinPath(P.path, rel) : P.path;
    const key = "prep" + (++PREP_SEQ);
    // the description has to match what Rust builds, so the prep row can retire
    // the moment the real transfer takes over
    const row = {
      id: key, desc: `${file.name} → ${host.label}:${destDir}`,
      done: 0, total: file.size, status: "queued", error: null,
      speed: 0, method: "", resumable: false, elapsed_ms: 0,
      cancel: false, handedOff: false,
    };
    PREP.set(key, row);
    return { file, destDir, key, row };
  });
  renderTransfers();

  for (const { file, destDir, key, row } of queue) {
    if (row.cancel) { PREP.delete(key); renderTransfers(); continue; }
    row.status = "preparing";
    renderTransfers();
    let path, painted = 0;
    try {
      path = await invoke("stash_begin", { name: file.name });
      for (let off = 0; off < file.size; off += STASH_CHUNK) {
        if (row.cancel) throw new Error("__canceled__");
        const buf = await file.slice(off, off + STASH_CHUNK).arrayBuffer();
        await invoke("stash_append", { path, chunk: b64(new Uint8Array(buf)) });
        row.done = Math.min(file.size, off + STASH_CHUNK);
        // repaint a few times a second, not once per chunk
        if (Date.now() - painted > 200) { painted = Date.now(); renderTransfers(); }
      }
      if (row.cancel) throw new Error("__canceled__");
      row.handedOff = true;
      renderTransfers();
      await invoke("sftp_upload", {
        ...fastOpts(),
        hostId: P.hostId, localPath: path, remoteDir: destDir, hostLabel: host.label,
      });
    } catch (e) {
      PREP.delete(key);
      if (String(e).includes("__canceled__")) {
        // nothing was handed to the transfer layer yet, so there is nothing to
        // show — just drop the spool
      } else {
        SERVER_ROWS = SERVER_ROWS.concat([{
          id: key, desc: row.desc, done: 0, total: null, status: "error",
          error: String(e && e.message ? e.message : e), speed: 0,
          method: "", resumable: false, elapsed_ms: 0,
        }]);
      }
      renderTransfers();
      // on success the upload task deletes the spool itself, since sftp_upload
      // returns as soon as the background transfer is spawned
      if (path) invoke("stash_cleanup", { path });
    }
  }
  if (reload) reload();
}

function renderPaneHostOptions() {
  $$(".fpane").forEach((paneEl, i) => {
    if (!paneEl.dataset.built) buildPane(paneEl, i);
    const P = PANES[i];
    const dl = paneEl.querySelector("datalist");
    P.optMap = {};
    dl.innerHTML = STATE.hosts.map(h => {
      const u = hostUser(h);
      let text = !u || h.label.includes(u) ? h.label : `${h.label} (${u})`;
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
      <button class="btn-ghost small disc" title="Release the file session for this host (terminals stay connected)">⏻</button>
    </div>
    <div class="fp-find">
      <input class="findbox" placeholder="🔎 search files in this folder and below — type .json and press Enter" spellcheck="false">
      <button class="btn-ghost small findgo" title="Search">Search</button>
      <button class="btn-ghost small findclear hidden" title="Back to browsing">✕ clear</button>
      <span class="findnote muted"></span>
    </div>
    <div class="fp-tools">
      <button class="up">⬆ up</button>
      <button class="upload">Upload</button>
      <button class="mkdir">+ dir</button>
      <button class="rename">Rename</button>
      <button class="chmod">chmod</button>
      <button class="del">Delete</button>
      <button class="dl">Download</button>
    </div>
    <div class="fp-list"><div class="fp-empty">Select a host to browse.</div></div>`;

  const P = PANES[i];
  const sel = paneEl.querySelector(".hostsel");
  const pathInput = paneEl.querySelector(".path");
  const listEl = paneEl.querySelector(".fp-list");

  function pickHost() {
    const id = P.optMap && P.optMap[sel.value];
    if (id) { P.hostId = id; P.path = "."; sel.title = sel.value; load("."); sel.blur(); }
  }
  sel.addEventListener("change", pickHost);
  sel.addEventListener("input", pickHost);
  sel.addEventListener("focus", () => sel.select());

  async function load(path) {
    if (!P.hostId) return;
    listEl.innerHTML = '<div class="fp-empty">loading…</div>';
    try {
      const r = await invoke("sftp_list", { hostId: P.hostId, path: path ?? P.path });
      P.path = r.path;
      P.entries = r.entries;
      P.selIdx = new Set();
      P.anchor = null;
      pathInput.value = r.path;
      renderList();
    } catch (e) {
      listEl.innerHTML = `<div class="fp-empty">✗ ${esc(e)}</div>`;
    }
  }
  P.load = load;
  const selected = () => [...P.selIdx].sort((a, b) => a - b).map(k => P.entries[k]).filter(Boolean);

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
    const syncSel = () => listEl.querySelectorAll(".fp-row").forEach(r =>
      r.classList.toggle("sel", P.selIdx.has(+r.dataset.i)));
    listEl.querySelectorAll(".fp-row").forEach(row => {
      const idx = +row.dataset.i;
      const entry = P.entries[idx];
      row.onclick = ev => {
        if (ev.ctrlKey || ev.metaKey) { P.selIdx.has(idx) ? P.selIdx.delete(idx) : P.selIdx.add(idx); P.anchor = idx; }
        else if (ev.shiftKey && P.anchor !== null) {
          P.selIdx = new Set();
          const [a, b] = [Math.min(P.anchor, idx), Math.max(P.anchor, idx)];
          for (let k = a; k <= b; k++) P.selIdx.add(k);
        } else { P.selIdx = new Set([idx]); P.anchor = idx; }
        syncSel();
      };
      row.ondblclick = () => { if (entry.is_dir) load(joinPath(P.path, entry.name)); };
      row.ondragstart = ev => {
        if (!P.selIdx.has(idx)) { P.selIdx = new Set([idx]); P.anchor = idx; syncSel(); }
        const items = selected().map(e => ({ path: joinPath(P.path, e.name), is_dir: e.is_dir, name: e.name }));
        ev.dataTransfer.setData("application/x-deck", JSON.stringify({ pane: i, hostId: P.hostId, items }));
        ev.dataTransfer.effectAllowed = "copy";
      };
    });
  }

  /* ---- Explorer-style search: `find` runs on the server, from the current folder down ---- */
  const findBox = paneEl.querySelector(".findbox");
  const findNote = paneEl.querySelector(".findnote");
  const findClear = paneEl.querySelector(".findclear");

  function exitSearch() {
    P.searching = false;
    findBox.value = "";
    findNote.textContent = "";
    findClear.classList.add("hidden");
    load(P.path);
  }
  findClear.onclick = exitSearch;

  async function runFind() {
    const q = findBox.value.trim();
    if (!P.hostId) return;
    if (!q) return exitSearch();
    findNote.textContent = "searching…";
    findClear.classList.remove("hidden");
    listEl.innerHTML = '<div class="fp-empty">searching ' + esc(P.path) + ' …</div>';
    try {
      const r = await invoke("sftp_find", { hostId: P.hostId, path: P.path, query: q, limit: 1000 });
      P.searching = true;
      P.entries = r.hits;
      P.selIdx = new Set();
      P.anchor = null;
      findNote.textContent = r.note || `${r.hits.length} match${r.hits.length === 1 ? "" : "es"}`;
      renderFindResults(r.hits);
    } catch (e) {
      findNote.textContent = "";
      listEl.innerHTML = `<div class="fp-empty">✗ ${esc(e)}</div>`;
    }
  }
  findBox.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); runFind(); }
    else if (e.key === "Escape") { e.preventDefault(); exitSearch(); }
  });
  paneEl.querySelector(".findgo").onclick = runFind;

  function renderFindResults(hits) {
    if (!hits.length) { listEl.innerHTML = '<div class="fp-empty">no matches</div>'; return; }
    const rows = hits.map((e, idx) => `
      <tr class="fp-row ${e.is_dir ? "dir" : ""}" draggable="true" data-i="${idx}">
        <td class="fname"><span class="ficon">${e.is_dir ? "📁" : "📄"}</span>${esc(e.name)}</td>
        <td class="fwhere" title="${esc(e.dir)}">${esc(e.dir)}</td>
        <td class="fsize">${e.is_dir ? "" : fmtBytes(e.size)}</td>
        <td class="fdate">${fmtDate(e.mtime)}</td>
      </tr>`).join("");
    listEl.innerHTML = `<table class="fp-table">
      <thead><tr><th>Name</th><th>Folder</th><th>Size</th><th>Modified</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    const syncSel = () => listEl.querySelectorAll(".fp-row").forEach(r =>
      r.classList.toggle("sel", P.selIdx.has(+r.dataset.i)));
    listEl.querySelectorAll(".fp-row").forEach(row => {
      const idx = +row.dataset.i, hit = hits[idx];
      row.onclick = ev => {
        if (ev.ctrlKey || ev.metaKey) { P.selIdx.has(idx) ? P.selIdx.delete(idx) : P.selIdx.add(idx); P.anchor = idx; }
        else if (ev.shiftKey && P.anchor !== null) {
          P.selIdx = new Set();
          const [a, b] = [Math.min(P.anchor, idx), Math.max(P.anchor, idx)];
          for (let k = a; k <= b; k++) P.selIdx.add(k);
        } else { P.selIdx = new Set([idx]); P.anchor = idx; }
        syncSel();
      };
      // open a folder, or jump to the folder holding the file and select it
      row.ondblclick = async () => {
        const target = hit.is_dir ? hit.path : hit.dir;
        findBox.value = ""; findNote.textContent = ""; findClear.classList.add("hidden");
        P.searching = false;
        await load(target);
        if (!hit.is_dir) {
          const i = P.entries.findIndex(x => x.name === hit.name);
          if (i >= 0) {
            P.selIdx = new Set([i]); P.anchor = i;
            listEl.querySelectorAll(".fp-row").forEach(r => r.classList.toggle("sel", +r.dataset.i === i));
            listEl.querySelector(`.fp-row[data-i="${i}"]`)?.scrollIntoView({ block: "center" });
          }
        }
      };
      row.ondragstart = ev => {
        if (!P.selIdx.has(idx)) { P.selIdx = new Set([idx]); P.anchor = idx; syncSel(); }
        const items = [...P.selIdx].map(k => hits[k]).filter(Boolean)
          .map(e => ({ path: e.path, is_dir: e.is_dir, name: e.name }));
        ev.dataTransfer.setData("application/x-deck", JSON.stringify({ pane: i, hostId: P.hostId, items }));
        ev.dataTransfer.effectAllowed = "copy";
      };
    });
  }

  pathInput.addEventListener("keydown", e => { if (e.key === "Enter") load(pathInput.value); });
  paneEl.querySelector(".go").onclick = () => load(pathInput.value);
  paneEl.querySelector(".disc").onclick = async () => {
    if (!P.hostId) return;
    try { await invoke("pool_release", { hostId: P.hostId }); } catch (e) {}
    sel.value = ""; P.hostId = null; P.entries = []; P.selIdx = new Set();
    listEl.innerHTML = '<div class="fp-empty">File session released. Terminals untouched. Select a host to browse.</div>';
  };
  paneEl.querySelector(".up").onclick = () => load(parentPath(P.path));

  paneEl.querySelector(".upload").onclick = async () => {
    if (!P.hostId) return;
    const files = await window.__TAURI__.dialog.open({ multiple: true, title: "Upload to " + P.path });
    if (!files) return;
    const host = hostById(P.hostId);
    for (const f of [].concat(files))
      await invoke("sftp_upload", { hostId: P.hostId, localPath: f, remoteDir: P.path, hostLabel: host.label, ...fastOpts() })
        .catch(e => { logUi("ui", e); alert(e); });
  };
  paneEl.querySelector(".dl").onclick = async () => {
    const sel = selected().filter(e => !e.is_dir);
    if (!sel.length) return alert("Select file(s) first (directories: drag to the other pane)");
    const host = hostById(P.hostId);
    for (const e of sel) {
      const dest = await window.__TAURI__.dialog.save({ defaultPath: e.name, title: "Save " + e.name });
      if (!dest) continue;
      await invoke("sftp_download", { hostId: P.hostId, remotePath: joinPath(P.path, e.name), localPath: dest, hostLabel: host.label, ...fastOpts() })
        .catch(e2 => { logUi("ui", e2); alert(e2); });
    }
  };
  paneEl.querySelector(".mkdir").onclick = async () => {
    if (!P.hostId) return;
    const name = prompt("New directory name:");
    if (!name) return;
    try { await invoke("sftp_mkdir", { hostId: P.hostId, path: joinPath(P.path, name) }); load(); }
    catch (e) { logUi("ui", e); alert(e); }
  };
  paneEl.querySelector(".rename").onclick = async () => {
    const sel = selected();
    if (sel.length !== 1) return alert("Select exactly one item");
    const name = prompt("Rename to:", sel[0].name);
    if (!name || name === sel[0].name) return;
    try {
      await invoke("sftp_rename", { hostId: P.hostId, path: joinPath(P.path, sel[0].name), newPath: joinPath(P.path, name) });
      load();
    } catch (e) { logUi("ui", e); alert(e); }
  };
  paneEl.querySelector(".chmod").onclick = async () => {
    const sel = selected();
    if (!sel.length) return alert("Select file(s) first");
    const mode = prompt(`chmod ${sel.length === 1 ? sel[0].name : sel.length + " items"} (octal):`, "644");
    if (!mode) return;
    try {
      for (const e of sel) await invoke("sftp_chmod", { hostId: P.hostId, path: joinPath(P.path, e.name), mode });
      load();
    } catch (e) { logUi("ui", e); alert(e); }
  };
  paneEl.querySelector(".del").onclick = async () => {
    const sel = selected();
    if (!sel.length) return alert("Select file(s) first");
    const label = sel.length === 1 ? `"${sel[0].name}"` : `${sel.length} items`;
    if (!confirm(`Delete ${label}?`)) return;
    try {
      for (const e of sel) await invoke("sftp_delete", { hostId: P.hostId, path: joinPath(P.path, e.name), isDir: e.is_dir });
      load();
    } catch (e) { logUi("ui", e); alert(e); }
  };

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
    const raw = ev.dataTransfer.getData("application/x-deck");
    if (!raw) {
      // files or folders dropped from Explorer → spool their bytes, then upload.
      // Grab the entries synchronously; awaiting first would empty the list.
      const entries = dropEntries(ev.dataTransfer);
      const plain = [...(ev.dataTransfer.files || [])];
      if (entries.length) {
        const { items, dirs } = await expandDrop(entries);
        if (items.length || dirs.length) await uploadLocalFiles(P, items, load, dirs);
      } else if (plain.length) {
        await uploadLocalFiles(P, plain, load);
      }
      return;
    }
    const d = JSON.parse(raw);
    if (d.pane === i && d.hostId === P.hostId) return;
    const src = hostById(d.hostId), dst = hostById(P.hostId);
    for (const item of d.items)
      await invoke("transfer_start", {
        srcHostId: d.hostId, srcPath: item.path, dstHostId: P.hostId, dstDir: P.path,
        isDir: item.is_dir, srcLabel: src.label, dstLabel: dst.label, ...fastOpts(),
      }).catch(e => { logUi("ui", e); alert(e); });
  });
}

/* transfers strip
 *
 * There are two kinds of row and they used to fight. Rows the Rust side owns
 * arrive in the `transfers` event; rows for a local file still being spooled to
 * a temp file exist only here, because the transfer has not started yet. The
 * old code appended the local ones straight into the list, so the next event —
 * including the one "clear finished" triggers — wiped them mid-upload, and the
 * row reappeared later when the real transfer began. Both kinds now go through
 * one render, and only the server ones are ever cleared. */
const PREP = new Map();          // spooling rows, keyed by a local id
let PREP_SEQ = 0;
let SERVER_ROWS = [];

function fmtEta(secs) {
  if (!isFinite(secs) || secs <= 0) return "";
  if (secs < 60) return Math.round(secs) + "s";
  if (secs < 3600) return Math.floor(secs / 60) + "m " + Math.round(secs % 60) + "s";
  return Math.floor(secs / 3600) + "h " + Math.round(secs % 3600 / 60) + "m";
}
function trButton(cls, label, title, fn) {
  const b = document.createElement("button");
  b.className = "btn-ghost small " + cls;
  b.textContent = label;
  b.title = title;
  b.onclick = () => fn(b);
  return b;
}

function renderTransfers() {
  const box = $("#transfers"), el = $("#tr-list");
  // once the real transfer exists under the same description, the prep row has
  // done its job — drop it rather than showing the file twice
  const live = new Set(SERVER_ROWS.map(t => t.desc));
  for (const [k, p] of PREP) if (p.handedOff && live.has(p.desc)) PREP.delete(k);

  const rows = SERVER_ROWS.concat([...PREP.values()]);
  box.classList.toggle("hidden", !rows.length);
  el.innerHTML = "";
  for (const t of rows) {
    const item = document.createElement("div");
    item.className = "tr-item " + t.status;
    const pct = t.total ? Math.round(t.done / t.total * 100) : null;
    // the badge is the only way to tell a streaming transfer from one that
    // quietly fell back to SFTP
    const badge = t.method && t.method !== "sftp"
      ? `<span class="tr-badge ${t.method === "fast+zstd" ? "zstd" : ""}">${esc(t.method)}</span>` : "";
    const avg = t.elapsed_ms > 500 ? t.done / (t.elapsed_ms / 1000) : 0;
    let status;
    if (t.status === "queued") {
      status = "waiting \u00b7 " + fmtBytes(t.total);
    } else if (t.status === "preparing") {
      status = "reading " + fmtBytes(t.done) + " / " + fmtBytes(t.total);
    } else if (t.status === "running") {
      const eta = t.speed && t.total ? fmtEta((t.total - t.done) / t.speed) : "";
      status = fmtBytes(t.done) + (t.total ? " / " + fmtBytes(t.total) : "")
        + (t.speed ? " \u00b7 " + fmtBytes(t.speed) + "/s" : "")
        + (eta ? " \u00b7 " + eta + " left" : "");
    } else if (t.status === "error") {
      status = "\u2717 " + esc(t.error || "failed");
    } else if (t.status === "canceled") {
      status = "\u2715 canceled at " + fmtBytes(t.done);
    } else if (t.status === "paused") {
      status = "\u23f8 paused at " + fmtBytes(t.done) + (t.total ? " / " + fmtBytes(t.total) : "");
    } else {
      status = "\u2713 " + fmtBytes(t.done) + (avg ? " \u00b7 " + fmtBytes(avg) + "/s avg" : "");
    }
    item.innerHTML = `
      <span class="desc" title="${esc(t.desc)}">${esc(t.desc)}</span>${badge}
      <span class="meter"><i style="width:${pct ?? (t.status === "done" ? 100 : 30)}%"></i></span>
      <span class="status">${status}</span>`;

    if (t.status === "queued" || t.status === "preparing") {
      // cancellable from the moment it joins the queue, not only once it starts
      item.appendChild(trButton("tr-act tr-x", "\u2715", "Cancel — drop this file from the queue",
        b => {
          b.disabled = true;
          t.cancel = true;
          if (typeof t.id === "number") invoke("transfer_cancel", { id: t.id });
        }));
    } else if (t.status === "running") {
      item.appendChild(trButton("tr-act", "\u23f8 Pause", "Stop now and keep what has transferred, so Resume can finish it later",
        b => { b.disabled = true; invoke("transfer_pause", { id: t.id }); }));
      item.appendChild(trButton("tr-act tr-x", "\u2715", "Cancel this transfer and delete the partial file",
        b => { b.disabled = true; invoke("transfer_cancel", { id: t.id }); }));
    }
    if (t.resumable) {
      item.appendChild(trButton("tr-act", "\u25b6 Resume", "Pick up from " + fmtBytes(t.done) + " instead of starting over",
        b => {
          b.disabled = true;
          invoke("transfer_resume", { id: t.id, ...fastOpts() }).catch(e => { b.disabled = false; alert(e); });
        }));
    }
    if (t.status !== "running" && t.status !== "preparing") {
      item.appendChild(trButton("tr-act tr-x", "\u2715", "Remove this row", () => forgetRow(t.id)));
    }
    el.appendChild(item);
  }
}

/* a row raised here — a spool that failed before any transfer existed — carries
   a string id, so it is ours to remove; numeric ids belong to Rust */
function forgetRow(id) {
  if (typeof id === "string") {
    SERVER_ROWS = SERVER_ROWS.filter(t => t.id !== id);
    renderTransfers();
  } else {
    invoke("transfer_forget", { id });
  }
}

listen("transfers", ev => {
  // keep local-only rows; the payload only knows about Rust-side transfers
  const localOnly = SERVER_ROWS.filter(t => typeof t.id === "string");
  SERVER_ROWS = ev.payload.concat(localOnly);
  renderTransfers();
  if (ev.payload.some(t => t.status !== "running"))
    PANES.forEach(P => { if (P.hostId && P.load) P.load(); });
});
$("#tr-clear").onclick = () => {
  // never touches anything still in flight, here or on the Rust side
  SERVER_ROWS = SERVER_ROWS.filter(t => typeof t.id !== "string");
  renderTransfers();
  invoke("transfers_clear");
};

/* ---------- tunnels (M4) ---------- */

const TUN_HINT = {
  local:  "Example: Elasticsearch on the server at <code>localhost:9200</code> → set <b>Port on this PC</b> = 15200, <b>Destination</b> = localhost : 9200 → open <code>https://localhost:15200</code> here. Destination can also be another box the server can reach (e.g. 192.168.6.202:8081).",
  remote: "The <b>server</b> opens the listen port; connections there tunnel back to a port on <b>this PC</b>. Example: show your local dev site (localhost:3000) to a colleague on the server: <b>Port on server</b> = 8080, <b>Destination</b> = localhost : 3000. ⚠ The server port must be free — pick something not already used there.",
  socks:  "A SOCKS5 proxy on <b>localhost:PORT</b> here. Point a browser/app at it and all its traffic goes out through the SSH host — no destination needed. Handy for reaching an entire internal network.",
};
const TUN_LABELS = {
  local:  ["Port on this PC", "Destination (as seen from the server)"],
  remote: ["Port on the SERVER", "Destination (as seen from THIS PC)"],
  socks:  ["Proxy port on this PC", ""],
};

async function loadTunnels() {
  const hsel = $("#tun-host");
  hsel.innerHTML = STATE.hosts.map(h => { const u = hostUser(h);
    return `<option value="${h.id}">${esc(h.label)}${u ? " (" + esc(u) + ")" : ""}</option>`; }).join("");
  let list;
  try { list = await invoke("tunnels_list"); } catch (e) { return; }
  const el = $("#tunlist");
  el.innerHTML = list.length ? "" : '<p class="muted">No tunnels yet.</p>';
  for (const t of list) {
    const item = document.createElement("div");
    item.className = "key-item";
    const desc = t.kind === "socks"
      ? `SOCKS5 localhost:${t.listen_port} via ${esc(t.host_label)}`
      : t.kind === "remote"
        ? `${esc(t.host_label)}:${t.listen_port} → this machine ${esc(t.dest_host)}:${t.dest_port}`
        : `localhost:${t.listen_port} → ${esc(t.dest_host)}:${t.dest_port} via ${esc(t.host_label)}`;
    item.innerHTML =
      `<span class="tdot ${t.active ? "on" : ""}"></span>` +
      `<span class="kname">${esc(t.name)}</span><span class="kind-chip">${t.kind}</span>` +
      `<span class="muted">${desc}</span>` +
      `<button class="btn-${t.active ? "danger" : "primary"} small tgl">${t.active ? "Stop" : "Start"}</button>` +
      `<button class="btn-ghost small del">Delete</button>`;
    item.querySelector(".tgl").onclick = async () => {
      try {
        if (t.active) await invoke("tunnel_stop", { id: t.id });
        else await invoke("tunnel_start", { id: t.id });
        loadTunnels();
      } catch (e) { logUi("ui", e); alert(e); }
    };
    item.querySelector(".del").onclick = async () => {
      if (!confirm(`Delete tunnel "${t.name}"?`)) return;
      await invoke("tunnel_delete", { id: t.id });
      loadTunnels();
    };
    el.appendChild(item);
  }
}
listen("tunnels-changed", () => { if ($("#view-tunnels").classList.contains("active")) loadTunnels(); });

function tunKindChanged() {
  const k = $("#tun-kind").value;
  $("#tun-dest-wrap").classList.toggle("hidden", k === "socks");
  $("#tun-hint").innerHTML = TUN_HINT[k];
  $("#tun-lport-label").textContent = TUN_LABELS[k][0];
  $("#tun-dest-label").textContent = TUN_LABELS[k][1];
  $("#tun-lport").placeholder = k === "socks" ? "1080" : k === "remote" ? "8080" : "15200";
}
$("#tun-kind").onchange = tunKindChanged;
tunKindChanged();

$("#tun-add").onclick = async () => {
  const kind = $("#tun-kind").value;
  const args = {
    hostId: parseInt($("#tun-host").value),
    name: $("#tun-name").value.trim(),
    kind,
    listenPort: parseInt($("#tun-lport").value),
    destHost: kind === "socks" ? "" : ($("#tun-dhost").value.trim() || "localhost"),
    destPort: kind === "socks" ? 0 : parseInt($("#tun-dport").value),
  };
  if (!args.hostId || !args.listenPort || (kind !== "socks" && !args.destPort)) {
    alert("SSH host, listen port" + (kind !== "socks" ? " and destination port" : "") + " are required");
    return;
  }
  if (!args.name) args.name = `${kind}-${args.listenPort}`;
  try {
    await invoke("tunnel_save", args);
    $("#tun-name").value = $("#tun-lport").value = $("#tun-dport").value = "";
    loadTunnels();
  } catch (e) { logUi("ui", e); alert(e); }
};

/* ---------- preferences: cursor, safety ---------- */

$("#pref-cursor-style").value = PREFS.cursorStyle;
$("#pref-cursor-motion").value = PREFS.cursorMotion;
$("#pref-fast").checked = PREFS.fastTransfer;
$("#pref-fast").onchange = e => savePref("fastTransfer", e.target.checked);
$("#pref-fast-min").value = PREFS.fastMinMb;
$("#pref-fast-min").onchange = e => {
  const v = Math.max(1, parseInt(e.target.value) || 64);
  e.target.value = v;
  savePref("fastMinMb", v);
};
$("#pref-warn-tab").checked = PREFS.warnCloseTab;
$("#pref-warn-quit").checked = PREFS.warnQuit;
$("#pref-cursor-style").onchange = e => { savePref("cursorStyle", e.target.value); applyCursorPrefs(); };
$("#pref-cursor-motion").onchange = e => { savePref("cursorMotion", e.target.value); applyCursorPrefs(); };
$("#pref-warn-tab").onchange = e => savePref("warnCloseTab", e.target.checked);
$("#pref-warn-quit").onchange = e => savePref("warnQuit", e.target.checked);
applyCursorPrefs();

/* quit warning: intercept window close while SSH sessions are live */
(async () => {
  try {
    const win = window.__TAURI__.window.getCurrentWindow();
    await win.onCloseRequested(async ev => {
      const n = liveSessionCount();
      if (!PREFS.warnQuit || !n) return;
      ev.preventDefault();
      const c = await choose("Quit SSHDeck?",
        `<b>${n} SSH session${n > 1 ? "s are" : " is"}</b> still connected. Quitting disconnects ${n > 1 ? "them" : "it"}.`,
        [{ label: "Cancel", value: null }, { label: "Quit", value: "yes", cls: "btn-danger" }]);
      if (c === "yes") { savePref("warnQuit", PREFS.warnQuit); await win.destroy(); }
    });
  } catch (e) { /* window API unavailable (dev in browser) */ }
})();

/* ---------- factory reset ---------- */

$("#factory-reset").onclick = async () => {
  const typed = prompt('This deletes ALL SSHDeck data on this machine and restarts the app.\nType RESET to confirm:');
  if (typed !== "RESET") return;
  try {
    localStorage.clear();
    await invoke("factory_reset");
  } catch (e) { logUi("ui", e); alert(e); }
};

/* ---------- import web backup ---------- */

$("#deck-import").onclick = async () => {
  const path = await window.__TAURI__.dialog.open({
    multiple: false, title: "Select sshdeck-backup.json",
    filters: [{ name: "SSHDeck backup", extensions: ["json"] }],
  });
  if (!path) return;
  $("#deck-result").textContent = "importing…";
  try {
    const r = await invoke("import_backup", { path });
    $("#deck-result").textContent =
      `✓ ${r.hosts} hosts, ${r.folders} folders, ${r.identities} identities, ${r.keys} keys imported (${r.skipped} duplicate hosts skipped)`;
    loadState();
  } catch (e) { $("#deck-result").textContent = "✗ " + e; }
};

$("#deck-export").onclick = async () => {
  const path = await window.__TAURI__.dialog.save({
    title: "Save full backup", defaultPath: "sshdeck-backup.json",
    filters: [{ name: "SSHDeck backup", extensions: ["json"] }],
  });
  if (!path) return;
  try {
    const n = await invoke("export_backup", { path });
    $("#deck-result").textContent = `✓ exported ${n} hosts → ${path}`;
  } catch (e) { $("#deck-result").textContent = "✗ " + e; }
};

$("#moba-export").onclick = async () => {
  const path = await window.__TAURI__.dialog.save({
    title: "Export MobaXterm bookmarks", defaultPath: "sshdeck-export.mobaconf",
    filters: [{ name: "MobaXterm config", extensions: ["mobaconf"] }],
  });
  if (!path) return;
  try {
    const n = await invoke("export_mobaconf", { path });
    $("#moba-result").textContent = `✓ exported ${n} sessions → ${path}`;
  } catch (e) { $("#moba-result").textContent = "✗ " + e; }
};

$("#moba-import").onclick = async () => {
  const path = await window.__TAURI__.dialog.open({
    multiple: false, title: "Select MobaXterm .mobaconf",
    filters: [{ name: "MobaXterm config", extensions: ["mobaconf", "ini", "txt"] }],
  });
  if (!path) return;
  $("#moba-result").textContent = "importing…";
  try {
    const r = await invoke("import_mobaconf", { path });
    $("#moba-result").textContent = `✓ ${r.imported} sessions imported, ${r.skipped} duplicates skipped`;
    loadState();
  } catch (e) { $("#moba-result").textContent = "✗ " + e; }
};

/* terminal prefs: highlighting + scrollback */
$("#hl-toggle").checked = HL_ON;
$("#hl-toggle").onchange = e => {
  HL_ON = e.target.checked;
  localStorage.setItem("deck.hl", HL_ON ? "1" : "0");
};
$("#sb-lines").value = PREFS.scrollback;
$("#sb-lines").onchange = e => {
  const v = Math.min(200000, Math.max(1000, parseInt(e.target.value) || 50000));
  e.target.value = v;
  savePref("scrollback", v);
  for (const tab of TABS.values()) for (const i of tab.insts) i.term.options.scrollback = v;
};

/* show/hide password inputs (create/edit forms only — saved secrets never come back) */
document.addEventListener("click", e => {
  const btn = e.target.closest(".eye");
  if (!btn) return;
  const input = document.getElementById(btn.dataset.for);
  if (!input) return;
  input.type = input.type === "password" ? "text" : "password";
  btn.classList.toggle("on", input.type === "text");
});

/* ---------- boot ---------- */

/* stamp the build into the UI and into the log, so a saved log always says
   which version produced it */
(async () => {
  try {
    const v = await invoke("app_version");
    $("#version").textContent = "v" + v;
    invoke("log_add", { level: "info", src: "app", msg: "SSHDeck v" + v + " started" }).catch(() => {});
  } catch (e) { $("#version").textContent = "v?"; }
})();

loadLogs();
try { applyTheme(JSON.parse(localStorage.getItem("deck.theme")) || PRESETS.zeegly, false); }
catch (e) { applyTheme(PRESETS.zeegly, false); }
loadState();
