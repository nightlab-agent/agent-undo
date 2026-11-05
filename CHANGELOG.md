# Changelog

## 0.3.0 - 2026-11-05
- An Edit or Write waiting behind a running undo no longer goes on beside it at Claude Code's hook limit, where the undo's write could land over it: it stops itself first and tells the agent to read the file and try again (`tests/release-audit10.test.mjs`, `tests/release-audit11.test.mjs`).
- An undo waiting its turn no longer outlives its call. Behind an Edit at its question or a running snapshot, an
  interrupt, the end of the conversation or the end of the hook's time now stops it there: it says so at once and
  writes nothing later. Before, a queued undo could land on the next conversation's edit of the same number after a
  `/resume`. An undo that gives up leaves the queue at once, so Edits of other files go on. One that has begun looks
  at its turn again before its write, and a conversation that ends during it leaves the next conversation's list
  alone, read inside the list's own update. A conversation that ends during the permission check spends the allow too, and a snapshot's git call that
  never comes back no longer holds the queue for good (`tests/release-audit18.test.mjs`,
  `tests/release-audit3.test.mjs`, real files and real git).
- An undo on a slow drive is no longer refused as out of time: its limit now counts the hook's own time, as Claude Code's
  does, not the time its tools take (`tests/release-audit7.test.mjs`). While that time stands still it looks again at most four times a second, and with no time to read it waits once (`tests/release-audit8.test.mjs`, `tests/release-audit9.test.mjs`). A slow undo stops before its write once an Edit behind it nears that Edit's own 10 s, so it cannot land over an Edit Claude Code ran on without it (`tests/release-audit10.test.mjs`).
- A shell undo whose time ran out stops at once, with no git call for each file it will not touch
  (`tests/review-tsr-after-turn.test.tsx`).
- An Edit or Write run on an attached machine is not recorded: this machine cannot restore it. Read from Claude Code's
  program, not yet seen on a screen (`tests/review-crz.test.tsx`).
- A command that starts during a shell undo waits for the restore, so it cannot list the undo as its own change
  and a later undo of that command cannot reverse it. A command that starts during an Edit undo no longer lists the
  temporary copy, outside the instant `mktemp` makes it (`tests/release-audit3.test.mjs`, `tests/release-audit4.test.mjs`).
- A deleted file whose restore was cut short now reads "failed part way" with the command that brings it back. Before,
  it said "nothing changed" with part of the file on disk (`tests/release-audit4.test.mjs`).
- If no copy can be made for an undo (a folder you cannot write in, `mktemp`, `cp` or `mv` that cannot run), the undo
  says so and changes nothing (`tests/release-audit2.test.mjs`, `tests/release-audit17.test.mjs`, real files).
- An undo no longer lands on another file if a link replaces the file while the undo reads it
  (`tests/release-audit2.test.mjs`).
- Where git ignores permissions (`core.filemode` false), a shell undo keeps an executable bit you set; `git restore`
  takes it away and said nothing (`tests/release-audit17.test.mjs`).
- Claude's undo tool now checks Claude Code's permission rules and mode first (not settings hooks or the auto-mode classifier; a plugin's own check hook is asked).
  Before, it answered with no permission step, so plan mode and deny rules did not stop it. An allow goes through;
  where the rules ask, you get the question; a no, a closed question, a deny, an ask of a kind it does not know or a
  run with no one to answer changes nothing, and `/agent-undo` stays yours (`tests/review-crz.test.tsx`,
  `tests/review-ask.test.tsx`). Plan mode stays a refusal: a yes does not override it (`tests/review-dex-plan.test.tsx`).
  A question left open when the conversation ends or clears is spent, so a late yes cannot land on the next
  conversation's edit of the same number (`tests/review-dex-ask.test.tsx`). Listing needs no check.
- An undo killed halfway no longer empties the file: an Edit or Write undo writes a fresh copy beside it under a name
  of its own and renames, so it cannot overwrite a file already there (`tests/release-audit.test.mjs`, a real killed write).
- An undo no longer follows a link put at the edited path into another file, or replaces a link or linked folder put
  there since a command. Before, it changed the other file, or swapped the link for a plain file
  (`tests/release-audit.test.mjs`, real links).
- A shell undo compares the bytes on disk. Before, git's own hash hid a later change of line endings or an `$Id$`
  keyword, and the undo wiped it and said it worked. Files git converts are now left as they are. An executable bit
  changed since the command is also refused; before, the undo dropped it.
- A shell undo keeps the file's permissions. Before, `git restore` recreated the file at the umask mode: 600 became 644,
  700 became 755. Where the command itself changed the executable bit, that bit goes back and the rest stays.
- A save made while a shell undo waits behind a snapshot stays. The checks now run after the wait.
- A shell undo that git leaves unfinished says so, with the command that brings the file back. Before, it said "left
  as is" after git had already removed the file.
- Two sessions on one checkout each keep their own private index. Before, one session reseeding the shared file could
  drop unstaged work from the other's snapshot, and a later undo restored committed text and said it worked.
- A repo git refuses (dubious ownership) now shows git's line. Before, nothing was recorded and nothing was said.
- A first snapshot may take 60 s, not 20. A killed one recorded nothing on a large repo.
- An undo still waiting near the end of its hook budget gives up and says so, instead of writing after its answer.
- Every undo ends in its outcome line. A read-only file, a file deleted during the undo and a failure no step expected
  used to leave as a hook failure, and the person read Claude Code's message for plugin authors.
- A file too large to read answers with a line instead of an error. When the store is full and an old conversation's copy is dropped, one saved since the
  scan is kept. A failed release no longer depends on `tests/release.sh` missing the real-file tests: they run there now.
- The npm package carries `hooks/hunks.tsx`. A release from before this line would not have loaded: `hooks/register.tsx` imports that file
  and the package's file list left it out. 0.2.2 is not affected. The release check now fails when a packed hook imports an unpacked file.
- An Edit through a linked folder during a command stays with the Edit. Before, git's real path and the Edit's path
  did not match, so the file was listed under the command too. Paths are now compared by where they land
  (`tests/symlink-edit.test.tsx`; the test world walks links as the declarations say, no real link was followed).
- When git cannot take a snapshot, the status line and the list give git's first error line. Before, a failed
  `git add -A` (a nested repo with no commit, `core.safecrlf` refusing a file) turned off the Bash and MCP record with
  no word. Each command still tries again, and the line goes once one works (`tests/git-fails.test.tsx`, git's words
  from `tests/git-wipe.sh`; not seen on a screen).
- A Monitor command now stops recording the way a background Bash command does. Before, it went on running and its
  writes were listed under the next command. A Monitor on a socket runs no command here and changes nothing
  (`tests/background.test.tsx`; the tool's input and answer are from the declarations, no real Monitor was run).
- Recording stays off after a background command when the engine fires its start hook again in a running process.
  Before, that second start turned recording back on, and the command's later writes landed in the next record; a
  command running at that moment also lost its own record. A /clear or a resume still starts fresh
  (`tests/background.test.tsx`; the second start is raised by the test, not seen in a real reload).
- An Edit or Write waiting on its permission question no longer holds back those of other files, and one made on the
  way through another Edit of a different file no longer hangs. Before, all of them shared one queue. An undo still
  waits for every Edit and Write in progress; the list answers at once (`tests/queues.test.tsx`; not seen on a screen).
- An undo refuses a file holding bytes that are not UTF-8. Before, the undo read the file as text, where each such
  byte shows as U+FFFD, and wrote that text back: the undo said it worked and the bytes were gone. A real U+FFFD
  in good UTF-8 is still fine (`tests/bytes.test.tsx`; not seen on a screen).
- A shell undo no longer replaces what stands where a deleted file's folder was. Before, a file or link saved at
  that folder's name was replaced by the folder, and that file was in no snapshot, so it was lost; a link leading
  nowhere at the file's own path was replaced too. Now each is refused (`tests/shell-undo.test.tsx`, fake git; real
  git's replacing in `tests/git-wipe.sh`).
- A shell undo refuses a file under a git clean filter. Before, a filter such as nbstripout could make the person's
  later change hash the same as the command's, and the undo overwrote it. A deleted file still comes back
  (`tests/shell-undo.test.tsx`; the attribute read in `tests/git-wipe.sh`).
- An undo no longer reverts a look-alike. Before, one match anywhere in the file was taken, and later
  edits did not move a hunk's place, so where two blocks read the same the undo could change the block the edit
  never touched and say it worked. Hunks now follow later edits and undos, and an undo acts only at that
  place with the file's length as followed, or where the lines stood once and stand once now; otherwise it
  refuses (`tests/lookalike.test.tsx`; not seen on a screen).
- On a git older than 2.31, shell commands are no longer recorded, and the list says why. Before,
  git's answer was read by position, so each snapshot staged every change in your real index
  (`tests/old-git.test.tsx`, with a fake git answering as 2.30 is reported to; no older git was run).
- An edit to tab-indented code can be undone, and an undo gives the tabs back. Claude Code's diff shows a
  leading tab as two spaces, so before, a changed tab line was refused, and a tab changed to spaces came back as
  two spaces while the undo said it worked. Hunks now take their words from the file's own text and the diff
  only for places. A list stored by an earlier version is no longer read: its hunks hold the diff's words
  (`tests/tabs.test.tsx`; not seen on a screen).
- The npm description fits the registry's 255 characters; it was cut in the middle of a word.
- A stored copy that needs more room than one other conversation's copy now takes as many of the
  oldest copies as it needs, and no more; before, one went, the store still refused, and a /resume
  from a new process could not find this conversation's list (`tests/review-store-room.test.tsx`,
  `tests/review4-resume.test.tsx`; not seen on a screen).
- Undo marks now count toward the list's size limit, so a fifth undo of very large edits is
  listed instead of refused after the file was already back (`tests/review-store-room.test.tsx`,
  not seen on a screen).

## 0.2.2 - 2026-11-03
- The list stays under the 4 MiB Claude Code allows it, dropping the oldest entries first; an
  edit that alone would fill it is listed as too large. Before, once big edits took the list past
  that size, each new edit was refused there and never listed, with no word (in the tests,
  `tests/review-statecap.test.tsx`; not seen on a screen).
- When a restored list gained entries from the stored copy, the copy is written again without
  holding up the edit or undo that asked: before, a store write that never finished left
  /agent-undo with no answer and every later Edit or Write waiting (in the tests,
  `tests/review-ts-grew.test.tsx`; not seen on a screen, a store that never answers cannot be
  made there).
- A stored-copy write the store refuses for a reason other than its size (a busy file, a write
  cut short, a mod above that refuses it) is tried once more as it is, and another conversation's
  copy is removed to make room only when the store, measured with the new copy, is over its
  4 MiB, counted in characters as Claude Code counts it (so accented or CJK text is not read as
  full early). Before, any refusal removed the oldest other conversation's undo list. Not seen on
  a screen; in the tests, `tests/review-cr6.test.tsx` (P1) and `tests/review-cr7.test.tsx` (Q1:
  refused twice, under the cap, the other copy stays; at the cap, it goes).
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
  copy loses them too, so a second /clear in that instant leaves none behind
  (`tests/review8-window.test.tsx`, F1, F1b, F2).
  A copy that cannot be read twice, or written, is dropped rather than kept with them
  (`tests/review9-scrub.test.tsx`).
- Leaving the window (/exit, ctrl+c) while the last edit is still being stored no longer drops
  that edit from the stored copy, so a later `claude --resume` lists it: the end waits for that
  write, a second at most, before Claude Code finishes (`tests/review-end9.test.tsx`, X1 fails before it;
  `tests/review-undo11.test.tsx`, E1, E1b). An edit whose list update lands during that wait
  is waited for too, at an exit and at a /clear, under the same second, and so is one whose tool
  result came in but whose list update has not started (`tests/review-undo13ts.test.tsx`, L1, L2;
  `tests/review-undo14.test.tsx`, R1).
- An undo or an Edit or Write whose own stored-copy write never finishes now answers after a second
  at most, and later Edits and Writes still run: before, it waited for that write with no bound and
  held them all (`tests/review-crx-serial.test.tsx`, S1, S2). The write is still waited for by an
  exit, a /clear and the next save.
- After a /clear, a stored-copy write that never finishes no longer holds `/agent-undo` and every
  later Edit and Write: the next conversation's first read waits for it a second at most
  (`tests/review-undo13.test.tsx`, L1). If the write has not landed by then, the stored copy is
  read as it stands and the new edits are stored from then on: each edit's own save waits for
  the one before it a second at most, and once a late write lands the list is saved again, so
  the newest copy is written last (`tests/review-undo16.test.tsx`, N1, N1b); a /clear before it
  lands, even one in that second, still leaves the ending conversation's copy whole
  (`tests/review-undo17.test.tsx`, X1, X1b, X2; `tests/review-undo17ts.test.tsx`, T1). A known
  limit: a write that lands later still is written over, so edits only it carried leave the undo
  list (their files keep them) (`tests/review-undo14.test.tsx`, R2;
  `tests/review-undo15.test.tsx`, S1, S2). A second known limit: a write the store never finishes
  is waited for with no bound by every ending conversation's copy and every cleanup of other stored
  copies from then on, so none of them is written in that process (later edits are still saved, the
  first after a second and the rest at once;
  `tests/review-undo17.test.tsx` X1 and `tests/review-undo18.test.tsx` Y1 show the two waits;
  `tests/review-undo16.test.tsx` N1 the later edits). A bound there would let that write land last,
  over the newer copy.
- Each "a second at most" in this release is timed by Claude Code's own timer. Where another mod
  refuses that timer: an undo and an Edit or Write wait for a stored-copy write that never
  finishes with no bound, as before this release; the end of a conversation (an exit, a /clear, a
  /resume) waits for it until that hook's own time limit, then goes on, where before it did not
  wait at all; the next conversation's first read of its stored list does not wait for it, as
  before this release; and the cleanup of other stored copies after a /clear in that instant
  waits for it with no bound. Read from the code; not covered by a test.
- An Edit or Write that takes an old conversation's entries back out waits for the cleanup of the
  other stored copies a second at most, so a stored-copy write that never finishes does not hold
  that edit, and it is listed (`tests/review-cr-whole.test.tsx`, Z1). With that write stuck, the
  edit waits about two seconds in all: one for its read of the stored copy and one for the
  cleanup, which is not waited for a second time (under 2.5 s in `tests/review-cr4.test.tsx`, R2). The
  cleanup itself still runs once that write lands, and the list is saved again after it. A /resume
  back to a conversation whose stored copy that cleanup has not yet cleaned waits for it under its
  read's one second, so the old entries are not listed again if it lands within that second
  (`tests/review-cr4.test.tsx`, R1). An exit waits for it the same way, so a later `claude --resume`
  does not list them either (`tests/review-pr5.test.tsx`). A known limit: a cleanup that lands
  later, or never, costs the read its whole second, and the old entries are listed and stored again.
- A Bash command or MCP call that changed files and is still being recorded when a /clear or an
  exit comes is waited for too, under the same second (`tests/review-undo15ts.test.tsx`, B1).
- A /clear and a /resume back (or a /resume to another conversation) while the stored list was
  still being read no longer stops the rest of the session's edits from being stored: a read that
  finds its stored entries already listed counts as done, stored entries numbered below every
  listed one are put back in front of them, and one that gives up is tried again at the next
  read (`tests/review-end9.test.tsx`, X2, X2b and X3 fail before it).
- A /clear while an edit was still being stored no longer writes the new conversation's list as the
  old one's stored copy: the old list is taken when the conversation ends, before the switch, so a
  later `claude --resume` of it lists every edit (`tests/review-undo10.test.tsx`, P1, P1b, P1c; not
  seen on a screen, a /clear cannot be timed there).

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
