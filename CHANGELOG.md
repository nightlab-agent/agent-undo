# Changelog

## 0.1.0 (2026-10-30)

- First version: lists the Edit and Write calls that Claude Code and its subagents make in a session (the newest 20
  shown, 300 kept), hunk by hunk, and
  undoes the one you pick (`/agent-undo 3.1`), or all of one edit (`/agent-undo 3`). Claude can do the same through
  its own tool when you ask in words. An undo puts back only lines that still read as the edit left them.
