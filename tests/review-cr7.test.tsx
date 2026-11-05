import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// Code review of ff35561..549ca77 (put() retries once, evicts only when over() measures the store over 4 MiB).
// Q1 (kinds 3, 4): the engine measures its cap in characters: its store backend refuses a set when
// `JSON.stringify({...store, [key]: value}).length > 4194304` ("the store would be N characters, over the 4194304
// limit", claude 2.1.312 binary: the message is a template there, `would be ${l} characters`, so a grep for
// the whole sentence finds nothing, the constant is `uSe=4194304`; the plugin test kit's store gives the same refusal). over() measures UTF-8 bytes, so a store of non-ASCII text (an accented or CJK file
// in the undo lists) that is 3 MiB of characters reads as over 4 MiB, and a busy file refused twice evicts another
// conversation's copy, the case 0.2.2 says no longer happens. The world below enforces the engine's rule.
type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
type Hold = { reached: () => void; p: Promise<void> }

const world = (on: On, files0: Record<string, string>, opts: { sleeps?: boolean } = {}) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = {
    files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(),
    holdStoreSet: undefined as undefined | ({ key: string } & Hold),
    holdAll: false,
    rejectOnce: undefined as undefined | string,
    rejectLeft: 0, rejectKey: "",
  }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  if (opts.sleeps !== false) on('clock.sleep', (_, e, next) => new Promise(r => {
    const t = setTimeout(() => r({ value: undefined }), e.ms)
    next.signal.addEventListener('abort', () => clearTimeout(t), { once: true })
  }) as never)
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
    if (w.holdAll) await new Promise<void>(() => {})
    if (w.rejectLeft > 0 && w.rejectKey === e.key) { w.rejectLeft--; throw new Error('EBUSY: resource busy or locked') }
    if (w.rejectOnce && w.rejectOnce === e.key) { w.rejectOnce = undefined; throw new Error('EBUSY: resource busy or locked') }
    if (w.holdStoreSet && w.holdStoreSet.key === e.key) { const h = w.holdStoreSet; w.holdStoreSet = undefined; h.reached(); await h.p }
    const next = { ...Object.fromEntries(disk), [e.key]: e.value }
    const l = JSON.stringify(next).length
    if (l > 4194304) throw new Error(`the store would be ${l} characters, over the 4194304 limit`)
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

const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
const tick = () => new Promise<void>(r => setTimeout(r, 0))
const settle = async () => { await tick(); await tick(); await tick() }
const ms = (n: number) => new Promise<void>(r => setTimeout(r, n))
const all = { 'a.txt': 'one\n' }
// Another conversation's copy with `chars` characters of list text, of `ch` (a few large Writes make 1 MiB).
const copy = (w: { disk: Map<string, unknown> }, id: string, at: number, chars: number, ch: string) => {
  w.disk.set(`at:${id}`, at)
  w.disk.set(`changes:${id}`, { shape: 'changes-3', list: [{ n: 1, at: '2026-11-03T00:00:00.000Z', tool: 'Write', file: `/proj/${id}.txt`, hunks: [], pad: ch.repeat(chars) }] })
}
const MiB = 1024 * 1024
const run = async ($: $T, on: On, opts: { ch: string; each: number; refusals: number }) => {
  const w = world(on, all)
  copy(w, 's0', 1, opts.each, opts.ch); copy(w, 's2', 2, opts.each, opts.ch); copy(w, 's3', 3, opts.each, opts.ch)
  await start($); await settle()
  w.rejectKey = 'at:s1'; w.rejectLeft = opts.refusals
  await edit($, 'a.txt', 'one', 'ONE'); await settle(); await settle()
  const text = JSON.stringify(Object.fromEntries(w.disk))
  console.log(`Q1 ch=${opts.ch} refusals=${opts.refusals}: store ${text.length} chars, ${new TextEncoder().encode(text).length} bytes; copies ${JSON.stringify([...w.disk.keys()].filter(k => k.startsWith('changes:')).sort())}`)
  return w
}
test('review-cr7 Q1: 3 MiB of accented text stored (under the cap), at:s1 refused twice as EBUSY: s0\'s copy stays', { timeoutMs: 20000 }, async ($, on) => {
  const w = await run($, on, { ch: '\u00e9', each: MiB, refusals: 2 })
  expect(w.disk.has('changes:s0')).toBe(true)
})
test('review-cr7 Q1 comparison: 3 MiB of ASCII text stored, at:s1 refused twice as EBUSY: s0\'s copy stays', { timeoutMs: 20000 }, async ($, on) => {
  const w = await run($, on, { ch: 'x', each: MiB, refusals: 2 })
  expect(w.disk.has('changes:s0')).toBe(true)
})
test('review-cr7 Q1 guard: ASCII store at the cap, no refusal but the cap\'s: s0 goes and s1 is stored (the fix\'s own path)', { timeoutMs: 20000 }, async ($, on) => {
  const w = await run($, on, { ch: 'x', each: Math.floor(4194304 / 3) - 120, refusals: 0 })
  expect(w.disk.has('changes:s0')).toBe(false)
  expect(w.disk.has('changes:s1')).toBe(true)
})
