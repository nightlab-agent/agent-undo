# State

- Version 0.2.0 public (2026-11-02); the next version (local) records MCP tool calls in a git repo and keeps the stored list safer. Tests: 141 pass (`sh tests/release.sh`); `sh tests/git-snapshot.sh <dir>` runs the git commands on a real repo.
- Seen on a screen (2026-10-30, Claude Code 2.1.312): Claude's tool listing three edits, one by a subagent, and undoing one hunk.
- Seen on a screen (2026-11-02, Claude Code 2.1.312, permissions bypassed): one Bash command's three files listed, one file undone, the other two left.
- Open: `/agent-undo` typed by a person, not yet seen on a screen; the list kept in `$.store` per session id (last 5 sessions) and restored in a new process with the same id: tested (tests/resume.test.tsx), not yet seen on a screen; Claude Code's docs (the `--fork-session` row of the CLI reference) imply a plain `claude --resume` reuses the session id; the list coming back after a resume: not yet seen on a screen; a new session in a preview starts empty (2026-11-02); a Bash command after a permission question is not recorded by design; Windows (no `cp`: the first snapshot reads every file) not seen.

## Next release (0.2.2)

The stored list now keeps each session's copy with its own write time and never writes over a copy it did
not take as the list; a late restore no longer claims the session. MCP tool calls are recorded in a git repo.
141 tests pass. Not yet seen on a screen: the list after a resume, and an MCP call in a real session.
