// Review of 8cf2d41..758dd48 (restore()'s rollback after a /clear in the gap): the races the engine's
// declarations allow beyond tests/review6-gap, review7-mirror and review7-ts-gap. World copied from
// review7-ts-gap.test.tsx (gate: the second id check waits; armed: a /clear lands at the first check).
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { tempTools } from './temp-tools'

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
  tempTools(on, files)
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
const files = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
const tick = () => new Promise<void>(r => setTimeout(r, 0))




// A real /clear or in-process /resume: session.end for the old id (SessionEndInput), then another id.
// The engine's state is "held by the host for the session" (index.d.ts store/state docs); the repo's
// tests model an id change as a fresh state (review6-gap clearTo), and so does this one.
const endTo = async ($: $T, w: W, reason: 'clear' | 'resume', sid: string) => {
  await $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } })
  w.state.clear(); w.sid = sid
}

// The /clear lands at the first check; the old list is in s2's state; the second check waits on the gate.
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

// F1 (kind 1, a second /clear): s2 edits in the window (its mirror copies the old entries into changes:s2),
// then /clear again before the rollback's id check answers. The rollback filters s3's empty state and
// mirror() writes under s3 (nothing: restored is s2), so changes:s2 keeps the old conversation's entries.
const twoClears = async ($: $T, w: W, secondClear: boolean) => {
  const open = await openGap($, w)
  await edit($, 'c.txt', 'p', 'q')
  if (secondClear) await endTo($, w, 'clear', 's3')
  open(); await tick(); await tick(); await tick()
}
test('review-undo7 F1: edit in the window then a second /clear, the store copy of s2 holds only its own edit', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await twoClears($, w, true)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
})
test('review-undo7 F1 comparison: edit in the window, no second /clear, the store copy of s2 holds only its own edit', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await twoClears($, w, false)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
})
test('review-undo7 F1b: then s2 resumed in a new process does not list the old conversation\'s b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await twoClears($, w, true)
  await restart($, w, 's2'); await tick(); await tick()
  expect(await undo($, '')).not.toContain('b.txt')
})
test('review-undo7 F1b comparison: no second /clear, s2 resumed lists only its own edit', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await twoClears($, w, false)
  await restart($, w, 's2'); await tick(); await tick()
  expect(await undo($, '')).not.toContain('b.txt')
})

// F2 (kind 3, the comparison key): in the window the new conversation sees the old list and undoes #2.
// The undo marks the hunk undone, so the entry's JSON no longer equals the taken one and the rollback
// (common.tsx: `mine.has(entryKey(c))`) keeps it: s2 lists and stores the old conversation's b.txt.
const undoInWindow = async ($: $T, w: W, inside: boolean) => {
  const open = await openGap($, w)
  if (!inside) { open(); await tick(); await tick() }
  const said = await undo($, '2')
  if (inside) { open(); await tick(); await tick() }
  return said
}
test('review-undo7 F2: an undo of an old entry inside the window, the rollback still takes it out of s2\'s list', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n' })
  await undoInWindow($, w, true)
  expect(await undo($, '')).not.toContain('b.txt')
  expect(files(w, 'changes:s2')).toEqual([])
})
test('review-undo7 F2 comparison: the same undo after the rollback finds no such entry; s2 lists and stores none', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n' })
  const said = await undoInWindow($, w, false)
  expect(said).toContain('no edit')
  expect(await undo($, '')).not.toContain('b.txt')
  expect(files(w, 'changes:s2')).toEqual([])
})

// F3 (store write failing): the rollback's mirror hits a store that refuses every write; no stale copy of s2 stays.
const failingStore = async ($: $T, w: W, failAfterRollback: boolean) => {
  const open = await openGap($, w)
  await edit($, 'c.txt', 'p', 'q')          // s2's mirror copied [a, b, c] under changes:s2
  if (failAfterRollback) w.refuseSets = true
  open(); await tick(); await tick(); await tick()
}
test('review-undo7 F3: the rollback\'s mirror refused by the store, changes:s2 does not keep the old entries', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await failingStore($, w, true)
  expect(files(w, 'changes:s2')).not.toContain('b.txt')
})
test('review-undo7 F3 comparison: the store accepts the write, changes:s2 holds only c.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n' })
  await failingStore($, w, false)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
})

// F4 (kind 1, an id that comes back): s1 restored in this process, /clear to s2, then an in-process
// /resume of s1 (SessionEndReason 'resume': "another took its place"; no session.start fires). The
// module-level `restoring.id === s1` short-circuits the restore, and `restored === s1` lets the next
// edit's mirror write a one-entry list over s1's stored two.
const backToS1 = async ($: $T, w: W, viaNewProcess: boolean) => {
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  await endTo($, w, 'clear', 's2')
  // No edit in s2: restoring and restored still say s1 (an s2 edit would replace them and hide this).
  if (viaNewProcess) await restart($, w, 's1')
  else await endTo($, w, 'resume', 's1')
  await tick(); await tick()
  await edit($, 'd.txt', 'k', 'K')
  await tick()
}
test('review-undo7 F4: /clear then an in-process /resume of s1 (no s2 edit between), its list and store still hold a.txt and b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n', 'd.txt': 'k\n' })
  await backToS1($, w, false)
  expect(await undo($, '')).toContain('b.txt')
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'd.txt'])
})
test('review-undo7 F4 comparison: s1 resumed in a new process, its list and store hold a.txt and b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n', 'd.txt': 'k\n' })
  await backToS1($, w, true)
  expect(await undo($, '')).toContain('b.txt')
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'd.txt'])
})

// P1/P2 (probes of the harness's own $.state across session.end) were removed: under realState the harness
// keeps one state per test, also across a session.start, so they say nothing about the engine.

// F4b: the irreversible part. After the in-process /resume of s1 the next edit's mirror writes the
// one-entry list over s1's stored two (save(): restored === s1 still, so nothing stops the shorter write).
// Engine: code.claude.com/docs/en/plugins/mods/interface, "Load a saved value again after /clear": /clear,
// /resume and /branch reset every $.state value to its default and session.start does not fire again.
test('review-undo7 F4b: after an in-process /resume of s1, its stored copy still holds a.txt and b.txt', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n', 'd.txt': 'k\n' })
  await backToS1($, w, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'd.txt'])
})
test('review-undo7 F4b comparison: s1 resumed in a new process, its stored copy holds a.txt, b.txt and the new edit', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n', 'd.txt': 'k\n' })
  await backToS1($, w, true)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'd.txt'])
})
