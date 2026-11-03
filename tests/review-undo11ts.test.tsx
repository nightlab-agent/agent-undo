// Review of 29969ed..4d5e8a2 (0.2.2): the in-process /resume (F4) reads the stored copy without waiting for
// the save queue, and mirrorEnding() reads the list once, before the end step.
// World copied from review-undo10.test.tsx, plus holdStoreSet (a store.set of one key waits: a slow store
// write) and holdStateSet (the next state.set of the list waits: an edit's update landing late).
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
type Hold = { reached: () => void; p: Promise<void> }

const world = (on: On, files0: Record<string, string>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const statuses: string[] = []
  const w = {
    statuses, files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
    holdStateSet: undefined as undefined | Hold,
    trace: [] as string[],
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  // The engine's clock: a real wait (the test kit answers none), so session.end's bounded wait for a held save ends.
  on('clock.sleep', (_, e) => new Promise(r => setTimeout(() => r({ value: undefined }), e.ms)) as never)
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
  on('session.end', (_, e: any) => ({ sessionId: e.sessionId }) as never)
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

// A real session.end (SessionEndInput): for a /clear or an in-process /resume the process goes on under
// another id with a fresh state; the world swaps after next(e) returns, as review-undo10 does.
const end = ($: $T, w: W, reason: 'clear' | 'resume') =>
  $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } })
const endTo = async ($: $T, w: W, reason: 'clear' | 'resume', sid: string) => { await end($, w, reason); w.state.clear(); w.sid = sid }

// Q1 (kind 1, a read that does not wait for the queued write of the same key): s1's second edit is stored
// (save() is at its store.set of changes:s1, the store slow) when a /clear and an in-process /resume back to s1
// land. restore() reads changes:s1 before that write and takes the one-entry copy; the queued saves then write
// a.txt, b.txt; s1's next edit writes a.txt, c.txt over it. b.txt is gone from the list and the store.
const resumeDuringStoreWrite = async ($: $T, w: W, inside: boolean) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const h = hold()
  if (inside) w.holdStoreSet = { key: 'changes:s1', ...h }
  const editing = edit($, 'b.txt', 'x', 'y')
  if (inside) await h.at                      // save() for s1 is writing changes:s1 = [a, b]
  else { await editing; await settle() }
  await endTo($, w, 'clear', 's2')
  await endTo($, w, 'resume', 's1')
  const editingC = edit($, 'c.txt', 'k', 'K'); await settle()   // its mirror waits in the queue behind the held write
  h.release(); await editing; await editingC; await settle()
}
test('review-undo11 Q1: /clear and /resume back while the stored copy is being written, s1 still lists and stores b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' })
  await resumeDuringStoreWrite($, w, true)
  expect(await undo($, '')).toContain('b.txt')
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})
test('review-undo11 Q1 comparison: /clear and /resume back after the write settled, s1 lists and stores b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' })
  await resumeDuringStoreWrite($, w, false)
  expect(await undo($, '')).toContain('b.txt')
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})
test('review-undo11 Q1b: then s1 resumed in a new process lists b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' })
  await resumeDuringStoreWrite($, w, true)
  await restart($, w, 's1'); await settle()
  expect(await undo($, '')).toContain('b.txt')
})

// B (kind 1, a write between the read and the swap): s1's second edit's list update lands after mirrorEnding()
// read the list in session.end and before the end step swaps the state. Its own save finds `restored` gone
// (forgetRestore) and writes nothing; the ending copy was read without it.
const clearDuringListUpdate = async ($: $T, w: W, inside: boolean) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const h = hold()
  if (inside) w.holdStateSet = h
  const editing = edit($, 'b.txt', 'x', 'y')
  if (inside) await h.at                      // record() is writing the list [a, b] to $.state
  else { await editing; await settle() }
  w.trace.push('end')
  const ending = end($, w, 'clear')          // mirrorEnding reads the list, forgetRestore, next(e)
  await tick(); w.trace.push('release')
  h.release(); await ending; await editing; await settle()
  w.state.clear(); w.sid = 's2'
  await settle()
}
test('review-undo11 B: the edit\'s list update lands during session.end, s1\'s stored copy still holds b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n' })
  await clearDuringListUpdate($, w, true)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo11 B comparison: the list update landed before session.end, s1\'s stored copy holds b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n' })
  await clearDuringListUpdate($, w, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
