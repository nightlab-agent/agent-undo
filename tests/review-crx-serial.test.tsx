import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { tempTools } from './temp-tools'

// Code review of 1c08fb2 (0.2.2). The world is review-pr5's (real clock, a store.set that can be held once).
// S1 (kind 2): run() (the /agent-undo command and the undo tool) runs inside serial(), the queue every Edit
// and Write passes its tool through (register.tsx:220, :236, :254). An undo's updateList awaits its own copy
// write (common.tsx:304 `await p`, p = mirror() -> save() -> $.store.set). If that write never lands, serial()
// never moves: /agent-undo never answers and no later Edit or Write runs its tool. The comparison holds the
// same kind of write (an Edit's own copy write, outside serial()) and both answer.
type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
type Hold = { reached: () => void; p: Promise<void> }

const world = (on: On, files0: Record<string, string>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = {
    files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('clock.sleep', (_, e, next) => new Promise(r => {
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
  tempTools(on, files)
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
const hold = () => {
  let reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  const p = new Promise<void>(() => {}) // never lands
  return { reached, p, at }
}
const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' }

test('review-crx S1: the undo\'s own copy write never lands; /agent-undo answers and the next Edit writes its file within 3 s', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  const h = hold()
  w.holdStoreSet = { key: 'at:s1', ...h }
  const u = within(undo($, '1'), 3000)
  const ed = within(edit($, 'c.txt', 'p', 'q'), 3000)
  const [uu] = await Promise.all([u, ed])
  console.log(`S1 undo: ${uu === 'timeout' ? 'no answer in 3 s' : JSON.stringify(uu.v)}; a.txt=${JSON.stringify(w.files.get(`${ROOT}/a.txt`))}; c.txt=${JSON.stringify(w.files.get(`${ROOT}/c.txt`))}`)
  expect(uu).not.toBe('timeout')
  expect(w.files.get(`${ROOT}/c.txt`)).toBe('q\n')
})

test('review-crx S1 comparison: an Edit\'s own copy write never lands; /agent-undo answers and the next Edit writes its file within 3 s', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE')
  const h = hold()
  w.holdStoreSet = { key: 'at:s1', ...h }
  void edit($, 'b.txt', 'x', 'y')
  await h.at
  const u = within(undo($, '1'), 3000)
  const ed = within(edit($, 'c.txt', 'p', 'q'), 3000)
  const [uu] = await Promise.all([u, ed])
  console.log(`S1c undo: ${uu === 'timeout' ? 'no answer in 3 s' : JSON.stringify(uu.v)}`)
  expect(uu).not.toBe('timeout')
  expect(w.files.get(`${ROOT}/c.txt`)).toBe('q\n')
})

test('review-crx S2: an Edit\'s own copy write never lands; that Edit\'s tool result comes back within 3 s', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE')
  w.holdStoreSet = { key: 'at:s1', ...hold() }
  const got = await within(edit($, 'b.txt', 'x', 'y'), 3000)
  console.log(`S2 edit b: ${got === 'timeout' ? 'no tool result in 3 s' : 'returned'}; b.txt=${JSON.stringify(w.files.get(`${ROOT}/b.txt`))}`)
  expect(got).not.toBe('timeout')
})
test('review-crx S2 comparison: an earlier Edit\'s copy write never lands; the next Edit\'s tool result comes back within 3 s', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE')
  const h = hold()
  w.holdStoreSet = { key: 'at:s1', ...h }
  void edit($, 'b.txt', 'x', 'y'); await h.at
  const got = await within(edit($, 'c.txt', 'p', 'q'), 3000)
  expect(got).not.toBe('timeout')
})
