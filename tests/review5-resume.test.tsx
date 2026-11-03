import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Fresh review of 638d113..2dee149 (the stored copy with its own write time, no index). World copied
// from review4-resume.test.tsx, plus a hook on the first read of a given store key (onGet).
// Engine behaviour leaned on (cc-types 2.1.310, claude-code.d.ts):
// - $.state "survives a hot reload of the plugin's code" (3466-3467);
// - session.start fires again "once per fresh load of one ... an enable, a worker respawn, or a
//   reload" (4463-4468): a reload is a start whose $.state is NOT empty;

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
const LIMIT = 4 * 1024 * 1024

const world = (on: On, files0: Record<string, string>, o: { limit?: boolean; realState?: boolean } = {}) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = {
    files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    failGet: undefined as string | undefined,
    failGetLeft: 0,
    onGet: undefined as { key: string; f: () => void } | undefined,
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
    if (w.failGet === e.key) { if (--w.failGetLeft <= 0) w.failGet = undefined; throw new Error('EBUSY: store file locked') }
    const v = disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined
    // Another process writes after this read answered (this process holds the old value).
    if (w.onGet && w.onGet.key === e.key) { const f = w.onGet.f; w.onGet = undefined; f() }
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

const stored = (file: string, n: number, width: number, shape = 'changes-2') => ({
  shape,
  list: Array.from({ length: n }, (_, k) => ({
    n: k + 1, at: '2026-11-02T10:00:00.000Z', tool: 'Edit', file: `${ROOT}/${file}`,
    hunks: [{ before: ['x'.repeat(width)], after: ['y'.repeat(width)], line: 1 }],
  })),
})
const files = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
/** n other sessions' copies, old1 the oldest (write times 1000, 2000, ...). */
const olds = (w: W, n: number) => {
  for (let i = 1; i <= n; i++) { w.disk.set(`at:old${i}`, i * 1000); w.disk.set(`changes:old${i}`, stored(`o${i}.txt`, 1, 10)) }
}
const oldLeft = (w: W, n: number) => Array.from({ length: n }, (_, i) => i + 1).filter(i => w.disk.has(`changes:old${i}`))

// --- F1 (kind 4): a reload (session.start again, $.state kept) restores again, finds the list
// non-empty, so the copy is "not taken" and this session is never saved again in this process.

const reload = async ($: $T, doReload: boolean) => {
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  if (doReload) await start($) // a reload, enable or worker respawn: d.ts 4463-4468; $.state survives (3466)
  await edit($, 'c.txt', 'p', 'q')
}

test('review5 F1: after a reload of the mod (state kept), later edits are never stored', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await reload($, true)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})

test('review5 F1 comparison: with no reload, the third edit is stored', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await reload($, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})

test('review5 F1 on the engine\'s own $.state: after a reload, later edits are never stored', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' }, { realState: true })
  await reload($, true)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})

test('review5 F1 comparison on the engine\'s own $.state: no reload, the third edit is stored', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' }, { realState: true })
  await reload($, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})

test('review5 F1 a step later: after the reload and a resume, the edit made after the reload cannot be undone', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await reload($, true)
  await restart($, w) // claude --resume: a new process, same id
  expect(await undo($, '')).toContain('c.txt')
})
