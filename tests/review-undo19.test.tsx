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
const ms = (n: number) => new Promise<void>(r => setTimeout(r, n))

const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n', 'd.txt': 'm\n', 'e.txt': 'q\n' }

// Z1 (kind 1, out of order; the self-wait in whole()). s1 edits a, then b with b's copy write held 5 s (the /clear's end and s2's restore each wait a second first). A /clear to
// s2 queues the ending copy E = whole(): saving (= b's write) then Promise.all(passed). s2 edits c: its save passes E
// at 1 s, so E goes into `passed`. When b's write lands at 5 s, E's Promise.all snapshot holds E itself: E never
// settles and stays in `passed` for good. Every later ending copy and scrub in the process waits on it. Shown with
// s2's own end: d's write held, e passes it, a /clear to s3 queues s2's ending copy [c, d, e], which never writes;
// d's write lands over it and s2's copy ends as [c, d]: e leaves the undo list, the very loss this PR fixes.
const endWhilePassed = async ($: $T, w: W, sid: string, lands: number) => {
  const h = hold(); w.holdStoreSet = { key: `changes:${sid}`, ...h }
  const ed = edit($, 'd.txt', 'm', 'M'); await h.at
  setTimeout(h.release, lands)
  await edit($, 'e.txt', 'q', 'Q')
  await endTo($, w, 'clear', 's3')
  await ed; await ms(lands + 300); await settle(); await settle()
}
const poison = async ($: $T, w: W) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE')
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const eb = edit($, 'b.txt', 'x', 'y'); await h.at
  setTimeout(h.release, 5000)
  await endTo($, w, 'clear', 's2')
  await edit($, 'c.txt', 'k', 'K')
  await eb; await ms(400); await settle(); await settle()
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
}
test('review-undo19 Z1: an ending copy passed by while it waits is waited for by itself; the next /clear\'s ending copy is never written and d\'s late write lands over e', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await poison($, w)
  await endWhilePassed($, w, 's2', 1500)
  expect(files(w, 'changes:s2')).toEqual(['c.txt', 'd.txt', 'e.txt'])
})
test('review-undo19 Z1 comparison: the same end (d held 1.5 s, e passes it, /clear) with no earlier passed-by ending copy: the copy holds c, d and e', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await start($); await settle()
  await edit($, 'c.txt', 'k', 'K')
  await endWhilePassed($, w, 's1', 1500)
  expect(files(w, 'changes:s1')).toEqual(['c.txt', 'd.txt', 'e.txt'])
})
