# What the test world copies from the engine, and what it may still hide

`tests/engine.tsx` holds the Edit and Write results the tests see. `tests/world.tsx` and
`tests/review2-world.tsx` hold the fake git and file system. Everything under "Read from the engine"
was read on 2026-11-04 from the Claude Code 2.1.312 binary on this machine and from its declarations,
without running a session. A later engine may differ; the audit that led to this file read 2.1.318.

## Read from the engine

- `structuredPatch` is display text. Every line goes through convertTabs: `/^\t+/gm`, each leading tab
  becomes two spaces. The `m` flag also matches after a lone `\r`, ` ` or ` ` inside a line.
- Edit's `originalFile` is the text the diff was made from: the file decoded, every CRLF turned to LF,
  the BOM kept. The diff never shows `\r` for a CRLF file.
- Edit decides the line ending from the first 4096 characters (more CRLF than LF means CRLF) and writes
  the whole file that way, so a mixed file comes out with one ending. The diff does not show that.
- Write puts `content` on disk as given, with no line ending conversion, and keeps a BOM the old text had.
- A diff line holds its text without the `\n`. A last line without one is followed by
  `\ No newline at end of file`. Three lines of context; an unchanged run of up to six lines stays
  inside one hunk. A diff that times out gives `[]`.
- `newString` in Edit's result is the input. The text really written can differ (curly quotes copied from
  the file). `oldString` is the text really matched.
- `$.fs.read` is `Buffer.toString('utf8')`: invalid bytes become U+FFFD, the BOM stays, CRLF stays, over
  4 MiB rejects. `$.fs.write` is `writeFile`: it follows a link, makes parent folders, is not atomic.
- `$.fs.exists` is `stat`: false under a file, false for a link that leads nowhere. `$.fs.stat` is
  `lstat` first: a missing path rejects with text ending in the errno (`ENOENT`, `ENOTDIR`).
- A tool's absolute `file_path` goes through `path.normalize`: `..` is folded as text, so `link/../c.txt` is the link's
  parent's `c.txt`, not its target's parent's. `$.fs.stat` under the kit folds the same way before a hook sees the path
  (seen in a test); `{ resolve: true }` is declared to follow every link and fold `..`. Hooks import nothing but
  `claude-code`, so `fs.realpathSync` is not to hand. Real `$.fs.stat` on such a path was not run.
- An Edit or Write with `_host` naming a machine runs on that machine. A trimmed empty name, `container`
  and `this-machine` mean here. Declarations do not list `_host`; the field was read from the binary.

## Not the same as the engine, or not checked

- The diff's line matching. `tests/engine.tsx` uses a longest common subsequence; the engine has its own
  search. With repeated lines the two may place a change differently, and a hunk's bounds with it.
- The written new text when it differs from `newString` (curly quotes, memory-file changes, shared items).
  The fake always writes `newString`, so that path has only a hand-made test.
- Real `claude` sessions. Every result here is built by the fake. The audit's `_host` path was read, not run:
  which hook sees the field in a real call has not been seen, nor has an Edit on an attached machine.
- UTF-16 files. The engine reads and writes them; the fake holds strings only, so the refusal is shown
  with bytes that are not valid UTF-8, not with a real UTF-16 file.
- Old git. No git before 2.31 ran here. The fake answers what the audit reports for 2.30.
- Windows, WSL drives, case-insensitive file systems, sparse index, LFS, git-crypt: not run.
- `fs.stat` errors other than `ENOENT`: read from the binary, one hand-made test.
- `tests/world.tsx` and `review2-world.tsx` answer only the git commands the record runs. Real git
  runs in `tests/git-snapshot.sh`, `tests/git-wipe.sh` and the `tests/release-audit*.test.mjs` files. The hand-written one-line patches in the
  older `review-*` worlds carry no tabs and do not go through `tests/engine.tsx`.

## A fake's result must describe its file

The mod works out the new file from a result's `originalFile`, `oldString` and `newString`, and proves each diff line
against them. A world that answers with a marker string and made-up diff lines leaves an edit with no hunks, and a test
that only counts entries still passes while testing nothing: the size-cap tests sat at 1 KB of list for that reason. A
test about size asserts the size it reached.

## What the worlds hide, and where the real thing is tested

`tests/world.tsx` is maps of strings: its `fs.exists` and `hash-object` walk no link, its restore never fails part way
except where a test wraps it, it knows no permissions or text conversion, it ignores `timeoutMs`, its writes are
atomic. The worst faults of the audit lived in that gap. So `tests/release-audit.test.mjs`, `release-audit2` to `7`
run the compiled hooks on real files, links, modes and git, and are part of `tests/release.sh`. A fault about bytes,
links, modes or a kill gets its test there, not in the world. No test here runs a model turn; `tests/native-ask.sh` starts the real engine for its permission verdict.
The plugin test kit refuses `clock.sleep` and the audit worlds answer it, so a timer path runs both ways only if a test exists in each.
