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
| exe / install size  | ≤ 15 MB        | ~60 MB         | **3.0 MB** single exe         |
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

- [ ] Local terminal tabs (PowerShell / cmd / WSL picker) — M1
- [ ] SSH terminals with saved hosts/identities/keys — M2
- [ ] Monitoring bar + graphs (reuse stats command from `app/ws.py`) — M2
- [x] SFTP dual pane + host↔host transfer — M3 (russh-sftp; native file dialogs
      for upload/download; live progress via `transfers` event)
- [ ] Tunnels: local→remote, **remote→local**, SOCKS — natively bound, no Docker — M4
- [ ] Splits + MultiExec (broadcast typing) — removed from web on purpose,
      REQUESTED for desktop — M5. **Each split lets you choose its source:
      a LOCAL terminal (PowerShell/cmd/WSL) or ANY saved host** — owner explicit.
- [ ] **Cursor style option in Settings: block / bar / underline + blink style
      (steady / blink / VS Code expand-pulse)** — M5
- [ ] **Theme presets (owner explicit): exactly ~5 built-ins, no 10+ gallery.
      Default preset is named "zeegly" — the current SSHDeck Moba-dark palette.
      Others from well-known terminal schemes (Dracula, Nord, One Dark, Gruvbox).
      JSON import stays (same schema as the web app) so any theme can be pasted.**
- [ ] Middle-click closes tabs (parity with web) — M1
- [ ] Close warnings: tab with live session + app quit (toggleable) — M5
- [ ] Factory reset button (wipe data dir, type-to-confirm, relaunch) — M5
- [ ] mobaconf + sshdeck-backup.json import (reuse formats from `app/mobaconf.py`
      and `app/routers/portability.py`) — M5
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
cd rust/ui && npm install && npm run vendor
cd ../src-tauri && cargo tauri dev        # or: cargo tauri build
```

If `cargo tauri` is missing: `cargo install tauri-cli --locked`.

## Gotchas learned the hard way

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
Next: M5 polish (splits w/ local-or-host picker + MultiExec, cursor style option,
close warnings, reset, backup import), then release build + installer.

## Rules

- Never break the web app while working here; shared repo, separate directory.
- Keep the UI visually identical to the web version unless the owner asks.
- Measure before adding dependencies — footprint is the whole point of this branch
  of work.
