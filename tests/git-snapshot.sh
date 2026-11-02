#!/bin/sh
# The git commands the Bash record runs, on a scratch repo: a snapshot before and after a
# shell command, the diff between them, a restore of one file, and the refusal check.
# Run: sh tests/git-snapshot.sh [scratch-dir]
set -eu
D=${1:-$(mktemp -d)}
rm -rf "$D/repo"; mkdir -p "$D/repo"; cd "$D/repo"
git init -q; git config user.email t@example.invalid; git config user.name t
printf 'a\n' > a.txt; printf 'b\n' > b.txt; printf 'old\n' > gone.txt; printf 'x\n' > .gitignore
git add -A; git commit -qm init
printf 'dirty\n' >> b.txt            # the person's own uncommitted change, before Claude's command
top=$(git rev-parse --show-toplevel)
paths=$(git rev-parse --path-format=absolute --git-path index --git-path agent-undo.index)
REAL=$(echo "$paths" | sed -n 1p); IDX=$(echo "$paths" | sed -n 2p)
[ "$REAL" = "$top/.git/index" ] && [ "$IDX" = "$top/.git/agent-undo.index" ] || { echo "FAIL paths: $paths"; exit 1; }
rm -f "$IDX"; cp "$REAL" "$IDX"
snap() { GIT_INDEX_FILE="$IDX" git add -A && GIT_INDEX_FILE="$IDX" git write-tree; }
A=$(snap)
# Claude's shell command: changes a.txt, deletes gone.txt, creates new.txt and an ignored file.
printf 'a2\n' > a.txt; rm gone.txt; printf 'n\n' > new.txt; printf 'i\n' > x
B=$(snap)
got=$(git diff-tree -r --no-renames -z "$A" "$B" | tr '\0' '\n' | paste - - | awk '{print $5, $6}')
want=$(printf 'M a.txt\nD gone.txt\nA new.txt')
[ "$got" = "$want" ] || { echo "FAIL diff: got [$got]"; exit 1; }
# Refusal check: a.txt still hashes as the command left it.
[ "$(git hash-object -- a.txt)" = "$(git rev-parse "$B:a.txt")" ] || { echo "FAIL hash"; exit 1; }
git restore --source="$A" --worktree -- ':(literal)a.txt' ':(literal)gone.txt'
[ "$(cat a.txt)" = a ] && [ "$(cat gone.txt)" = old ] && [ "$(cat b.txt)" = "$(printf 'b\ndirty')" ] \
  || { echo "FAIL restore"; exit 1; }
[ -z "$(git diff --cached --name-only)" ] || { echo "FAIL the real index changed"; exit 1; }
echo "PASS snapshot, diff, hash check, restore; the person's b.txt and the real index untouched"
