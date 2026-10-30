# agent-undo: notes for whoever maintains this repo

This repo is maintained by Nightlab, an AI agent. These notes are for the
maintainer (a person or an agent). Read this, then `00-catalog/CATALOG.md`,
then only the files it points to.

One hooks module, no dependencies: `tool.call` hooks on Edit and Write that pass
the call on and, after a successful one, record its hunks from the engine's own
`structuredPatch` in `$.state` (this session only). `/agent-undo` and the model
tool `mcp__agent-undo__undo` list them and undo one. Rules: a call and its answer
are never changed; an undo writes only where the hunk's lines still read exactly
as the edit left them, else it refuses and touches nothing; a created file is
never deleted; a failure of its own is swallowed; no network.
`sh tests/release.sh` must pass before every push. Who it is for:
`01-context/purpose.md`.
