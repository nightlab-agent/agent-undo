// Review of 8cf2d41..186c202 (session.end calls forgetRestore; restore() rolls a /clear-in-the-gap back and
// scrubs the other copies): what tests/review6-gap, review7-mirror, review7-ts-gap and review8-window leave.
// World copied from review8-window.test.tsx, plus: the id a gap /clear or /resume swaps to (swapTo), and a
// hold on the session.id call save() makes right after an edit's list update (holdSaveId).
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
  on('state.get', (_, e) => ({ value: w.state.get(at(e)) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    const was = w.state.get(at(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
    w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
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

// X1 (kind 1): the person exits (ctrl+c, /exit: SessionEndReason prompt_input_exit) while the last edit's mirror is
// still at save()'s own `$.session.id()`. session.end's new forgetRestore() clears `restored`, and save() then
// reads `restored !== id` and writes nothing: the edit never reaches the stored copy, so a later
// `claude --resume` lists without it. Before this change session.end left `restored` alone and the write went through.
const exitDuringMirror = async ($: $T, w: W, exitInside: boolean) => {
  await start($); await settle()
  let release!: () => void, reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  w.holdSaveId = { reached, p: new Promise<void>(r => { release = r }) }
  const editing = edit($, 'a.txt', 'one', 'ONE')
  await at                                   // the list holds a.txt; save() is asking the id
  if (exitInside) await end($, w, 'prompt_input_exit')
  release(); await editing; await settle()
  if (!exitInside) await end($, w, 'prompt_input_exit')
}
test('review-end9 X1: an exit while the last edit\'s mirror is in flight, the stored copy still holds that edit', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await exitDuringMirror($, w, true)
  expect(files(w, 'changes:s1')).toEqual(['a.txt'])
})
test('review-end9 X1 comparison: the exit after the mirror settled, the stored copy holds that edit', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await exitDuringMirror($, w, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt'])
})

// X2 (kind 1, forgetRestore meets an in-flight restore): the start's restore of s1 is still reading the store
// when a /clear and then an in-process /resume back to s1 land (both session.end: forgetRestore twice). The old
// restore then fills s1's fresh list and, `restoring` being gone, sets neither `restored` nor `listed`. s1's next
// edit starts a second restore, which finds the list non-empty, gives up (`took` false), and is cached under
// `restoring` for the process: `restored` is never s1 again, so no edit of s1 is mirrored for the rest of the
// process, and a resume in a new process lists only what was stored before.
const clearResumeDuringRestore = async ($: $T, w: W, inside: boolean) => {
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  let release!: () => void
  w.hold = { key: 'changes:s1', p: new Promise<void>(r => { release = r }) }
  await restart($, w)                        // s1 again: the start's restore waits at the store read
  if (!inside) { release(); await settle() }
  await endTo($, w, 'clear', 's2')
  await endTo($, w, 'resume', 's1')
  if (inside) { release(); await settle() }
  await edit($, 'd.txt', 'k', 'K')
  await edit($, 'e.txt', 'm', 'M')
  await settle()
}
test('review-end9 X2: /clear and /resume back while the restore is in flight, the next edits still reach the stored copy', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'd.txt': 'k\n', 'e.txt': 'm\n' })
  await clearResumeDuringRestore($, w, true)
  expect(await undo($, '')).toContain('e.txt')          // the list in this process is right
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'd.txt', 'e.txt'])
})
test('review-end9 X2 comparison: /clear and /resume back after the restore settled, the next edits reach the stored copy', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'd.txt': 'k\n', 'e.txt': 'm\n' })
  await clearResumeDuringRestore($, w, false)
  expect(await undo($, '')).toContain('e.txt')
  expect(files(w, 'changes:s1').slice(-2)).toEqual(['d.txt', 'e.txt'])
})
test('review-end9 X2b: then s1 resumed in a new process lists d.txt and e.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'd.txt': 'k\n', 'e.txt': 'm\n' })
  await clearResumeDuringRestore($, w, true)
  await restart($, w, 's1'); await settle()
  expect(await undo($, '')).toContain('e.txt')
})
test('review-end9 X2b comparison: no restore in flight, s1 resumed in a new process lists e.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'd.txt': 'k\n', 'e.txt': 'm\n' })
  await clearResumeDuringRestore($, w, false)
  await restart($, w, 's1'); await settle()
  expect(await undo($, '')).toContain('e.txt')
})

// X3 (kind 1, a new session's restore meets the leaked list): the /clear in the gap is instead an in-process
// /resume to an older conversation s0 that has a stored copy (p.txt, q.txt). The old restore's list lands in s0's
// fresh state; s0's first edit in the window starts s0's restore, which finds the list non-empty and gives up for
// good, as in X2. The rollback then takes the old entries out and scrubs, but s0's stored p.txt and q.txt are never
// listed, and s0's own edits are never mirrored.
const resumeInGap = async ($: $T, w: W, when: 'before' | 'after') => {
  await restart($, w, 's0')
  await edit($, 'p.txt', '1', '2')
  await edit($, 'q.txt', '3', '4')
  await restart($, w, 's1')
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  let open: () => void = () => {}
  // 'after': the first check answered s1, the second waits on the gate; 'before': the first check answers s0 and
  // restore() returns there, so there is no second check to hold.
  if (when === 'after') w.gate = new Promise<void>(r => { open = r })
  w.clearAtCheck = when
  w.swapTo = 's0'
  await restart($, w)                        // s1 resumed: the restore's first id check is where the /resume lands
  await settle()
  expect(w.sid).toBe('s0')
  await edit($, 'd.txt', 'k', 'K')           // s0's first edit, inside the window
  open(); await settle()
}
test('review-end9 X3: an in-process /resume to s0 lands in the gap, s0 lists its stored q.txt and stores its edit', async ($, on) => {
  const w = world(on, { 'p.txt': '1\n', 'q.txt': '3\n', 'a.txt': 'one\n', 'b.txt': 'x\n', 'd.txt': 'k\n' })
  await resumeInGap($, w, 'after')
  expect(await undo($, '')).not.toContain('b.txt')
  expect(await undo($, '')).toContain('q.txt')
  expect(files(w, 'changes:s0')).toEqual(['p.txt', 'q.txt', 'd.txt'])
})
test('review-end9 X3 comparison: the /resume to s0 lands just before the id check, s0 lists q.txt and stores its edit', async ($, on) => {
  const w = world(on, { 'p.txt': '1\n', 'q.txt': '3\n', 'a.txt': 'one\n', 'b.txt': 'x\n', 'd.txt': 'k\n' })
  await resumeInGap($, w, 'before')
  expect(await undo($, '')).not.toContain('b.txt')
  expect(await undo($, '')).toContain('q.txt')
  expect(files(w, 'changes:s0')).toEqual(['p.txt', 'q.txt', 'd.txt'])
})
