import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Review of 349506c: the world is review-undo16's, so the two files read alike.
type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
type Hold = { reached: () => void; p: Promise<void> }

const world = (on: On, files0: Record<string, string>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = {
    files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
    trace: [] as string[],
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  // The engine's clock: a real wait (the test kit answers none), so a bounded wait for a held save ends.
  on('clock.sleep', (_, e) => new Promise(r => setTimeout(() => r({ value: undefined }), e.ms)) as never)
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
    if (e.key.startsWith('changes:')) w.trace.push(`${e.key} <- ${(e.value as { list: { file: string }[] }).list.map(c => c.file.split('/').pop()).join(',')}`)
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => { disk.delete(e.key); return { value: undefined } as never })
  on('store.keys', () => ({ value: [...disk.keys()] }) as never)
  on('session.end', async (_, e: any) => ({ sessionId: e.sessionId }) as never)
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => { const t = files.get(e.path); if (t === undefined) throw new Error('ENOENT'); return { value: t } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('tool.call', (_, e) => {
    const x = e as unknown as { file_path: string; old_string: string; new_string: string }
    const was = files.get(x.file_path)!
    files.set(x.file_path, was.replace(x.old_string, x.new_string))
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
const files = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }
const hold = () => {
  let release!: () => void, reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  const p = new Promise<void>(r => { release = r })
  return { reached, p, release, at }
}
const endTo = async ($: $T, w: W, reason: 'clear' | 'resume', sid: string) => {
  await $.session.end({ reason, sessionId: w.sid, resume: { id: w.sid } }); w.state.clear(); w.sid = sid
}
const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' }

// X1 (kind 1, out of order). CHANGELOG 0.2.2: "once a late write lands the list is saved again, so the newest copy
// is written last". a's copy write is held; b's save passes it at 1 s (common.tsx after(), late) and writes [a, b];
// a /clear follows: mirrorEnding(s1) chains on `saving`, which no longer holds a's write, so its copy [a, b] is
// written at once. a's write lands at 1.3 s over it. The promised fresh save (prev.then(() => mirror($))) runs
// save() under the new id s2 and its owner guard returns (common.tsx save(): restored !== id && id !== ended):
// s1's copy ends as [a]; b leaves the undo list though its own write landed.
const passedByThenClear = async ($: $T, w: W, lands: number, editAfter: boolean) => {
  await start($); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const ea = edit($, 'a.txt', 'one', 'ONE'); await h.at
  setTimeout(h.release, lands)
  await edit($, 'b.txt', 'x', 'y')
  await endTo($, w, 'clear', 's2')
  if (editAfter) await edit($, 'c.txt', 'k', 'K')
  await ea; await settle(); await settle(); await settle()
}
test('review-undo17 X1: a\'s copy write lands at 1.3 s, b passed it at 1 s, a /clear came between: s1\'s copy holds a and b', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await passedByThenClear($, w, 1300, false)
  expect(w.trace.join(' | ')).toContain('changes:s1 <- a.txt,b.txt')
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo17 X1 comparison: a\'s write lands at 0.3 s, then the /clear: s1\'s copy holds a and b', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await passedByThenClear($, w, 300, false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo17 X1b: the same, s2 edits c before a lands: the fresh save writes s2\'s copy, s1\'s still holds a and b', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await passedByThenClear($, w, 1300, true)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})

// X2 (kind 1, out of order). The /clear comes at 0.4 s, while b's save is still in its one-second wait for a's
// held write: a is not passed by yet when mirrorEnding(s1) is queued, so a wait that reads the passed-by writes
// at that moment misses it, the ending copy [a, b] is written once b's save is done, and a's write lands over it.
const clearDuringWait = async ($: $T, w: W, lands: number) => {
  await start($); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const ea = edit($, 'a.txt', 'one', 'ONE'); await h.at
  setTimeout(h.release, lands)
  const eb = edit($, 'b.txt', 'x', 'y')
  await new Promise<void>(r => setTimeout(r, 400))
  await endTo($, w, 'clear', 's2')
  await ea; await eb; await new Promise<void>(r => setTimeout(r, 500)); await settle(); await settle()
}
test('review-undo17 X2: a /clear during b\'s wait, a\'s write lands at 1.3 s: s1\'s copy holds a and b', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await clearDuringWait($, w, 1300)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo17 X2 comparison: the same /clear, a\'s write lands at 0.2 s: s1\'s copy holds a and b', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await clearDuringWait($, w, 200)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
