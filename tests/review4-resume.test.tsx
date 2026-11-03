import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Loop 2 review of 31293d7..fc30a9b. World copied from review3-resume.test.tsx, plus a held store
// read (hold) and a hook on the Nth read of `sessions` (onSessionsGetAt).
// Review of d2b4f16..31293d7 (the list mirrored into the store). The host as in resume.test.tsx,
// with faults the engine's declarations allow: a store read that fails, a store over 4 MiB of JSON
// text in all is refused (index.d.ts store.set), another process writing the same store between
// two of this process's calls, and (realState) the engine's own $.state instead of the test's.

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
const LIMIT = 4 * 1024 * 1024

type Opts = { realState?: boolean; limit?: boolean }
const world = (on: On, files0: Record<string, string>, o: Opts = {}) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = {
    files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    failGet: undefined as string | undefined,
    failGetLeft: 0,
    onSessionsGet: undefined as (() => void) | undefined,
    hold: undefined as { key: string; p: Promise<void> } | undefined,
    sessionsGets: 0,
    onSessionsGetAt: undefined as { n: number; f: () => void } | undefined,
    sets: 0,
    onSetAt: undefined as { n: number; f: () => void } | undefined,
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('session.id', () => ({ value: w.sid }))
  if (!o.realState) {
    on('state.get', (_, e) => ({ value: w.state.get(at(e)) ?? { value: undefined, version: 0 } }) as never)
    on('state.set', (_, e) => {
      const was = w.state.get(at(e))?.version ?? 0
      if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
      w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
      return { value: { isSet: true, version: was + 1 } } as never
    })
  }
  on('store.get', async (_, e) => {
    if (w.hold && w.hold.key === e.key) { const h = w.hold; w.hold = undefined; await h.p }
    if (w.failGet === e.key) { if (--w.failGetLeft <= 0) w.failGet = undefined; throw new Error('EBUSY: store file locked') }
    const v = disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined
    if (e.key === 'sessions' && w.onSessionsGet) { const f = w.onSessionsGet; w.onSessionsGet = undefined; f() }
    if (e.key === 'sessions' && ++w.sessionsGets === w.onSessionsGetAt?.n) { const f = w.onSessionsGetAt.f; w.onSessionsGetAt = undefined; f() }
    return { value: v } as never
  })
  on('store.set', (_, e) => {
    if (++w.sets === w.onSetAt?.n) { const f = w.onSetAt.f; w.onSetAt = undefined; f() }
    if (o.limit) {
      const next = new Map(disk)
      next.set(e.key, e.value)
      if (JSON.stringify(Object.fromEntries(next)).length > LIMIT) throw new Error('store over 4 MiB')
    }
    disk.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => { disk.delete(e.key); return { value: undefined } as never })
  on('store.keys', () => ({ value: [...disk.keys()] }) as never)
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
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

const stored = (file: string, n: number, width: number) => ({
  shape: 'changes-2',
  list: Array.from({ length: n }, (_, k) => ({
    n: k + 1, at: '2026-11-02T10:00:00.000Z', tool: 'Edit', file: `${ROOT}/${file}`,
    hunks: [{ before: ['x'.repeat(width)], after: ['y'.repeat(width)], line: 1 }],
  })),
})
const files = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
const tick = () => new Promise<void>(r => setTimeout(r, 0))

// --- R1 (kind 1): the store comes back after two refused reads. The retried restore finds the
// list non-empty (the edit made meanwhile) and keeps it; the next save writes it over the stored one.

test('review4 R1: after two refused reads the store recovers, and the next edit writes a shorter list over the stored one', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n', 'd.txt': 'k\n' })
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  await restart($, w)
  w.failGet = 'changes:s1'
  w.failGetLeft = 2
  await edit($, 'c.txt', 'p', 'q')
  await edit($, 'd.txt', 'k', 'K')
  // Not merged (c and d were listed as #1 and #2), and the stored a and b are never written over.
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})

test('review4 R1 comparison: one refused read (the retry succeeds), all four edits are stored', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n', 'd.txt': 'k\n' })
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  await restart($, w)
  w.failGet = 'changes:s1'
  w.failGetLeft = 1
  await edit($, 'c.txt', 'p', 'q')
  await edit($, 'd.txt', 'k', 'K')
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt'])
})

// --- R2 (kind 1): /clear (a new session id, no session.start: index.d.ts SessionEndInput.reason)
// while the old id's restore is still reading. The old restore settles last and sets `restored`
// to the old id; the new session never restores again, so it never mirrors.

const clearRace = async ($: $T, w: W, late: boolean) => {
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await restart($, w)
  let release!: () => void
  if (late) w.hold = { key: 'changes:s1', p: new Promise<void>(r => { release = r }) }
  const p1 = edit($, 'b.txt', 'x', 'y')
  await tick()
  w.sid = 's2' // /clear: same process, new session id
  await edit($, 'c.txt', 'p', 'q')
  if (late) release()
  await p1
  await edit($, 'd.txt', 'k', 'K')
}

test('review4 R2: /clear while the old session\'s restore is in flight, the new session\'s later edits are never stored', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n', 'd.txt': 'k\n' })
  await clearRace($, w, true)
  expect(files(w, 'changes:s2')).toContain('d.txt')
})

test('review4 R2 comparison: /clear after the old restore settled, the new session\'s edits are stored', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n', 'd.txt': 'k\n' })
  await clearRace($, w, false)
  expect(files(w, 'changes:s2')).toContain('d.txt')
})

// --- R3 (kind 2): another process's whole save lands in the middle of this one's (at its first or
// second store write). On the shared `sessions` index its id was dropped and its copy never cleared;
// with no index, a copy is found by its key and aged by its own write time (`at:<id>`).

const race = async ($: $T, w: W, at: number) => {
  await start($)
  w.onSetAt = { n: at, f: () => {
    w.disk.set('at:s2', Date.now())
    w.disk.set('changes:s2', stored('b.txt', 1, 1))
  } }
  await edit($, 'a.txt', 'one', 'ONE')
}

test('review4 R3: another process saving at this one\'s second store write keeps its copy', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await race($, w, 2)
  expect(files(w, 'changes:s2')).toEqual(['b.txt'])
  expect(files(w, 'changes:s1')).toEqual(['a.txt'])
})

test('review4 R3 comparison: the same save landing at this one\'s first store write keeps its copy', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await race($, w, 1)
  expect(files(w, 'changes:s2')).toEqual(['b.txt'])
})

const cycle = async ($: $T, w: W) => {
  for (let i = 3; i <= 9; i++) {
    await restart($, w, `s${i}`)
    w.files.set(`${ROOT}/a.txt`, 'one\n')
    await edit($, 'a.txt', 'one', 'ONE')
  }
}

test('review4 R3b: the copy whose index entry was lost is never cleared, seven sessions later', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await race($, w, 2)
  await cycle($, w)
  expect(w.disk.has('changes:s2')).toBe(false)
})

test('review4 R3b comparison: a copy the index named is cleared once five newer sessions are stored', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await race($, w, 1)
  await cycle($, w)
  expect(w.disk.has('changes:s2')).toBe(false)
})

// --- R4 (kind 4: the store's 4 MiB in all, index.d.ts store.set): eviction is by count only. Two
// large stored sessions filling the store are never evicted, since a refused copy leaves the index
// and the index never reaches KEEP; no later session gets a copy.

const full = (w: W, n: number) => {
  for (let i = 1; i <= n; i++) w.disk.set(`changes:old${i}`, stored('big.txt', 20, Math.floor(100000 / n)))
  w.disk.set('sessions', Array.from({ length: n }, (_, i) => `old${i + 1}`))
  const room = LIMIT - 150 - JSON.stringify(Object.fromEntries(w.disk)).length
  const last = (w.disk.get(`changes:old${n}`) as ReturnType<typeof stored>).list[0]!.hunks[0]!
  last.after = [last.after[0]! + 'z'.repeat(room)]
}

const later = async ($: $T, w: W) => {
  for (let i = 1; i <= 6; i++) {
    await restart($, w, `n${i}`)
    w.files.set(`${ROOT}/a.txt`, 'one\n')
    await edit($, 'a.txt', 'one', 'ONE')
  }
}

test('review4 R4: two stored sessions filling the store, six later sessions all get no copy', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' }, { limit: true })
  full(w, 2)
  await later($, w)
  expect(w.disk.has('changes:n6')).toBe(true)
})

test('review4 R4 comparison: five stored sessions filling the store, the later sessions get copies', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' }, { limit: true })
  full(w, 5)
  await later($, w)
  expect(w.disk.has('changes:n6')).toBe(true)
})
