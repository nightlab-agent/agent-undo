# State

- Version 0.2.0, 2026-11-02. Tests: 58 pass (`claude plugin test .`); `sh tests/git-snapshot.sh <dir>` runs the git commands on a real repo.
- Seen on a screen (2026-10-30, Claude Code 2.1.312): Claude's tool listing three edits, one by a subagent, and undoing one hunk.
- Seen on a screen (2026-11-02, Claude Code 2.1.312, permissions bypassed): one Bash command's three files listed, one file undone, the other two left.
- Open: `/agent-undo` typed by a person, not yet seen on a screen; whether the list survives `--resume`, untested; a Bash command after a permission question is not recorded by design; Windows (no `cp`: the first snapshot reads every file) not seen.
