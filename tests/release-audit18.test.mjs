// Run with node --test tests/release-audit18.test.mjs. No packages or network needed.
// An undo waiting its turn, on real files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { world, wrapRun } from './audit-harness.mjs'

// ---- A queued undo must not outlive its call: an interrupt, a change of conversation, the end of its budget.
const DEFAULT_ASK = "Claude requested permissions to use mcp__agent-undo__undo, but you haven't granted it yet."
const tick = (ms = 40) => sleep(ms)
const gate = () => { let open; const p = new Promise(r => { open = r }); return { p, open } }
/** Two conversations in one process, with an id that moves when the end step runs, as the declarations say. */
const conversations = w => {
  const c = { id: 'B' }
  w.engine.session.id = async () => c.id
  c.swap = (to, reason) => w.dispatch('session.end', { reason, sessionId: c.id }, async () => { c.id = to; w.engine._atoms.clear(); return {} })
  return c
}
/** An Edit at its question: it holds the undo queue until `open`. */
const heldEdit = (w, file) => {
  const g = gate()
  const done = w.dispatch('tool.call', { tool: 'Edit', tool_use_id: `held-${Math.random()}`, file_path: join(w.root, file) },
    async () => { await g.p; return { deny: 'the person said no' } })
  return { open: g.open, done }
}
test('an undo queued behind an Edit does not land on the next conversation\'s number after /resume', async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  const c = conversations(w)
  await w.edit('b.txt', 'two', 'TWO')
  await c.swap('A', 'clear')
  await w.edit('a.txt', 'one', 'ONE')
  const held = heldEdit(w, 'a.txt'); await tick()
  const undo = w.toolUndo('1'); await tick()
  await c.swap('B', 'resume')
  held.open(); await held.done
  const out = await undo
  assert.equal(await w.read('b.txt'), 'TWO\n', `conversation A's "1" changed conversation B's file: ${out.result}`)
  assert.match(out.result, /conversation.*ended.*nothing changed/)
})
test('comparison: with no change of conversation the queued undo lands on its own edit', async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  const c = conversations(w)
  await w.edit('b.txt', 'two', 'TWO')
  await c.swap('A', 'clear')
  await w.edit('a.txt', 'one', 'ONE')
  const held = heldEdit(w, 'a.txt'); await tick()
  const undo = w.toolUndo('1'); await tick()
  held.open(); await held.done
  await undo
  assert.equal(await w.read('a.txt'), 'one\n')
  assert.equal(await w.read('b.txt'), 'TWO\n')
})
for (const stop of [true, false]) {
  test(`${stop ? 'an interrupted undo does not write once its queue frees, and answers at once' : 'comparison: not interrupted, it writes'}`, async t => {
    const w = await world(t, { 'a.txt': 'one\n' })
    await w.edit('a.txt', 'one', 'ONE')
    const held = heldEdit(w, 'a.txt'); await tick()
    const ctrl = new AbortController()
    w.signal = ctrl.signal
    const undo = w.toolUndo('1'); await tick()
    w.signal = undefined
    if (stop) {
      ctrl.abort()
      assert.match((await undo).result, /interrupted; nothing changed/)
    }
    held.open(); await held.done; await undo
    await tick()
    assert.equal(await w.read('a.txt'), stop ? 'ONE\n' : 'one\n')
  })
}
test('a conversation that ends during a check that allows spends the allow too', async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  const c = conversations(w)
  await w.edit('b.txt', 'two', 'TWO')
  await c.swap('A', 'clear')
  await w.edit('a.txt', 'one', 'ONE')
  const check = gate()
  w.engine.tool.check = async () => { await check.p; return { decision: 'allow' } }
  const undo = w.toolUndo('1'); await tick()
  await c.swap('B', 'resume')
  check.open()
  assert.match((await undo).result, /did not allow/)
  assert.equal(await w.read('b.txt'), 'TWO\n')
})
for (const when of ['during the permission check', 'during the question']) {
  test(`a conversation that ends ${when} spends the yes`, async t => {
    const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
    const c = conversations(w)
    await w.edit('b.txt', 'two', 'TWO')
    await c.swap('A', 'clear')
    await w.edit('a.txt', 'one', 'ONE')
    const check = gate(), question = gate()
    w.engine.tool.check = async () => { if (when.includes('check')) await check.p; return { decision: 'ask', reason: DEFAULT_ASK } }
    w.engine.ui.ask = async () => { if (when.includes('question')) await question.p; return 'Undo it' }
    const undo = w.toolUndo('1'); await tick()
    await c.swap('B', 'resume')
    check.open(); question.open()
    const out = await undo
    assert.match(out.result, /did not allow/)
    assert.equal(await w.read('b.txt'), 'TWO\n')
  })
}

/** A snapshot stuck inside its `git add`, until `open`. */
const stuckSnapshot = async w => {
  const g = gate(), at = gate()
  wrapRun(w, async (argv, init, run) => {
    if (argv[1] === 'add') { at.open(); await g.p }
    return run(argv, init)
  })
  const bash = w.bash('echo x >> c.txt')
  await at.p
  return { open: g.open, bash }
}
test('a shell undo behind a stuck snapshot answers inside its budget and writes nothing afterwards', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  const stuck = await stuckSnapshot(w)
  w.budgetMs = 2000
  const began = Date.now()
  const out = await w.undo('1')
  assert.ok(Date.now() - began < 1500, 'answered inside the budget')
  assert.match(out, /1\.1 left as is: this undo ran out of time/)
  assert.match(out, /nothing changed/)
  stuck.open(); await stuck.bash; await tick()
  assert.equal(await w.read('a.txt'), 'ONE\n')
  assert.doesNotMatch(await w.undo('list'), /\(undone\)/)
})
test('comparison: a shell undo behind a snapshot that ends in time goes through', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  const stuck = await stuckSnapshot(w)
  const out = w.undo('1'); await tick()
  stuck.open(); await stuck.bash
  assert.match(await out, /undid 1\.1/)
})
test('a shell undo behind a snapshot, interrupted, writes nothing', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  const stuck = await stuckSnapshot(w)
  const ctrl = new AbortController()
  w.signal = ctrl.signal
  const out = w.undo('1'); await tick()
  w.signal = undefined
  ctrl.abort()
  assert.match(await out, /nothing changed/)
  stuck.open(); await stuck.bash; await tick()
  assert.equal(await w.read('a.txt'), 'ONE\n')
})
test('a shell undo behind a snapshot, the conversation gone meanwhile, leaves the next list alone', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  const c = conversations(w)
  await w.bash("printf 'ONE\\n' > a.txt")
  const stuck = await stuckSnapshot(w)
  const out = w.undo('1'); await tick()
  await c.swap('A', 'resume')
  stuck.open()
  assert.match(await out, /conversation.*ended/)
  assert.equal(await w.read('a.txt'), 'ONE\n')
})
test('a git that never comes back cannot hold the queue for good: the next turn goes on', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  const sleepReal = w.engine.clock.sleep
  w.engine.clock.sleep = (ms, o) => sleepReal(ms >= 60000 ? 30 : ms, o)
  const stuck = await stuckSnapshot(w)
  await tick(80)
  w.engine.process.run = w.plainRun
  const out = await w.undo('1')
  assert.match(out, /undid 1\.1/)
  stuck.open()
})
test('comparison: a turn inside its bound still holds the next one back', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  const stuck = await stuckSnapshot(w)
  w.budgetMs = 1700
  const out = await w.undo('1')
  assert.match(out, /ran out of time/)
  stuck.open(); await stuck.bash
})

