#!/bin/sh
# Type-check the hooks module, its tests and the state contract against the engine's own
# declarations (tsc --noEmit, with the options the declarations' header gives a hooks module).
# Run from anywhere: sh tests/typecheck.sh
#
# Needs two things; a missing one FAILS with what to install, it never skips:
# - the engine's declarations: CC_TYPES if set, else the file Claude Code writes beside
#   a mod each time it loads it from your own folder,
#   .claude-plugin/types/claude-code/index.d.ts (load this mod once with
#   `claude --plugin-dir .`, or set CC_TYPES to that file in another mod);
# - TypeScript: TSC if set (a path, or a command on PATH), else the project's own
#   `npx --no-install tsc`, else `tsc` on PATH.
#   No compiler found: put tsc on PATH or set TSC.
# No hooks module file (tests and .d.ts do not count) is a FAIL too.
set -e
cd "$(dirname "$0")/.."
types="${CC_TYPES:-.claude-plugin/types/claude-code/index.d.ts}"
[ -f "$types" ] || {
  echo "typecheck: FAIL, no engine declarations at $types."
  echo "  Claude Code writes them when it loads this mod: run 'claude --plugin-dir .' once from here,"
  echo "  or set CC_TYPES to a .claude-plugin/types/claude-code/index.d.ts from another mod."
  exit 1
}
if [ -n "${TSC:-}" ]; then
  tsc="$(command -v "$TSC" || true)"
  [ -n "$tsc" ] && [ -x "$tsc" ] || { echo "typecheck: FAIL, TSC=$TSC is not an executable or a command on PATH"; exit 1; }
  set -- "$tsc"
elif command -v npx >/dev/null 2>&1 && npx --no-install tsc --version >/dev/null 2>&1; then
  set -- npx --no-install tsc
elif command -v tsc >/dev/null 2>&1; then
  set -- tsc
else
  echo "typecheck: FAIL, no TypeScript compiler. Put tsc on PATH,"
  echo "  or set TSC to a tsc executable."
  exit 1
fi
files=$(ls hooks/*.ts hooks/*.tsx types/*.d.ts 2>/dev/null || true)
echo "$files" | grep '^hooks/' | grep -v -E '\.test\.tsx?$|\.d\.ts$' | grep -q . || { echo "typecheck: FAIL, no hooks module (hooks/*.ts or *.tsx other than tests and .d.ts) to check"; exit 1; }
# Claude Code lays a tsconfig.json beside a loaded mod (git ignores it); tsc 6 and later refuse to run with
# files on the command line while one is present, so an untracked one is told to be ignored (tsc 5 ignores it
# on its own and does not know the option).
extra=""
major=$("$@" --version 2>/dev/null | sed -n 's/^Version \([0-9]*\).*/\1/p')
if [ -f tsconfig.json ] && ! git ls-files --error-unmatch tsconfig.json >/dev/null 2>&1 && [ "${major:-0}" -ge 6 ]; then extra="--ignoreConfig"; fi
"$@" --noEmit $extra --target es2023 --lib es2023 --module esnext \
  --moduleResolution bundler --strict --noUncheckedIndexedAccess --skipLibCheck \
  --jsx react --jsxFactory h --jsxFragmentFactory Fragment "$types" $files
echo "typecheck: tsc --noEmit passed against $(head -1 "$types" | sed 's,^// ,,')"
