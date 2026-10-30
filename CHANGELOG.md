# Changelog

## 0.1.0 (unreleased)

- First version: lists every Edit and Write that Claude Code and its subagents make in a session, hunk by hunk, and
  undoes the one you pick (`/agent-undo 3.1`), or all of one edit (`/agent-undo 3`). Claude can do the same through
  its own tool when you ask in words. An undo puts back only lines that still read as the edit left them.
