// code-reviewer on c2c7c1e..39386d1 (0.2.2): the `late` flag (aa52fc5) and the end's record count (39386d1). World copied from
// The `late` flag was removed after this review (a design choice, common.tsx restore()); the tests below hold the result.
// review-undo14.test.tsx.
//
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

// S1 (kind 1, a late-window edit never stored): s1's copy write hangs past the second. /clear to s2; s2's first Edit (b)
// runs restore(s2), whose saved($, 1000) returns false at the bound (common.tsx:188): late = { s2 }, `no`, so `restored`
// stays unset and b's save writes nothing (common.tsx:114). The hung write lands at 1.5 s; still() flips late.still, but
// nothing mirrors the list that b already sits in: s2's copy never holds b. At c2c7c1e, restore(s2) read the (absent)
// copy after the bound, took ownership, and b's save landed behind the hung write. The comment at :185-186 says the new
// edits stay out "until a late one lands"; after it lands they still do, and an exit writes nothing either.
const clearThenEditDuringHang = async ($: $T, w: W, lands: number, then: 'settle' | 'list' | 'exit') => {
  await start($); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const ea = edit($, 'a.txt', 'one', 'ONE'); await h.at       // a's save is at its store.set of changes:s1
  await endTo($, w, 'clear', 's2')                           // the end's bound passes, the write still held
  const eb = edit($, 'b.txt', 'x', 'y')                       // restore(s2) waits the second, then gives up: late = s2
  setTimeout(h.release, lands)
  await ea; await eb; await settle(); await settle()
  if (then === 'list') { await undo($, ''); await settle() }
  if (then === 'exit') { await end($, w, 'prompt_input_exit'); await settle() }
  await settle()
}
test('review-undo15 S1: /clear while s1\'s copy write hangs, s2\'s first edit, the write lands at 1.5 s: s2\'s copy holds b.txt', async ($, on) => {
  const w = world(on, all)
  await clearThenEditDuringHang($, w, 1500, 'settle')
  expect(files(w, 'changes:s2')).toEqual(['b.txt'])
})
test('review-undo15 S1b: the same, then /agent-undo (a read after the write landed): s2\'s copy holds b.txt', async ($, on) => {
  const w = world(on, all)
  await clearThenEditDuringHang($, w, 1500, 'list')
  expect(files(w, 'changes:s2')).toEqual(['b.txt'])
})
test('review-undo15 S1c: the same, then an exit: s2\'s copy holds b.txt', async ($, on) => {
  const w = world(on, all)
  await clearThenEditDuringHang($, w, 1500, 'exit')
  expect(files(w, 'changes:s2')).toEqual(['b.txt'])
})
test('review-undo15 S1 comparison: the write lands at 0.3 s (inside the bound), s2\'s copy holds b.txt', async ($, on) => {
  const w = world(on, all)
  await clearThenEditDuringHang($, w, 300, 'settle')
  expect(files(w, 'changes:s2')).toEqual(['b.txt'])
})

test('review-undo15 S1 comparison b: the same, then a further edit after the write landed: that edit\'s mirror carries b.txt', async ($, on) => {
  const w = world(on, all)
  await clearThenEditDuringHang($, w, 1500, 'settle')
  await edit($, 'c.txt', 'k', 'K'); await settle(); await settle()
  expect(files(w, 'changes:s2')).toEqual(['b.txt', 'c.txt'])
})

// S2 (kind 1, the resumed id): review-undo14 R2's scenario, read past the store: after the [a, b] write lands at 1.3 s,
// the next read finds late.still and reads the copy (common.tsx:187), but c (n = 1, listed while late) is numbered no
// lower than the copy's a (n = 1), so the copy is neither merged nor written (common.tsx:220-223): /agent-undo lists c
// alone, the store holds [a, b] for good, and c reaches no copy. CHANGELOG 0.2.2: "the copy is read once it has [landed]".
const resumeDuringSlowWrite = async ($: $T, w: W, lands: number) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const eb = edit($, 'b.txt', 'x', 'y'); await h.at
  await endTo($, w, 'clear', 's2')
  await endTo($, w, 'resume', 's1')
  const ec = edit($, 'c.txt', 'k', 'K'); await settle()
  setTimeout(h.release, lands)
  await eb; await ec; await settle(); await settle()
  const listed = await undo($, '')
  await settle(); await settle()
  return listed
}
// The design choice (common.tsx restore()): past the second the copy is read as it stands and this conversation's
// edits are stored from then on; b, carried only by the write that lands late, leaves the undo list (its file keeps it).
test('review-undo15 S2 (design choice): /clear and /resume back, the copy write lands at 1.3 s: /agent-undo lists a and c', async ($, on) => {
  const w = world(on, all)
  const listed = await resumeDuringSlowWrite($, w, 1300)
  expect(listed).toContain('a.txt'); expect(listed).not.toContain('b.txt'); expect(listed).toContain('c.txt')
})
test('review-undo15 S2b: the same, s1\'s copy holds c.txt once the queue stands still', async ($, on) => {
  const w = world(on, all)
  await resumeDuringSlowWrite($, w, 1300)
  await end($, w, 'prompt_input_exit'); await settle(); await settle()
  expect(files(w, 'changes:s1')).toContain('c.txt')
})
test('review-undo15 S2 comparison: the write lands at 0.3 s, /agent-undo lists a, b and c and the copy holds all three', async ($, on) => {
  const w = world(on, all)
  const listed = await resumeDuringSlowWrite($, w, 300)
  expect(listed).toContain('a.txt'); expect(listed).toContain('b.txt'); expect(listed).toContain('c.txt')
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})

// D1-D3 (deadlock probes of quiet()/idle, common.tsx:100-109): each end must answer inside its bound.
const timeout = (ms: number) => new Promise<string>(r => setTimeout(() => r('still waiting'), ms))
const timed = async (p: Promise<unknown>) => { const t0 = Date.now(); const r = await Promise.race([p.then(() => 'answered'), timeout(3000)]); return { r, ms: Date.now() - t0 } }
test('review-undo15 D1: /clear while an Edit\'s restore waits on a hung queue (a record in flight): the end answers within 1.5 s', async ($, on) => {
  const w = world(on, all, { swapAtEnd: 's2' })
  await start($); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  void edit($, 'a.txt', 'one', 'ONE'); await h.at
  await endTo($, w, 'clear', 's2')                                       // first end: bounded by its own second
  const eb = edit($, 'b.txt', 'x', 'y'); await settle()                  // b's restore(s2) is in saved($, 1000)
  const { r, ms } = await timed(end($, w, 'clear'))
  expect(r).toBe('answered'); expect(ms).toBeLessThan(1500)
  h.release(); await eb
})
test('review-undo15 D2: a record whose list update is refused by the host during the end\'s wait: the end answers and the count returns to zero', async ($, on) => {
  const w = world(on, all, { swapAtEnd: 's2' })
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const ht = hold(); w.holdStateSet = ht
  const eb = edit($, 'b.txt', 'x', 'y'); await ht.at
  const ending = end($, w, 'clear'); await tick()
  setTimeout(ht.release, 30)
  const { r, ms } = await timed(ending)
  expect(r).toBe('answered'); expect(ms).toBeLessThan(1500)
  await eb; await settle()
  // A later end must not wait on a stale count: it answers at once with nothing queued.
  const again = await timed(end($, w, 'clear'))
  expect(again.r).toBe('answered'); expect(again.ms).toBeLessThan(300)
})
// D3 (reads across ids with a write that never lands): each first read after a switch waits its own second at most.
// Both ends answer, each read within its bound.
test('review-undo15 D3a: hung write, /clear to s2 /resume to s3: s3\'s first read answers within its bound', async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  void edit($, 'a.txt', 'one', 'ONE'); await h.at
  await endTo($, w, 'clear', 's2')
  expect((await timed(undo($, ''))).r).toBe('answered')
  await endTo($, w, 'resume', 's3')
  const { r, ms } = await timed(undo($, ''))
  expect(r).toBe('answered'); expect(ms).toBeLessThan(1500)
  h.release()
})
// Without the `late` slot each first read after a switch waits its own second (common.tsx restore()), never more.
test('review-undo15 D3b: hung write, /clear to s2, /resume to s3, /resume to s2 again: s2\'s read answers within its bound', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  void edit($, 'a.txt', 'one', 'ONE'); await h.at
  await endTo($, w, 'clear', 's2')
  expect((await timed(undo($, ''))).r).toBe('answered')
  await endTo($, w, 'resume', 's3')
  await endTo($, w, 'resume', 's2')
  const { r, ms } = await timed(undo($, ''))
  expect(r).toBe('answered'); expect(ms).toBeLessThan(1500)
  h.release()
})
