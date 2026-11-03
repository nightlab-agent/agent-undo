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

// N1 (kind 1/2): CHANGELOG 0.2.2 says a stored-copy write that never finishes leaves the next conversation's
// edits "stored from then on" once restore's second passes. mirror() chains every save on `saving`
// (common.tsx:33), so behind a write that never lands no later save runs: s2's copy never holds b.txt.
const neverLands = async ($: $T, w: W, lands: number | undefined) => {
  await start($); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const ea = edit($, 'a.txt', 'one', 'ONE'); await h.at
  await endTo($, w, 'clear', 's2')
  const eb = edit($, 'b.txt', 'x', 'y')
  if (lands !== undefined) setTimeout(h.release, lands)
  const wait = (ms: number) => new Promise(r => setTimeout(() => r('still waiting'), ms))
  const bDone = await Promise.race([eb.then(() => 'returned'), wait(3000)])
  const ec = edit($, 'c.txt', 'k', 'K'); await Promise.race([ec, wait(1000)]); await settle()
  await end($, w, 'prompt_input_exit'); await settle(); await settle()
  void ea
  return bDone
}
test('review-undo16 N1: s1\'s copy write never lands, /clear to s2, two edits and an exit: s2\'s copy holds b.txt and c.txt', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  const bDone = await neverLands($, w, undefined)
  expect(w.files.get('/proj/c.txt')).toBe('K\n')
  expect(w.files.get('/proj/b.txt')).toBe('y\n')
  expect(files(w, 'changes:s2')).toEqual(['b.txt', 'c.txt'])
})
test('review-undo16 N1 comparison: the same write lands at 1.5 s, s2\'s copy holds b.txt and c.txt', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await neverLands($, w, 1500)
  expect(files(w, 'changes:s2')).toEqual(['b.txt', 'c.txt'])
})
test('review-undo16 N1 probe: s1\'s copy write never lands, s2\'s first Edit hook returns to the engine', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  expect(await neverLands($, w, undefined)).toBe('returned')
})

// N1b (kind 1, out of order): with the bound, c's save no longer waits for b's held write of the same copy; when that
// write lands at 1.3 s it must not leave the older [a, b] as the copy.
test('review-undo16 N1b: b\'s copy write lands at 1.3 s, c saved meanwhile: the copy ends holding a, b and c', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const eb = edit($, 'b.txt', 'x', 'y'); await h.at
  const ec = edit($, 'c.txt', 'k', 'K')
  setTimeout(h.release, 1300)
  await eb; await ec; await new Promise(r => setTimeout(r, 300)); await settle(); await settle()
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})
test('review-undo16 N1b comparison: b\'s write lands at 0.3 s: the copy holds a, b and c', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const eb = edit($, 'b.txt', 'x', 'y'); await h.at
  const ec = edit($, 'c.txt', 'k', 'K')
  setTimeout(h.release, 300)
  await eb; await ec; await settle(); await settle()
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})
