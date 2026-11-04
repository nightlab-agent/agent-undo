// Additional cap boundaries and interleavings; host doubles follow review-statecap.test.tsx.
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { Change } from '../types'
import * as common from '../hooks/common'
import * as shared from '../hooks/shared'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
const BUDGET = 4_000_000
const CAP = 4_194_304
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const key = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
const stateKey = 'agent-undo/changes/'
const entry = (n: number): Change => ({ n, at: '2026-11-03T12:00:00.000Z', tool: 'Edit',
  file: `${ROOT}/${n}.txt`, hunks: [{ before: ['old'], after: ['new'], line: 1 }] })
// Pad a real hunk, so the requested size includes brackets, commas, keys and JSON escaping.
const sized = (list: Change[], chars: number): Change[] => {
  const out = clone(list)
  out[0]!.hunks[0]!.before[0] += 'x'.repeat(chars - JSON.stringify(out).length)
  return out
}

const world = (on: On) => {
  const w = { sid: 's1', files: new Map<string, string>(), disk: new Map<string, unknown>(),
    state: new Map<string, { value: unknown; version: number }>(), statuses: [] as string[],
    attempts: [] as Change[][], conflict: undefined as undefined | (() => void),
    hold: undefined as undefined | { at: () => void; wait: Promise<void> } }
  on('session.id', () => ({ value: w.sid }))
  on('state.get', (_, e) => ({ value: clone(w.state.get(key(e)) ?? { value: undefined, version: 0 }) }) as never)
  on('state.set', (_, e) => {
    if (e.key === 'changes') {
      w.attempts.push(clone((e.value as { value: Change[] }).value))
      const conflict = w.conflict; w.conflict = undefined; conflict?.()
    }
    const version = w.state.get(key(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } } as never
    w.state.set(key(e), { value: clone(e.value), version: version + 1 })
    return { value: { isSet: true, version: version + 1 } } as never
  })
  on('store.get', (_, e) => ({ value: w.disk.has(e.key) ? clone(w.disk.get(e.key)) : undefined }) as never)
  on('store.set', async (_, e) => {
    if (e.key === 'changes:s1' && w.hold) { const h = w.hold; w.hold = undefined; h.at(); await h.wait }
    w.disk.set(e.key, clone(e.value)); return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...w.disk.keys()] }) as never)
  on('store.delete', (_, e) => { w.disk.delete(e.key); return { value: undefined } as never })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e: any) => ({ sessionId: e.sessionId }) as never)
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', (_, e) => { w.statuses.push(String((e as { text?: unknown }).text)); return { value: undefined } as never })
  on('fs.exists', (_, e) => ({ value: w.files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: w.files.get(e.path)! }))
  on('fs.write', (_, e) => { w.files.set(e.path, e.text); return { value: undefined } })
  on('tool.call', (_, e) => {
    const x = e as unknown as { file_path: string; old_string: string; new_string: string }
    const was = w.files.get(x.file_path)!
    w.files.set(x.file_path, was.replace(x.old_string, () => x.new_string))
    return { result: { filePath: x.file_path, originalFile: was,
      structuredPatch: [{ newStart: 1, lines: [`-${x.old_string}`, `+${x.new_string}`] }] } } as never
  })
  return w
}
type W = ReturnType<typeof world>
const list = (w: W) => (w.state.get(stateKey)?.value as { value: Change[] }).value
const stored = (w: W) => (w.disk.get('changes:s1') as { list: Change[] }).list
const putList = (w: W, value: Change[]) => w.state.set(stateKey, { value: { shape: 'changes-2', value: clone(value) }, version: (w.state.get(stateKey)?.version ?? 0) + 1 })
const seed = (w: W, value: Change[]) => w.disk.set('changes:s1', { shape: 'changes-2', list: clone(value) })
const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const undo = async ($: $T, args = '') => (await $.command.run({ command: 'agent-undo', args } as never) as { text: string }).text
const edit = ($: $T, file = 'next.txt', text = 'NEW') => $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: 'old', new_string: text } as never)
const deferred = () => {
  let release!: () => void
  const wait = new Promise<void>(r => { release = r })
  return { release, wait }
}
const clock = (on: On) => on('clock.sleep', (_, e, next) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => resolve({ value: undefined }), e.ms)
  next.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
}) as never)

for (const count of [299, 300, 301]) test(`cap edges: ${count} small entries followed by an edit retain the newest 300`, async ($, on) => {
  const w = world(on)
  seed(w, Array.from({ length: count }, (_, k) => entry(k + 1)))
  w.files.set(`${ROOT}/next.txt`, 'old\n')
  await start($); await edit($)
  const expected = Array.from({ length: 300 }, (_, k) => count + 1 - 299 + k)
  expect(list(w).map(c => c.n)).toEqual(expected)
  expect(stored(w).map(c => c.n)).toEqual(expected)
})

for (const delta of [0, 1]) test(`cap edges: aggregate JSON at budget ${delta ? '+ 1 drops oldest' : 'keeps oldest'}`, async ($, on) => {
  const w = world(on)
  w.files.set(`${ROOT}/next.txt`, 'old\n')
  await start($); await undo($)
  // Learn the hook's actual serialized entry (not a guess about optional fields).
  await edit($)
  const newest = { ...list(w)[0]!, n: 2 }
  const initial = sized([entry(1)], BUDGET + delta - JSON.stringify(newest).length - 1)
  putList(w, initial)
  w.files.set(`${ROOT}/next.txt`, 'old\n')
  await edit($)
  expect(list(w).map(c => c.n)).toEqual(delta ? [2] : [1, 2])
  expect(JSON.stringify(list(w)).length <= BUDGET).toBe(true)
})

test('cap edges: JSON escaping and CJK use serialized characters, and trim only the oldest', async ($, on) => {
  const w = world(on)
  const old = entry(1)
  old.hunks[0]!.before = ['漢'.repeat(600_000) + '"\\\n'.repeat(100_000)]
  seed(w, sized([old, entry(2)], BUDGET))
  w.files.set(`${ROOT}/next.txt`, 'old\n')
  await start($); await edit($)
  expect(list(w).map(c => c.n)).toEqual([2, 3])
  expect(stored(w).map(c => c.n)).toEqual([2, 3])
})

test('cap edges: a failed CAS at the size cap recalculates trimming and numbering', async ($, on) => {
  const w = world(on)
  seed(w, sized([entry(1), entry(2)], BUDGET))
  w.files.set(`${ROOT}/next.txt`, 'old\n')
  await start($); await undo($)
  w.attempts.length = 0
  w.conflict = () => putList(w, [entry(2), entry(3)])
  await edit($)
  expect(w.attempts[0]!.map(c => c.n)).toEqual([2, 3])
  expect(list(w).map(c => c.n)).toEqual([2, 3, 4])
  expect(stored(w).map(c => c.n)).toEqual([2, 3, 4])
})

test('cap edges: two simultaneous edits at the size cap both survive with distinct numbers', async ($, on) => {
  const w = world(on)
  seed(w, sized([entry(1), entry(2)], BUDGET))
  for (const f of ['a.txt', 'b.txt']) w.files.set(`${ROOT}/${f}`, 'old\n')
  await start($); await undo($)
  await Promise.all([edit($, 'a.txt'), edit($, 'b.txt')])
  expect(list(w).map(c => c.n)).toEqual([2, 3, 4])
  expect(list(w).slice(1).map(c => c.file).sort()).toEqual([`${ROOT}/a.txt`, `${ROOT}/b.txt`])
  expect(stored(w)).toEqual(list(w))
})

test('cap edges: restore trims a valid old copy over the new budget; the retained edit still undoes', async ($, on) => {
  const w = world(on)
  seed(w, sized([entry(1), entry(2)], BUDGET + 100_000))
  expect(JSON.stringify(Object.fromEntries(w.disk)).length < CAP).toBe(true)
  w.files.set(`${ROOT}/2.txt`, 'new\n')
  await start($)
  expect(await undo($, '1')).toContain('no edit "1"')
  expect(await undo($, '2')).toContain('undid 2.1')
  expect(w.files.get(`${ROOT}/2.txt`)).toBe('old\n')
  expect(stored(w)[0]!.hunks[0]!.undone).toBe(true)
})

// A singleton from before the new cap can fit the engine/store yet leave no room for undo flags.
for (const chars of [BUDGET]) test(`cap edges: undo of a restored singleton of ${chars} characters records all flags`, async ($, on) => {
  const w = world(on)
  const c = entry(1)
  c.hunks = Array.from({ length: 8 }, (_, k) => ({ before: [`a${k}`], after: [`b${k}`], line: k + 1 }))
  seed(w, sized([c], chars))
  expect(JSON.stringify(Object.fromEntries(w.disk)).length < CAP).toBe(true)
  w.files.set(c.file, c.hunks.map(h => h.after[0]).join('\n') + '\n')
  await start($); await undo($)
  let error: unknown
  try { expect(await undo($, '1')).toContain('undid 1.1') } catch (e) { error = String(e) }
  console.log(`singleton ${chars}: ${error ?? 'undo answered'}; file restored: ${w.files.get(c.file)!.startsWith('a0')}; state flags: ${list(w)[0]!.hunks.filter(h => h.undone).length}; stored flags: ${stored(w)[0]!.hunks.filter(h => h.undone).length}`)
  expect(error).toBeUndefined()
  expect(list(w)[0]!.hunks.every(h => h.undone)).toBe(true)
  expect(stored(w)[0]!.hunks.every(h => h.undone)).toBe(true)
})

for (const count of [8, 9]) test(`cap edges: undo flags on ${count} entries cannot grow a fitted list past the engine limit`, { timeoutMs: 30000 }, async ($, on) => {
  const w = world(on)
  const entries = Array.from({ length: count }, (_, k) => ({ ...entry(k + 1),
    hunks: Array.from({ length: 2000 }, (_, j) => ({ before: j === 0 ? ['a0'] : [], after: [`b${j}`], line: j + 1 })) }))
  for (const c of entries) w.files.set(c.file, c.hunks.map(h => h.after[0]).join('\n') + '\n')
  seed(w, sized(entries, BUDGET))
  await start($); await undo($)
  let error: unknown
  for (const c of entries) {
    try { await undo($, String(c.n)) } catch (e) { error = `undo #${c.n}: ${String(e)}`; break }
  }
  console.log(`${count} fitted entries after undos: ${JSON.stringify(list(w)).length} characters; ${error ?? 'all answered'}; last file restored: ${w.files.get(entries.at(-1)!.file) === 'a0\n'}; last entry marked: ${list(w).at(-1)!.hunks.every(h => h.undone)}`)
  expect(error).toBeUndefined()
})

test('cap edges: a delayed grew mirror lands after undo and cannot unmark it in the final copy', { timeoutMs: 10000 }, async ($, on) => {
  const w = world(on)
  clock(on)
  await start($); await undo($)
  // A newer entry is already listed; the next restore can merge stored #1 before #2.
  seed(w, [entry(1)])
  putList(w, [entry(2)])
  w.state.delete('agent-undo/listed/')
  w.files.set(`${ROOT}/2.txt`, 'new\n')
  const reached = deferred(), held = deferred()
  w.hold = { at: reached.release, wait: held.wait }
  await start($)
  await reached.wait
  try {
    expect(await undo($)).toContain('#2 ')
    expect(await undo($, '2')).toContain('undid 2.1')
    expect(w.files.get(`${ROOT}/2.txt`)).toBe('old\n')
  } finally { held.release() }
  await ($ as any).session.end({ reason: 'exit', sessionId: 's1' })
  expect(stored(w).map(c => c.n)).toEqual([1, 2])
  expect(stored(w)[1]!.hunks[0]!.undone).toBe(true)
})

test('shared extraction: every re-export is the same helper and shared state object', () => {
  for (const name of ['editing', 'fileKey', 'inFlight', 'serial', 'slashed', 'time', 'touched', 'windows'] as const)
    expect(common[name]).toBe(shared[name])
})
