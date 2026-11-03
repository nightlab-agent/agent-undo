# Changelog

## 0.2.2 - 2026-11-03
- A /clear in the instant between the restore's session check and the list's update no longer
  lets the old session's list into the new conversation: the id is asked again after the update,
  and if it changed, exactly the entries taken come out again (in the tests,
  `tests/review6-gap.test.tsx`; not seen on a screen, a /clear cannot be timed there). The
  stored copy is written again after, so an edit the new conversation makes in that instant does
  not carry the old entries into its store, and a later resume does not list them
  (`tests/review7-mirror.test.tsx`, `tests/review7-ts-gap.test.tsx`). Such an edit keeps the
  number it was given, as every entry does.
- After a /clear, a /resume back to the earlier conversation in the same window reads its stored
  list again: before, the next edit wrote a list of one over the stored one, and its earlier
  entries were lost (`tests/review8-window.test.tsx`, F4 and F4b).
- When the old entries are taken back out, they are found by number, time and file, so an undo
  of one in that instant does not keep it in the new list; and every other conversation's stored
  copy loses them too, so a second /clear in that instant leaves none behind (F1, F1b, F2).

## 0.2.1 - 2026-11-03
- Seen on a screen: two writes by an MCP tool listed, one undone, the other kept (README picture;
  the preview's small MCP server is `preview/mcp-writer.js`, tested in `tests/mcp-writer.test.mjs`).
- Git commands that throw away uncommitted work (`checkout --`, `restore`, `reset --hard`,
  `clean -fd`, `stash -u`), run by Claude as a Bash command, are undone like any other command:
  a new test, `tests/git-wipe.sh`, runs them against real git with the mod's git calls and is
  part of `tests/release.sh`. `clean -fdx` deletes ignored files, which are never recorded.
- MCP tools: in a git repo, a call to any `mcp__*` tool (other than agent-undo's own) that ran
  without a question is recorded the way a Bash command is, listed as `MCP <server> <tool>` with
  its files, and undone with the same shell undo (a file changed since is refused, a new file is
  never deleted, the private index only). A call that ran while a Bash command or another MCP
  call ran records neither, except that an MCP call the engine reports read-only, ended before
  the other, costs the other nothing; a denied call records nothing, and unlike a failed Bash
  command, an MCP call that errors or is interrupted is not recorded, so a partial write it made
  is not undone (in the tests; not yet seen on a screen). "Read-only" is the server's own word:
  a read-only call that writes anyway has its write counted in the Bash command's change.
- An undo of part of an edit is never taken as the change of a Bash command that starts while
  the undo is still writing.
- The type check passes whether or not the engine's tool result declarations are present.

- The list is copied into the mod's store under the session's id after each recorded change and
  each undo, and an empty list takes that copy back at its first read: in the tests, a new process
  with the same session id lists the earlier edits and Bash commands and undoes them, with the
  same check as before (a file changed since is refused). Another session id starts empty; only
  the 5 sessions written most recently are kept; a copy saved by an older version, whose list has other fields, is ignored.
  Claude Code's docs imply a plain `claude --resume` reuses the session id (`--fork-session`
  makes "a new session ID instead of reusing the original", code.claude.com/docs/en/cli-reference); the list coming back
  after a resume was seen on a screen (2.1.312, 2026-11-02). A new session, in a preview, starts empty.
- After a resume the status line names the newest stored change at once (it stayed blank until
  the next change, seen on that screen). The start does not wait for the store.
  A /clear while that restore is still reading leaves the old session's list out of the new one.
  (A /clear in the instant between that check and the list's update could still let it in; fixed
  in 0.2.2.) A /clear also empties the status line.
- When the store is full and an older session's copy must go, a write time that could not be read
  is tried once more, and a copy whose time still cannot be read is kept, not evicted (in the tests).
- The stored copy: a read refused once is tried again, and no copy is written until the stored
  one was read and taken as the list, so a shorter list never replaces it. If the store refused
  both reads and edits were listed meanwhile, the stored copy is kept as it was and those later
  edits are not stored (merging would change numbers already shown). Each copy carries its own
  write time and there is no shared list of saved sessions: the 5 newest copies are kept, and a
  copy the store refuses (4 MiB in all) clears the oldest other copy and is tried once more, then
  is not stored. A /clear while the earlier session's copy is still being read stores only the
  new session. In the tests, a save by another process in the middle of this one keeps its copy
  (two timings).

## 0.2.0 (2026-11-02)

- Shell commands: in a git repo, each Bash command that changed files is listed, one number per
  file (changed, deleted or new), and `/agent-undo 4.2` (or Claude's undo tool) puts one file back
  as it was just before the command; `/agent-undo 4` puts back all of them. A file comes back only
  if it still reads as the command left it; a new file is never deleted. Recorded only when the
  command ran without a permission question (seen with permissions bypassed; an allow rule is
  tested), never two commands running at once, and not after any command went on in the
  background (the list says so). After `git gc`, the next snapshot copies the index again.
- Writes a private index (`agent-undo.index` in the git folder) and git objects in each repo it
  records; the README says how to remove them.
- Claude's undo tool describes Bash entries (<command>.<file>).
- From the second code review: an approved command running beside a recorded one makes it not
  recorded; a snapshot is taken only for a call this mod is wrapping, and dropped if the call
  ended first; a session folder that is a symbolic link into a repo's subfolder is handled;
  shell state starts fresh after `/clear`.
- The list's last line names the newest entry's own number instead of an example "3.1".

## 0.1.1 (2026-10-30)

- README: says what a hunk is (one block of changed lines inside an edit).
- The 0.1.0 entry below said Claude undoes when you ask in words; it was seen doing so only when the request names
  the agent-undo tool. The entry now says that.
- 04-memory/STATE.md now matches the README on what was seen on a screen.

## 0.1.0 (2026-10-30)

- First version: lists the Edit and Write calls that Claude Code and its subagents make in a session (the newest 20
  shown, 300 kept), hunk by hunk, and
  undoes the one you pick (`/agent-undo 3.1`), or all of one edit (`/agent-undo 3`). Claude gets a tool for the same
  list and undo (seen working when the request names the tool). An undo puts back only lines that still read as the edit left them.
