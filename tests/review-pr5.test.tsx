import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Review of 79bdbfb (restore() waits for scrub() a second at most). The world is review9-scrub's gap
// (a /clear at restore()'s first id check, its second check held by a gate) plus review-cr-whole's real
// clock and a store.set that can be held, so a save is passed by and sits in `passed`.
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
    clearAtCheck: undefined as undefined | 'after' | 'new',
    clearTo: 's2',
    armed: false,
    gate: undefined as Promise<void> | undefined,
    gated: false,
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('clock.sleep', (_, e, next) => new Promise(r => {
    const t = setTimeout(() => r({ value: undefined }), e.ms)
    next.signal.addEventListener('abort', () => clearTimeout(t), { once: true })
  }) as never)
  on('session.id', async () => {
    if (w.gated) { w.gated = false; const g = w.gate; w.gate = undefined; if (g) await g }
    const v = w.sid
    if (w.armed) {
      w.armed = false
      const m = w.clearAtCheck; w.clearAtCheck = undefined
      w.state.clear(); w.sid = w.clearTo
      if (w.gate) w.gated = true
      void m; return { value: v } // the first check still reads the old id
    }
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
    if (e.key === 'changes:s1' && w.clearAtCheck) w.armed = true
    return { value: disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined } as never
  })
  on('store.set', async (_, e) => {
    if (w.holdStoreSet && w.holdStoreSet.key === e.key) { const h = w.holdStoreSet; w.holdStoreSet = undefined; h.reached(); await h.p }
    disk.set(e.key, JSON.parse(JSON.stringify(e.value)))
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
const restart = async ($: $T, w: W, sid = w.sid) => { w.state.clear(); w.sid = sid; await start($) }
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const listed = (w: W) => {
  const k = [...w.state.keys()].find(x => x.startsWith('agent-undo/changes/'))
  const v = k ? (w.state.get(k)?.value as { value?: unknown } | undefined)?.value : undefined
  return (Array.isArray(v) ? (v as { file: string }[]) : []).map(c => c.file.split('/').pop())
}
const stored = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
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
const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'p\n', 'd.txt': 'd\n', 'e.txt': 'e\n' }

// R1 (kind 1, out of order). review9-scrub F1's gap: s1's a and b go into s2's list, s2's edit c mirrors
// [a, b, c] into changes:s2, a /clear to s3, and restore(s1) takes a and b back and calls scrub(). Here one
// save of s2 (edit d's) is slow: e's save passes it at 1 s, so it sits in `passed`, s2's ending copy waits for
// it, and scrub() waits for both. At 79bdbfb restore() stops waiting for scrub() after a second
// (after() in restore()) and its mirror() moves `saving` past it, so scrub() is no longer on the queue that
// restore()'s own read waits for (saved($, 1000) -> still() reads `saving` only). A /resume back to s2 then
// reads changes:s2 before scrub() lands, takes s1's a and b into s2's list, and when the slow write and
// scrub() land, the passed-by re-mirror in after() writes them back into changes:s2. At f6697d2 `saving` was
// still scrub(), so the read waited for it (the slow write lands 0.3 s into that read's one-second wait)
// and found the copy clean.
// P1 (kind 1, the exit half of R1). Same world as review-cr4 R1 up to restore(s1) having returned (scrub()
// passed by, sitting in `passed`, waiting for s2's slow write of d). Then the user exits s3 instead of
// /resume-ing. session.end's wait (shell.tsx:319, saved($, ..., true)) reads `saving` only, not `passed`, so the
// end step runs before scrub() lands, though the slow write lands 0.3 s into that one-second bound. The engine
// ends the process after the chain ("Exits stay fast ... the whole chain shares one short wall-clock bound",
// index.d.ts 4558-4560): what is on disk at the end step is what `claude --resume s2` reads.
const exitDuringScrub = async ($: $T, w: W, slow: boolean) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  let open!: () => void
  w.gate = new Promise<void>(r => { open = r })
  w.clearAtCheck = 'after'
  await restart($, w); await settle()
  expect(w.sid).toBe('s2')
  await edit($, 'c.txt', 'p', 'q')
  const h = hold()
  if (slow) w.holdStoreSet = { key: 'changes:s2', ...h }
  const ed = edit($, 'd.txt', 'd', 'D')
  if (slow) await h.at; else await ed
  await edit($, 'e.txt', 'e', 'E')
  await endTo($, w, 'clear', 's3'); await settle()
  open()
  await ms(2500)
  if (slow) setTimeout(h.release, 300)
  const t0 = Date.now()
  await $.session.end({ reason: 'exit', sessionId: w.sid, resume: { id: w.sid } } as never)
  const took = Date.now() - t0
  const atEnd = ((w.disk.get('changes:s2') as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
  await ms(1500); await settle()
  return { atEnd, later: stored(w, 'changes:s2'), took }
}
test('review-pr5 P1: s2\'s slow write lands 0.3 s into an exit\'s end wait; changes:s2 at the end step still holds s1\'s a.txt and b.txt', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  const { atEnd, later, took } = await exitDuringScrub($, w, true)
  console.log(`P1 end wait ${took} ms; at the end step changes:s2 = ${JSON.stringify(atEnd)}; 1.5 s later = ${JSON.stringify(later)}`)
  expect(atEnd).toEqual(['c.txt', 'd.txt', 'e.txt'])
})
test('review-pr5 P1 comparison: every save lands at once, the same gap and exit: changes:s2 at the end step holds only s2\'s edits', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  const { atEnd } = await exitDuringScrub($, w, false)
  expect(atEnd).toEqual(['c.txt', 'd.txt', 'e.txt'])
})
