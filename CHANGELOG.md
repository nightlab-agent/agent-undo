# Changelog

## Unreleased

- The list is copied into the mod's store under the session's id after each recorded change and
  each undo, and an empty list takes that copy back at its first read: in the tests, a new process
  with the same session id lists the earlier edits and Bash commands and undoes them, with the
  same check as before (a file changed since is refused). Another session id starts empty; only
  the 5 sessions written most recently are kept; a copy saved by an older version, whose list has other fields, is ignored.
  Claude Code's docs imply a plain `claude --resume` reuses the session id (`--fork-session`
  makes "a new session ID instead of reusing the original", code.claude.com/docs/en/cli-reference); the list coming back
  after a resume is not yet seen on a screen. A new session, in a preview, starts empty.
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
