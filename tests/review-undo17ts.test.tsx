// Review of 743276a..349506c: the save that passes a held write (common.tsx after(), the `late` branch) is
// followed by a fresh mirror() once that write lands; but save() writes nothing once the conversation has ended
// (restored !== id && id !== ended), so a held write that lands after a /clear is the last write of the ending copy.
// World copied from tests/review-undo16.test.tsx.
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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
    if (e.key === 'changes:s1') w.trace.push(`set ${(e.value as { list: { file: string }[] }).list.map(c => c.file.split('/').pop()).join(',')}`)
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
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
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
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const hold = () => {
  let release!: () => void, reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  const p = new Promise<void>(r => { release = r })
  return { reached, p, release, at }
}
const endTo = async ($: $T, w: W, sid: string) => {
  await $.session.end({ reason: 'clear', sessionId: w.sid, resume: { id: w.sid } })
  w.state.clear(); w.sid = sid
}
const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n' }

// T1 (kind 1, interleaved awaits): a saved, b's copy write held, c's save passes it at 1 s and writes [a, b, c];
// a /clear at 1.1 s writes the ending copy [a, b, c]; b's write lands at 1.3 s as [a, b]. The follow-up mirror()
// runs under s2 and save() returns before writing, so s1's copy ends [a, b]: c left the undo list of s1.
const lateAfterClear = async ($: $T, w: W, lands: number) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE'); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const eb = edit($, 'b.txt', 'x', 'y'); await h.at
  const ec = edit($, 'c.txt', 'k', 'K')
  setTimeout(h.release, lands)
  await sleep(1100)
  await endTo($, w, 's2')
  await eb; await ec; await sleep(500); await settle(); await settle()
}
test('review-undo17ts T1: b\'s copy write lands at 1.3 s, c saved and a /clear at 1.1 s meanwhile: s1\'s copy still holds a, b and c', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await lateAfterClear($, w, 1300)
  expect(w.trace.join(' | ')).toContain('set a.txt,b.txt,c.txt')
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})
test('review-undo17ts T1 comparison: b\'s write lands at 0.3 s, then the same /clear at 1.1 s: s1\'s copy holds a, b and c', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await lateAfterClear($, w, 300)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt', 'c.txt'])
})
