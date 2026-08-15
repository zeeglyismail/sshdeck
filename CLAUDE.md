# CLAUDE.md — project context for AI assistants

Read this first. It carries the project's goals, architecture, conventions and current
state so any chat session (Claude Code or otherwise) can continue work without re-discovery.

## What this is

**SSHDeck** — a self-hosted web SSH client replacing MobaXterm/Termius for its author
(a DevOps engineer managing a fleet of internal Linux servers). Runs as ONE Docker
container, multi-user, browser UI. Priorities: simplicity, Moba-like dark UX, zero
extra infrastructure. Public open-source repo: https://github.com/zeeglyismail/sshdeck

## Golden rules

- **Keep it simple.** No frontend framework, no build step, no extra services.
  Vanilla JS + xterm.js, FastAPI backend, SQLite. The owner explicitly rejects
  "hard stuff" — prefer the boring solution.
- **Modular monolith, NOT microservices.** All features share one pooled SSH
  connection per (user, host) in `app/ssh_manager.py` — terminal, SFTP, stats and
  transfers multiplex channels over it. Never split that. New feature = new file in
  `app/routers/` + registration in `app/routers/__init__.py`.
- **Never touch `data/`** (SQLite DB + Fernet `secret.key`) and never let it reach
  git — it holds encrypted credentials for the owner's production fleet.
- After every code change the owner runs `docker compose up -d --build` and
  **must hard-refresh the browser tab (Ctrl+F5)** — remind them if something
  "doesn't work" right after a rebuild; stale cached JS is the usual cause.
- Commit style: plain descriptive messages; owner pushes to `main` directly.

## Architecture

```
app/
├── main.py            # app assembly, session middleware, global error handler
├── db.py              # sqlite3 (thread-lock wrapper), schema + tiny migrations in init()
├── crypto.py          # Fernet for stored secrets; key auto-created at /data/secret.key
├── auth.py            # bcrypt + session-cookie dependency (current_user)
├── ssh_manager.py     # THE connection pool; drop() kills conn, drop_sftp() only sftp
├── ws.py              # /ws/term/{host_id} (PTY, bytes) + /ws/stats/{host_id} (JSON, 0.5s)
├── log.py             # logging → stdout (docker logs)
├── mobaconf.py        # MobaXterm bookmark format parse/export
└── routers/           # one module per feature, all registered in __init__.py
    ├── account.py     # signup/login/logout/me
    ├── inventory.py   # folders + hosts CRUD, move, duplicate, disconnect(sftp-only)
    ├── credentials.py # identities (user+pw templates) + SSH keys
    ├── sftp.py        # list/upload/download/mkdir/rename/chmod/delete
    ├── transfers.py   # server-side host→host copy (SFTP read→write pipe), in-mem progress
    ├── tunnels.py     # local port forwards; listeners in-memory, defs in DB
    └── portability.py # mobaconf import/export + full JSON backup/restore (decrypted!)
static/                # index.html, login.html, app.js (~1100 lines), app.css
                       # xterm.js vendored into the image at Docker build (static/vendor)
```

- DB schema changes: add `CREATE TABLE IF NOT EXISTS` to `SCHEMA` **and** a guarded
  `ALTER TABLE` in `db.init()` for existing volumes (see `identity_id` example).
- Auth flows: host.auth_type ∈ password | key | identity (identity = saved
  username+password template; resolution in `ssh_manager._connect_args`).
- Stats: one command over the pooled conn reads /proc/stat, meminfo, df, net/dev,
  uptime, `who`; server computes deltas; client keeps 120-sample (60 s) histories
  per terminal for the CPU and NET canvas sparklines.
- Frontend state: `STATE` (server data), `TABS` Map (tab → single terminal instance),
  `PANES[2]` (file manager). Terminal features: Enter-reconnect-in-place when dead,
  select-to-copy / middle-click paste / Ctrl+Shift+C/V (right-click stays native),
  Ctrl+scroll font zoom, client-side output highlighting (regex → ANSI, skipped on
  alternate screen buffer so nano/vim/htop are untouched, toggle in Settings).
- Theming: JSON in localStorage → CSS variables + xterm theme (`applyTheme`).
- UI motion: FLIP animation for tab drag-reorder; 120–180 ms transitions elsewhere.

## Current feature state (all shipped & pushed)

Terminals (tabs, reconnect, highlighting, zoom, copy/paste) · monitoring bar
(CPU/NET graphs, RAM/DISK meters, uptime, per-user `who` counts with hover popup)
· dual-pane SFTP (multi-select, drag-drop desktop upload, host→host transfers with
progress) · searchable host picker · identities & keys (encrypted) · folders with
DnD + natural sort (base, 1, 2, …, 10) · host duplicate/context menus · resizable
sidebar · tunnels (local forwards, ports 15000-15020 published) · mobaconf
import/export · full JSON backup/restore · theme JSON · multi-user · logging ·
configurable scrollback (default 50k, Settings) · identity picker live-syncs the
username field in the host modal · middle-click closes terminal tabs ·
"phase" cursor pulse (CSS animation on .xterm-cursor, xterm blink disabled).

## Decisions already made (don't relitigate)

- **X11 forwarding: rejected for the web app** — a browser has no X server. Only
  possible in a future desktop build.
- **FTP/TFTP for speed: rejected** — insecure / wrong tool. If large-file transfer
  speed comes up, the agreed path is streamed `cat` over an SSH exec channel
  (scp-style) as an accelerated mode. On the roadmap, not built.
- **Splits & broadcast-typing: built, then REMOVED at owner's request** (UI too
  complex). Don't re-add without being asked.
- **Bind mount `./data` over named volume** — owner moves/wipes data by folder.
- Moba stored passwords can't be imported (master-password encrypted) — only
  bookmarks; owner knows.
- Windows ephemeral-port collisions can break compose port publishing
  (owner's dynamic range is 1025-65535); retry or `netsh int ipv4 set dynamicport
  tcp start=49152 num=16384` as admin.

## Parked / next (waiting for owner's go)

1. **Desktop exe — IN PROGRESS in `rust/` (Tauri 2 experiment)**. See `rust/CLAUDE.md`
   for its own context: milestones, feature checklist (splits/multiexec return there,
   cursor style options, both-direction tunnels, local terminal, reset, warnings),
   and the evaluation gate vs the pywebview fallback.
2. Remote / dynamic (SOCKS) forwarding on top of tunnels.
3. Transfer acceleration (exec `cat` streaming).
4. SSH host key verification (currently `known_hosts=None` — LAN tool), TOTP login.

## How to verify changes

- Syntax: `python -m py_compile app/**/*.py`, `node --check static/app.js`.
- Smoke: build image, run a throwaway instance on port 8023 (never take 8022 —
  that's the owner's live instance), drive the UI headlessly; a disposable sshd
  (`lscr.io/linuxserver/openssh-server` on a shared docker network) works for real
  SSH flow tests, incl. the Enter-reconnect path. Clean up test containers/images.
- The owner tests on their own instance and reports back screenshots — iterate.
