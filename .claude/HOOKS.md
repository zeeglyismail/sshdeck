# Claude Code setup for this repo

Everything an assistant needs is checked in, so a fresh session on any machine
starts with full context. Nothing here depends on per-machine memory.

| Piece | Where | What it does |
|---|---|---|
| Project context | `CLAUDE.md` (root) and `rust/CLAUDE.md` | Goals, architecture, decisions already made, gotchas learned the hard way. Read first, always. |
| Skills | `.claude/skills/*/SKILL.md` | Step-by-step procedures for the two workflows that have gone wrong before: shipping a desktop release, and testing against a real sshd. Invoke with `/release-desktop` and `/test-desktop`. |
| Hook | `.claude/settings.json` → `.claude/hooks/guard.py` | Runs before every Bash command. Blocks `git commit`, `git push`, `cargo tauri build` and `gh release create` while any of these is true: a throwaway test file exists, `main.rs` still carries the self-test hook, the two version fields disagree, or the test sshd container is still up. |
| Ignore list | `.gitignore` | Second line of defence for the same test artifacts. |

## Why the hook exists

Each rule is a thing that actually happened:

- A commit went out with `mod selftest;` in `main.rs` after the file was
  deleted — the pushed tree did not compile.
- A shim page was committed because the cleanup ran from the wrong directory.
- Two rounds were spent debugging an "unchanged" build that was in fact an
  older version still installed; the version is now shown in the app and the
  hook keeps `Cargo.toml` and `tauri.conf.json` from drifting apart.
- The owner's standing instruction: every test artifact is removed in the same
  step it was used — containers, images, servers, shim files. The hook makes
  forgetting impossible at the moments that matter.

## Testing the hook by hand

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"git push"}}' | python .claude/hooks/guard.py; echo "exit=$?"
```

Exit 0 means clean. Exit 2 prints the reasons and blocks the command.
