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

for (const caller of ['command', 'tool']) {
  for (const missing of ['finite', 'budget', 'remainingMs']) test(`${caller}: ${missing === 'finite' ? 'finite budget expires with no $ call in flight' : `missing ${missing} expires after its default sleep`}`, async t => {
    const w = world(), held = gate(), ctrl = new AbortController(), waits = []
    const ahead = w.shared.serial(['a'], () => held.p)
    let remaining = 10000
    w.$.clock.sleep = (ms, o) => {
      const g = gate(); waits.push({ ms, g })
      o.signal.addEventListener('abort', () => g.open(), { once: true })
      return g.p.then(() => { if (o.signal.aborted) throw new Error('aborted') })
    }
    let answer
    const undo = w.call(caller, missing === 'budget' ? undefined : () => missing === 'remainingMs' ? undefined : remaining, ctrl.signal).then(x => { answer = x })
    try {
      await tick()
      assert.equal(waits[0].ms, 8500)
      remaining = 1500
      waits[0].g.open() // the requested 8500 ms have elapsed on this clock
      await tick()
      t.diagnostic(`answer=${JSON.stringify(answer)}, sleeps=${waits.map(x => x.ms)}`)
      assert.match(String(answer?.text ?? answer?.result), /nothing changed/)
    } finally {
      ctrl.abort(); held.open(); await Promise.all([ahead, undo])
    }
  })

  test(`${caller}: queue cancellation uses next.signal even when the sleep rejects`, async () => {
    const w = world(), held = gate(), ctrl = new AbortController()
    const ahead = w.shared.serial(['a'], () => held.p)
    w.$.clock.sleep = async () => { throw new Error('clock refused') }
    const undo = w.call(caller, () => Infinity, ctrl.signal)
    await tick(); ctrl.abort()
    const out = await undo
    assert.match(out.text ?? out.result, /interrupted/)
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
    assert.equal(w.shared.ended.size, 0)
    held.open(); await ahead
  })

  test(`${caller}: session.end cancels a queued undo and removes its timer`, async () => {
    const w = world(), held = gate(), ctrl = new AbortController()
    const ahead = w.shared.serial(['a'], () => held.p)
    let timerSignal
    w.$.clock.sleep = (ms, o) => {
      timerSignal = o.signal
      return sleep(ms, undefined, { signal: o.signal })
    }
    const undo = w.call(caller, () => 10000, ctrl.signal)
    await tick()
    for (const end of w.shared.ended) end() // shell.tsx's session.end notification
    const out = await undo
    assert.match(out.text ?? out.result, /conversation.*ended/)
    assert.ok(timerSignal.aborted)
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
    assert.equal(w.shared.ended.size, 0)
    held.open(); await ahead
  })

  for (const remaining of [Infinity, 1501, 10000]) test(`${caller}: frozen remainingMs=${remaining} avoids rapid polling`, async t => {
    const w = world(), held = gate(), ctrl = new AbortController()
    // Keep a real $ call in flight so a finite engine budget legitimately stands still.
    let ids = 0
    w.$.session.id = () => ++ids <= (caller === 'tool' ? 2 : 0) ? Promise.resolve('s1') : held.p.then(() => 's1')
    let sleeps = 0
    w.$.clock.sleep = (ms, o) => {
      sleeps++
      // The real engine rejects Infinity (a local probe, 2.1.312).
      if (!Number.isFinite(ms)) return Promise.reject(new Error('sleep takes a non-negative number of milliseconds'))
      return sleep(ms, undefined, { signal: o.signal })
    }
    const undo = w.call(caller, () => remaining, ctrl.signal)
    try {
      await sleep(60)
      t.diagnostic(`sleeps in 60ms: ${sleeps}`)
      assert.ok(sleeps <= 2, `unnecessary clock dispatches while budget is frozen: ${sleeps}`)
    } finally {
      ctrl.abort(); held.open(); await undo
    }
  })

  test(`${caller}: two queued undos cancel independently, then a retry still cancels`, async () => {
    const w = world(), held = gate()
    const ahead = w.shared.serial(['a'], () => held.p)
    const a = new AbortController(), b = new AbortController()
    const first = w.call(caller, () => 10000, a.signal)
    const second = w.call(caller, () => 10000, b.signal)
    await tick(); a.abort()
    assert.match((await first).text ?? (await first).result, /interrupted/)
    b.abort()
    const secondOut = await second
    assert.match(secondOut.text ?? secondOut.result, /interrupted/)
    const c = new AbortController(), third = w.call(caller, () => 10000, c.signal)
    await tick(); c.abort()
    const thirdOut = await third
    assert.match(thirdOut.text ?? thirdOut.result, /interrupted/)
    assert.equal(w.shared.ended.size, 0)
    for (const ctrl of [a, b, c]) assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
    held.open(); await ahead
  })
}
