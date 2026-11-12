#!/bin/sh
# Release check: the manifest and module validate, the tests pass, the plugin
# directory checklist (tests/checklist.py, from mod-ready) has no FAIL, and the
# version string is the same in the plugin manifest, the marketplace manifest,
# the changelog's newest release, and package.json (the README carries no version).
# Exit non-zero on any of them. Run from the repo root: sh tests/release.sh
# Type-check: tests/typecheck.sh, tsc --noEmit against the engine's declarations.
# Real git: tests/git-wipe.sh, git commands that throw away uncommitted work, then undone.
set -e
cd "$(dirname "$0")/.."
claude plugin validate .
# A failing run ends with the failed tests' names, so a tool that shows only the tail still names them.
out=$(mktemp)
if ! claude plugin test . >"$out" 2>&1; then
  cat "$out"; grep -E '^\(fail\)' "$out" | cut -c1-110 | tail -4; rm -f "$out"; exit 1
fi
cat "$out"; rm -f "$out"
# Real files, links, permissions and git, where tests/world.tsx has only maps (tests/ENGINE-NOTES.md).
# One node --test run takes the files side by side; each makes its own mkdtemp scratch, none opens a port.
node --test tests/mcp-writer.test.mjs tests/release-audit*.test.mjs
sh tests/typecheck.sh
sh tests/git-wipe.sh
# The engine's own words on an ask: hooks/register.tsx reads them, the fakes copy them.
if [ -n "${RUN_NATIVE:-}" ]; then sh tests/native-ask.sh; fi
if [ -n "${RUN_NATIVE:-}" ]; then sh tests/native-budget.sh; fi
python3 -I tests/checklist.py
python3 -I - <<'PY'
import json, re, sys
plugin = json.load(open('.claude-plugin/plugin.json'))['version']
market = json.load(open('.claude-plugin/marketplace.json'))['plugins'][0]['version']
changelog = re.search(r'^## (\d+\.\d+\.\d+) ', open('CHANGELOG.md').read(), re.M).group(1)
package = json.load(open('package.json'))['version']
versions = {'plugin.json': plugin, 'marketplace.json': market, 'CHANGELOG.md': changelog, 'package.json': package}
if len(set(versions.values())) != 1:
    sys.exit(f"version strings differ: {versions}")
print(f"version check: all four say {plugin}")
PY
echo "release check: validate, test, type check, checklist and version check passed"
