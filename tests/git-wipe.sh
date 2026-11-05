#!/bin/sh
# Real git: Claude's shell command is itself a git command that throws away uncommitted work
# (checkout --, restore, reset --hard, clean -fd, stash -u). The record's snapshot before the
# command holds that work, so the undo brings it back. Same git calls as git-snapshot.sh.
# A file git ignores is never in the snapshot: clean -fdx deletes it for good (the limit, tested).
# Run: sh tests/git-wipe.sh [scratch-dir]
set -u
D=${1:-$(mktemp -d)}
fail() { echo "FAIL $*"; exit 1; }

fresh() {
  rm -rf "$D/repo"; mkdir -p "$D/repo"; cd "$D/repo" || exit 1
  git init -q; git config user.email t@example.invalid; git config user.name t
  printf 'a\n' > a.txt; printf 'b\n' > b.txt; printf 'build/\n' > .gitignore
  git add -A; git commit -qm init
  # The person's uncommitted work: an unstaged edit, a staged edit, a new file, an ignored file.
  printf 'a mine\n' > a.txt
  printf 'b staged\n' > b.txt; git add b.txt
  printf 'notes\n' > notes.txt
  mkdir -p build; printf 'cache\n' > build/out.bin
  REAL=$(git rev-parse --path-format=absolute --git-path index)
  IDX=$(git rev-parse --path-format=absolute --git-path agent-undo.index)
  rm -f "$IDX"; cp "$REAL" "$IDX"
}
snap() { GIT_INDEX_FILE="$IDX" git add -A && GIT_INDEX_FILE="$IDX" git write-tree; }
changed() { git diff-tree -r --no-renames -z "$1" "$2" | tr '\0' '\n' | paste - - | awk '{print $5, $6}' | tr '\n' ' '; }
undo_all() {  # $1 before, $2 after: restore every file the command changed or deleted
  files=$(git diff-tree -r --no-renames -z --diff-filter=MD --name-only "$1" "$2" | tr '\0' '\n' | sed 's/^/:(literal)/')
  # shellcheck disable=SC2086
  GIT_INDEX_FILE="$IDX" git restore --source="$1" --worktree -- $files
}
mine_back() {
  [ "$(cat a.txt)" = 'a mine' ] || fail "$1: a.txt is [$(cat a.txt)]"
  [ "$(cat b.txt)" = 'b staged' ] || fail "$1: b.txt is [$(cat b.txt)]"
}

# 1. git checkout -- . : the unstaged edit is gone, then back.
fresh; A=$(snap); git checkout -- . ; B=$(snap)
[ "$(changed "$A" "$B")" = 'M a.txt ' ] || fail "checkout: listed [$(changed "$A" "$B")]"
undo_all "$A" "$B"; mine_back checkout

# 2. git restore . : the same through the newer command.
fresh; A=$(snap); git restore . ; B=$(snap)
[ "$(changed "$A" "$B")" = 'M a.txt ' ] || fail "restore: listed [$(changed "$A" "$B")]"
undo_all "$A" "$B"; mine_back restore

# 3. git reset --hard: the staged and the unstaged edit are gone, and the real index moved too.
fresh; A=$(snap); git reset -q --hard; B=$(snap)
[ "$(changed "$A" "$B")" = 'M a.txt M b.txt ' ] || fail "reset: listed [$(changed "$A" "$B")]"
undo_all "$A" "$B"; mine_back reset
[ -f notes.txt ] || fail "reset: notes.txt should never have gone"

# 4. git clean -fd: the new file the person had not added yet is deleted, then back.
fresh; A=$(snap); git clean -qfd; B=$(snap)
[ "$(changed "$A" "$B")" = 'D notes.txt ' ] || fail "clean: listed [$(changed "$A" "$B")]"
undo_all "$A" "$B"; [ "$(cat notes.txt)" = notes ] || fail "clean: notes.txt not back"
[ -f build/out.bin ] || fail "clean -fd must not touch ignored files"

# 5. git stash -u: tracked edits and the new file go into a stash; all back, the stash stays.
fresh; A=$(snap); git stash -q -u; B=$(snap)
[ "$(changed "$A" "$B")" = 'M a.txt M b.txt D notes.txt ' ] || fail "stash: listed [$(changed "$A" "$B")]"
undo_all "$A" "$B"; mine_back stash; [ "$(cat notes.txt)" = notes ] || fail "stash: notes.txt not back"
[ "$(git stash list | wc -l)" -eq 1 ] || fail "stash: the stash itself should be left alone"

# 6. The limit: git clean -fdx deletes an ignored file; it was never in the snapshot.
fresh; A=$(snap); git clean -qfdx; B=$(snap)
[ "$(changed "$A" "$B")" = 'D notes.txt ' ] || fail "clean -x: listed [$(changed "$A" "$B")]"
[ ! -e build/out.bin ] || fail "clean -x: expected the ignored file gone"

# 7. Why a shell undo checks a deleted file's folder: real git replaces a person's file with the folder.
fresh; mkdir -p d; printf 'x\n' > d/f.txt; A=$(snap); rm -rf d; printf 'mine\n' > d
GIT_INDEX_FILE="$IDX" git restore --source="$A" --worktree -- ':(literal)d/f.txt' 2>/dev/null
[ -d d ] || fail "restore over a file: git no longer replaces it, so the refusal has no reason to exist"

# 8. What the refusal of a filtered file reads: the filter's name, or unspecified.
fresh; printf '*.nb filter=strip\n' > .gitattributes
[ "$(git check-attr -z filter -- n.nb | tr '\0' ' ')" = 'n.nb filter strip ' ] || fail "check-attr: filter set"
[ "$(git check-attr -z filter -- a.txt | tr '\0' ' ')" = 'a.txt filter unspecified ' ] || fail "check-attr: no filter"

# 9. What makes a snapshot fail, and git's own words (tests/git-fails.test.tsx replays them): exit 128, first line first.
adds() { GIT_INDEX_FILE="$IDX" git add -A 2>"$D/err"; }
fresh; mkdir sub; (cd sub && git init -q)
adds; [ $? -eq 128 ] || fail "nested repo with no commit: git add exit changed"
[ "$(head -n 1 "$D/err")" = "error: 'sub/' does not have a commit checked out" ] || fail "nested repo: git said [$(cat "$D/err")]"
[ "$(sed -n 2p "$D/err")" = 'fatal: adding files failed' ] || fail "nested repo, second line: [$(cat "$D/err")]"
fresh; git config core.autocrlf input; git config core.safecrlf true; printf 'x\r\ny\r\n' > c.txt
adds; [ $? -eq 128 ] || fail "safecrlf: git add exit changed"
[ "$(cat "$D/err")" = 'fatal: CRLF would be replaced by LF in c.txt' ] || fail "safecrlf: git said [$(cat "$D/err")]"
# A warning with exit 0 is no failure, and is not shown.
fresh; git config core.autocrlf input; git config core.safecrlf warn; printf 'x\r\ny\r\n' > c.txt
adds || fail "safecrlf warn: git add failed: [$(cat "$D/err")]"
grep -q '^warning:' "$D/err" || fail "safecrlf warn: no warning: [$(cat "$D/err")]"

echo "PASS git add's failures: a nested repo with no commit, core.safecrlf; a warning alone is no failure"
echo "PASS a deleted file's folder replaced by git; check-attr's answer"
echo "PASS checkout --, restore, reset --hard, clean -fd, stash -u: the person's uncommitted work comes back; clean -fdx: an ignored file is not recorded (the limit)"
