// A /clear that lands after restore()'s id check answered the old id and before the list update reads the state.
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Loop 2 review of 31293d7..fc30a9b. World copied from review3-resume.test.tsx, plus a held store
// read (hold) and a hook on the Nth read of `sessions` (onSessionsGetAt).
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
  const statuses: string[] = []
  const w = {
    statuses, files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    failGet: undefined as string | undefined,
    failGetLeft: 0,
    onSessionsGet: undefined as (() => void) | undefined,
    hold: undefined as { key: string; p: Promise<void> } | undefined,
    sessionsGets: 0,
    onSessionsGetAt: undefined as { n: number; f: () => void } | undefined,
    sets: 0,
    onSetAt: undefined as { n: number; f: () => void } | undefined,
    clearAtCheck: undefined as undefined | 'before' | 'after',
    armed: false,
    gate: undefined as Promise<void> | undefined,
    gated: false,
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('session.id', async () => {
    if (w.gated) { w.gated = false; const g = w.gate; w.gate = undefined; if (g) await g }
    const v = w.sid
    if (w.armed) {
      w.armed = false
      const m = w.clearAtCheck; w.clearAtCheck = undefined
      w.state.clear(); w.sid = 's2' // /clear lands at restore()'s id check
      if (w.gate) w.gated = true // hold the next id call: restore()'s second check
      return { value: m === 'after' ? v : w.sid }
    }
    return { value: v }
  })
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
    if (w.hold && w.hold.key === e.key) { const h = w.hold; w.hold = undefined; await h.p }
    if (w.failGet === e.key) { if (--w.failGetLeft <= 0) w.failGet = undefined; throw new Error('EBUSY: store file locked') }
    const v = disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined
    if (e.key === 'changes:s1' && w.clearAtCheck) w.armed = true
    if (e.key === 'sessions' && w.onSessionsGet) { const f = w.onSessionsGet; w.onSessionsGet = undefined; f() }
    if (e.key === 'sessions' && ++w.sessionsGets === w.onSessionsGetAt?.n) { const f = w.onSessionsGetAt.f; w.onSessionsGetAt = undefined; f() }
    return { value: v } as never
  })
  on('store.set', (_, e) => {
    if (++w.sets === w.onSetAt?.n) { const f = w.onSetAt.f; w.onSetAt = undefined; f() }
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

const stored = (file: string, n: number, width: number) => ({
  shape: 'changes-2',
  list: Array.from({ length: n }, (_, k) => ({
    n: k + 1, at: '2026-11-02T10:00:00.000Z', tool: 'Edit', file: `${ROOT}/${file}`,
    hunks: [{ before: ['x'.repeat(width)], after: ['y'.repeat(width)], line: 1 }],
  })),
})
const files = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
const tick = () => new Promise<void>(r => setTimeout(r, 0))



// A real /clear: session.end for the old id (SessionEndInput, reason clear), then a new id and an empty state.
const clearTo = async ($: $T, w: W, sid: string) => {
  await $.session.end({ reason: 'clear', sessionId: w.sid, resume: { id: w.sid } })
  w.state.clear(); w.sid = sid
}


// The /clear lands at restore()'s first id check (answered the old id); the old list goes into s2's
// state; s2's own first edit is recorded and mirrored before restore()'s second id check answers.
const raced = async ($: $T, w: W, editInsideWindow: boolean) => {
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  let open!: () => void
  w.gate = new Promise<void>(r => { open = r })
  w.clearAtCheck = 'after'
  await restart($, w)
  await tick(); await tick()
  expect(w.sid).toBe('s2')
  if (!editInsideWindow) { open(); await tick(); await tick() }
  await edit($, 'c.txt', 'p', 'q')
  open(); await tick(); await tick()
}

test('review-ts R1: s2 edit mirrored inside the second-check window, the store copy of s2 holds only its own edit', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await raced($, w, true)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
})
test('review-ts R1 comparison: second check answered before the s2 edit, the store copy of s2 holds only its own edit', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await raced($, w, false)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
})
test('review-ts R1b: then s2 resumed in a new process, its list does not name the old conversation\'s b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await raced($, w, true)
  await restart($, w, 's2'); await tick(); await tick()
  expect(await undo($, '')).not.toContain('b.txt')
})
test('review-ts R1b comparison: no race, s2 resumed lists only its own edit', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await raced($, w, false)
  await restart($, w, 's2'); await tick(); await tick()
  expect(await undo($, '')).not.toContain('b.txt')
})
// Numbers are kept when entries leave, so the raced edit keeps the #3 it got.
test('review-ts R1c: the s2 edit raced inside the window keeps its number in the new conversation', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await raced($, w, true)
  expect(await undo($, '')).toMatch(/(^|\n)\s*#?3\b[^\n]*c\.txt/)
})
