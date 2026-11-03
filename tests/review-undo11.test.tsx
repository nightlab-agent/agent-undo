// Review of 29969ed..4d5e8a2 (the 0.2.2 release): what session.end now does at a /clear, /resume and exit.
// World copied from review-undo10.test.tsx, plus: a hold on the next store.set of one key (holdStoreSet), and a
// record of what the store holds when the engine's end step runs (seenAtEnd), i.e. when session.end's hook
// calls next(e): claude-code.d.ts 'session.end' ("`next(e)` runs the engine's end step").
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
    // The next store.set of `key` waits here (the write is on its way to the store).
    holdStoreSet: undefined as undefined | { key: string; reached: () => void; p: Promise<void> },
    // What the store held each time the engine's end step ran: the keys, as session.end's next(e) sees them.
    seenAtEnd: [] as string[][],
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  // The engine's clock: a real wait (the test kit answers none), so session.end's bounded wait for a held save ends.
  on('clock.sleep', (_, e) => new Promise(r => setTimeout(() => r({ value: undefined }), e.ms)) as never)
  on('session.id', async () => ({ value: w.sid }))
  on('state.get', async (_, e) => ({ value: w.state.get(at(e)) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
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
  // The engine's end step: what session.end's next(e) runs. For an exit, nothing of the plugin's runs after it
  // but what the one short bound still allows (claude-code.d.ts SessionEndInput).
  on('session.end', (_, e: any) => { w.seenAtEnd.push([...disk.keys()]); return { sessionId: e.sessionId } as never })
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
// A new process for session `sid`: a fresh $.state, then session.start.
const restart = async ($: $T, w: W, sid = w.sid) => { w.state.clear(); w.sid = sid; await start($) }
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
const files = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }

// A real session.end (SessionEndInput): for a /clear or an in-process /resume the process goes on under another id
// with a fresh state (the model every review test here uses); for an exit it does not.
const end = ($: $T, w: W, reason: 'clear' | 'resume' | 'prompt_input_exit') =>
  $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } })
const endTo = async ($: $T, w: W, reason: 'clear' | 'resume', sid: string) => { await end($, w, reason); w.state.clear(); w.sid = sid }

// E1 (kind 4, the engine's real end): the person exits (SessionEndReason prompt_input_exit) while the last edit's
// copy is being written to the store (store.set of changes:s1 in flight). session.end's hook does not wait for the
// queued save: it returns next(e) at once, and the engine's end step runs with the store not yet holding the
// edit. claude-code.d.ts 'session.end': the end step is next(e); "Exits stay fast whatever is loaded: the whole
// chain shares one short wall-clock bound"; its own example saves inside the hook, `await save(next.budget), next(e)`;
// SessionEndInput: "at it `next.signal` aborts, a `$` call in flight with it; only a process a command let go of
// outlives it". So what the end step does not yet see is what the exiting process may never write. review-end9 X1
// is green only because the test keeps running after the end step, which an exiting process does not.
// The hold is let go 30 ms after the write reached the store, so a hook that waits for its save (bounded) ends too.
const exitDuringWrite = async ($: $T, w: W, exitInside: boolean) => {
  await start($); await settle()
  let release!: () => void, reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  w.holdStoreSet = { key: 'changes:s1', reached, p: new Promise<void>(r => { release = r }) }
  const editing = edit($, 'a.txt', 'one', 'ONE')
  await at                                   // the list holds a.txt; its copy's store.set is in flight
  setTimeout(release, 30)
  if (exitInside) await end($, w, 'prompt_input_exit')
  await editing; await settle()
  if (!exitInside) await end($, w, 'prompt_input_exit')
}
test('review-undo11 E1: an exit while the last edit\'s copy is being written, the engine\'s end step already sees changes:s1 in the store', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await exitDuringWrite($, w, true)
  expect(w.seenAtEnd.length).toBe(1)
  expect(w.seenAtEnd[0]).toContain('changes:s1')
})
test('review-undo11 E1 comparison: the exit after the write settled, the end step sees changes:s1 in the store', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await exitDuringWrite($, w, false)
  expect(w.seenAtEnd.length).toBe(1)
  expect(w.seenAtEnd[0]).toContain('changes:s1')
})

// V1 (kind 1, a regression of 4d5e8a2): a process starts (session.start's restore finds no copy, so `restored` is the
// new id) and the person /clears or /resumes before any edit. mirrorEnding now queues a save of the empty list,
// which writes `changes:<id> = []` and `at:<id>`, and save()'s eviction then keeps only the KEEP - 1 = 4 newest
// other copies (common.tsx:97). Five such starts, and the one conversation that holds edits is evicted, though
// nothing with edits was ever written: before this commit a conversation with no edits wrote no copy. README:
// the store keeps the list "for the 5 sessions written most recently".
const freshStartsThenLeave = async ($: $T, w: W, n: number, by: 'clear' | 'resume' | 'prompt_input_exit') => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()  // s1's copy: a.txt
  for (let k = 2; k <= n + 1; k++) {
    await restart($, w, `s${k}`); await settle()         // a new process, no edits
    if (by === 'prompt_input_exit') await end($, w, by)
    else await endTo($, w, by, `t${k}`)                   // /clear, or /resume to another conversation
    await settle()
  }
}
test('review-undo11 V1: five new processes each left by /clear with no edit, s1\'s stored copy still holds a.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await freshStartsThenLeave($, w, 5, 'clear')
  expect(files(w, 'changes:s1')).toEqual(['a.txt'])
})
test('review-undo11 V1 comparison: five new processes each left by /exit with no edit, s1\'s stored copy holds a.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await freshStartsThenLeave($, w, 5, 'prompt_input_exit')
  expect(files(w, 'changes:s1')).toEqual(['a.txt'])
})
test('review-undo11 V1b: five new processes each left by /resume with no edit, then s1 resumed in a new process lists a.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await freshStartsThenLeave($, w, 5, 'resume')
  await restart($, w, 's1'); await settle()
  expect(await undo($, '')).toContain('a.txt')
})
test('review-undo11 V1b comparison: four such processes, s1 resumed in a new process lists a.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await freshStartsThenLeave($, w, 4, 'resume')
  await restart($, w, 's1'); await settle()
  expect(await undo($, '')).toContain('a.txt')
})
test('review-undo11 V1c: one new process left by /clear with no edit writes no copy of an empty list', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await freshStartsThenLeave($, w, 1, 'clear')
  expect([...w.disk.keys()].filter(k => k.endsWith(':s2'))).toEqual([])
})
test('review-undo11 V1c comparison: one new process left by /exit with no edit writes no copy', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await freshStartsThenLeave($, w, 1, 'prompt_input_exit')
  expect([...w.disk.keys()].filter(k => k.endsWith(':s2'))).toEqual([])
})
test('review-undo11 E1b: an exit while a copy\'s write never lands still reaches the end step, within about a second', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await start($); await settle()
  let reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  w.holdStoreSet = { key: 'changes:s1', reached, p: new Promise<void>(() => {}) }
  void edit($, 'a.txt', 'one', 'ONE')
  await at
  const t0 = Date.now()
  await end($, w, 'prompt_input_exit')
  expect(w.seenAtEnd.length).toBe(1)
  expect(Date.now() - t0).toBeLessThan(2000)
})
