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
claude plugin test .
node --test tests/mcp-writer.test.mjs
# Real files, links, permissions and git, where tests/world.tsx has only maps (tests/ENGINE-NOTES.md).
node --test tests/release-audit.test.mjs
node --test tests/release-audit2.test.mjs
node --test tests/release-audit3.test.mjs
node --test tests/release-audit4.test.mjs
node --test tests/release-audit5.test.mjs
node --test tests/release-audit6.test.mjs
node --test tests/release-audit7.test.mjs
node --test tests/release-audit8.test.mjs
node --test tests/release-audit9.test.mjs
node --test tests/release-audit10.test.mjs
sh tests/typecheck.sh
sh tests/git-wipe.sh
# The engine's own words on an ask: hooks/register.tsx reads them, the fakes copy them.
sh tests/native-ask.sh
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
