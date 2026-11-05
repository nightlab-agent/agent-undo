// The undo's time bound: the real compiled hooks, a gated queue and a controllable engine clock. Written by Dex.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { getEventListeners } from 'node:events'

const source = resolve(import.meta.dirname, '..')
const scratch = await fs.mkdtemp(join(source, '.audit9-'))
after(() => fs.rm(scratch, { recursive: true, force: true }))
await fs.writeFile(join(scratch, '.gitignore'), '*\n')
execFileSync(process.env.TSC ?? 'tsc', [
  '--target', 'es2023', '--module', 'node16', '--moduleResolution', 'node16',
  '--jsx', 'react', '--jsxFactory', 'h', '--skipLibCheck', '--strict',
  '--rootDir', source, '--outDir', scratch, process.env.CC_TYPES,
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
const gate = () => { let open; const p = new Promise(r => { open = r }); return { p, open } }
const tick = () => sleep(0)

function world() {
  for (const key of Object.keys(require.cache)) if (key.startsWith(scratch)) delete require.cache[key]
  const handlers = []
  require(join(scratch, 'hooks/register.js')).register((event, filter, handler) => {
    if (typeof filter === 'function') handler = filter
    handlers.push({ event, handler })
  })
  const shared = require(join(scratch, 'hooks/shared.js'))
  const $ = { session: { id: async () => 's1' }, tool: { check: async () => ({ decision: 'allow' }) },
    clock: { sleep: (ms, o) => sleep(ms, undefined, { signal: o?.signal }) } }
  const call = (caller, left, signal) => {
    const next = Object.assign(() => { throw new Error('undo leaked to core') }, { signal })
    if (left) Object.defineProperty(next, 'budget', { get: () => ({ remainingMs: left() }) })
    const h = handlers.find(h => h.event === (caller === 'command' ? 'command.run' : 'tool.call') &&
      (caller === 'command' || h === handlers.at(-1)))
    return h.handler($, { args: '1', ref: '1', tool: 'mcp__agent-undo__undo' }, next)
  }
  return { $, shared, call }
}

for (const caller of ['command', 'tool']) test(`${caller}: moving, frozen, then jumping budget keeps its reserve`, async t => {
  const w = world(), held = gate(), ctrl = new AbortController(), waits = []
  const ahead = w.shared.serial(['a'], () => held.p)
  let remaining = 1700, answer
  w.$.clock.sleep = (ms, o) => {
    const g = gate(); waits.push({ ms, g })
    o.signal.addEventListener('abort', () => g.open(), { once: true })
    return g.p.then(() => { if (o.signal.aborted) throw new Error('aborted') })
  }
  const undo = w.call(caller, () => remaining, ctrl.signal).then(x => { answer = x })
  try {
    await tick()
    assert.equal(waits[0].ms, 200)
    remaining = 1510; waits[0].g.open(); await tick()
    assert.equal(waits[1].ms, 10, 'a moving budget receives no floor')
    waits[1].g.open(); await tick()
    assert.equal(waits[2].ms, 250, 'an unmoved budget receives the floor')
    assert.equal(answer, undefined, 'paused budget has not expired')
    remaining = 1400; waits[2].g.open(); await tick()
    assert.match(answer.text ?? answer.result, /nothing changed/)
    assert.equal(waits.length, 3, 'jump past the reserve stops before another sleep')
    t.diagnostic(`requested sleeps: ${waits.map(w => w.ms)}`)
  } finally {
    ctrl.abort(); held.open(); await Promise.all([ahead, undo])
  }
})
