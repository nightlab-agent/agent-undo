import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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
  on('store.get', (_, e) => {
    if (w.failGet === e.key) { if (--w.failGetLeft <= 0) w.failGet = undefined; throw new Error('EBUSY: store file locked') }
    const v = disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined
    if (e.key === 'sessions' && w.onSessionsGet) { const f = w.onSessionsGet; w.onSessionsGet = undefined; f() }
    return { value: v } as never
  })
  on('store.set', (_, e) => {
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

/** A stored list as this version writes it: `n` one-hunk edits whose lines are `width` characters. */
const stored = (file: string, n: number, width: number) => ({
  shape: 'changes-2',
  list: Array.from({ length: n }, (_, k) => ({
    n: k + 1, at: '2026-11-02T10:00:00.000Z', tool: 'Edit', file: `${ROOT}/${file}`,
    hunks: [{ before: ['x'.repeat(width)], after: ['y'.repeat(width)], line: 1 }],
  })),
})

// --- Store error at the first restore: the stored list is then overwritten by a shorter one.

test('review3 F1: one failed store read at the first restore loses the earlier edits for good', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  await restart($, w)
  w.failGet = 'changes:s1'
  await edit($, 'c.txt', 'p', 'q')
  await restart($, w)
  const text = await undo($, '')
  expect(text).toContain('Edit c.txt')
  expect(text).toContain('Edit a.txt')
})

test('F1b: a store read that keeps failing never writes a shorter list over the stored one', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  await restart($, w)
  w.failGet = 'changes:s1'
  w.failGetLeft = 2
  await edit($, 'c.txt', 'p', 'q')
  const kept = w.disk.get('changes:s1') as { list: { file: string }[] }
  expect(kept.list.map(c => c.file.split('/').pop())).toEqual(['a.txt', 'b.txt'])
})

test('review3 F1 comparison: no failed read, the earlier edits are still listed after the next edit', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  await restart($, w)
  await edit($, 'c.txt', 'p', 'q')
  await restart($, w)
  const text = await undo($, '')
  expect(text).toContain('Edit c.txt')
  expect(text).toContain('Edit a.txt')
})

// --- Another process (another terminal, another session) writes the same store mid-save.

// review3 F2 and its comparison read the shared `sessions` index, which is gone (each copy now has its
// own write time); the same race, another process saving in the middle of this one's save, is
// review4 R3 and its comparison.

// --- The store's 4 MiB in all: a full store with five sessions never makes room for a sixth.

test('review3 F3: with five stored sessions filling the store, a sixth session gets no copy and none is evicted', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' }, { limit: true })
  for (let i = 1; i <= 5; i++) w.disk.set(`changes:old${i}`, stored('big.txt', 20, 20000))
  w.disk.set('sessions', ['old1', 'old2', 'old3', 'old4', 'old5'])
  // The store just under its 4 MiB (each old session about 0.8 MiB, as a few large Writes make).
  const room = LIMIT - 150 - JSON.stringify(Object.fromEntries(w.disk)).length
  const last = (w.disk.get('changes:old5') as ReturnType<typeof stored>).list[0]!.hunks[0]!
  last.after = [last.after[0]! + 'z'.repeat(room)]
  expect(JSON.stringify(Object.fromEntries(w.disk)).length).toBe(LIMIT - 150)
  await restart($, w, 's6')
  await edit($, 'a.txt', 'one', 'ONE')
  expect(w.disk.has('changes:s6')).toBe(true)
  expect(w.disk.has('changes:old1')).toBe(false)
})

test('review3 F3 comparison: five small stored sessions, a sixth gets its copy and the oldest goes', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' }, { limit: true })
  for (let i = 1; i <= 5; i++) w.disk.set(`changes:old${i}`, stored('big.txt', 20, 20))
  w.disk.set('sessions', ['old1', 'old2', 'old3', 'old4', 'old5'])
  await restart($, w, 's6')
  await edit($, 'a.txt', 'one', 'ONE')
  expect(w.disk.has('changes:s6')).toBe(true)
  expect(w.disk.has('changes:old1')).toBe(false)
})

// --- Probes (kind 4): the engine's own $.state under the mirror; two hooks racing on the first restore.

test('review3 P1: with the engine\'s own $.state, the stored copy holds both edits', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n' }, { realState: true })
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  const got = w.disk.get('changes:s1') as { list: { file: string }[] } | undefined
  expect(got?.list.map(c => c.file)).toEqual([`${ROOT}/a.txt`, `${ROOT}/b.txt`])
})

test('review3 P2: two edits at once as the first events of a new process keep the restored list and both', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await restart($, w)
  await Promise.all([edit($, 'b.txt', 'x', 'y'), edit($, 'c.txt', 'p', 'q'), undo($, '')])
  await restart($, w)
  const text = await undo($, '')
  for (const f of ['a', 'b', 'c']) expect(text).toContain(`Edit ${f}.txt`)
  expect(text).toContain('#3 ')
})
