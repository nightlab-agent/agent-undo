// typescript-reviewer on 4d5e8a2..86fcca4 (0.2.2): restore()'s bounded wait (common.tsx:171) when the clock is refused.
// World copied from review-undo13.test.tsx (clock: false = no clock.sleep hook, the kit refuses the sleep).
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
type Hold = { reached: () => void; p: Promise<void> }

const world = (on: On, files0: Record<string, string>, opts: { clock?: boolean } = {}) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = {
    files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
    sleeps: 0, probe: [] as string[],
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  if (opts.clock !== false) on('clock.sleep', (_, e) => { w.sleeps++; return new Promise(r => setTimeout(() => r({ value: undefined }), e.ms)) as never })
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
  on('session.end', (_, e: any) => ({ sessionId: e.sessionId }) as never)
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', (_, e) => { const t = String((e as { text?: unknown }).text); if (t.startsWith('probe:')) w.probe.push(t); return { value: undefined } as never })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => { const t = files.get(e.path); if (t === undefined) throw new Error('ENOENT'); return { value: t } })
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
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }
const end = ($: $T, w: W, reason: 'clear' | 'resume' | 'prompt_input_exit') =>
  $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } })
const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' }
const timeout = (ms: number) => new Promise<string>(r => setTimeout(() => r('still waiting'), ms))

// R1 (kind 1, a wait with no end): restore() calls saved($, 1000) with no signal (common.tsx:171). With clock.sleep
// refused (no hook answers it: this kit, or a mod above that denies it) `bound` never resolves (common.tsx:92: a
// refusal resolves it only when the signal aborted, and there is none), so the wait is the whole queue, and a hung
// write holds it. restoreList caches that never-settling restore in `restoring` (common.tsx:143-158), so the hook's
// budget ending one caller frees none of the later ones: /agent-undo, and every Edit and Write behind it in serial().
// The saved() comment (common.tsx:87-89) says the hook's budget is then the cap; here nothing is.
const clearThenList = async ($: $T, w: W, stuck: boolean) => {
  await start($); await settle()
  let reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  if (stuck) w.holdStoreSet = { key: 'changes:s1', reached, p: new Promise<void>(() => {}) }
  const ea = edit($, 'a.txt', 'one', 'ONE')
  if (stuck) await at; else { await ea; await settle() }
  // The /clear's session.end: its own wait (saved() with next.signal) ends in the engine at the chain's wall-clock
  // cut (NextBudget.ms, session.end); this kit's root dispatch has no cut, so the end step is stood in for here:
  // the hook has run mirrorEnding and forgetRestore by its first tick, then the world swaps the conversation.
  const ending = end($, w, 'clear'); await settle(); w.state.clear(); w.sid = 's2'
  const endedBy = await Promise.race([ending.then(() => 'ended'), timeout(1500)])
  const listed = await Promise.race([undo($, '').then(() => 'answered'), timeout(2000)])
  // A second caller after the first timed out: the cached restore still holds it.
  const listedAgain = await Promise.race([undo($, '').then(() => 'answered'), timeout(300)])
  void edit($, 'b.txt', 'x', 'y'); await timeout(300)
  return { endedBy, listed, listedAgain, b: w.files.get(`${ROOT}/b.txt`) }
}
test('review-undo14ts R1: clock refused, /clear while s1\'s copy write hangs: /agent-undo in s2 answers and the next Edit writes its file', async ($, on) => {
  const w = world(on, all, { clock: false })
  const got = await clearThenList($, w, true)
  // C1, documented at common.tsx:87-89: with the clock refused the end's own wait ends only at the chain's abort.
  expect(got.endedBy).toBe('still waiting')
  expect({ listed: got.listed, listedAgain: got.listedAgain, b: got.b }).toEqual({ listed: 'answered', listedAgain: 'answered', b: 'y\n' })
})
test('review-undo14ts R1 comparison a: clock answers, the same /clear with the hung write: answered within the second', async ($, on) => {
  const w = world(on, all)
  expect(await clearThenList($, w, true)).toEqual({ endedBy: 'ended', listed: 'answered', listedAgain: 'answered', b: 'y\n' })
})
test('review-undo14ts R1 comparison b: clock refused, the write landed before the /clear: answered', async ($, on) => {
  const w = world(on, all, { clock: false })
  expect(await clearThenList($, w, false)).toEqual({ endedBy: 'ended', listed: 'answered', listedAgain: 'answered', b: 'y\n' })
})

// Probe (not a finding): what the hooks environment has for a timer of its own, read from inside the hooks module
// (a temporary status line in register.tsx), against the comment at common.tsx:87 ("no setTimeout in its environment").
test('review-undo14ts probe: the hooks module reports its own globals', async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  expect(w.probe.length).toBeGreaterThanOrEqual(0)
  console.log('PROBE', JSON.stringify(w.probe))
})
