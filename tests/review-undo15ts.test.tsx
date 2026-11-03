// typescript-reviewer on c2c7c1e..39386d1 (0.2.2): restore()'s late path (common.tsx:187-188), the end's record wait
// The `late` flag was removed after this review (a design choice, common.tsx restore()); the tests below hold the result.
// (common.tsx:100-105, 262-269) and the Bash record window (shell.tsx:252-283). World copied from review-undo14.test.tsx.
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { ROOT as RROOT, bash, repoWorld, start as rstart } from './world'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
type Hold = { reached: () => void; p: Promise<void> }

const stateWorld = (on: On, opts: { clock?: boolean; swapAtEnd?: string; noStatus?: boolean } = {}) => {
  const disk = new Map<string, unknown>()
  const statuses: string[] = []
  const w = {
    statuses, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
    trace: [] as string[],
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  if (opts.clock !== false) on('clock.sleep', (_, e) => new Promise(r => setTimeout(() => r({ value: undefined }), e.ms)) as never)
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
    if (e.key.startsWith('changes:')) w.trace.push(`set ${e.key} ${(e.value as { list: { file: string }[] }).list.map(c => c.file.split('/').pop()).join(',')}`)
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => { disk.delete(e.key); return { value: undefined } as never })
  on('store.keys', () => ({ value: [...disk.keys()] }) as never)
  on('session.end', async (_, e: any) => {
    if (opts.swapAtEnd) { w.trace.push(`swap to ${opts.swapAtEnd}`); w.state.clear(); w.sid = opts.swapAtEnd }
    return { sessionId: e.sessionId } as never
  })
  if (!opts.noStatus) on('ui.status', (_, e) => { statuses.push(String((e as { text?: unknown }).text)); return { value: undefined } as never })
  return w
}

const fsWorld = (on: On, files0: Record<string, string>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
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
  return files
}
type W = ReturnType<typeof stateWorld>

const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
const files = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const hold = () => {
  let release!: () => void, reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  const p = new Promise<void>(r => { release = r })
  return { reached, p, release, at }
}
const end = ($: $T, w: W, reason: 'clear' | 'resume' | 'prompt_input_exit') =>
  $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } })
const endTo = async ($: $T, w: W, reason: 'clear' | 'resume', sid: string) => { await end($, w, reason); w.state.clear(); w.sid = sid }
const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' }

// L1 (kind 1/5, the late path): review-undo14 R2's flow, the copy write ([a, b]) landing after restore()'s second
// while c was recorded meanwhile (n = 1 in the empty list). The comment at common.tsx:185-186 and the CHANGELOG say
// the copy "is read once it has" landed; the read happens (common.tsx:190) but the merge at common.tsx:219-220
// refuses it (a.n = 1 is not below c.n = 1), `may` stays false, so the list never shows a or b and, with `restored`
// never set (common.tsx:114, 159), c and every later edit are never written to s1's copy.
const lateLanding = async ($: $T, w: W, lands: number) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const eb = edit($, 'b.txt', 'x', 'y'); await h.at         // b's save is at its store.set of changes:s1 = [a, b]
  await endTo($, w, 'clear', 's2')                           // the end's own bound (1 s) passes, the write still held
  await endTo($, w, 'resume', 's1')
  const ec = edit($, 'c.txt', 'k', 'K'); await settle()      // restore(s1) is waiting for the queue, c behind it
  setTimeout(h.release, lands)
  await eb; await ec; await settle(); await settle()
  const listed = await undo($, '')
  await edit($, 'a.txt', 'ONE', 'TWO'); await settle(); await settle()   // one more edit after the landing
  return { listed, copy: files(w, 'changes:s1') }
}
// The design choice (common.tsx restore()): past the second the copy is read as it stands and this conversation's
// edits are stored from then on; b, carried only by the write that lands late, leaves the undo list (its file keeps it).
test('review-undo15ts L1 (design choice): the copy write lands at 1.3 s after c was recorded: the copy holds c and the later edit, not b', async ($, on) => {
  const w = stateWorld(on); fsWorld(on, all)
  const got = await lateLanding($, w, 1300)
  expect(got.listed).not.toContain('b.txt')
  expect(got.copy).toEqual(['a.txt', 'c.txt', 'a.txt'])
})
test('review-undo15ts L1 comparison: the copy write lands at 0.3 s (inside the second): b.txt listed, the copy holds a, b, c, a', async ($, on) => {
  const w = stateWorld(on); fsWorld(on, all)
  const got = await lateLanding($, w, 300)
  expect(got.listed).toContain('b.txt')
  expect(got.copy).toEqual(['a.txt', 'b.txt', 'c.txt', 'a.txt'])
})

// B1 (kind 1, the record window for a Bash command): beginRecord() runs at updateList (common.tsx:262); for a Bash
// command the tool result is in, then shell.tsx:270-281 snapshots the repo (git add, write-tree, diff-tree) before
// record(). A /clear in that window: the end's wait (shell.tsx:316) finds recording = 0 and the queue still, and
// returns true at once; the end step swaps the conversation; the record then lands in s2's list and s2's copy.
// Same class as review-undo14 R1, which the PR fixes for Edit and Write only.
const clearDuringSnapshot = async ($: $T, on: On, inWindow: boolean) => {
  const w = stateWorld(on, { swapAtEnd: 's2', noStatus: true })
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  const h = hold()
  repo.onAdd = async n => { if (inWindow && n === 2) { h.reached(); await h.p } }   // the second add: the snapshot after the command
  await rstart($); await settle()
  const eb = bash($, repo, 'sh tidy.sh', f => f.set(`${RROOT}/a.txt`, 'a2\n'))
  if (inWindow) await h.at; else { await eb; await settle() }
  const ending = end($, w, 'clear'); await tick()
  if (inWindow) setTimeout(h.release, 30)
  await ending; await eb; await settle(); await settle()
  return { s1: files(w, 'changes:s1'), s2: files(w, 'changes:s2'), adds: repo.adds }
}
test('review-undo15ts B1: /clear while the Bash command\'s after-snapshot runs: s1\'s copy holds the command', async ($, on) => {
  const got = await clearDuringSnapshot($, on, true)
  expect(got.adds).toBe(2)
  expect(got).toMatchObject({ s1: ['sh tidy.sh'], s2: [] })
})
test('review-undo15ts B1 comparison: the command recorded before the /clear, s1\'s copy holds it', async ($, on) => {
  const got = await clearDuringSnapshot($, on, false)
  expect(got).toMatchObject({ s1: ['sh tidy.sh'], s2: [] })
})

// D1 (kind 1, the race at common.tsx:95 with the sleep refused): a new process resumes s1 whose copy is stored; with
// no clock the kit refuses the sleep, `bound` resolves at once (no signal, common.tsx:93), and whichever of quiet()
// and bound settles first decides whether the copy is read or restore() gives up (late set, common.tsx:188).
const resumeStored = async ($: $T, w: W) => {
  w.disk.set('at:s1', 1)
  w.disk.set('changes:s1', { shape: 'changes-2', list: [{ n: 1, at: '2026-11-03T00:00:00.000Z', tool: 'Edit', file: `${ROOT}/a.txt`, hunks: [] }] })
  await start($); await settle(); await wait(50)
  return w.statuses.filter(s => s.startsWith('#'))
}
test('review-undo15ts D1: clock refused, a new process resuming s1 names the stored newest change on the status line', async ($, on) => {
  const w = stateWorld(on, { clock: false }); fsWorld(on, all)
  expect(await resumeStored($, w)).toEqual(['#1 a.txt (0 hunks) · /agent-undo'])
})
test('review-undo15ts D1 comparison: with a clock, the status line names it', async ($, on) => {
  const w = stateWorld(on); fsWorld(on, all)
  expect(await resumeStored($, w)).toEqual(['#1 a.txt (0 hunks) · /agent-undo'])
})
