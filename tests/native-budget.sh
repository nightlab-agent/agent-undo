#!/bin/sh
# Read the installed engine's real next.budget without a model turn.
set -eu
cd "$(dirname "$0")/.."
probe=$(mktemp -d .native-budget-XXXXXX)
trap 'rm -rf "$probe"' EXIT
printf '%s\n' '*' > "$probe/.gitignore"
mkdir -p "$probe/.claude-plugin" "$probe/hooks"
printf '%s\n' '{"name":"budget-probe","version":"0.0.0","description":"Local budget probe"}' > "$probe/.claude-plugin/plugin.json"
printf '%s\n' '{"modules":["./probe.tsx"]}' > "$probe/hooks/hooks.json"
cat > "$probe/hooks/probe.tsx" <<'TS'
import type { Register } from 'claude-code'
export const register: Register = on => {
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const first = next.budget
    const retained = first.remainingMs
    const another = next.budget
    const until = Date.now() + 120
    while (Date.now() < until) {}
    const own = next.budget
    await $.process.run(['sleep', '0.3'])
    const afterProcess = next.budget
    await $.clock.sleep(120)
    const afterClock = next.budget
    const infinityRefused = await $.clock.sleep(Infinity).then(() => false, () => true)
    const stop = new AbortController()
    stop.abort()
    const abortRefused = await $.clock.sleep(1000, { signal: stop.signal }).then(() => false, () => true)
    const result = {
      first, own, afterProcess, afterClock,
      distinct: first !== another,
      frozen: Object.isFrozen(first),
      plain: typeof Object.getOwnPropertyDescriptor(first, 'remainingMs')?.value === 'number',
      retainedUnchanged: first.remainingMs === retained,
      infinityRefused, abortRefused,
    }
    await $.fs.write((await $.env.get('NATIVE_BUDGET_OUTPUT'))!, JSON.stringify(result))
    return { deny: 'Local budget probe complete' }
  })
  on('prompt.submit', async ($) => {
    await $.tool.call({ tool: 'Edit', file_path: 'unused-native-budget.txt', old_string: 'unused', new_string: 'unused' })
    return { drop: 'Local budget probe complete; no model turn' }
  })
}
TS
NATIVE_BUDGET_OUTPUT="$PWD/$probe/result.json" claude --setting-sources '' --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' --plugin-dir "$probe" -p 'Local budget probe' > "$probe/engine.txt"
node - "$probe/result.json" <<'JS'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
console.log('native budget:', JSON.stringify(r))
assert.equal(r.first.ms, 10000)
assert.equal(r.distinct, true)
assert.equal(r.frozen, true)
assert.equal(r.plain, true)
assert.equal(r.retainedUnchanged, true)
assert.equal(r.infinityRefused, true)
assert.equal(r.abortRefused, true)
assert.ok(r.first.remainingMs - r.own.remainingMs >= 90, 'own code spends budget')
assert.ok(Math.abs(r.own.remainingMs - r.afterProcess.remainingMs) < 100, 'process wait pauses budget')
assert.ok(r.afterProcess.remainingMs - r.afterClock.remainingMs >= 90, 'clock.sleep spends budget')
JS
