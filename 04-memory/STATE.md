# State

- Version 0.2.1 public (MCP tool calls recorded in a git repo); 0.2.2 (local, CHANGELOG) keeps the stored list right across /clear, /resume and exit. Tests: 294 plugin tests and 6 node tests pass (`sh tests/release.sh`); `sh tests/git-snapshot.sh <dir>` runs the git commands on a real repo.
- Seen on a screen (2026-10-30, Claude Code 2.1.312): Claude's tool listing three edits, one by a subagent, and undoing one hunk.
- Seen on a screen (2026-11-02, Claude Code 2.1.312, permissions bypassed): one Bash command's three files listed, one file undone, the other two left.
- Open: `/agent-undo` typed by a person, not yet seen on a screen; the list kept in `$.store` per session id (last 5 sessions) and restored in a new process with the same id: tested (tests/resume.test.tsx), not yet seen on a screen; Claude Code's docs (the `--fork-session` row of the CLI reference) imply a plain `claude --resume` reuses the session id; the list coming back after a resume: not yet seen on a screen; a new session in a preview starts empty (2026-11-02); a Bash command after a permission question is not recorded by design; Windows (no `cp`: the first snapshot reads every file) not seen.

## Next release (0.2.2)

The stored list keeps each conversation's copy right across a /clear, a /resume back and an exit, with a
one-second bound on each wait for a stored write where Claude Code's timer answers (CHANGELOG 0.2.2 has the cases and the known limit).
301 plugin tests pass. Not yet seen on a screen: the list after a resume, and an MCP call in a real session.
