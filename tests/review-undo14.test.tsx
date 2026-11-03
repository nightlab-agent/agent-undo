// Review of 4d5e8a2..86fcca4 (0.2.2), the three newest commits: saved()'s drain loop (c02b754), restore()'s 1 s bound
// (50e7e01) and the clock-refused design choice (86fcca4). World copied from review-undo13.test.tsx, plus `landed` on the
// held list write and an engine end step the test writes (endStep), run inside session.end's next(e) before the swap.
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
type Hold = { reached: () => void; p: Promise<void> }

const world = (on: On, files0: Record<string, string>, opts: { clock?: boolean; swapAtEnd?: string; endStep?: () => Promise<void> } = {}) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const statuses: string[] = []
  const w = {
    statuses, files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
    holdStateSet: undefined as undefined | (Hold & { landed: () => void }),
    trace: [] as string[], denySleep: false,
    seenAtEnd: [] as (string | undefined)[][],
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  // The engine's clock: a real wait (the test kit answers none), so a bounded wait for a held save ends.
  // w.denySleep: every later sleep is refused, as a mod above that denies clock.sleep would.
  if (opts.clock !== false) on('clock.sleep', (_, e) => {
    if (w.denySleep) throw new Error('clock.sleep denied by a mod above')
    return new Promise(r => setTimeout(() => r({ value: undefined }), e.ms)) as never
  })
  on('session.id', async () => ({ value: w.sid }))
  on('state.get', async (_, e) => {
    const v = w.state.get(at(e)) ?? { value: undefined, version: 0 }
    return { value: v } as never
  })
  on('state.set', async (_, e) => {
    let h: (Hold & { landed: () => void }) | undefined
    if (e.key === 'changes' && w.holdStateSet) { h = w.holdStateSet; w.holdStateSet = undefined; h.reached(); await h.p }
    const was = w.state.get(at(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
    w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
    const list = (e.value as { value?: unknown } | undefined)?.value
    if (e.key === 'changes' && Array.isArray(list)) w.trace.push(`landed ${(list as { file: string }[]).map(c => c.file.split('/').pop()).join(',')} in ${w.sid}`)
    h?.landed()
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
  // The engine's end step (claude-code.d.ts SessionEndInput.reason: a /clear "goes on under a new session id").
  on('session.end', async (_, e: any) => {
    w.seenAtEnd.push(((disk.get('changes:s1') as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop()))
    if (opts.endStep) await opts.endStep()
    if (opts.swapAtEnd) { w.trace.push(`swap to ${opts.swapAtEnd}`); w.state.clear(); w.sid = opts.swapAtEnd }
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
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
const files = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }
const hold = () => {
  let release!: () => void, reached!: () => void, landed!: () => void
  const at = new Promise<void>(r => { reached = r })
  const p = new Promise<void>(r => { release = r })
  const land = new Promise<void>(r => { landed = r })
  return { reached, p, release, at, landed, land }
}
const end = ($: $T, w: W, reason: 'clear' | 'resume' | 'prompt_input_exit') =>
  $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } })
const endTo = async ($: $T, w: W, reason: 'clear' | 'resume', sid: string) => { await end($, w, reason); w.state.clear(); w.sid = sid }
const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' }

// R1 (kind 1/2, an edit between its tool result and its mirror()): b's Edit is done on disk and its list update is in
// flight (state.set dispatched, answered 30 ms later) when the person /clears. The ending copy's write is quick, so
// saved()'s drain loop (common.tsx:96) finds the queue standing still and returns before b's mirror() is queued; the
// end step swaps the conversation; b's save then finds session.id() = s2 (or `listed` empty) and writes nothing
// (common.tsx:101-109). s1's copy holds a.txt only, and b's update lands in whatever state is there (here s2's).
// review-undo13 G2 is green only because its ending write is slow enough for b's save to be queued while the drain
// loop still waits. The same window: an Edit whose record() has not reached update() yet (restoreList, the host's answer).
const clearWhileUpdateInFlight = async ($: $T, on: On, inFlight: boolean) => {
  const w = world(on, all, { swapAtEnd: 's2' })
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const ht = hold()
  if (inFlight) w.holdStateSet = ht
  const eb = edit($, 'b.txt', 'x', 'y')
  if (inFlight) await ht.at; else { await eb; await settle() }   // in flight: b's list update dispatched, not answered
  const ending = end($, w, 'clear'); await tick()
  if (inFlight) setTimeout(ht.release, 30)                       // the host answers it 30 ms on, well inside the bound
  await ending; await eb; await settle(); await settle()
  return w
}
test('review-undo14 R1: /clear while b\'s list update is in flight and the ending write is quick, s1\'s copy holds b.txt', async ($, on) => {
  const w = await clearWhileUpdateInFlight($, on, true)
  expect(w.trace.some(t => t.startsWith('landed') && t.includes('b.txt'))).toBe(true)   // b's update did land (in s2's state here)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo14 R1 comparison: b\'s update landed before the /clear, s1\'s copy holds b.txt', async ($, on) => {
  const w = await clearWhileUpdateInFlight($, on, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})

// R2 (kind 1, a stale read after the bound): s1's copy write ([a, b]) is slow, a /clear and an in-process /resume back
// to s1 land (review-undo11 Q1). restore() now waits a second at most (common.tsx:171, 50e7e01); the write lands at
// 1.3 s. At the bound restore reads the older copy ([a]), takes it as the list and makes this process the copy's
// owner; the [a, b] write then lands and c's save writes [a, c] over it. b is gone from the list and the store.
// 07c0415 waited for the write; Q1 passes only because it releases the write before the bound.
const resumeDuringSlowWrite = async ($: $T, w: W, lands: number) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const eb = edit($, 'b.txt', 'x', 'y'); await h.at         // b's save is at its store.set of changes:s1 = [a, b]
  await endTo($, w, 'clear', 's2')                           // the end's own bound (1 s) passes, the write still held
  await endTo($, w, 'resume', 's1')
  const ec = edit($, 'c.txt', 'k', 'K'); await settle()      // restore(s1) is waiting for the queue, c behind it
  setTimeout(h.release, lands)
  await eb; await ec; await settle(); await settle()
}
test('review-undo14 R2: /clear and /resume back, the copy write lands at 1.3 s, s1\'s store still holds b.txt', async ($, on) => {
  const w = world(on, all)
  await resumeDuringSlowWrite($, w, 1300)
  // The invariant any fix keeps: an edit that reached the store is not written over by a shorter list. (07c0415's
  // own promise, the list and the copy both [a, b, c], is what the comparison holds; here the copy ends [a, c].)
  expect(files(w, 'changes:s1')).toContain('b.txt')
})
test('review-undo14 R2 comparison: the copy write lands at 0.3 s, s1 lists and stores b.txt', async ($, on) => {
  const w = world(on, all)
  await resumeDuringSlowWrite($, w, 300)
  expect(await undo($, '')).toContain('b.txt')
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})

// R3 (kind 4, the bound with the sleep refused): restore()'s saved($, 1000) passes no signal (common.tsx:171). Where
// clock.sleep is refused for a reason other than an abort (a mod above denies it; this kit answers none), `bound`
// never settles (common.tsx:92) and the wait is the whole queue again: review-undo13 L1 comes back, and the comment
// at common.tsx:170 ("a second at most") does not hold. session.end's call has next.signal (the chain's 1.5 s cut,
// SessionEndInput) to fall back on; this one runs under a command hook and has nothing. The end's own sleep is
// answered here so the test reaches s2; every sleep after it is refused.
const clearThenList = async ($: $T, w: W, deny: boolean) => {
  await start($); await settle()
  let reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  w.holdStoreSet = { key: 'changes:s1', reached, p: new Promise<void>(() => {}) }
  void edit($, 'a.txt', 'one', 'ONE'); await at
  await end($, w, 'clear'); w.state.clear(); w.sid = 's2'   // the end's own wait ends at its bound (the clock answered)
  w.denySleep = deny
  const timeout = (ms: number) => new Promise(r => setTimeout(() => r('still waiting'), ms))
  return Promise.race([undo($, '').then(() => 'answered'), timeout(2500)])
}
test('review-undo14 R3: with clock.sleep refused, /clear while s1\'s copy write hangs, /agent-undo in s2 still answers', async ($, on) => {
  const w = world(on, all)
  expect(await clearThenList($, w, true)).toBe('answered')
})
test('review-undo14 R3 comparison: with a clock, the same /agent-undo answers within the bound', async ($, on) => {
  const w = world(on, all)
  expect(await clearThenList($, w, false)).toBe('answered')
})

// R4 (kind 4, a claim about the environment): common.tsx:87 says "no setTimeout in its environment". The engine's
// declarations (index.d.ts:18-20) name the environment's web APIs with an open list and never mention setTimeout
// either way; this kit's environment, "like the one a plugin's hooks run in" (index.d.ts:30-32), has one, and the repo's
// own tests use it (review-undo13.test.tsx:26, 90). `require` is what the declarations do say is absent (index.d.ts:23).
// Fixed in c2c7c1e: the comment now says the declarations type no timer, which stays true with one at runtime.
test('review-undo14 R4: the test environment has a setTimeout the declarations do not type', async () => {
  expect(typeof (globalThis as { setTimeout?: unknown }).setTimeout).toBe('function')
})
test('review-undo14 R4 comparison: the test environment has no require (the declarations\' claim)', async () => {
  expect(typeof (globalThis as { require?: unknown }).require).toBe('undefined')
})
