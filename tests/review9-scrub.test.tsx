// Review of 8cf2d41..758dd48 (restore()'s rollback after a /clear in the gap): the races the engine's
// declarations allow beyond tests/review6-gap, review7-mirror and review7-ts-gap. World copied from
// review7-ts-gap.test.tsx (gate: the second id check waits; armed: a /clear lands at the first check).
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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
    refuseSets: false,
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
    if (w.refuseSets) throw new Error('store over 4 MiB')
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
  shape: 'changes-3',
  list: Array.from({ length: n }, (_, k) => ({
    n: k + 1, at: '2026-11-02T10:00:00.000Z', tool: 'Edit', file: `${ROOT}/${file}`,
    hunks: [{ before: ['x'.repeat(width)], after: ['y'.repeat(width)], line: 1 }],
  })),
})
const files = (w: W, key: string) => ((w.disk.get(key) as { list: ({ file: string } | null)[] } | undefined)?.list ?? []).map(c => c?.file.split('/').pop())
const tick = () => new Promise<void>(r => setTimeout(r, 0))

// Review of 8cf2d41..186c202 (scrub()): the store conditions the repo itself models (a read refused once,
// EBUSY, retried in restore() and copies()) against scrub()'s single get and bare catch.
const endTo = async ($: $T, w: W, reason: 'clear' | 'resume', sid: string) => {
  await $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } })
  w.state.clear(); w.sid = sid
}
const openGap = async ($: $T, w: W) => {
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  let open!: () => void
  w.gate = new Promise<void>(r => { open = r })
  w.clearAtCheck = 'after'
  await restart($, w)
  await tick(); await tick()
  expect(w.sid).toBe('s2')
  return open
}

// S1: F1's world (edit in the window, then a second /clear) with the one read of changes:s2 that scrub()
// makes refused once, as review3 F1 models a busy store file. restore() and copies() try again; scrub() does not.
const busyScrub = async ($: $T, w: W, busyOnce: boolean) => {
  const open = await openGap($, w)
  await edit($, 'c.txt', 'p', 'q')          // s2's mirror copied [a, b, c] under changes:s2
  await endTo($, w, 'clear', 's3')
  if (busyOnce) { w.failGet = 'changes:s2'; w.failGetLeft = 1 }
  open(); await tick(); await tick(); await tick()
}
test('review-undo9 S1: scrub\'s one read of changes:s2 refused once, the copy keeps the old conversation\'s a.txt and b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await busyScrub($, w, true)
  expect(w.failGet).toBeUndefined() // the refusal was spent on scrub's read
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
})
test('review-undo9 S1 comparison: no refusal, the copy of s2 holds only c.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await busyScrub($, w, false)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
})
test('review-undo9 S1b: then s2 resumed in a new process lists the old conversation\'s b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await busyScrub($, w, true)
  await restart($, w, 's2'); await tick(); await tick()
  expect(await undo($, '')).not.toContain('b.txt')
})

// S2: a stored list with one element that is not an object (restore() at common.tsx:133 skips such an
// element; scrub() casts the list and entryKey reads `.n` of it). Seeded into changes:s2 after s2's own
// mirror and before scrub reads it (onSetAt counts store.set calls: at:s2, changes:s2 are s2's mirror).
const nullInCopy = async ($: $T, w: W, seedNull: boolean) => {
  const open = await openGap($, w)
  await edit($, 'c.txt', 'p', 'q')
  await endTo($, w, 'clear', 's3')
  if (seedNull) {
    const got = w.disk.get('changes:s2') as { shape: string; list: unknown[] }
    w.disk.set('changes:s2', { shape: got.shape, list: [null, ...got.list] })
  }
  open(); await tick(); await tick(); await tick()
}
test('review-undo9 S2: a null element in the copy of s2, scrub leaves the old conversation\'s entries in it', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await nullInCopy($, w, true)
  expect(files(w, 'changes:s2').filter(Boolean)).toEqual(['c.txt'])
})
test('review-undo9 S2 comparison: no such element, the copy of s2 holds only c.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await nullInCopy($, w, false)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
})
