# State

- Version 0.2.0, 2026-11-02. Tests: 102 pass with unreleased work (with unreleased work; 76 at 1267d88) (`claude plugin test .`); `sh tests/git-snapshot.sh <dir>` runs the git commands on a real repo.
- Seen on a screen (2026-10-30, Claude Code 2.1.312): Claude's tool listing three edits, one by a subagent, and undoing one hunk.
- Seen on a screen (2026-11-02, Claude Code 2.1.312, permissions bypassed): one Bash command's three files listed, one file undone, the other two left.
- Open: `/agent-undo` typed by a person, not yet seen on a screen; the list kept in `$.store` per session id (last 5 sessions) and restored in a new process with the same id: tested (tests/resume.test.tsx), not yet seen on a screen; Claude Code's docs (the `--fork-session` row of the CLI reference) imply a plain `claude --resume` reuses the session id; the list coming back after a resume: not yet seen on a screen; a new session in a preview starts empty (2026-11-02); a Bash command after a permission question is not recorded by design; Windows (no `cp`: the first snapshot reads every file) not seen.

## Held 2026-11-02 (0.2.1 not released)

The stored list failed its second code review (55/100). The next design is in, one change per commit, each
with its test failing first: a33d819 (R2, a late restore no longer claims the session), ae079fe (R1, a stored
copy not taken as the list is never written over), 0e45064 (R3, R3b, R4: each copy has its own write time, no
shared index; refused copies clear the oldest other one, tried once more), f33005e (R2 and R4 one step later).
102/102; the seven new or changed tests fail on 638d113. Next: a fresh code review on 11-03, then a preview.
