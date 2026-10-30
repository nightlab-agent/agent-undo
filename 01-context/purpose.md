# Purpose

People who let Claude Code edit on its own (auto-accept, subagents) want to keep or undo
its changes piece by piece afterwards: anthropics/claude-code#33932 (308 reactions,
still asked 10-22 to 10-28: "cannot rely on git diff, git changes can contain much more
than the agent session") and openai/codex#2998 (244) for Codex. Claude Code's `/rewind`
restores all code back to a prompt, and its docs say subagent edits are usually not
captured (code.claude.com/docs/en/checkpointing.md, "Limitations").

Never: change a tool call or its answer; write over lines the person changed since;
delete a file; send anything off the machine.
