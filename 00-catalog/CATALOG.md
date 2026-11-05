# Catalog

| File | Holds |
|---|---|
| `CLAUDE.md` | What the mod is and its rules. |
| `01-context/purpose.md` | Who asked for it and what it must never do. |
| `04-memory/STATE.md` | What is true now: version, seen where, open questions. |
| `04-memory/log/` | One dated file per working session. |
| `hooks/register.tsx` | The hooks module: Edit and Write records, the list, `/agent-undo` and Claude's undo tool. |
| `hooks/hunks.tsx` | One edit's hunks: taken from the engine's diff and the file's text, and put back line by line. |
| `hooks/shell.tsx` | The Bash record: git snapshots around each command. |
| `hooks/shell-undo.tsx` | The shell undo: the checks that a file is still the command's, then git restore. |
| `hooks/common.tsx` | What both share: the list, its stored copy, the record. |
| `hooks/shared.tsx` | Small things that hold no list: path keys, the clock line, the undo queue, the shell windows. |
| `types/index.d.ts` | The `$.state` contract. |
| `tests/agent-undo.test.tsx` | The tests, the collision cases included. |
| `tests/release.sh` | The release check. |
| `tests/bash.test.tsx` | Tests of the Bash record. |
| `tests/mcp.test.tsx` | Tests of the MCP tool record (the Bash record's snapshots around an `mcp__*` call). |
| `tests/mcp-writer.test.mjs` | Tests of the preview's MCP server (node --test, run by the release check). |
| `preview/mcp-writer.js` | A small MCP server (one write_file tool) for the screen preview only; not published. |
| `docs/preview-mcp.png` | The screen picture of two MCP writes listed and one undone. |
| `tests/review-bash.test.tsx`, `tests/review2-*.tsx`, `tests/words-code.test.tsx` | The 0.2.0 reviews' findings as tests, each beside a passing comparison. |
| `tests/review-*.test.tsx`, `tests/review[3-9]-*.test.tsx`, `tests/review5-later.test.txt` | Cases found by code reviews, each beside its nearest normal case; the .txt holds later cases not yet run. |
| `tests/resume.test.tsx` | The list across a new process: kept in the store per session id, restored, bounded, declined under another tag. |
| `tests/engine.tsx`, `tests/edit-world.tsx` | What Claude Code's Edit and Write do to text and answer, for the test worlds, and a world for the hunk undo built on it. |
| `tests/ENGINE-NOTES.md` | What the test world copies from the engine, and what it may still hide. |
| `tests/tabs.test.tsx` | Tab-indented code through Edit, Write and undo. |
| `tests/lookalike.test.tsx` | Look-alike blocks, and hunks followed through later edits and undos. |
| `tests/shell-undo.test.tsx` | A shell undo where a file, a link or a git filter stands in the way. |
| `tests/background.test.tsx` | Recording stops when a command goes on in the background, and what starts it again. |
| `tests/git-fails.test.tsx` | A snapshot git refuses: what the person is told. |
| `tests/symlink-edit.test.tsx` | An Edit through a linked folder while a command runs. |
| `tests/old-git.test.tsx` | Shell recording stops where git cannot name the private index. |
| `tests/world.tsx` | The test world for the Bash record: an in-memory repo, a strict fake git, the permission question. |
| `tests/git-snapshot.sh` | The Bash record's git commands on a real scratch repo. |
| `tests/git-wipe.sh` | Real git commands that throw away uncommitted work, then undone. |
| `tests/release-audit.test.mjs` | The compiled hooks on real files, links, modes and git: kills, links, private files. |
| `tests/audit-harness.mjs` | The hooks compiled on real files, shared by the next three. |
| `tests/release-audit2.test.mjs` | The same on real files: renames, links, temporary copies. |
| `tests/release-audit17.test.mjs` | Real files: permissions, a copy that cannot be made. |
| `tests/release-audit18.test.mjs` | Real files: an undo waiting its turn. |
| `tests/release-audit3.test.mjs` | The same: a conversation or interrupt during an undo, the queue after one gives up. |
| `tests/release-audit4.test.mjs` | The same: the turn and the queue under a passed bound, a restore cut short. |
| `tests/release-audit5.test.mjs` | The same: one undo giving up behind another, the last read, a list changing hands. |
| `tests/release-audit6.test.mjs` | Probes: abandoned undos, a retried list update, a many-file undo run again. |
| `tests/release-audit7.test.mjs` | Slow healthy tools: the hook's budget stands still during a `$` call, so an undo is not refused for them. |
| `tests/release-audit8.test.mjs` | The budget paused above its margin: no spinning clock. |
| `tests/release-audit9.test.mjs` | The undo's time bound, on the real compiled hooks with a controllable clock. |
| `tests/release-audit10.test.mjs` | An Edit queued behind a slow undo: the undo stops before it writes. |
| `tests/release-audit11.test.mjs` | A write in flight when the Edit behind it runs out of time; a clock correction during an undo. |
| `tests/release-audit12.test.mjs` | A budget that moves, stands still and jumps. |
| `tests/release-audit13.test.mjs` | An Edit or Write stops itself at the margin of a budget read as the engine gives it. |
| `tests/release-audit14.test.mjs` | An Edit that leaves its queue keeps the same-file Edit ahead of it held. |
| `tests/release-audit15.test.mjs` | A later undo waits for an Edit whose neighbour left the queue. |
| `tests/release-audit16.test.mjs` | A slow undo, with the budget in the engine's shape, leaves the Edit stopped and the file whole. |
| `tests/review-tsr-after-turn.test.tsx` | A shell undo past its time spends no git call per file. |
| `tests/native-ask.sh` | The real engine's words on an ask, which hooks/register.tsx reads. |
| `tests/temp-tools.tsx` | Fake `mktemp`, `cp`, `mv` and `rm` for the plugin test worlds. |
| `preview/ask-plugin/` | A second plugin for previews, so a real no can be shown on screen. |
| `docs/preview-bash.png` | The shell undo seen on a screen. |
| `preview/project/` | The sample project the screen preview opens. |
