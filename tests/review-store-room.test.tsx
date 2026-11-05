// Release gate review of 72e52e1..HEAD ("Hang and size-cap fixes for 0.2.2"), code-reviewer.
// World: tests/review-gate-statecap.test.tsx's, plus the engine's two caps as the claude 2.1.312 binary applies
// them: $.state.set refuses a value over 4194304 characters of JSON (`var uSe=4194304`, "the value is N
// characters, over the 4194304 limit"), and $.store.set refuses when the whole store's JSON would be over the
// same number (tests/review-cr7.test.tsx's world, same rule).
// `fill:<n>`: an edit whose engine diff is n one-line insertions, so the entry has n hunks (n lines, under MAX_LINES).
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'
const CAP = 4194304

const world = (on: On, files0: Record<string, string>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = { files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(), statuses: [] as string[], stateSets: [] as number[], refused: [] as string[] }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('session.id', async () => ({ value: w.sid }))
  on('state.get', (_, e) => ({ value: w.state.get(at(e)) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    const was = w.state.get(at(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
    const l = JSON.stringify(e.value).length
    if (l > CAP) throw new Error(`$.state.set: the value is ${l} characters, over the ${CAP} limit`)
    w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
    if (e.key === 'changes') w.stateSets.push(l)
    return { value: { isSet: true, version: was + 1 } } as never
  })
  on('store.get', async (_, e) => ({ value: disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined }) as never)
  on('store.set', (_, e) => {
    const l = JSON.stringify({ ...Object.fromEntries(disk), [e.key]: e.value }).length
    if (l > CAP) { w.refused.push(`${e.key} ${l}`); throw new Error(`the store would be ${l} characters, over the ${CAP} limit`) }
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
  on('ui.status', (_, e) => { w.statuses.push(String((e as { text?: unknown }).text)); return { value: undefined } as never })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => { const t = files.get(e.path); if (t === undefined) throw new Error('ENOENT'); return { value: t } })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('tool.call', (_, e) => {
    const x = e as unknown as { file_path: string; old_string: string; new_string: string }
    const was = files.get(x.file_path)!
    const fill = /^fill:(\d+)$/.exec(x.new_string)
    if (fill) {
      // The result's strings and diff say what the file became, as the engine's do: the mod works the new text out from them.
      const n = Number(fill[1])
      const newString = `seed\n${'L\n'.repeat(n - 1)}L`
      files.set(x.file_path, was.replace(x.old_string, newString))
      return { result: { filePath: x.file_path, oldString: x.old_string, newString, originalFile: was,
        structuredPatch: Array.from({ length: n }, (_, k) => ({ oldStart: 2, oldLines: 0, newStart: k + 2, newLines: 1, lines: ['+L'] })),
        userModified: false, replaceAll: false } } as never
    }
    // `wide:<n>`: an edit that rewrote n lines of 1100 characters (under MAX_LINES, so kept hunk by hunk): the file held
    // the old block where `old_string` stands, and the result's strings and diff agree with it, as the engine's do.
    const m = /^wide:(\d+)$/.exec(x.new_string)
    const block = (c: string) => Array.from({ length: Number(m![1]) / 2 }, (_, k) => `${String(k).padStart(4, '0')}${c.repeat(1096)}`)
    const [before, after] = m ? [block('x'), block('y')] : [[x.old_string], [x.new_string]]
    const line = was.split('\n').indexOf(x.old_string) + 1
    const [oldString, newString] = [before.join('\n'), after.join('\n')]
    files.set(x.file_path, was.replace(x.old_string, newString))
    return { result: { filePath: x.file_path, oldString, newString, originalFile: was.replace(x.old_string, oldString),
      structuredPatch: [{ oldStart: line, oldLines: before.length, newStart: line, newLines: after.length,
        lines: [...before.map(l => `-${l}`), ...after.map(l => `+${l}`)] }],
      userModified: false, replaceAll: false } } as never
  })
  return w
}
type W = ReturnType<typeof world>

const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const restart = async ($: $T, w: W) => { w.state.clear(); await start($) }
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const undo = async ($: $T, args: string) =>
  ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
const undoOr = ($: $T, args: string) => undo($, args).catch(e => `threw: ${String(e)}`)
const tenLines = Array.from({ length: 10 }, (_, k) => `l${k + 1}`).join('\n') + '\n'
const wide = async ($: $T, n: number) => { for (let k = 1; k <= n; k++) await edit($, 'a.txt', `l${k}`, 'wide:400') }

// Another conversation's stored copy of about `kb` KB (one entry, one long line).
const other = (w: W, id: string, at: number, kb: number) => {
  w.disk.set(atOf(id), at)
  w.disk.set(`changes:${id}`, { shape: 'changes-3', list: [{ n: 1, at: '2026-11-03T00:00:00.000Z', tool: 'Edit', file: `/x/${id}.txt`,
    hunks: [{ before: [], after: ['y'.repeat(kb * 1000)], line: 1 }] }] })
}
const atOf = (id: string) => `at:${id}`

// S1 (kinds 4, 5 of the store): MAX_CHARS lets the session's list reach 3.97 MB in $.state, and its stored copy is
// as big. The store's cap is 4 MiB for every copy together (index.d.ts:3453), and put() (common.tsx:120-135) evicts
// one other conversation's copy, then gives up; save() then drops this session's own copy (common.tsx:196-200).
// With two other copies of 250 KB, the ninth wide edit (the PR's own C1 comparison case) leaves no copy of s1: a new
// process for s1 (an exit and `claude --resume`) lists nothing, with no word. README 58-63: "A new process that
// reports the same session id finds the list again".
test('review-store-room S1: nine wide edits (3.97 MB) beside two other 250 KB copies; the session\'s copy is stored and a new process lists #9', async ($, on) => {
  const w = world(on, { 'a.txt': tenLines })
  other(w, 'x1', 1, 250); other(w, 'x2', 2, 250)
  await start($)
  await wide($, 9)
  console.log(`S1 store keys after edit 9: ${[...w.disk.keys()].join(' ')}; store refusals: ${w.refused.join(' | ')}`)
  expect(w.disk.has('changes:s1')).toBe(true)
  await restart($, w)
  expect(await undo($, '')).toContain('#9 ')
})
test('review-store-room S1 comparison: the same nine edits beside one other 250 KB copy; the copy is stored and a new process lists #9', async ($, on) => {
  const w = world(on, { 'a.txt': tenLines })
  other(w, 'x1', 1, 250)
  await start($)
  await wide($, 9)
  expect(w.stateSets.at(-1)!).toBeGreaterThan(3_900_000)
  console.log(`S1c store keys after edit 9: ${[...w.disk.keys()].join(' ')}; store refusals: ${w.refused.join(' | ')}`)
  expect(w.disk.has('changes:s1')).toBe(true)
  await restart($, w)
  expect(await undo($, '')).toContain('#9 ')
})

// U1 (kind 4): fit() bounds record() and restore(), but an undo's list update (register.tsx:185, shell.tsx:212) is not
// fitted: each hunk it marks adds `,"undone":true` (14 characters). With the list under MAX_CHARS by design, the room
// to the engine's cap is 194,304 characters, which 13,880 marked hunks fill. 22 edits of 4,000 one-line insertions and
// a topper bring the list to about 3.99 MB; undoing five of them whole adds about 14 characters a hunk, past the cap at the fourth.
const fillList = async ($: $T, w: W) => {
  for (let k = 0; k < 22; k++) await edit($, `f${k}.txt`, 'seed', 'fill:4000')
  // A topper under 1,104 characters a line brings the list to about 3,999,000 characters without dropping an entry.
  const room = 3_999_000 - w.stateSets.at(-1)!
  const lines = Math.max(2, Math.floor(room / 1104 / 2) * 2)
  await edit($, 'a.txt', 'l1', `wide:${lines}`)
  expect(w.stateSets.at(-1)!).toBeGreaterThan(3_950_000)
  console.log(`U1 list JSON after 22 fills and a ${lines}-line topper: ${w.stateSets.at(-1)} characters; entries: ${(w.state.get('agent-undo/changes/')?.value as unknown[]).length}`)
}
const seeds = Object.fromEntries(Array.from({ length: 22 }, (_, k) => [`f${k}.txt`, 'seed\n']))

test('review-store-room U1: with the list near its cap, undoing five 4,000-hunk edits whole; each undo answers "undid" and marks its hunks', { timeoutMs: 120000 }, async ($, on) => {
  const w = world(on, { ...seeds, 'a.txt': tenLines })
  await start($)
  await fillList($, w)
  const got: string[] = []
  for (const n of [22, 21, 20, 19, 18]) {
    const text = await undoOr($, String(n))
    got.push(`#${n}: ${text.split('\n')[0]!.slice(0, 90)} | f${n - 1}.txt now ${w.files.get(`${ROOT}/f${n - 1}.txt`)!.length} chars | list ${w.stateSets.at(-1)} chars`)
  }
  console.log(`U1 undos:\n${got.join('\n')}`)
  for (const g of got) expect(g).toContain('undid')
})
test('review-store-room U1 comparison: the same list, four such undos; each answers "undid"', { timeoutMs: 120000 }, async ($, on) => {
  const w = world(on, { ...seeds, 'a.txt': tenLines })
  await start($)
  await fillList($, w)
  const got: string[] = []
  for (const n of [22, 21, 20, 19]) got.push(`#${n}: ${(await undoOr($, String(n))).split('\n')[0]!.slice(0, 90)} | list ${w.stateSets.at(-1)} chars`)
  console.log(`U1c undos:\n${got.join('\n')}`)
  for (const g of got) expect(g).toContain('undid')
})
