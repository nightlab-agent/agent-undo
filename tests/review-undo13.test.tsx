// Review of 4d5e8a2..8597eac (0.2.2): session.end's bounded wait (saved()) and the late-edit path (ended).
// World copied from review-undo11ts.test.tsx, plus seenAtEnd (changes:s1 when the end step runs), an engine end
// step that swaps the conversation inside next(e) (swapAtEnd), and a world with no clock.sleep hook (clock: false).
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
type Hold = { reached: () => void; p: Promise<void> }

const world = (on: On, files0: Record<string, string>, opts: { clock?: boolean; swapAtEnd?: string } = {}) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const statuses: string[] = []
  const w = {
    statuses, files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
    holdStateSet: undefined as undefined | Hold,
    trace: [] as string[],
    // changes:s1's files as the engine's end step (session.end's next(e)) sees them.
    seenAtEnd: [] as (string | undefined)[][],
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  // The engine's clock: a real wait (the test kit answers none), so session.end's bounded wait for a held save ends.
  if (opts.clock !== false) on('clock.sleep', (_, e) => new Promise(r => setTimeout(() => r({ value: undefined }), e.ms)) as never)
  on('session.id', async () => ({ value: w.sid }))
  on('state.get', async (_, e) => {
    const v = w.state.get(at(e)) ?? { value: undefined, version: 0 }
    if (e.key === 'changes') w.trace.push(`get v${v.version} ${Array.isArray(v.value) ? (v.value as { file: string }[]).map(c => c.file.split('/').pop()).join(',') : JSON.stringify(v.value)}`)
    return { value: v } as never
  })
  on('state.set', async (_, e) => {
    if (e.key === 'changes' && w.holdStateSet) { const h = w.holdStateSet; w.holdStateSet = undefined; h.reached(); await h.p }
    const was = w.state.get(at(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
    w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
    return { value: { isSet: true, version: was + 1 } } as never
  })
  on('store.get', async (_, e) => ({ value: disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined }) as never)
  on('store.set', async (_, e) => {
    if (w.holdStoreSet && w.holdStoreSet.key === e.key) { const h = w.holdStoreSet; w.holdStoreSet = undefined; h.reached(); await h.p }
    disk.set(e.key, JSON.parse(JSON.stringify(e.value)))
    if (e.key === 'changes:s1') w.trace.push(`set ${(e.value as { list: { file: string }[] }).list.map(c => c.file.split('/').pop()).join(',')}`)
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => { disk.delete(e.key); return { value: undefined } as never })
  on('store.keys', () => ({ value: [...disk.keys()] }) as never)
  // The engine's end step. With swapAtEnd it is where a /clear or /resume swaps the conversation (claude-code.d.ts
  // SessionEndInput.reason: "the process goes on under a new session id"): a fresh state, the new id.
  on('session.end', (_, e: any) => {
    w.seenAtEnd.push(((disk.get('changes:s1') as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop()))
    if (opts.swapAtEnd) { w.state.clear(); w.sid = opts.swapAtEnd }
    return { sessionId: e.sessionId } as never
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', (_, e) => { statuses.push(String((e as { text?: unknown }).text)); return { value: undefined } as never })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('tool.call', (_, e) => {
    const x = e as unknown as { file_path: string; old_string: string; new_string: string }
    const was = files.get(x.file_path)!
    const now = was.replace(x.old_string, x.new_string)
    files.set(x.file_path, now)
    const i = was.split('\n').findIndex(l => l.includes(x.old_string))
    const line = was.split('\n')[i]!
    return { result: { filePath: x.file_path, oldString: x.old_string, newString: x.new_string, originalFile: was,
      structuredPatch: [{ oldStart: i + 1, oldLines: 1, newStart: i + 1, newLines: 1,
        lines: [`-${line}`, `+${line.replace(x.old_string, x.new_string)}`] }],
      userModified: false, replaceAll: false } } as never
  })
  return w
}
type W = ReturnType<typeof world>

const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const restart = async ($: $T, w: W, sid = w.sid) => { w.state.clear(); w.sid = sid; await start($) }
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
const files = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }
const hold = (): Hold & { release: () => void; at: Promise<void> } => {
  let release!: () => void, reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  const p = new Promise<void>(r => { release = r })
  return { reached, p, release, at }
}

const end = ($: $T, w: W, reason: 'clear' | 'resume' | 'prompt_input_exit') =>
  $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } })
const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' }

// G1 (kind 1/2, a queue that grows during the wait): b's copy is being written (store slow) when the person exits;
// c's list update lands during session.end's wait and queues c's save behind b's. saved() raced the `saving` it read
// at its call (common.tsx:92), so it ends when b's save ends and the end step sees a.txt, b.txt only.
const exitWhileQueueGrows = async ($: $T, w: W, late: boolean) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const hs = hold(); w.holdStoreSet = { key: 'changes:s1', ...hs }
  const eb = edit($, 'b.txt', 'x', 'y'); await hs.at        // b's save is at its store.set of changes:s1 = [a, b]
  const ht = hold(); if (late) w.holdStateSet = ht
  const ec = edit($, 'c.txt', 'k', 'K')
  if (late) await ht.at; else { await settle() }            // late: c's list update not yet landed
  const ending = end($, w, 'prompt_input_exit'); await tick()
  if (late) { ht.release(); await settle() }                 // c's update lands, its save queued behind b's
  setTimeout(hs.release, 30)
  await ending; await eb; await ec; await settle()
}
test('review-undo13 G1: an exit while b is being stored and c\'s update lands in the wait, the end step sees c.txt', async ($, on) => {
  const w = world(on, all)
  await exitWhileQueueGrows($, w, true)
  expect(w.seenAtEnd[0]).toEqual(['a.txt', 'b.txt', 'c.txt'])
})
test('review-undo13 G1 comparison: c\'s update landed before the exit, the end step sees c.txt', async ($, on) => {
  const w = world(on, all)
  await exitWhileQueueGrows($, w, false)
  expect(w.seenAtEnd[0]).toEqual(['a.txt', 'b.txt', 'c.txt'])
})

// G2 (kind 1/4, 843f8d5's own case with the engine's real swap): b's list update lands after mirrorEnding() read
// the list and before the end step; the ending copy's write is slow. The engine swaps the conversation in next(e)
// (SessionEndInput), so b's save, queued after the ending copy's and not waited for, finds session.id() = s2 and
// writes nothing. review-undo11 B is green only because it swaps the world after it settled.
const clearWhileUpdateLands = async ($: $T, w: W, late: boolean) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const ht = hold(); if (late) w.holdStateSet = ht
  const eb = edit($, 'b.txt', 'x', 'y')
  if (late) await ht.at; else { await eb; await settle() }
  const hs = hold(); w.holdStoreSet = { key: 'changes:s1', ...hs }   // the ending copy's write is slow
  const ending = end($, w, 'clear'); await hs.at
  if (late) { ht.release(); await settle() }                        // b's update lands, its save queued
  setTimeout(hs.release, 30)
  await ending; await eb; await settle(); await settle()
}
test('review-undo13 G2: /clear, b\'s update lands while the ending copy is written, s1\'s copy holds b.txt', async ($, on) => {
  const w = world(on, all, { swapAtEnd: 's2' })
  await clearWhileUpdateLands($, w, true)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo13 G2 comparison: b\'s update landed before the /clear, s1\'s copy holds b.txt', async ($, on) => {
  const w = world(on, all, { swapAtEnd: 's2' })
  await clearWhileUpdateLands($, w, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})

// C1 (kind 4/6, the 1 s cap with no clock hook): saved() bounds its wait with $.clock.sleep and, when the sleep is
// refused for any reason but the abort, leaves next.signal to end it (common.tsx:90). Where no hook answers
// clock.sleep (this kit; a mod above that denies it) the wait ends only at the chain's abort, if one comes.
const exitWithStuckWrite = async ($: $T, w: W) => {
  await start($); await settle()
  let reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  w.holdStoreSet = { key: 'changes:s1', reached, p: new Promise<void>(() => {}) }
  void edit($, 'a.txt', 'one', 'ONE')
  await at
  const t0 = Date.now()
  const out = await Promise.race([end($, w, 'prompt_input_exit').then(() => 'ended'), new Promise(r => setTimeout(() => r('still waiting'), 3000))])
  return { out, ms: Date.now() - t0 }
}
// Not a test: a mod has no timer of its own to fall back on (hooks/common.tsx, saved()); with the clock refused,
// the hook's budget ends the wait. The comparison below holds the one-second bound where the clock answers.
test('review-undo13 C1 comparison: with a clock.sleep hook, the same exit reaches the end step within about a second', async ($, on) => {
  const w = world(on, all)
  const r = await exitWithStuckWrite($, w)
  expect(r.out).toBe('ended')
  expect(r.ms).toBeLessThan(2000)
})

// L1 (kind 2, a wait on the whole queue inside the undo queue): restore() now awaits `saving` (common.tsx:165, 07c0415),
// and run() calls restoreList inside serial() (register.tsx:152), the queue every Edit and Write also waits in. A store
// write that does not settle (the exit bound does not apply to a /clear's process, which goes on) holds the list command,
// and every later Edit or Write behind it.
const clearThenList = async ($: $T, w: W, stuck: boolean) => {
  await start($); await settle()
  let reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  if (stuck) w.holdStoreSet = { key: 'changes:s1', reached, p: new Promise<void>(() => {}) }
  const ea = edit($, 'a.txt', 'one', 'ONE')
  if (stuck) await at; else { await ea; await settle() }
  await end($, w, 'clear'); w.state.clear(); w.sid = 's2'
  const timeout = (ms: number) => new Promise(r => setTimeout(() => r('still waiting'), ms))
  const listed = await Promise.race([undo($, '').then(() => 'answered'), timeout(2500)])
  // The Edit's own hook may still wait on its copy's write (as at 4d5e8a2); the file must be written.
  void edit($, 'b.txt', 'x', 'y'); await timeout(500)
  return { listed, b: w.files.get(`${ROOT}/b.txt`) }
}
test('review-undo13 L1: /clear while s1\'s copy write hangs, /agent-undo in s2 answers and s2\'s next Edit writes its file', async ($, on) => {
  const w = world(on, all)
  expect(await clearThenList($, w, true)).toEqual({ listed: 'answered', b: 'y\n' })
})
test('review-undo13 L1 comparison: /clear after s1\'s copy was written, /agent-undo answers and the Edit writes its file', async ($, on) => {
  const w = world(on, all)
  expect(await clearThenList($, w, false)).toEqual({ listed: 'answered', b: 'y\n' })
})
