// Review of 29969ed..3ca5774: save() checks `restored` against the id, then reads the list across an await.
// World copied from review-end9.test.tsx (its session.id holds and gates unused here), plus holdListGet:
// after the next state.set of the list, the next state.get of the list (save()'s read) waits.
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'

const world = (on: On, files0: Record<string, string>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const statuses: string[] = []
  const w = {
    statuses, files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    hold: undefined as { key: string; p: Promise<void> } | undefined,
    clearAtCheck: undefined as undefined | 'before' | 'after',
    swapTo: 's2',
    armed: false,
    gate: undefined as Promise<void> | undefined,
    gated: false,
    // After the next state.set of the list, the next session.id call (save()'s) waits here.
    holdSaveId: undefined as undefined | { reached: () => void; p: Promise<void> },
    idHeld: undefined as undefined | { reached: () => void; p: Promise<void> },
    ids: 0,
    holdListGet: undefined as undefined | { reached: () => void; p: Promise<void> },
    getHeld: undefined as undefined | { reached: () => void; p: Promise<void> },
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('session.id', async () => {
    w.ids++
    if (w.idHeld) { const h = w.idHeld; w.idHeld = undefined; h.reached(); await h.p }
    if (w.gated) { w.gated = false; const g = w.gate; w.gate = undefined; if (g) await g }
    const v = w.sid
    if (w.armed) {
      w.armed = false
      const m = w.clearAtCheck; w.clearAtCheck = undefined
      w.state.clear(); w.sid = w.swapTo // a /clear or in-process /resume lands at restore()'s id check
      if (w.gate) w.gated = true // hold the next id call: restore()'s second check
      return { value: m === 'after' ? v : w.sid }
    }
    return { value: v }
  })
  on('state.get', async (_, e) => {
    if (e.key === 'changes' && w.getHeld) { const h = w.getHeld; w.getHeld = undefined; h.reached(); await h.p }
    return { value: w.state.get(at(e)) ?? { value: undefined, version: 0 } } as never
  })
  on('state.set', (_, e) => {
    const was = w.state.get(at(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
    w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
    if (e.key === 'changes' && w.holdListGet) { w.getHeld = w.holdListGet; w.holdListGet = undefined }
    if (e.key === 'changes' && w.holdSaveId) { w.idHeld = w.holdSaveId; w.holdSaveId = undefined }
    return { value: { isSet: true, version: was + 1 } } as never
  })
  on('store.get', async (_, e) => {
    if (w.hold && w.hold.key === e.key) { const h = w.hold; w.hold = undefined; await h.p }
    const v = disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined
    if (e.key === 'changes:s1' && w.clearAtCheck) w.armed = true
    return { value: v } as never
  })
  on('store.set', (_, e) => { disk.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } as never })
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

// A real session.end (SessionEndInput): for a /clear or an in-process /resume the process goes on under
// another id with a fresh state (index.d.ts SessionEndInput.reason; review8-window endTo); for an exit it does not.
const end = ($: $T, w: W, reason: 'clear' | 'resume' | 'prompt_input_exit') =>
  $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } })
const endTo = async ($: $T, w: W, reason: 'clear' | 'resume', sid: string) => { await end($, w, reason); w.state.clear(); w.sid = sid }

// P1 (kind 2, the known unprobed one): s1's second edit is being mirrored; save() has asked the id (s1) and
// passed `restored === id`, and is reading the list when a /clear lands (session.end reason clear: a new id, a
// fresh $.state, forgetRestore). save() then reads the new conversation's list and writes it as s1's copy.
const clearDuringSaveRead = async ($: $T, w: W, inside: boolean, newEdit: boolean) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  let release!: () => void, reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  w.holdListGet = { reached, p: new Promise<void>(r => { release = r }) }
  const editing = edit($, 'b.txt', 'x', 'y')
  await at                                   // save() for s1 passed its check and is reading the list
  let other: Promise<unknown> | undefined
  if (inside) {
    await endTo($, w, 'clear', 's2')
    if (newEdit) { other = edit($, 'c.txt', 'k', 'K'); await settle() }
  }
  release(); await editing; await other; await settle()
  if (!inside) {
    await endTo($, w, 'clear', 's2')
    if (newEdit) { await edit($, 'c.txt', 'k', 'K'); await settle() }
  }
}
test('review-undo10 P1: a /clear while save() reads the list, s1\'s stored copy still holds a.txt and b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' })
  await clearDuringSaveRead($, w, true, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo10 P1 comparison: the /clear after the mirror settled, s1\'s stored copy holds a.txt and b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' })
  await clearDuringSaveRead($, w, false, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo10 P1b: the new conversation edits c.txt in that gap, s1\'s stored copy does not list c.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' })
  await clearDuringSaveRead($, w, true, true)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo10 P1b comparison: c.txt edited after the mirror settled, s1\'s copy is a.txt, b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' })
  await clearDuringSaveRead($, w, false, true)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo10 P1c: then s1 resumed in a new process lists b.txt and not c.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' })
  await clearDuringSaveRead($, w, true, true)
  await restart($, w, 's1'); await settle()
  const text = await undo($, '')
  expect(text).toContain('b.txt')
  expect(text).not.toContain('c.txt')
})
test('review-undo10 P1c comparison: no /clear in the gap, s1 resumed lists b.txt and not c.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' })
  await clearDuringSaveRead($, w, false, true)
  await restart($, w, 's1'); await settle()
  const text = await undo($, '')
  expect(text).toContain('b.txt')
  expect(text).not.toContain('c.txt')
})
