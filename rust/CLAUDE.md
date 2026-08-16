# CLAUDE.md — SSHDeck Desktop (Rust/Tauri experiment)

Context for AI assistants working in `rust/`. Read the repo-root `CLAUDE.md` first
for overall project rules; this file governs the desktop build only.

## Why this directory exists

The owner wants a native desktop app (no browser) like MobaXterm/Termius/Tabby,
optimized hard for disk/CPU/RAM. Decision: **prototype in Rust (Tauri 2) first and
measure**; if the savings don't justify the rewrite cost, fall back to
pywebview + PyInstaller reusing the Python backend. The web/Docker version at the
repo root stays alive either way — this is a second product from the same repo.

## Evaluation gate (fill in when measured)

| Metric              | Target (Tauri) | pywebview est. | Measured (M1, release)        |
|---------------------|----------------|----------------|-------------------------------|
| exe / install size  | ≤ 15 MB        | ~60 MB         | **3.0 MB** (M1) → **5.7 MB** (M5, full feature set) single exe |
| idle RAM (1 tab)    | ≤ 200 MB       | ~250 MB        | **29 MB** main + ~327 MB WebView2 pool (system-shared, same for any webview approach) |
| cold start          | < 1 s          | ~2 s           | **305 ms** to window          |

**DECISION (owner-approved after M1 demo): Rust/Tauri it is.** 3 MB exe, 0.3 s start,
tiny main process — pywebview fallback is dead; all desktop work continues here.
The WebView2 pool cost is identical for every webview framework, so Rust wins on
everything that differs. Owner's reaction to M1: "feels super smooth".

## Architecture (desktop)

- **Tauri 2**, `withGlobalTauri: true`, no frontend framework — plain HTML/JS like
  the web app, xterm.js vendored via `ui/package.json` (`npm i && npm run vendor`).
- Rust backend replaces FastAPI entirely (no localhost server, no Python):
  - terminal I/O over Tauri events: `pty-out-{id}` (bytes), commands
    `pty_spawn/pty_write/pty_resize`
  - local terminals: `portable-pty` (ConPTY on Windows → PowerShell/cmd/WSL;
    /bin/bash etc. on Linux)
  - SSH (Milestone 2): `russh` + `russh-sftp` — same features as the web app's
    `ssh_manager.py`: one pooled connection per host, channels for shell/sftp/stats
  - storage: `rusqlite`, same schema ideas as `app/db.py`; secrets via Windows
    DPAPI / OS keychain (better than the web version's on-disk Fernet key)
  - data dir: `%APPDATA%/SSHDeck` (Windows), `~/.local/share/sshdeck` (Linux)
- UI: port `static/app.js` piecemeal — keep the same look (Moba dark, Cascadia).

## Feature checklist for the desktop (owner's asks)

- [x] Local terminal tabs (PowerShell / cmd / WSL picker) — M1
- [x] SSH terminals with saved hosts/identities/keys — M2
- [x] Monitoring bar + graphs (reuse stats command from `app/ws.py`) — M2
- [x] SFTP dual pane + host↔host transfer — M3 (russh-sftp; native file dialogs
      for upload/download; live progress via `transfers` event)
- [x] Tunnels: local→remote, **remote→local**, SOCKS — natively bound, no Docker — M4
- [x] Splits + MultiExec (broadcast typing) — removed from web on purpose,
      REQUESTED for desktop — M5. **Each split lets you choose its source:
      a LOCAL terminal (PowerShell/cmd/WSL) or ANY saved host** — owner explicit.
- [x] **Cursor style option in Settings: block / bar / underline + blink style
      (steady / blink / VS Code expand-pulse)** — M5
- [x] **Theme presets (owner explicit): exactly ~5 built-ins, no 10+ gallery.
      Default preset is named "zeegly" — the current SSHDeck Moba-dark palette.
      Others from well-known terminal schemes (Dracula, Nord, One Dark, Gruvbox).
      JSON import stays (same schema as the web app) so any theme can be pasted.**
- [x] Middle-click closes tabs (parity with web) — M1
- [x] Close warnings: tab with live session + app quit (toggleable) — M5
- [x] Factory reset button (wipe data dir, type-to-confirm, relaunch) — M5
- [x] mobaconf import/export + sshdeck-backup.json import/export (`export.rs`) — M5
- [ ] X11 forwarding via user-installed VcXsrv — post-M5, optional

## Milestones

1. **M1 — footprint proof** (current): Tauri shell + xterm + working local
   PowerShell terminal. Build release exe, record metrics in the table above.
2. **M2 — SSH core**: russh connect (password/key), PTY channel, reconnect-on-Enter,
   host store in rusqlite, stats channel + monitoring bar.
3. **M3 — files**: russh-sftp browse/upload/download + server-side transfer.
4. **M4 — tunnels** both directions + SOCKS.
5. **M5 — polish**: splits/multiexec, cursor options, warnings, reset, import.

## Build (Windows)

Prereqs (one-time): VS Build Tools C++ workload, rustup (MSVC toolchain),
WebView2 runtime (preinstalled on Win 10/11), Node (for vendoring xterm).

```
cd rust/src-tauri
cargo build --release          # plain exe  → target/release/sshdeck-desktop.exe
cargo tauri build              # + installer → target/release/bundle/nsis/SSHDeck_<ver>_x64-setup.exe
```

If `cargo tauri` is missing: `cargo install tauri-cli --locked`.
**Kill any running sshdeck-desktop.exe first** — Windows locks the binary and the
build fails with "Access is denied (os error 5)".
Icons in `src-tauri/icons/` (32/128/128@2x png + multi-size ico) are generated,
not hand-drawn; bundle config lives in `tauri.conf.json` → `bundle` (NSIS,
installMode currentUser = no admin prompt).

## Gotchas learned the hard way

- **Launch the RELEASE exe for the owner** (`cargo build --release`, target/release/): the debug
  exe attaches a console window that shows harmless WebView2 log noise. Release has
  `windows_subsystem = "windows"` → no console.
- **The exe embeds `ui/` at compile time.** Every frontend edit needs
  `cargo build` + relaunch — there is no hard-refresh. (Kill the running exe first
  or the linker can't overwrite it.)
- **`dragDropEnabled: false`** in `tauri.conf.json` is required — Tauri's native
  drag-drop interception swallows all HTML5 `dragstart` events on Windows; without
  it no in-app drag & drop (files between panes, hosts to folders) works.
- File dialogs need `tauri-plugin-dialog` + `dialog:default` permission.
- **russh is pinned to 0.52** — chosen deliberately: 0.46's keyboard-interactive
  was broken (hangs), and 0.6x pulls aws-lc-sys (needs CMake/NASM on Windows, fatter
  exe). 0.52 = ring backend + working kbd-interactive + native async traits.
- **Auth MUST try password THEN keyboard-interactive.** The owner's Ubuntu fleet
  advertises only `publickey,keyboard-interactive` (no plain password) — asyncssh
  falls back silently, russh does not. See `connect()` in ssh.rs. Never remove
  the fallback: it's why the "authentication rejected" bug happened.
- russh 0.5x API: no `#[async_trait]`, `russh::keys::PublicKey`, auth returns
  `AuthResult` (`.success()`), publickey needs `PrivateKeyWithHashAlg`,
  `Handle` is not Clone (wrap in Arc).
- Emoji glyphs (👁) ignore CSS `color` → use inline SVG with `currentColor`.

## Status

M1 ✓ shell/local PTY · M2 ✓ SSH/hosts/monitoring/themes · M3 ✓ SFTP dual pane,
host↔host transfer, upload/download via native dialogs, nested folders, full
sidebar parity with the web app (edit ✎, duplicate, rename, drag to folder/root)
· M4 ✓ tunnels: local (-L), remote (-R), SOCKS5 (-D) in `tunnels.rs`, natively
bound on 127.0.0.1; local + socks share the pooled connection, remote opens a
dedicated connection whose `Client.forwarded` channel receives server-opened
channels (Handler::server_channel_open_forwarded_tcpip). Local -L verified
end-to-end against ls01 (SSH banner through 127.0.0.1:49555).
· M5 ✓ polish: tabs are containers of split instances (`tab.insts`, each
`{kind:"local"}` or `{kind:"ssh", host}`) — ◫/⬓ open a picker (local terminal
or any saved host), nestable; ⌨ ALL = MultiExec broadcast per tab with per-split
opt-out; cursor prefs (bar/block/underline × phase/blink/steady, `PREFS`,
body[data-cursor-motion]); close warnings for live SSH on tab/split close and app
quit (`onCloseRequested`, needs core:window:allow-destroy); factory reset
(`portability::factory_reset` wipes data dir + `app.restart()`); import of the
web app's `sshdeck-backup.json` v1/v2 incl. nested folder paths.
Headless test recipe: build a shim page (`_shim_test.html`, stubbed
`window.__TAURI__`) served on a local port and drive it via the browser tool —
verified splits/MultiExec/prefs with zero JS errors. Delete the shim afterwards.
· **v1.0.0 shipped**: NSIS installer `SSHDeck_1.0.0_x64-setup.exe` (2.2 MB
installer, 5.7 MB exe, no admin needed, per-user install).
Next: GitHub Release + Linux CI matrix, then host-key verification (TOFU),
mobaconf import in desktop, X11 via VcXsrv (optional).

## Parity discipline (owner asked twice — do not skip)

Before calling a desktop milestone done, DIFF against the web app and port
anything missing. Quick check:
`for f in hlApply HL_ON SCROLLBACK pasteClipboard flipMove dragTabEl datalist disc   export/sshdeck export/mobaconf; do grep -c "$f" static/app.js rust/ui/app.js; done`
Features that were missed once and had to be back-filled: output highlighting,
scrollback setting, middle-click/Ctrl+Shift paste, tab drag-reorder with FLIP
preview, SFTP release button, backup/mobaconf EXPORT (import existed).

## Rules

- Never break the web app while working here; shared repo, separate directory.
- Keep the UI visually identical to the web version unless the owner asks.
- Measure before adding dependencies — footprint is the whole point of this branch
  of work.
