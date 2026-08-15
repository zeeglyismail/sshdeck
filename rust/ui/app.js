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
  for (const t of TABS.values()) t.term.options.theme = ACTIVE_THEME.terminal;
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

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtRate(n) {
  const mbps = n * 8 / 1e6;
  return mbps >= 1 ? mbps.toFixed(2) + " Mb/s" : (n / 1024).toFixed(1) + " kB/s";
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

function renderTree() {
  const filter = $("#filter").value.trim().toLowerCase();
  const tree = $("#tree");
  tree.innerHTML = "";
  const match = h => !filter || h.label.toLowerCase().includes(filter) ||
    h.hostname.toLowerCase().includes(filter) || h.username.toLowerCase().includes(filter);
  const groups = [{ id: null, name: "" }, ...STATE.folders];
  for (const f of groups) {
    const hosts = STATE.hosts.filter(h => h.folder_id === f.id && match(h));
    if (f.id !== null && !hosts.length && filter) continue;
    if (f.id !== null) {
      const fe = document.createElement("div");
      const closed = closedFolders.has(f.id) && !filter;
      fe.className = "tree-folder" + (closed ? " closed" : "");
      fe.innerHTML = `<span class="arrow">▼</span><span>${esc(f.name)}</span>`;
      fe.onclick = () => {
        closedFolders.has(f.id) ? closedFolders.delete(f.id) : closedFolders.add(f.id);
        localStorage.setItem("deck.closed", JSON.stringify([...closedFolders]));
        renderTree();
      };
      fe.oncontextmenu = e => ctxMenu(e, [
        { label: "Delete", danger: true, fn: async () => {
            if (confirm(`Delete folder "${f.name}"? (hosts move to root)`)) {
              await invoke("folder_delete", { id: f.id });
              loadState();
            }
          } },
      ]);
      tree.appendChild(fe);
      if (closed) continue;
    }
    for (const h of hosts) {
      const ident = h.identity_id ? STATE.identities.find(i => i.id === h.identity_id) : null;
      const shownUser = h.auth_type === "identity" && ident ? ident.username : h.username;
      const he = document.createElement("div");
      he.className = "tree-host";
      he.title = `${shownUser}@${h.hostname}:${h.port}`;
      he.innerHTML = `<span class="hicon">●</span><span class="hlabel">${esc(h.label)}</span>` +
        `<span class="hmeta">${esc(shownUser)}</span>`;
      he.onclick = () => openSshTerminal(h);
      he.oncontextmenu = e => ctxMenu(e, [
        { label: "Connect", fn: () => openSshTerminal(h) },
        { label: "Edit", fn: () => openHostModal(h) },
        { label: "Delete", danger: true, fn: async () => {
            if (!confirm(`Delete host "${h.label}"?`)) return;
            await invoke("host_delete", { id: h.id });
            loadState();
          } },
      ]);
      tree.appendChild(he);
    }
  }
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

function makeTab(title) {
  const id = ++seq;
  $("#empty").style.display = "none";
  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.innerHTML = `<span class="tlabel">${esc(title)}</span><button class="x" title="close">✕</button>`;
  $("#tabbar").appendChild(tabEl);
  const pane = document.createElement("div");
  pane.className = "pane";
  const el = document.createElement("div");
  el.className = "term-el";
  pane.appendChild(el);
  $("#panes").appendChild(pane);

  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: FONT_SIZE,
    theme: ACTIVE_THEME.terminal, cursorStyle: "bar", cursorBlink: false, scrollback: 50000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);

  // zoom + copy/paste parity with the web app
  el.addEventListener("wheel", ev => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    setFontSize(FONT_SIZE + (ev.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) navigator.clipboard.writeText(sel).catch(() => {});
  });

  return { id, tabEl, pane, term, fit };
}

function registerTab(t) {
  TABS.set(t.id, t);
  t.tabEl.onclick = e => {
    if (e.target.classList.contains("x")) { t.close(); return; }
    activateTab(t.id);
  };
  t.tabEl.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });
  t.tabEl.addEventListener("auxclick", e => { if (e.button === 1) { e.preventDefault(); t.close(); } });
  activateTab(t.id);
}

function activateTab(id) {
  activeTab = id;
  for (const [tid, t] of TABS) {
    t.pane.classList.toggle("active", tid === id);
    t.tabEl.classList.toggle("active", tid === id);
  }
  const t = TABS.get(id);
  if (t) {
    if (t.host) {
      $("#statusbar").classList.remove("hidden");
      $("#st-label").textContent = t.host.label;
      $("#st-addr").textContent = ` · ${t.host.hostname}:${t.host.port}`;
      renderStats(t);
      updateConn(t);
    } else {
      $("#statusbar").classList.add("hidden");
    }
    setTimeout(() => { t.sendResize(); t.term.focus(); }, 10);
  }
}

function removeTab(t) {
  t.unsubs.forEach(u => u());
  t.term.dispose();
  t.pane.remove();
  t.tabEl.remove();
  TABS.delete(t.id);
  if (activeTab === t.id) {
    const last = [...TABS.keys()].pop();
    if (last) activateTab(last);
    else { activeTab = null; $("#statusbar").classList.add("hidden"); $("#empty").style.display = ""; }
  }
}

function fitActive() {
  const t = TABS.get(activeTab);
  if (t) t.sendResize();
}
window.addEventListener("resize", fitActive);

function setFontSize(size) {
  FONT_SIZE = Math.min(28, Math.max(7, size));
  localStorage.setItem("deck.fontsize", FONT_SIZE);
  for (const t of TABS.values()) { t.term.options.fontSize = FONT_SIZE; t.sendResize(); }
}

/* local terminal */
async function openLocalTerm() {
  const t = makeTab("PowerShell");
  t.host = null;
  t.unsubs = [];
  t.sendResize = () => {
    try { t.fit.fit(); } catch (e) {}
    invoke("pty_resize", { id: t.id, cols: t.term.cols, rows: t.term.rows });
  };
  t.close = () => { invoke("pty_kill", { id: t.id }); removeTab(t); };
  t.unsubs.push(await listen(`pty-out-${t.id}`, ev => t.term.write(new Uint8Array(ev.payload))));
  t.unsubs.push(await listen(`pty-exit-${t.id}`, () => t.term.write("\r\n\x1b[1;33m— process exited —\x1b[0m\r\n")));
  await invoke("pty_spawn", { id: t.id, shell: null });
  t.term.onData(d => invoke("pty_write", { id: t.id, data: d }));
  new ResizeObserver(() => { if (t.pane.classList.contains("active")) t.sendResize(); }).observe(t.pane);
  registerTab(t);
  setTimeout(t.sendResize, 50);
}
$("#new-local").onclick = openLocalTerm;

/* ssh terminal */
async function openSshTerminal(host) {
  showView("terms");
  const t = makeTab(host.label);
  t.host = host;
  t.dead = false;
  t.unsubs = [];
  t.stats = null;
  t.prev = {};
  t.cpuHist = [];
  t.netHist = [];
  t.sendResize = () => {
    try { t.fit.fit(); } catch (e) {}
    if (!t.dead) invoke("ssh_resize", { id: t.id, cols: t.term.cols, rows: t.term.rows });
  };
  t.close = () => { invoke("ssh_kill", { id: t.id }); removeTab(t); };

  t.unsubs.push(await listen(`pty-out-${t.id}`, ev => t.term.write(new Uint8Array(ev.payload))));
  t.unsubs.push(await listen(`pty-exit-${t.id}`, () => {
    t.dead = true;
    t.term.write("\r\n\x1b[1;33m— disconnected — press Enter to reconnect —\x1b[0m\r\n");
    if (activeTab === t.id) updateConn(t);
  }));
  t.unsubs.push(await listen(`stats-${t.id}`, ev => {
    const s = parseStats(ev.payload, t.prev);
    if (!s) return;
    t.stats = s;
    t.cpuHist.push(s.cpu);
    if (t.cpuHist.length > 60) t.cpuHist.shift();
    t.netHist.push({ rx: s.rx_rate, tx: s.tx_rate });
    if (t.netHist.length > 60) t.netHist.shift();
    if (activeTab === t.id) { renderStats(t); updateConn(t); }
  }));

  t.term.onData(d => {
    if (t.dead) {
      if (d.includes("\r")) {
        t.dead = false;
        t.term.write("\x1b[36m… reconnecting …\x1b[0m\r\n");
        invoke("ssh_spawn", { id: t.id, hostId: host.id }).then(() => setTimeout(t.sendResize, 400))
          .catch(e => { t.dead = true; t.term.write(`\r\n\x1b[1;31m✗ ${e}\x1b[0m\r\n`); });
      }
      return;
    }
    invoke("ssh_write", { id: t.id, data: d });
  });

  new ResizeObserver(() => { if (t.pane.classList.contains("active")) t.sendResize(); }).observe(t.pane);
  registerTab(t);
  try {
    await invoke("ssh_spawn", { id: t.id, hostId: host.id });
    setTimeout(t.sendResize, 400);
  } catch (e) {
    t.dead = true;
    t.term.write(`\r\n\x1b[1;31m✗ ${e}\x1b[0m\r\n`);
  }
}

function updateConn(t) {
  $("#st-conn").textContent = t.dead ? "disconnected" : "connected";
  $("#st-conn").classList.toggle("err", t.dead);
  $(".st-host").classList.toggle("err", t.dead);
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
  let rx = 0, tx = 0;
  for (const line of parts[3].split("\n").slice(2)) {
    const [name, rest] = line.split(":");
    if (!rest || name.trim() === "lo") continue;
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
  if (name === "files") renderPaneHostOptions();
}

/* ---------- host modal ---------- */

let editingHost = null;

function openHostModal(host) {
  editingHost = host || null;
  $("#hm-title").textContent = host ? "Edit host" : "Add host";
  $("#hm-delete").classList.toggle("hidden", !host);
  $("#hm-folder").innerHTML = '<option value="">(no folder)</option>' +
    STATE.folders.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
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
  } catch (e) { alert(e); }
};

$("#hm-delete").onclick = async () => {
  if (!editingHost || !confirm(`Delete host "${editingHost.label}"?`)) return;
  await invoke("host_delete", { id: editingHost.id });
  $("#modal-bg").classList.add("hidden");
  loadState();
};

$("#add-host").onclick = () => openHostModal(null);
$("#add-folder").onclick = async () => {
  const name = prompt("Folder name:");
  if (name && name.trim()) { await invoke("folder_save", { name: name.trim() }); loadState(); }
};

/* ---------- identities & keys ---------- */

function renderIdentities() {
  const el = $("#identlist");
  el.innerHTML = STATE.identities.length ? "" : '<p class="muted">No identities yet.</p>';
  for (const i of STATE.identities) {
    const item = document.createElement("div");
    item.className = "key-item";
    item.innerHTML = `<span class="kname">👤 ${esc(i.name)}</span><span class="muted">${esc(i.username)}</span>` +
      `<button class="btn-danger small">Delete</button>`;
    item.querySelector("button").onclick = async () => {
      if (!confirm(`Delete identity "${i.name}"?`)) return;
      try { await invoke("identity_delete", { id: i.id }); loadState(); } catch (e) { alert(e); }
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
      if (!confirm(`Delete key "${k.name}"?`)) return;
      try { await invoke("key_delete", { id: k.id }); loadState(); } catch (e) { alert(e); }
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

function renderPaneHostOptions() {
  $$(".fpane").forEach((paneEl, i) => {
    if (!paneEl.dataset.built) buildPane(paneEl, i);
    const P = PANES[i];
    const dl = paneEl.querySelector("datalist");
    P.optMap = {};
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

  pathInput.addEventListener("keydown", e => { if (e.key === "Enter") load(pathInput.value); });
  paneEl.querySelector(".go").onclick = () => load(pathInput.value);
  paneEl.querySelector(".up").onclick = () => load(parentPath(P.path));

  paneEl.querySelector(".upload").onclick = async () => {
    if (!P.hostId) return;
    const files = await window.__TAURI__.dialog.open({ multiple: true, title: "Upload to " + P.path });
    if (!files) return;
    const host = hostById(P.hostId);
    for (const f of [].concat(files))
      await invoke("sftp_upload", { hostId: P.hostId, localPath: f, remoteDir: P.path, hostLabel: host.label })
        .catch(e => alert(e));
  };
  paneEl.querySelector(".dl").onclick = async () => {
    const sel = selected().filter(e => !e.is_dir);
    if (!sel.length) return alert("Select file(s) first (directories: drag to the other pane)");
    const host = hostById(P.hostId);
    for (const e of sel) {
      const dest = await window.__TAURI__.dialog.save({ defaultPath: e.name, title: "Save " + e.name });
      if (!dest) continue;
      await invoke("sftp_download", { hostId: P.hostId, remotePath: joinPath(P.path, e.name), localPath: dest, hostLabel: host.label })
        .catch(e2 => alert(e2));
    }
  };
  paneEl.querySelector(".mkdir").onclick = async () => {
    if (!P.hostId) return;
    const name = prompt("New directory name:");
    if (!name) return;
    try { await invoke("sftp_mkdir", { hostId: P.hostId, path: joinPath(P.path, name) }); load(); }
    catch (e) { alert(e); }
  };
  paneEl.querySelector(".rename").onclick = async () => {
    const sel = selected();
    if (sel.length !== 1) return alert("Select exactly one item");
    const name = prompt("Rename to:", sel[0].name);
    if (!name || name === sel[0].name) return;
    try {
      await invoke("sftp_rename", { hostId: P.hostId, path: joinPath(P.path, sel[0].name), newPath: joinPath(P.path, name) });
      load();
    } catch (e) { alert(e); }
  };
  paneEl.querySelector(".chmod").onclick = async () => {
    const sel = selected();
    if (!sel.length) return alert("Select file(s) first");
    const mode = prompt(`chmod ${sel.length === 1 ? sel[0].name : sel.length + " items"} (octal):`, "644");
    if (!mode) return;
    try {
      for (const e of sel) await invoke("sftp_chmod", { hostId: P.hostId, path: joinPath(P.path, e.name), mode });
      load();
    } catch (e) { alert(e); }
  };
  paneEl.querySelector(".del").onclick = async () => {
    const sel = selected();
    if (!sel.length) return alert("Select file(s) first");
    const label = sel.length === 1 ? `"${sel[0].name}"` : `${sel.length} items`;
    if (!confirm(`Delete ${label}?`)) return;
    try {
      for (const e of sel) await invoke("sftp_delete", { hostId: P.hostId, path: joinPath(P.path, e.name), isDir: e.is_dir });
      load();
    } catch (e) { alert(e); }
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
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.pane === i && d.hostId === P.hostId) return;
    const src = hostById(d.hostId), dst = hostById(P.hostId);
    for (const item of d.items)
      await invoke("transfer_start", {
        srcHostId: d.hostId, srcPath: item.path, dstHostId: P.hostId, dstDir: P.path,
        isDir: item.is_dir, srcLabel: src.label, dstLabel: dst.label,
      }).catch(e => alert(e));
  });
}

/* transfers strip */
listen("transfers", ev => {
  const list = ev.payload;
  const box = $("#transfers");
  const el = $("#tr-list");
  box.classList.toggle("hidden", !list.length);
  el.innerHTML = "";
  let anyDone = false;
  for (const t of list) {
    if (t.status !== "running") anyDone = true;
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
  if (anyDone) PANES.forEach(P => { if (P.hostId && P.load) P.load(); });
});
$("#tr-clear").onclick = () => invoke("transfers_clear");

/* ---------- boot ---------- */

try { applyTheme(JSON.parse(localStorage.getItem("deck.theme")) || PRESETS.zeegly, false); }
catch (e) { applyTheme(PRESETS.zeegly, false); }
loadState();
