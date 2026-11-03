import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Review of 94cda39: the world is review-undo18's (its /clear at restore()'s id check), so the two files read alike.
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
    clearAtCheck: false,
    armed: false,
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('clock.sleep', (_, e, next) => new Promise(r => {
    const t = setTimeout(() => r({ value: undefined }), e.ms)
    next.signal.addEventListener('abort', () => clearTimeout(t), { once: true })
  }) as never)
  on('session.id', async () => {
    const v = w.sid
    // A /clear lands at restore()'s first id check, which still reads the old id (review9-scrub, review-undo18).
    if (w.armed) { w.armed = false; w.state.clear(); w.sid = 's3' }
    return { value: v }
  })
  on('state.get', async (_, e) => ({ value: w.state.get(at(e)) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', async (_, e) => {
    const was = w.state.get(at(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
    w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
    return { value: { isSet: true, version: was + 1 } } as never
  })
  on('store.get', async (_, e) => {
    if (e.key === 'changes:s1' && w.clearAtCheck) { w.clearAtCheck = false; w.armed = true }
    return { value: disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined } as never
  })
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
const listed = (w: W) => {
  const k = [...w.state.keys()].find(x => x.startsWith('agent-undo/changes/'))
  const v = k ? (w.state.get(k)?.value as { value?: unknown } | undefined)?.value : undefined
  return (Array.isArray(v) ? (v as { file: string }[]) : []).map(c => c.file.split('/').pop())
}
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }
const ms = (n: number) => new Promise<void>(r => setTimeout(r, n))
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

// Z1 (kind 2, an unbounded wait inside the hook's own path). a's copy write never lands (CHANGELOG 0.2.2's "second
// known limit"); b's save passes it at 1 s, so it sits in `passed` for good. A /clear to s2 queues s1's ending
// copy, which waits for `passed` with no bound. A /resume back to s1, then an edit of c: restore(s1) reads s1's
// stored copy, a /clear lands at its id check (review9-scrub's gap), restore() takes a and b back out and calls
// scrub(), which now chains on whole(): `passed` never empties, so scrub() never settles, restore() never returns,
// and the Edit hook that waits in restoreList() hangs until the engine's 10 s HookBudget drops it; c is never
// listed. At 349506c scrub() chained on `saving` (b's settled save) and the same edit returned at once.
const stuckThenGap = async ($: $T, w: W, lands: number | undefined) => {
  await start($); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const ea = edit($, 'a.txt', 'one', 'ONE'); await h.at
  if (lands !== undefined) setTimeout(h.release, lands)
  await edit($, 'b.txt', 'x', 'y')
  await endTo($, w, 'clear', 's2'); await settle()
  await endTo($, w, 'resume', 's1'); await settle()
  w.clearAtCheck = true
  const ec = edit($, 'c.txt', 'k', 'K')
  // restore(s1)'s own bounded wait is one second; four is room enough for the hook to come back.
  const got = await Promise.race([ec.then(() => 'returned'), ms(4000).then(() => 'hung')])
  return { got, ea, ec }
}
test('review-cr Z1: a\'s copy write never lands; after a /clear, a /resume back and a /clear at restore\'s id check, the Edit hook of c still returns and c is listed', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  const { got } = await stuckThenGap($, w, undefined)
  expect(got).toBe('returned')
  expect(w.sid).toBe('s3')
  expect(listed(w)).toEqual(['c.txt'])
})
test('review-cr Z1 comparison: a\'s write lands at 0.2 s, the same /clear, /resume and gap: the Edit hook of c returns and c is listed', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  const { got, ea, ec } = await stuckThenGap($, w, 200)
  expect(got).toBe('returned')
  await ea; await ec; await settle()
  expect(w.sid).toBe('s3')
  expect(listed(w)).toEqual(['c.txt'])
})
