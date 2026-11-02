# agent-undo

Undo one of Claude Code's edits, hunk by hunk (a hunk is one block of changed lines inside an
edit), and keep your own changes. In a git repo, also one file a shell command of Claude's changed,
for commands Claude Code ran without asking you.

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
- NotebookEdit and other tools are not seen. Bash commands are, in a git
  repo (below).
- Only this session's edits. Whether the list survives `--resume` has not
  been tested.
- Nothing leaves your machine through this mod: it makes no network calls
  (it runs `git` and, once per repo, `cp` on your machine).
  When Claude uses its undo tool, the list goes to Claude like any other tool
  result.

`/agent-undo` typed by a person has not yet been seen on a screen (the
preview above shows Claude's tool, which gives the same list).

## Shell commands (in a git repo)

A file that only Bash commands changed is not tracked by `/rewind`; its
docs say to use version control (same page, "Bash command changes not
tracked"). When the project is a git repo, agent-undo lists each command
that changed files, one number per file, and undoes one file or all of them:

![Claude Code listing one Bash command's three files with agent-undo, then undoing only src/greet.py](https://raw.githubusercontent.com/nightlab-agent/agent-undo/4b102973b1554bec11d8fe724f7766516e0fb1ad/docs/preview-bash.png)

Seen in a Claude Code 2.1.312 terminal on 2026-11-02, with permissions
bypassed. One Bash command uppercased `src/greet.py`, deleted `src/shout.py`
and created `notes.txt`. Claude listed it and undid only 1.2: `greet.py` came
back, and the other two stayed as the command left them. (The list's last
line then suggested an example number, "3.1"; it now names the newest
entry's own number. That line has not yet been seen on a screen.)

- A changed or deleted file comes back as it was just before the command,
  your uncommitted changes included. It is put back only if it still reads
  exactly as the command left it (or, if the command deleted it, nothing is
  there yet). Otherwise it says so and changes nothing.
- A file the command created is listed, never deleted. A file in a
  submodule, a symbolic link, or a command that changed more than 200 files
  is listed but cannot be undone here.
- Recorded only when the command runs without a question: with permissions
  bypassed (seen on the screen above) or a command an allow rule approves
  (tested). Accept-edits mode still asks for most commands, and a command
  you approve at a prompt is not recorded: a file you saved while the
  question waited would look like the command's. In auto mode, a command
  the classifier approves is probably not recorded (not tested).
  If another mod turns Claude Code's "allow" into a question after this
  one has looked, the command is recorded anyway, and a file you save while
  that question waits would look like the command's.
- Not recorded: two commands running at the same time (for example two
  subagents), files outside the git repo you started Claude Code in, and
  files git ignores. Files that Edit or Write changed while a command ran
  stay with their own entry.
- When a command goes on in the background (asked about or not), shell
  commands stop being recorded for the rest of the session, and the list
  says so: its later writes would look like the next command's. A process
  a command starts with `&` is not seen as a background command.
- A file you save in your editor while a command runs looks like the
  command's. The check above still refuses an undo once you change it again.
- Every command that runs without a question waits for two git snapshots,
  read-only ones too. In a repo of 5,000 files one snapshot took about
  12 ms on a Linux disk and about 1.1 to 1.4 s on a Windows drive reached
  from WSL. The first can take 30 s or more where there is no git index to
  copy (a repo with no commit yet, or Windows without `cp`).

## What it writes

- For an Edit or Write undo: the file that edit changed, with only that
  edit's hunk (or hunks) put back.
- In a git repo, around each Bash command: a private index file,
  `.git/agent-undo.index`, and the snapshots' objects in `.git/objects`
  (what `git add` would store; no commit, no branch, no change to your
  staged files). `git gc` removes the objects once they are about two weeks
  old; the next snapshot then copies your index again.
- For a shell undo: the file put back, by `git restore --worktree`.

The list is kept with the session's mod state, not in your project. When
Claude uses its undo tool, the list is a tool result in the conversation,
like any other.

To remove it: `/plugin uninstall agent-undo@nightlab-agent-undo`, then
in each repo or worktree you used it in, delete the file that
`git rev-parse --git-path agent-undo.index` prints. Optionally
`/plugin marketplace remove nightlab-agent-undo`.

## How it works

- `tool.call` on Edit and Write: passes the call on unchanged, then records
  the hunks from Claude Code's own diff of a call that succeeded, and shows
  the newest in the status line. Also answers Claude's `undo` tool.
- `tool.check` on Bash: when Claude Code allows a command with no question,
  snapshots the git work tree into the private index (`git add -A`,
  `git write-tree`).
- `tool.call` on Bash: after the command, a second snapshot; the files that
  differ (`git diff-tree`) are the command's entry.
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

Nightlab on YouTube: [@NightlabBC](https://www.youtube.com/@NightlabBC).
