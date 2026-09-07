"""PreToolUse guard for Bash commands.

Blocks the exact mistakes that have already cost a broken push or a leaked
test artifact in this repo. Runs before every Bash tool call; it only acts on
commands that commit, push, build an installer or publish a release. Exit code
2 blocks the command and hands the message back to the assistant.

Kept dependency-free and fast: a plain file check per rule, and `docker ps`
only when a release-shaped command is about to run.
"""
import json
import os
import re
import subprocess
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

if payload.get("tool_name") != "Bash":
    sys.exit(0)
cmd = (payload.get("tool_input") or {}).get("command", "") or ""

SHIPPING = re.compile(r"git\s+(commit|push)\b|cargo\s+tauri\s+build|gh\s+release\s+create")
if not SHIPPING.search(cmd):
    sys.exit(0)

root = os.getcwd()
problems = []

def exists(rel):
    return os.path.exists(os.path.join(root, rel))

# 1. temporary test files must never reach a commit or a build
for rel in ("rust/src-tauri/src/selftest.rs", "rust/ui/_shim_test.html"):
    if exists(rel):
        problems.append(f"{rel} still exists - delete it (it is a throwaway test artifact)")

# 2. the self-test hook in main.rs must be gone once selftest.rs is gone
main_rs = os.path.join(root, "rust/src-tauri/src/main.rs")
if os.path.exists(main_rs):
    src = open(main_rs, encoding="utf-8", errors="replace").read()
    if "mod selftest;" in src or "--selftest-fast" in src:
        problems.append("rust/src-tauri/src/main.rs still contains the selftest hook "
                        "(`mod selftest;` / `--selftest-fast`) - the tree will not build")

# 3. the version must agree in both places the desktop app reads it from
def read_version(rel, pattern):
    p = os.path.join(root, rel)
    if not os.path.exists(p):
        return None
    m = re.search(pattern, open(p, encoding="utf-8", errors="replace").read())
    return m.group(1) if m else None

cargo_v = read_version("rust/src-tauri/Cargo.toml", r'^version\s*=\s*"([^"]+)"')
conf_v = read_version("rust/src-tauri/tauri.conf.json", r'"version"\s*:\s*"([^"]+)"')
if cargo_v and conf_v and cargo_v != conf_v:
    problems.append(f"version mismatch: Cargo.toml says {cargo_v}, tauri.conf.json says {conf_v}")

# 4. no throwaway sshd container left running when shipping
if re.search(r"cargo\s+tauri\s+build|gh\s+release\s+create|git\s+push\b", cmd):
    try:
        out = subprocess.run(["docker", "ps", "-a", "--format", "{{.Names}}"],
                             capture_output=True, text=True, timeout=8).stdout
        if "sshdeck-fasttest" in out:
            problems.append("test container sshdeck-fasttest is still present - `docker rm -f sshdeck-fasttest`")
    except Exception:
        pass  # docker not available is not a reason to block

if problems:
    sys.stderr.write("BLOCKED by .claude/hooks/guard.py:\n  - " + "\n  - ".join(problems) + "\n")
    sys.exit(2)
sys.exit(0)
