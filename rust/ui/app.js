/* SSHDeck desktop M1 — local terminals over Tauri commands/events */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = s => document.querySelector(s);
const TABS = new Map();
let seq = 0;
let active = null;

const THEME = {
  background: "#2b2b2b", foreground: "#e6e1dc",
  cursor: "#ffffff", selectionBackground: "#44705a",
  black: "#2b2b2b", red: "#e5534b", green: "#4cc38a", yellow: "#e2b93d",
  blue: "#3fa9f5", magenta: "#c678dd", cyan: "#56b6c2", white: "#e6e1dc",
  brightBlack: "#6b6b70", brightRed: "#ff6f66", brightGreen: "#6fe0a8",
  brightYellow: "#ffd75f", brightBlue: "#6fc3ff", brightMagenta: "#db94ff",
  brightCyan: "#7ee7f2", brightWhite: "#ffffff",
};

async function newLocalTerm() {
  const id = ++seq;
  $("#empty").style.display = "none";

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.innerHTML = `<span>PowerShell ${id}</span><button class="x">✕</button>`;
  tabEl.onclick = e => {
    if (e.target.classList.contains("x")) { closeTab(id); return; }
    activate(id);
  };
  tabEl.addEventListener("auxclick", e => { if (e.button === 1) { e.preventDefault(); closeTab(id); } });
  $("#tabbar").appendChild(tabEl);

  const pane = document.createElement("div");
  pane.className = "pane";
  const el = document.createElement("div");
  el.className = "term-el";
  pane.appendChild(el);
  $("#panes").appendChild(pane);

  const term = new Terminal({
    fontFamily: '"Cascadia Code", Consolas, monospace', fontSize: 13,
    theme: THEME, cursorStyle: "bar", cursorBlink: false, scrollback: 50000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const unlisten = await listen(`pty-out-${id}`, ev => term.write(new Uint8Array(ev.payload)));
  const unExit = await listen(`pty-exit-${id}`, () => term.write("\r\n\x1b[1;33m— process exited —\x1b[0m\r\n"));

  await invoke("pty_spawn", { id, shell: null });
  term.onData(d => invoke("pty_write", { id, data: d }));

  const sendResize = () => {
    try { fit.fit(); } catch (e) {}
    invoke("pty_resize", { id, cols: term.cols, rows: term.rows });
  };
  new ResizeObserver(() => { if (pane.classList.contains("active")) sendResize(); }).observe(pane);

  TABS.set(id, { term, fit, tabEl, pane, unlisten, unExit, sendResize });
  activate(id);
  setTimeout(sendResize, 50);
}

function activate(id) {
  active = id;
  for (const [tid, t] of TABS) {
    t.pane.classList.toggle("active", tid === id);
    t.tabEl.classList.toggle("active", tid === id);
  }
  const t = TABS.get(id);
  if (t) setTimeout(() => { t.sendResize(); t.term.focus(); }, 10);
}

function closeTab(id) {
  const t = TABS.get(id);
  if (!t) return;
  invoke("pty_kill", { id });
  t.unlisten(); t.unExit();
  t.term.dispose();
  t.pane.remove();
  t.tabEl.remove();
  TABS.delete(id);
  if (active === id) {
    const last = [...TABS.keys()].pop();
    if (last) activate(last);
    else $("#empty").style.display = "";
  }
}

$("#new-term").onclick = newLocalTerm;
window.addEventListener("resize", () => { const t = TABS.get(active); if (t) t.sendResize(); });
