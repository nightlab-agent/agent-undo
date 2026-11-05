# Catalog

| File | Holds |
|---|---|
| `CLAUDE.md` | What the mod is and its rules. |
| `01-context/purpose.md` | Who asked for it and what it must never do. |
| `04-memory/STATE.md` | What is true now: version, seen where, open questions. |
| `04-memory/log/` | One dated file per working session. |
| `hooks/register.tsx` | The hooks module: Edit and Write records, the list, `/agent-undo` and Claude's undo tool. |
| `hooks/hunks.tsx` | One edit's hunks: taken from the engine's diff and the file's text, and put back line by line. |
| `hooks/shell.tsx` | The Bash record: git snapshots around each command, and the shell undo. |
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
| `docs/preview-bash.png` | The shell undo seen on a screen. |
| `preview/project/` | The sample project the screen preview opens. |
