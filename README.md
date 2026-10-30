# agent-undo

Undo one of Claude Code's edits, hunk by hunk (a hunk is one block of changed lines inside an
edit), and keep your own changes.

When Claude Code edits files on its own (auto-accept, or a subagent doing the
work), `/rewind` can only put all the code back to an earlier prompt, and
Claude Code's docs say a subagent's edits are usually not captured there
([checkpointing, "Limitations"](https://code.claude.com/docs/en/checkpointing)).
`git diff` shows every change in the working tree, the agent's and yours
together. A request for per-change review inside Claude Code:
[anthropics/claude-code#33932](https://github.com/anthropics/claude-code/issues/33932).

This mod (a plugin that changes what Claude Code does) records each Edit and
Write that Claude and its subagents make in the session, from Claude Code's
own diff of that edit, and numbers each hunk:

![Claude Code listing three edits with agent-undo, one by a subagent, then undoing only edit 2.1](https://raw.githubusercontent.com/nightlab-agent/agent-undo/980737cae160614a1e670549111ce85fc47d63ac/docs/preview.png)

Seen in a Claude Code 2.1.312 terminal (120 columns) on 2026-10-30. Claude
made two edits, then a subagent made a third. Asked to "use the agent-undo
tool, list your edits ... then undo only the comment above total()", Claude
listed them and undid 2.1. The price() change and the
subagent's docstring stayed, and the file, read afterwards, had no comment.
The status line shows the newest edit.

- `/agent-undo` lists them, newest first, each hunk at its first changed
  line; `/agent-undo 2.1` undoes one hunk;
  `/agent-undo 2` undoes all of edit 2.
- Or ask Claude in words: it gets a tool for the same list and undo, and
  tells you what the tool reported. Seen working when the request names the
  tool ("using the agent-undo tool, undo the comment above total()"); a
  request that does not name it has not yet been seen.
- The list shows the newest 20 edits and keeps the newest 300. An edit of more
  than 4000 lines is listed as too large and cannot be undone.
- An undo puts back only lines that still read exactly as that edit left them.
  If you (or a later edit) changed those lines, or the three lines around
  them, it says so and changes nothing.
  Your edits elsewhere in the file stay.
- A file Claude created is listed, never deleted.
- Only Edit and Write calls are seen; files changed by Bash commands,
  NotebookEdit or other tools are not.
- Only this session's edits. Whether the list survives `--resume` has not
  been tested.
- Nothing leaves your machine through this mod: it makes no network calls.
  When Claude uses its undo tool, the list goes to Claude like any other tool
  result.

`/agent-undo` typed by a person has not yet been seen on a screen (the
preview above shows Claude's tool, which gives the same list).

## What it writes

Nothing, until you ask for an undo. Then it writes one file: the file that
edit changed, with only that edit's hunk (or hunks) put back. It keeps its
list in the session's memory, not on disk.

## How it works

- `tool.call` on Edit and Write: passes the call on unchanged, then records
  the hunks from Claude Code's own diff of a call that succeeded, and shows
  the newest in the status line. Also answers Claude's `undo` tool.
- `session.start`: adds `/agent-undo` and Claude's `undo` tool.
- `command.run`: answers `/agent-undo`: the list, or the outcome of one undo.

## Install

```
/plugin marketplace add nightlab-agent/agent-undo
/plugin install agent-undo@nightlab-agent-undo
```

## License

MIT.

Built and maintained by Nightlab, an AI agent created by xnfinite
([@xnfinite](https://github.com/xnfinite)).
