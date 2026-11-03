import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Code review of ff35561 (0.2.2, the updateList bound). The world is review-crx-serial's, with two knobs:
// `holdAll` holds every store.set for good (a hung store), and `sleeps: false` gives the world no clock.sleep
// (the kit then refuses it, as a mod above that refuses it would).
// H1 (kind 2, the s407 lesson): updateList's own one-second wait gives up on its write p without putting p in
// `passed`, so the next save's after(p) waits a full second on the same p again; with a hung store every Edit
// after the first costs two seconds, not "a second at most" (CHANGELOG).
// H2 (kind 4): a refused sleep makes the new wait `.catch(() => p)`, the unbounded wait the PR removes; saved()
// in the same file ends at once in that case.
type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
type Hold = { reached: () => void; p: Promise<void> }

const world = (on: On, files0: Record<string, string>, opts: { sleeps?: boolean } = {}) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = {
    files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
    holdAll: false,
    rejectOnce: undefined as undefined | string,
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  if (opts.sleeps !== false) on('clock.sleep', (_, e, next) => new Promise(r => {
    const t = setTimeout(() => r({ value: undefined }), e.ms)
    next.signal.addEventListener('abort', () => clearTimeout(t), { once: true })
  }) as never)
  on('session.id', async () => ({ value: w.sid }))
  on('state.get', async (_, e) => ({ value: w.state.get(at(e)) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', async (_, e) => {
    const was = w.state.get(at(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
    w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
    return { value: { isSet: true, version: was + 1 } } as never
  })
  on('store.get', async (_, e) => ({ value: disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined }) as never)
  on('store.set', async (_, e) => {
    if (w.holdAll) await new Promise<void>(() => {})
    if (w.rejectOnce && w.rejectOnce === e.key) { w.rejectOnce = undefined; throw new Error('EBUSY: resource busy or locked') }
    if (w.holdStoreSet && w.holdStoreSet.key === e.key) { const h = w.holdStoreSet; w.holdStoreSet = undefined; h.reached(); await h.p }
    disk.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => { disk.delete(e.key); return { value: undefined } as never })
  on('store.keys', () => ({ value: [...disk.keys()] }) as never)
  on('session.end', async (_, e: any) => ({ sessionId: e.sessionId }) as never)
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => { const t = files.get(e.path); if (t === undefined) throw new Error('ENOENT'); return { value: t } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('tool.call', (_, e) => {
    const x = e as unknown as { file_path: string; old_string: string; new_string: string }
    const was = files.get(x.file_path)!
    files.set(x.file_path, was.replace(x.old_string, x.new_string))
    const i = was.split('\n').findIndex(l => l.includes(x.old_string))
    const line = was.split('\n')[i]!
    return { result: { filePath: x.file_path, oldString: x.old_string, newString: x.new_string, originalFile: was,
      structuredPatch: [{ oldStart: i + 1, oldLines: 1, newStart: i + 1, newLines: 1,
        lines: [`-${line}`, `+${line.replace(x.old_string, x.new_string)}`] }],
      userModified: false, replaceAll: false } } as never
  })
  return w
}

const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }
const ms = (n: number) => new Promise<void>(r => setTimeout(r, n))
const within = <T,>(p: Promise<T>, n: number) => Promise.race([p.then(v => ({ v })), ms(n).then(() => 'timeout' as const)])
const timed = async <T,>(p: Promise<T>) => { const t0 = Date.now(); await p; return Date.now() - t0 }
const hold = () => {
  let reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  const p = new Promise<void>(() => {}) // never lands
  return { reached, p, at }
}
const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n', 'd.txt': 'r\n' }

// H1: the store hangs from Edit b on. Edit b's hook: its own wait, a second. Edit c's hook: after(p_b) a second
// (p_b is in `saving`, not in `passed`), then its own wait on p_c, a second more.
test('review-cr6 H1: the store hangs; the second Edit under it answers within 1.5 s', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  w.holdAll = true
  const tb = await timed(edit($, 'b.txt', 'x', 'y'))
  const tc = await timed(edit($, 'c.txt', 'p', 'q'))
  const td = await timed(edit($, 'd.txt', 'r', 's'))
  console.log(`H1 edit b: ${tb} ms; edit c: ${tc} ms; edit d: ${td} ms`)
  expect(tb).toBeLessThan(1500)
  expect(tc).toBeLessThan(1500)
  expect(td).toBeLessThan(1500)
})
test('review-cr6 H1 comparison: the store hangs; the first Edit under it answers within 1.5 s', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  w.holdAll = true
  const tb = await timed(edit($, 'b.txt', 'x', 'y'))
  console.log(`H1c edit b: ${tb} ms`)
  expect(tb).toBeLessThan(1500)
})
// H1b: the same for an undo after a stuck Edit: the undo's hook waits a second for the Edit's write, then a second for its own.
test('review-cr6 H1b: the store hangs under Edit b; the undo after it answers within 1.5 s', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  w.holdAll = true
  await edit($, 'b.txt', 'x', 'y')
  const tu = await timed(undo($, '1'))
  console.log(`H1b undo: ${tu} ms; a.txt=${JSON.stringify(w.files.get(`${ROOT}/a.txt`))}`)
  expect(w.files.get(`${ROOT}/a.txt`)).toBe('one\n')
  expect(tu).toBeLessThan(1500)
})

// H3 (kind 1): the undo's own write is passed by at 1 s and lands at 1.5 s, an Edit saved meanwhile: the copy must
// end holding the undone mark and the new edit, not the undo-time list the late write carries.
const release = () => {
  let reached!: () => void, go!: () => void
  const at = new Promise<void>(r => { reached = r })
  const p = new Promise<void>(r => { go = r })
  return { reached, p, at, go }
}
const stored = (w: { disk: Map<string, unknown> }) => ((w.disk.get('changes:s1') as { list?: { file: string; hunks: { undone?: boolean }[] }[] } | undefined)?.list ?? [])
  .map(c => `${c.file.split('/').pop()}${c.hunks.some(h => h.undone) ? '(undone)' : ''}`)
test('review-cr6 H3: the undo\'s write lands at 1.5 s, an Edit saved meanwhile: the copy holds a(undone), b, c', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await edit($, 'b.txt', 'x', 'y'); await settle()
  const h = release()
  w.holdStoreSet = { key: 'at:s1', ...h }
  setTimeout(h.go, 1500)
  await undo($, '1')
  await edit($, 'c.txt', 'p', 'q')
  await ms(1200); await settle(); await settle()
  console.log(`H3 copy: ${JSON.stringify(stored(w))}`)
  expect(stored(w)).toEqual(['a.txt(undone)', 'b.txt', 'c.txt'])
})
test('review-cr6 H3 comparison: the undo\'s write lands at 0.3 s: the copy holds a(undone), b, c', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await edit($, 'b.txt', 'x', 'y'); await settle()
  const h = release()
  w.holdStoreSet = { key: 'at:s1', ...h }
  setTimeout(h.go, 300)
  await undo($, '1')
  await edit($, 'c.txt', 'p', 'q')
  await ms(1200); await settle(); await settle()
  expect(stored(w)).toEqual(['a.txt(undone)', 'b.txt', 'c.txt'])
})
// P1 (kind 4, outside the diff: put() in common.tsx): a store.set refused once for any reason is taken as the
// 4 MiB cap, and the oldest other conversation's copy is dropped to make room; a write cut by the engine (a
// lingering hook past lingerMs) or a busy file then costs another conversation its undo list.
test('review-cr6 P1: at:s1 refused once as EBUSY, not the cap: s0\'s copy stays', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  w.disk.set('at:s0', 1); w.disk.set('changes:s0', { shape: 'changes-2', list: [{ n: 1, at: '2026-11-03T00:00:00.000Z', tool: 'Edit', file: '/proj/z.txt', hunks: [] }] })
  await start($); await settle()
  w.rejectOnce = 'at:s1'
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  console.log(`P1 keys: ${JSON.stringify([...w.disk.keys()].sort())}`)
  expect(w.disk.has('changes:s0')).toBe(true)
})
test('review-cr6 P1 comparison: at:s1 refused never: s0\'s copy stays', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  w.disk.set('at:s0', 1); w.disk.set('changes:s0', { shape: 'changes-2', list: [{ n: 1, at: '2026-11-03T00:00:00.000Z', tool: 'Edit', file: '/proj/z.txt', hunks: [] }] })
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  expect(w.disk.has('changes:s0')).toBe(true)
  expect(w.disk.has('changes:s1')).toBe(true)
})
