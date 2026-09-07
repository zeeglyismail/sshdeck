---
name: test-desktop
description: Verify a desktop change for real — Rust code against a throwaway sshd container, frontend code in a browser with hit-testing — and remove every artifact in the same step.
---

# Test the desktop app

There are two halves and they need different rigs. Never call a change done on
reasoning alone; both rigs are cheap.

## A. Rust against a real sshd (transfers, du, stats, connect)

1. Start a disposable server — note the port is **2222 inside**, not 22:
   ```bash
   docker run -d --name sshdeck-fasttest -p 2299:2222 -e USER_NAME=test -e USER_PASSWORD=testpw -e PASSWORD_ACCESS=true lscr.io/linuxserver/openssh-server:latest
   sleep 12
   docker exec sshdeck-fasttest sh -c 'apk add --no-cache coreutils findutils zstd >/dev/null 2>&1; echo tools-ok'
   ```
   It advertises keyboard-interactive only, exactly like the owner's fleet, so
   it also exercises the auth fallback.
2. Write `rust/src-tauri/src/selftest.rs` with a `pub fn run()` that connects
   with `crate::ssh::connect_with(&spec, Client::default())`, sets up data with
   `run_command`, calls the function under test, and prints `PASS`/`FAIL` lines
   plus a `=== pass=N fail=M ===` total. Compare files with `sha256sum … | uniq | wc -l`
   on the host rather than hashing locally.
3. Hook it in temporarily and run:
   ```bash
   python -c "s=open('src/main.rs',encoding='utf-8').read();s=s.replace('mod fast;','mod fast;'+chr(10)+'mod selftest;',1);s=s.replace('fn main() {','fn main() {'+chr(10)+'    if std::env::args().any(|a| a == \"--selftest-fast\") { selftest::run(); return; }',1);open('src/main.rs','w',encoding='utf-8').write(s)"
   cargo build && ./target/debug/sshdeck-desktop.exe --selftest-fast
   ```
4. **Remove the hook with a regex that tolerates CRLF, then verify** — a plain
   string replace silently failed once and a non-building tree got pushed:
   ```bash
   python -c "import re;p='src/main.rs';s=open(p,encoding='utf-8').read();s=re.sub(r'mod selftest;\r?\n','',s,1);s=re.sub(r'[ \t]*if std::env::args\(\)\.any\(\|a\| a == \"--selftest-fast\"\) \{ selftest::run\(\); return; \}\r?\n','',s,1);open(p,'w',encoding='utf-8').write(s)"
   rm -f src/selftest.rs; grep -c selftest src/main.rs   # must print 0
   ```
5. Tear down in the same step: `docker rm -f sshdeck-fasttest; docker rmi lscr.io/linuxserver/openssh-server:latest`
   and delete any `ft_*.bin` in `%TEMP%`.

## B. Frontend in a browser (layout, dialogs, filters, renderers)

1. Build a shim page next to the real UI: copy `rust/ui/index.html`, strip the
   three `<script src>` tags, stub `window.__TAURI__` (`core.invoke`,
   `event.listen`, `dialog`, `window`) and `Terminal`/`FitAddon`, then include
   `app.js`. Stub hosts must carry `folder_id: null` or the tree renders empty.
   Bust the stylesheet cache with `href="style.css?v=N"` after each CSS edit.
2. Serve it: `python -m http.server 88NN --directory rust/ui &` and open it with
   the browser tool.
3. **Test clicks with `document.elementFromPoint`, not `.click()`.** A
   programmatic click fires the handler regardless of what is painted on top,
   which is how a full-window invisible overlay survived three test runs.
   Assert that the element under each control's centre *is* that control.
4. Drive state directly (`STATE`, `LISTENERS["transfers"]({payload:…})`,
   `deckConfirm(...)`) and read back DOM text; keep a `window.__errs` array
   fed by `window.onerror` and assert it is empty.
5. Tear down: `rm -f rust/ui/_shim_test.html` and kill the listener on the port.

## Things that look like bugs but are not
- `heredoc` in Bash eats backslashes in this environment — a `"\n"` inside
  JS written through a heredoc becomes a real newline and breaks the file.
  Write scripts with the Write tool, or use `chr(10)`/`NEWLINE`.
- The status-bar graphs use a shared linear ceiling on purpose (owner's
  decision, 2026-09-04). A "reset" when a spike arrives is rescaling.
