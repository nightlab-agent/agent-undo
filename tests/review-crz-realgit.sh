#!/bin/bash
# Real git, the same calls hooks/shell.tsx makes for a shell undo. Each case prints FAIL when the undo's own checks
# pass and git then changes something the person made; each COMPARE is the nearest normal case and must print PASS.
# Run: bash tests/review-crz-realgit.sh <scratch-dir>
D=${1:-$(mktemp -d)}
fresh() { rm -rf "$D/repo" "$D/out"; mkdir -p "$D/repo" "$D/out"; cd "$D/repo" || exit 1; git init -q; git config user.email t@example.invalid; git config user.name t
  mkdir src; printf 'one\n' > src/f.txt; printf 'keep\n' > src/g.txt; printf 'a\n' > a.txt; git add -A; git commit -qm init
  REAL=$(git rev-parse --path-format=absolute --git-path index); IDX=$(git rev-parse --path-format=absolute --git-path agent-undo.index); cp "$REAL" "$IDX"; }
snap() { GIT_INDEX_FILE="$IDX" git add -A && GIT_INDEX_FILE="$IDX" git write-tree; }
# As undoShell: status M is put back when the file exists and hash-object says the blob the command left.
undo_m() { # $1 path $2 before-tree $3 blob the command left
  [ -e "$1" ] || { echo refused-gone; return; }
  [ -z "$(git check-attr -z filter -- "$1" | tr '\0' '\n' | sed -n 3p | grep -v -x -e unspecified -e unset)" ] || { echo refused-filter; return; }
  now=$(git hash-object -- "$1" 2>/dev/null)
  [ "$now" = "$3" ] || { echo refused-changed; return; }
  GIT_INDEX_FILE="$IDX" git restore --source="$2" --worktree -- ":(literal)$1" 2>&1 && echo undid
}
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1: wanted [$2], got [$3]"; fi; }

# 1. A folder the person moved and linked: status M has no check of its folders, as status D has (inTheWay).
fresh; A=$(snap); printf 'two\n' > src/f.txt; B=$(snap); AFTER=$(git rev-parse "$B:src/f.txt")
mv src lib; ln -s lib src
said=$(undo_m src/f.txt "$A" "$AFTER"); echo "said: $said"
check 'M under a linked folder: the link stays' 'lib' "$(readlink src)"
check 'M under a linked folder: the other file still reads at its path' 'keep' "$(cat src/g.txt 2>/dev/null)"
# COMPARE: the folder still a folder.
fresh; A=$(snap); printf 'two\n' > src/f.txt; B=$(snap); AFTER=$(git rev-parse "$B:src/f.txt")
said=$(undo_m src/f.txt "$A" "$AFTER"); check 'COMPARE M in a plain folder comes back' 'one' "$(cat src/f.txt)"

# 2. The file itself is now a link to a file with the same words.
fresh; A=$(snap); printf 'two\n' > a.txt; B=$(snap); AFTER=$(git rev-parse "$B:a.txt")
mkdir -p "$D/out"; cp a.txt "$D/out/shared.txt"; rm a.txt; ln -s "$D/out/shared.txt" a.txt
said=$(undo_m a.txt "$A" "$AFTER"); echo "said: $said"
check 'M: a link the person put there stays' "$D/out/shared.txt" "$(readlink a.txt)"

# 3. text conversion: the person changes only line endings; hash-object cannot see it, so the check passes.
fresh; printf '* text=auto\n' > .gitattributes; git add -A; git commit -qm attrs; cp "$REAL" "$IDX"
printf 'l1\r\nl2\r\n' > c.txt; git add -A; git commit -qm c; cp "$REAL" "$IDX"; A=$(snap)
printf 'l1\nl2\nl3\n' > c.txt; B=$(snap); AFTER=$(git rev-parse "$B:c.txt")
printf 'l1\r\nl2\r\nl3\r\n' > c.txt   # the person's save, CRLF
said=$(undo_m c.txt "$A" "$AFTER"); echo "said: $said"
check 'a line-ending save under text=auto is seen as a change' 'refused-changed' "$said"

# 4. The exec bit the person set after the command: hash-object cannot see a mode.
fresh; A=$(snap); printf 'two\n' > a.txt; B=$(snap); AFTER=$(git rev-parse "$B:a.txt")
chmod +x a.txt
said=$(undo_m a.txt "$A" "$AFTER"); echo "said: $said"
check 'chmod +x stays' 'yes' "$([ -x a.txt ] && echo yes || echo no)"

# 5. git stops part way: it unlinks the file, then writes. undoShell's catch then says "left as is".
# Two ways to stop it: a blob it cannot read, and a write it cannot finish (a full disk, a kill at the 20 s timeout).
fresh; printf 'mine\n' > b.txt; A=$(snap); printf 'after\n' > b.txt; B=$(snap); O=$(git rev-parse "$A:b.txt")
rm -f ".git/objects/${O:0:2}/${O:2}"
GIT_INDEX_FILE="$IDX" git restore --source="$A" --worktree -- ':(literal)b.txt' 2>/dev/null; rc=$?
echo "git exit $rc: the mod says: left as is"
check 'git failed, so the file is as the command left it (missing blob)' 'after' "$(cat b.txt 2>/dev/null)"
fresh; head -c 300000 /dev/zero | tr '\0' 'x' > big.txt; A=$(snap); printf 'small\n' > big.txt; B=$(snap)
( ulimit -f 8; trap '' XFSZ; GIT_INDEX_FILE="$IDX" git restore --source="$A" --worktree -- ':(literal)big.txt' 2>/dev/null; echo "git exit $?: the mod says: left as is" )
check 'git failed, so the file is as the command left it (write cut short)' 'small' "$(head -c 5 big.txt 2>/dev/null)"
# COMPARE: a tree gone altogether stops git before it touches the file.
fresh; printf 'mine\n' > b.txt; A=$(snap); printf 'after\n' > b.txt; B=$(snap)
GIT_INDEX_FILE="$IDX" git prune --expire=now 2>/dev/null; git prune --expire=now
GIT_INDEX_FILE="$IDX" git restore --source="$A" --worktree -- ':(literal)b.txt' 2>/dev/null; rc=$?
echo "git exit $rc"
check 'COMPARE tree pruned: the file stays' 'after' "$(cat b.txt 2>/dev/null)"
