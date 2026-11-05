// Run: node --test tests/release-audit13.test.mjs
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const source = resolve(import.meta.dirname, '..')
const scratch = await fs.mkdtemp(join(tmpdir(), 'dex-queue-'))
after(() => fs.rm(scratch, { recursive: true, force: true }))
execFileSync(process.env.TSC ?? 'tsc', [
  '--target', 'es2023', '--module', 'node16', '--moduleResolution', 'node16',
  '--jsx', 'react', '--jsxFactory', 'h', '--skipLibCheck', '--strict',
  '--rootDir', source, '--outDir', scratch, process.env.CC_TYPES ?? join(source, '.claude-plugin/types/claude-code/index.d.ts'),
  ...['register', 'common', 'shared', 'hunks', 'shell', 'shell-undo'].map(n => join(source, `hooks/${n}.tsx`)),
  join(source, 'types/index.d.ts'),
], { cwd: scratch, stdio: 'pipe' })
await fs.mkdir(join(scratch, 'node_modules/claude-code'), { recursive: true })
await fs.writeFile(join(scratch, 'node_modules/claude-code/index.js'), `
exports.atom = (address, initial) => ({ address, initial });
exports.read = async ($, a) => a.initial;
exports.update = async () => {};
`)
const require = createRequire(join(scratch, 'entry.cjs'))
const gate = () => { let open, refuse; const p = new Promise((r, j) => { open = r; refuse = j }); return { p, open, refuse } }
const tick = () => sleep(0)
function world() {
  for (const key of Object.keys(require.cache)) if (key.startsWith(scratch)) delete require.cache[key]
  const handlers = [], waits = []
  require(join(scratch, 'hooks/register.js')).register((event, filter, handler) => {
    if (typeof filter !== 'function') handlers.push({ event, filter, handler })
  })
  const shared = require(join(scratch, 'hooks/shared.js'))
  const $ = { clock: { sleep: (ms, o) => {
    const g = gate(); waits.push({ ms, ...g })
    o.signal.addEventListener('abort', () => g.refuse(new Error('aborted')), { once: true })
    return g.p
  } } }
  const call = (tool, leaf, budget = () => ({ remainingMs: 10000 })) => {
    const next = Object.defineProperty(leaf, 'budget', { get: budget })
    return handlers.find(h => h.event === 'tool.call' && h.filter?.tool === tool).handler($, { tool, file_path: '/a' }, next)
  }
  return { $, shared, waits, call }
}

for (const tool of ['Edit', 'Write']) for (const live of [false, true]) test(`${tool}: budget margin with ${live ? 'live-field comparison' : 'native snapshot'}`, async t => {
  const w = world(), held = gate()
  const undo = w.shared.serial(undefined, () => held.p)
  let remaining = 1700, answer, calls = 0
  const call = w.call(tool, async () => { calls++; return {} }, () => live ? { get remainingMs() { return remaining } } : { remainingMs: remaining }).then(x => { answer = x })
  try {
    await tick(); assert.equal(w.waits[0].ms, 200)
    remaining = 1500; w.waits[0].open(); await tick()
    t.diagnostic(`answer=${JSON.stringify(answer)}, sleeps=${w.waits.map(x => x.ms)}, next calls=${calls}`)
    assert.match(String(answer?.deny), /still running/, 'must deny at the margin, before the engine bypasses the hook')
    assert.equal(calls, 0)
  } finally { held.open(); await Promise.all([undo, call]) }
})

