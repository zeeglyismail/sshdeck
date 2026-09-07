---
name: release-desktop
description: Ship a new SSHDeck desktop version — bump, build the NSIS installer, publish the GitHub release, hand the installer to the owner, verify nothing is left behind.
---

# Release the desktop app

Follow in order. Every step has bitten before; none is optional.

## 0. Preconditions
- `git status` clean apart from the change being shipped.
- No `rust/src-tauri/src/selftest.rs`, no `rust/ui/_shim_test.html`, no
  `mod selftest;` in `main.rs`. The guard hook blocks the commit otherwise.
- No `sshdeck-fasttest` container, no pulled test images (`openssh-server`,
  `alpine`), no local HTTP server still listening.

## 1. Bump the version in BOTH files (they must match)
```bash
sed -i 's/^version = "OLD"/version = "NEW"/' rust/src-tauri/Cargo.toml
sed -i 's/"version": "OLD"/"version": "NEW"/' rust/src-tauri/tauri.conf.json
```
The app shows this top-right and stamps it into every log. It is the first
thing to check when the owner reports "no change".

## 2. Record what changed
- `rust/CLAUDE.md` → "Gotchas learned the hard way" for anything that cost a
  round, and the feature checklist / status for new features.
- `README.md` → the Features list, and the version + installer size in both
  places they appear (header table and the Desktop section). Take sizes from
  the real build, never by hand.

## 3. Commit and push
Write the message to a file and use `git commit -F` — messages with quotes
have broken the shell before. Plain descriptive prose, no bullet salad.

## 4. Build the installer
```bash
powershell -Command "Get-Process sshdeck-desktop -ErrorAction SilentlyContinue | Stop-Process -Force"
cd rust/src-tauri && cargo tauri build 2>&1 | grep -E "^error|setup.exe|Error " | tail -2
```
- Kill the running exe first or the linker cannot overwrite it.
- If the build script fails with a path from a folder that no longer exists,
  the target cache holds stale absolute paths (happens after the repo is moved).
  Delete `target/{debug,release}/build/tauri-*` and `.../sshdeck-desktop-*`
  and rebuild; a full `cargo clean` is 25 GB and not needed.
- The installer lands in `target/release/bundle/nsis/SSHDeck_<ver>_x64-setup.exe`.

## 5. Publish
```bash
gh release create v<ver> "rust/src-tauri/target/release/bundle/nsis/SSHDeck_<ver>_x64-setup.exe#SSHDeck_<ver>_x64-setup.exe (Windows installer)" \
  --title "SSHDeck v<ver> — <what it is>" --notes-file <notes.md> --latest
```
Notes are written for someone who did not follow the work: what was wrong,
why, what changed, what was verified. Then commit the `Cargo.lock` bump.

## 6. Hand it over and verify cleanup
- Send the installer to the owner with a one-line caption.
- Final check, all must be zero/clean:
  `git status --short`, `docker ps -a | grep fasttest`,
  `docker images | grep -E 'openssh|alpine'`, `netstat -ano | grep -E ':(2299|88[0-9][0-9]) .*LISTENING'`.
- Tell the owner to confirm the version top-right says v<ver> before testing.
