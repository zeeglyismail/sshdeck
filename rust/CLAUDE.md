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
- [x] **Accelerated large-file transfers** (`fast.rs`) — M6. Owner's workload is
      14 GB DB dumps and 300 GB VHDX images.
- [x] **Log panel** (`log.rs` + Logs nav tab) — M7. One place every feature
      reports errors/warnings; added because transfer failures were only visible
      live and anything not caught in the moment was lost.
- [ ] `tar` streaming for directories of many small files — the other half of the
      transfer problem (per-file SFTP round trips), NOT built yet
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

## Accelerated transfers (`fast.rs`, M6)

The SFTP path is strictly serial — one 512 KB chunk per round trip — so its ceiling
is `512KB / RTT` regardless of link speed (~16 MB/s at 30 ms). `fast.rs` streams over
a plain exec channel instead: `tail -c +N | zstd -1 -c` for reads,
`zstd -d -c | dd of=... oflag=seek_bytes conv=notrunc,sparse` for writes.

- **Threshold** 64 MB, configurable in Settings (`deck.fastMinMb`), toggle
  `deck.fastTransfer`. Below it SFTP wins, because the exec-channel setup is a
  round trip plus a process spawn.
- **Compression is sampled, never guessed**: 4 MB from ~10% into the file, compress
  it, use zstd only if it shrinks below 85%. A `.vhdx` may be zero runs or packed
  solid and only the bytes know which.
- **Pause / cancel / stall** share one `AtomicU8` (`RUN/PAUSE/CANCEL/STALL`) that the
  copy loops watch. Cancel is not resumable and removes the partial file it created
  (only when it started at offset 0 — a canceled *resume* must not destroy what was
  already there). `transfer_pause` sets the flag the copy loops watch; it is not
  an error, it lands the row as `paused` + resumable. On the compressed upload path
  the encoder still calls `finish()` so the remote decoder gets a complete frame and
  writes out everything sent — resuming from a torn frame would leave a gap.
- **Resume**: failed or paused transfers keep `resumable`, and `transfer_resume` restarts at
  the destination's current size. `tail -c +N` seeks, so resuming a 300 GB file at
  280 GB is free. `transfer_forget` dismisses a row instead.
- **Sparse**: `conv=sparse` keeps zero runs as holes — a mostly-empty 300 GB VHDX
  lands small. Verified: 20 MB of zeros arrives as 20971520 bytes in **0 blocks**.
- **Host→host keeps the bytes compressed end to end**, so this machine spends no CPU
  on the codec and the relay carries only the compressed volume.
- **Every failure falls back to SFTP** and marks the host via `fast::disable`, so a
  restricted shell or a missing tool degrades instead of erroring. Streamed
  transfers are size-verified afterwards, since there is no per-chunk ack.

## Log panel (`log.rs`, M7)

`log::{error,warn,info}(&app, src, msg)` from anywhere with an `AppHandle`;
pushes onto a 3000-entry ring and emits a `log` event. The frontend mirrors it in
`LOG[]`, filters by level and text, and reports its own failures through
`log_add` (plus `window.onerror` / `unhandledrejection`), so JS and Rust problems
interleave in the right order. `logs_save` writes plain text via the same save
dialog as the backup export.

- In memory only. Nothing hits disk unless the owner saves it — entries carry
  host names and paths.
- The transfer lifecycle is instrumented deliberately: start (size + chosen
  method), fast-path fallback with the reason, stall, and failure with bytes
  moved, elapsed time and the remote's own message. That is the trail needed for
  the still-unexplained "Channel send error" near the end of a transfer.
- Errors bump a badge on the nav tab; opening the panel clears it.
- **All four log commands are `async` on purpose.** A synchronous Tauri command
  runs on the MAIN thread, which is also the window message loop; one that emits
  an event from there can wedge the whole window — indistinguishable from the app
  hanging with no click response. Never make a command that emits synchronous.
- Three more guards, because the logger must never be what breaks the app:
  `logReporting` stops report → render → error → report recursion; `logUi` is
  rate-limited (20/s, consecutive duplicates dropped) so a fault repeating every
  frame cannot flood IPC; and renders coalesce into one `requestAnimationFrame`
  instead of forcing layout per arriving event.

## Gotchas learned the hard way

- **A write-only exec channel DEADLOCKS.** SSH flow control delivers window
  adjustments on the same channel; if you only write and never read, the initial
  window is spent and nothing refills it — uploads froze at ~15 MB. Always
  `tokio::io::split` and drain the read half concurrently (`fast::split_drain`).
  The drain completing is also the signal that the remote command exited.
- **Bulk transfers get a DEDICATED connection (`ssh::dedicated`), never the pool.**
  A big stream and the SFTP browse/stat channels share the session window; one
  channel that stops draining wedges the whole session, so a second transfer froze
  a hair short of done and the next `channel_open_session` returned "Channel send
  error". One connection per transfer bounds the damage. Verified: 4 concurrent
  200 MB uploads all land sha256-identical while stat calls keep answering.
- **A blocked socket write cannot see a flag.** Pause/cancel/stall set an
  `AtomicU8`, but the loops only tested it *between* writes — and a write against
  a peer that stopped reading never returns, so the flag was unreachable and the
  buttons did nothing. Every socket read/write now races `until_stopped` via
  `tokio::select!` (`read_or_stop` / `write_or_stop`). Dropping the mpsc receiver
  is what frees the blocking reader thread, which can be parked in
  `blocking_send` where it also cannot see the flag.
- **Transfers to one host are serialized** (`gate_for`, a per-host `Semaphore(1)`).
  Several big streams at one spinning disk seek against each other until
  throughput collapses — that is how two uploads wedged at half done. Queueing
  also matches MobaXterm, and queued rows show as `queued` and stay cancellable.
- **`run_command` had NO timeout** and every small query goes through it (stat,
  capability probe, compression sample, the post-transfer size verify). An upload
  that had sent every byte could sit at "running" forever because the `stat` that
  confirms the size never returned. 30 s cap now; a non-answer is reported as
  "could not confirm" (resumable), never as "file missing".
- **A stalled stream must not look alive.** `start_ticker` watches for 90 s with no
  bytes and trips the cancel flag with `STALL`, so the row errors (and stays
  resumable) instead of sitting at 99% forever.
- **Dropped FOLDERS arrive as a 0-byte File.** The tree is only reachable via
  `webkitGetAsEntry()`, and it MUST be called synchronously in the drop handler —
  awaiting first empties `dataTransfer.items`. `readEntries` also returns at most
  100 per call, so loop until it is dry or you silently lose files.
- **The transfer strip has TWO row sources and they must go through one render.**
  Rust-owned rows arrive in the `transfers` event; a local file still being
  spooled to a temp file exists only in JS, because no transfer exists yet. The
  old code appended spool rows straight into `#tr-list`, so the next event —
  including the one "clear finished" triggers — wiped them mid-upload and the row
  reappeared later when the real transfer began. `PREP` + `SERVER_ROWS` +
  `renderTransfers()` is the fix; `clear finished` only ever drops finished
  server rows, and a prep row retires when a server row with the same `desc`
  appears (so the JS desc must match `format!("{name} → {label}:{dir}")` exactly).
- **Build every prep row before spooling any of them.** Creating rows inside the
  loop meant a multi-file drop showed one row until that file finished, which
  read as "only one file was accepted". Likewise `expandDrop` must start all
  entries with `Promise.all`: resolving them one at a time let the drag data
  store go stale and only the first file survived.
- **Spooling must be cancellable.** It is the longest phase for a big local file
  (base64 chunks over IPC) and there was no way to stop it.
- **Write commands run as `{ …; } 2>&1`** so the drain captures the remote's own
  message. Otherwise a real remote failure (no space, permission, read-only
  mount) surfaces as a bare "Channel send error" that says nothing.
- **Two transfers must never share a destination.** Dropping the same file twice
  gave both `dd` writes one path; the second `: > file` truncated under the first
  and the channel died with "Channel send error". `claim_dest` refuses the second.
- **WebView2 draws its OWN password reveal eye** once the field has content, next to
  ours — looks like a duplicate icon bug. Killed with `::-ms-reveal { display:none }`.
- **`::-webkit-scrollbar-corner` defaults to solid white** where a vertical and a
  horizontal scrollbar meet. Always style it alongside track and thumb.
- **Monitoring must count PHYSICAL NICs only.** Summing every interface but `lo`
  triples the numbers on a hypervisor: one packet to a guest appears on the NIC,
  the bridge and the tap. Verified against a synthetic host05-shaped
  `/proc/net/dev`: 6x inflation before, exact after. Only real hardware has
  `/sys/class/net/<if>/device`, so `STATS_CMD` asks for that list (section 9) and
  the parser filters by it, falling back to the old behaviour if it is empty.
  **The web app (`static/app.js`) still has this bug** — same parser, not fixed
  there because the owner asked for desktop-only changes.
- **`zd*` (ZFS zvols) double-count disk I/O**, as do `nbd`/`drbd`: their traffic
  is counted again on the physical disks underneath. host05 runs ZFS, so this
  roughly doubled the DISK I/O readout.
- **Progress events must be throttled.** The old code emitted a `transfers` event
  per 512 KB chunk — 600k events for a 300 GB file, enough to drown the webview.
  Transfers now bump an `AtomicU64` and one 400 ms ticker turns it into events
  (`start_ticker`), which is also where the rate and ETA come from.

- **Launch the RELEASE exe for the owner** (`cargo build --release`, target/release/): the debug
  exe attaches a console window that shows harmless WebView2 log noise. Release has
  `windows_subsystem = "windows"` → no console.
- **The exe embeds `ui/` at compile time.** Every frontend edit needs
  `cargo build` + relaunch — there is no hard-refresh. (Kill the running exe first
  or the linker can't overwrite it.)
- **`sftp_upload`/`sftp_download`/`transfer_start` RETURN IMMEDIATELY** — they spawn a
  detached task and report progress via the `transfers` event. Never delete or
  mutate their inputs after awaiting the invoke (that caused the os error 2 spool
  bug: the frontend deleted the temp file while the upload was still opening it).
  Cleanup belongs at the END of the spawned task.
- **OS file drops have NO path** when `dragDropEnabled: false`: the webview gets
  `File` objects only. `stash.rs` spools their bytes (base64 chunks from JS) into a
  temp file, then the normal `sftp_upload` runs on that path. Don't 'fix' this by
  turning dragDropEnabled on — that kills all in-app HTML5 dragging on Windows.
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
