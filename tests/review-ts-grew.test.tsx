// typescript-reviewer, 0.2.2 gate. World: review-end9's (its X3 sequence reaches restore()'s `grew` merge), plus
// review-crx-serial's held store.set and a clock.sleep that honours its abort.
// G1 (kind 1): restoreList() awaits `mirror($)` with no bound when a restore merged stored entries in front of
// listed ones (common.tsx:221). That mirror's own store write never landing leaves `restoring.done` unsettled for
// the process, so the command that started it never answers and every later Edit's updateList (which awaits
// restoreList first) hangs: the bound updateList gives its own write (common.tsx:333-336) is never reached.
// The comparison holds the same key's write once the restore has settled: the next Edit answers under its second.
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
    clearAtCheck: undefined as undefined | 'before' | 'after',
    swapTo: 's2',
    armed: false,
    gate: undefined as Promise<void> | undefined,
    gated: false,
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
    trace: [] as string[],
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  // Resolves after ms; rejects at once when the dispatch's signal aborts (claude-code.d.ts clock.sleep).
  on('clock.sleep', (_, e, next) => new Promise((r, j) => {
    const t = setTimeout(() => r({ value: undefined }), e.ms)
    next.signal.addEventListener('abort', () => { clearTimeout(t); j(new Error('aborted')) }, { once: true })
  }) as never)
  on('session.id', async () => {
    if (w.gated) { w.gated = false; const g = w.gate; w.gate = undefined; if (g) await g }
    const v = w.sid
    if (w.armed) {
      w.armed = false
      const m = w.clearAtCheck; w.clearAtCheck = undefined
      w.state.clear(); w.sid = w.swapTo
      if (w.gate) w.gated = true
      return { value: m === 'after' ? v : w.sid }
    }
    return { value: v }
  })
  on('state.get', (_, e) => ({ value: w.state.get(at(e)) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    const was = w.state.get(at(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
    w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
    return { value: { isSet: true, version: was + 1 } } as never
  })
  on('store.get', async (_, e) => {
    const v = disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined
    if (e.key === 'changes:s1' && w.clearAtCheck) w.armed = true
    return { value: v } as never
  })
  on('store.set', async (_, e) => {
    if (w.holdStoreSet && w.holdStoreSet.key === e.key) { const h = w.holdStoreSet; w.holdStoreSet = undefined; h.reached(); await h.p }
    disk.set(e.key, JSON.parse(JSON.stringify(e.value)))
    w.trace.push(e.key.startsWith('changes:') ? `${e.key} <- ${(e.value as { list: { file: string }[] }).list.map(c => c.file.split('/').pop()).join(',')}` : e.key)
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => { disk.delete(e.key); return { value: undefined } as never })
  on('store.keys', () => ({ value: [...disk.keys()] }) as never)
  on('session.end', (_, e: any) => ({ sessionId: e.sessionId }) as never)
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
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }
const ms = (n: number) => new Promise<void>(r => setTimeout(r, n))
const within = <T,>(p: Promise<T>, n: number) => Promise.race([p.then(v => ({ v })), ms(n).then(() => 'timeout' as const)])
const hold = () => {
  let reached!: () => void
  const at = new Promise<void>(r => { reached = r })
  const p = new Promise<void>(() => {}) // never lands
  return { reached, p, at }
}
const all = { 'p.txt': '1\n', 'q.txt': '3\n', 'a.txt': 'one\n', 'b.txt': 'x\n', 'd.txt': 'k\n', 'e.txt': 'm\n' }

// review-end9 X3's sequence: s1's in-flight restore leaks a.txt, b.txt into s0's fresh state; s0's first edit is
// numbered above them; the rollback takes them out; s0's next read merges its stored p.txt, q.txt in front (grew).
const leakIntoS0 = async ($: $T, w: W) => {
  await restart($, w, 's0')
  await edit($, 'p.txt', '1', '2')
  await edit($, 'q.txt', '3', '4')
  await restart($, w, 's1')
  await edit($, 'a.txt', 'one', 'ONE')
  await edit($, 'b.txt', 'x', 'y')
  let open: () => void = () => {}
  w.gate = new Promise<void>(r => { open = r })
  w.clearAtCheck = 'after'
  w.swapTo = 's0'
  await restart($, w)
  await settle()
  expect(w.sid).toBe('s0')
  await edit($, 'd.txt', 'k', 'K')
  open(); await settle()
}

test('review-ts G1: the grew merge\'s own copy write never lands; /agent-undo answers and the next Edit writes its file within 3 s', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await leakIntoS0($, w)
  const before = w.trace.length
  const h = hold()
  w.holdStoreSet = { key: 'at:s0', ...h }
  const u = await within(undo($, ''), 3000)
  const ed = await within(edit($, 'e.txt', 'm', 'M'), 3000)
  console.log(`G1 undo: ${u === 'timeout' ? 'no answer in 3 s' : 'answered'}; edit e: ${ed === 'timeout' ? 'no tool result in 3 s' : 'returned'}; writes after: ${JSON.stringify(w.trace.slice(before))}`)
  expect(u).not.toBe('timeout')
  expect(ed).not.toBe('timeout')
})

test('review-ts G1 comparison: the same write held once the restore has settled; /agent-undo answers and the next Edit returns within 3 s', { timeoutMs: 20000 }, async ($, on) => {
  const w = world(on, all)
  await leakIntoS0($, w)
  await undo($, ''); await settle()            // the grew merge and its mirror land
  const h = hold()
  w.holdStoreSet = { key: 'at:s0', ...h }
  const ed = await within(edit($, 'e.txt', 'm', 'M'), 3000)
  const u = await within(undo($, ''), 3000)
  console.log(`G1c edit e: ${ed === 'timeout' ? 'no tool result in 3 s' : 'returned'}; undo: ${u === 'timeout' ? 'no answer in 3 s' : 'answered'}`)
  expect(ed).not.toBe('timeout')
  expect(u).not.toBe('timeout')
})
