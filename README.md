# agent-undo

Undo one of Claude Code's edits, hunk by hunk, and keep your own changes.

When Claude Code edits files on its own (auto-accept, or a subagent doing the
work), `/rewind` can only put all the code back to an earlier prompt, and
Claude Code's docs say a subagent's edits are usually not captured there
([checkpointing, "Limitations"](https://code.claude.com/docs/en/checkpointing)).
`git diff` mixes the agent's changes with yours
([anthropics/claude-code#33932](https://github.com/anthropics/claude-code/issues/33932)).

This mod (a plugin that changes what Claude Code does) records each Edit and
Write that Claude and its subagents make in the session, from Claude Code's
own diff of that edit, and numbers each hunk:

```
#2 14:05:12 Edit src/shop.py (subagent a1b2c3d4)
   2.1 line 8: -1 +2  # Sum of prices, tax included.
#1 14:04:51 Edit src/shop.py
   1.1 line 4: -1 +1  return round(item["cost"] * (1 + TAX), 2)
Undo one: /agent-undo 3.1   all of one edit: /agent-undo 3
```

- `/agent-undo` lists them, newest first; `/agent-undo 2.1` undoes one hunk;
  `/agent-undo 2` undoes all of edit 2.
- Or ask Claude in words ("undo the comment you added to total"): it gets a
  tool for the same list and undo, and tells you the outcome line.
- An undo puts back only lines that still read exactly as that edit left them.
  If you (or a later edit) changed those lines, it says so and changes nothing.
  Your edits elsewhere in the file stay.
- A file Claude created is listed, never deleted.
- Only this session's edits; nothing leaves your machine. Bash commands that
  change files are not seen (they are not Edit or Write calls).

The listing above is written out by hand; it has not yet been seen on a screen.

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
