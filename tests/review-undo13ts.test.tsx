// Review of 4d5e8a2..8597eac (0.2.2), TypeScript lens: session.end's bounded wait (saved()) races the save
// queue as it stood when the wait began; a save queued during the wait (the late edit of 843f8d5) is not waited
// for, and it reads its session id when it runs, after the end step swapped the conversation.
// World copied from review-undo11ts.test.tsx, plus swapTo: the engine's end step (what session.end's next(e)
// runs, claude-code.d.ts 'session.end') swaps the conversation itself, a new id and a fresh state, as a /clear does.
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
    swapTo: undefined as undefined | string,
    seenAtEnd: [] as string[],
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
  // The end step: at a /clear the process goes on under the next id with a fresh state, from this moment on.
  on('session.end', (_, e: any) => {
    w.seenAtEnd.push(JSON.stringify((w.disk.get('changes:s1') as { list?: { file: string }[] } | undefined)?.list?.map(c => c.file.split('/').pop()) ?? null))
    w.trace.push('END STEP')
    if (w.swapTo) { w.state.clear(); w.sid = w.swapTo; w.swapTo = undefined }
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
const end = ($: $T, w: W, reason: 'clear' | 'resume' | 'prompt_input_exit') =>
  $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } })
const endTo = async ($: $T, w: W, reason: 'clear' | 'resume', sid: string) => { await end($, w, reason); w.state.clear(); w.sid = sid }


// L1 (kind 1, a queue that grows during the wait): s1's second edit's list update lands while session.end waits
// in saved() for mirrorEnding's queued save. Its mirror() is chained after that save, past the promise saved() is
// racing, so the hook returns next(e) and the end step swaps to s2 first. The late save() then asks
// $.session.id(), gets s2, and writes nothing: b.txt, listed when the conversation ended, is not in s1's copy.
const clearWhileListUpdates = async ($: $T, w: W, inside: boolean) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const hl = hold(), hs = hold()
  if (inside) w.holdStateSet = hl
  const editing = edit($, 'b.txt', 'x', 'y')
  if (inside) await hl.at                     // record() is writing the list [a, b] to $.state
  else { await editing; await settle() }
  w.holdStoreSet = { key: 'changes:s1', ...hs } // the ending copy's write is slow (30 ms)
  w.swapTo = 's2'
  const ending = end($, w, 'clear')           // mirrorEnding reads the list, queues its save; saved() waits; next(e) swaps
  await hs.at                                 // the ending copy is on its way to the store: session.end is in saved()
  w.trace.push('release'); hl.release()       // the list update lands during the wait; its mirror() queues behind
  setTimeout(hs.release, 30)
  await ending; await editing; await settle(); await new Promise(r => setTimeout(r, 50))
}
test('review-undo13ts L1: an edit whose list update lands while session.end waits for the ending copy, s1\'s copy holds b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n' })
  await clearWhileListUpdates($, w, true)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo13ts L1 comparison: the list update landed before session.end, s1\'s copy holds b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n' })
  await clearWhileListUpdates($, w, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})

// L2 (the same queue, at an exit): s1's first edit's copy is being written (store.set held 30 ms) when the person
// exits, and the second edit's list update lands during session.end's wait. saved() returns when the first write
// lands; the end step sees the copy without b.txt, and an exiting process may never write it (claude-code.d.ts
// SessionEndInput: "Exits stay fast ... one short wall-clock bound").
const exitWhileSecondEditLands = async ($: $T, w: W, inside: boolean) => {
  await start($); await settle()
  const hs = hold(), hl = hold()
  w.holdStoreSet = { key: 'changes:s1', ...hs }
  const first = edit($, 'a.txt', 'one', 'ONE')
  await hs.at                                 // a's copy is on its way to the store
  if (inside) w.holdStateSet = hl
  const second = edit($, 'b.txt', 'x', 'y')
  if (inside) await hl.at                     // b's list update is in flight
  else { await tick(); await tick(); await tick() }
  const ending = end($, w, 'prompt_input_exit')
  await tick(); await tick()
  hl.release()
  setTimeout(hs.release, 30)
  await ending; await first; await second; await settle()
}
test('review-undo13ts L2: an exit while a second edit lands during the wait, the end step sees b.txt in s1\'s copy', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n' })
  await exitWhileSecondEditLands($, w, true)
  expect(w.seenAtEnd).toEqual(['["a.txt","b.txt"]'])
})
test('review-undo13ts L2 comparison: the second edit queued its copy before the exit, the end step sees b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n' })
  await exitWhileSecondEditLands($, w, false)
  expect(w.seenAtEnd).toEqual(['["a.txt","b.txt"]'])
})
