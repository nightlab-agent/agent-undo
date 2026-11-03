import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Review of 0a43741: the world is review-undo17's, so the two files read alike, with two additions: the
// /clear at restore()'s id check from review9-scrub (armed by the read of changes:s1, the second check held
// on `gate`), and a record of each clock.sleep the test watches (its timer stopped when its dispatch aborts).
type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
type Hold = { reached: () => void; p: Promise<void> }
type Sleep = { ms: number; aborted: boolean; timedOut: boolean }

const world = (on: On, files0: Record<string, string>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = {
    files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
    trace: [] as string[],
    watchSleeps: false,
    sleeps: [] as Sleep[],
    clearAtCheck: false,
    armed: false,
    gate: undefined as Promise<void> | undefined,
    gated: false,
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  // The engine's clock: a real wait (the test kit answers none), so a bounded wait for a held save ends. The signal
  // given to $.clock.sleep does not cross (claude-code.d.ts 'clock.sleep'): it aborts the dispatch, so next.signal.
  on('clock.sleep', (_, e, next) => new Promise(r => {
    const s: Sleep = { ms: e.ms, aborted: false, timedOut: false }
    if (w.watchSleeps) w.sleeps.push(s)
    const t = setTimeout(() => { s.timedOut = true; r({ value: undefined }) }, e.ms)
    next.signal.addEventListener('abort', () => { s.aborted = true; clearTimeout(t) }, { once: true })
  }) as never)
  on('session.id', async () => {
    if (w.gated) { w.gated = false; const g = w.gate; w.gate = undefined; if (g) await g }
    const v = w.sid
    // A /clear lands at restore()'s first id check, which still reads the old id; the second waits for `gate`.
    if (w.armed) { w.armed = false; w.state.clear(); w.sid = 's2'; if (w.gate) w.gated = true }
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
const restart = async ($: $T, w: W) => { w.state.clear(); await start($) }
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const files = (w: W, key: string) => ((w.disk.get(key) as { list: { file: string }[] } | undefined)?.list ?? []).map(c => c.file.split('/').pop())
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
const all = { 'a.txt': 'one\n', 'b.txt': 'x\n', 'c.txt': 'k\n', 'd.txt': 'm\n' }

// Y1 (kind 1, out of order; mutant: scrub() chains on `saving` instead of whole()). s1 stored [a, b]; a new process
// restores it and a /clear (to s2) lands at restore()'s id check, so s2's list takes a and b (review9-scrub's gap).
// s2 edits c (its copy [a, b, c]); a /clear to s3 queues s2's ending copy [a, b, c], held. s3 edits d: its restore
// waits its second, then its save passes the held write at 1 s. The gap closes: restore() takes a and b back out
// and scrub() cleans s2's copy to [c]. The held write lands after that; a scrub that did not wait for it leaves
// s2's copy as [a, b, c] (the fresh save after it runs as s3 and writes only s3's copy), and s2 resumed lists them.
const passedThenScrub = async ($: $T, w: W, late: boolean) => {
  await start($); await settle()
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  let open!: () => void
  w.gate = new Promise<void>(r => { open = r })
  w.clearAtCheck = true
  await restart($, w)
  await settle()
  expect(w.sid).toBe('s2')
  await edit($, 'c.txt', 'k', 'K')
  expect(files(w, 'changes:s2')).toEqual(['a.txt', 'b.txt', 'c.txt'])
  const h = hold(); w.holdStoreSet = { key: 'changes:s2', ...h }
  if (!late) setTimeout(h.release, 200)
  await endTo($, w, 'clear', 's3')
  await edit($, 'd.txt', 'm', 'M')
  open()
  // Late: the held write lands half a second after the gap closed (over two seconds after it was queued).
  if (late) setTimeout(h.release, 500)
  await ms(800); await settle(); await settle()
}
test('review-undo18 Y1: s2\'s ending copy write is passed by and lands after the gap closes: scrub still leaves s2\'s copy as [c]', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await passedThenScrub($, w, true)
  // The ending copy write was passed by: it lands after s3's save of d.
  expect(w.trace.lastIndexOf('changes:s2 <- a.txt,b.txt,c.txt')).toBeGreaterThan(w.trace.indexOf('changes:s3 <- d.txt'))
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
})
test('review-undo18 Y1 comparison: the ending copy write lands at 0.2 s, before s3\'s edit: s2\'s copy is [c]', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  await passedThenScrub($, w, false)
  expect(files(w, 'changes:s2')).toEqual(['c.txt'])
})

// Y2 (kind 4, the engine's real behaviour; mutant: after() leaves out stop.abort()). a's copy write is held; b's
// save waits for it with a one-second $.clock.sleep. When a's write wins the race at 0.3 s, after() aborts the
// sleep, so the host's timer stops then and does not run on to 1 s (common.tsx: "the one-second timer stops when
// the earlier write wins"). When a's write is late (1.3 s), the sleep ends on its own and nothing is aborted.
const raceSleep = async ($: $T, w: W, lands: number) => {
  await start($); await settle()
  const h = hold(); w.holdStoreSet = { key: 'changes:s1', ...h }
  const ea = edit($, 'a.txt', 'one', 'ONE'); await h.at
  setTimeout(h.release, lands)
  w.watchSleeps = true
  const eb = edit($, 'b.txt', 'x', 'y')
  return { ea, eb }
}
test('review-undo18 Y2: a\'s write lands at 0.3 s, inside b\'s one-second wait: the wait\'s sleep is aborted then', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  const { ea, eb } = await raceSleep($, w, 300)
  await ea; await eb
  await ms(100); await settle()
  // b's save is done well before 1 s: its wait for a's write, then b's own one-second wait for its own write
  // (review-crx S1), must both be stopped by now, not still counting down.
  expect(w.sleeps).toEqual([{ ms: 1000, aborted: true, timedOut: false }, { ms: 1000, aborted: true, timedOut: false }])
  await ms(1000)
  expect(w.sleeps.some(s => s.timedOut)).toBe(false)
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
test('review-undo18 Y2 comparison: a\'s write lands at 1.3 s: the sleep runs its second out and is not aborted', { timeoutMs: 9000 }, async ($, on) => {
  const w = world(on, all)
  const { ea, eb } = await raceSleep($, w, 1300)
  await eb; await ea; await settle(); await settle()
  // b's wait for a's write runs its second out; b's own wait for its own write (review-crx S1) is stopped when it lands.
  expect(w.sleeps).toEqual([{ ms: 1000, aborted: false, timedOut: true }, { ms: 1000, aborted: true, timedOut: false }])
  expect(files(w, 'changes:s1')).toEqual(['a.txt', 'b.txt'])
})
