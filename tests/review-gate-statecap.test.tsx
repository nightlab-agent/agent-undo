// Release gate review of 0.2.2 (29969ed..72e52e1), kind 4 (the engine's real behaviour): the engine refuses a
// $.state value over 4 MiB of JSON text, as its store does per value (the kit's own message, under
// `claude plugin test`: "$.state.set: the value is 4194312 characters, over the 4194304 limit"; the
// declarations say nothing of a state cap, index.d.ts 3473-3507). hooks/common.tsx bounds the list by
// MAX_CHANGES (300) and MAX_LINES (4000 a change), which allow far more than 4 MiB: once the list's JSON
// nears the cap, update($, changes) is refused, record() throws, the Edit hook swallows it (register.tsx
// 229-231), and that edit and every later one in the session is not listed, with no status line and no word.
// World copied from tests/review8-window.test.tsx.
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
const ROOT = '/proj'

const world = (on: On, files0: Record<string, string>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = { files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>(), statuses: [] as string[], stateSets: [] as number[] }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('session.id', async () => ({ value: w.sid }))
  on('state.get', (_, e) => ({ value: w.state.get(at(e)) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    const was = w.state.get(at(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
    w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
    if (e.key === 'changes') w.stateSets.push(JSON.stringify(e.value).length)
    return { value: { isSet: true, version: was + 1 } } as never
  })
  on('store.get', async (_, e) => ({ value: disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined }) as never)
  on('store.set', (_, e) => { disk.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } as never })
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
    files.set(x.file_path, was.replace(x.old_string, x.new_string))
    // `wide:<n>`: the engine's diff of an edit that rewrote n lines of 1100 characters (under MAX_LINES, so
    // kept hunk by hunk); else one changed line, as review8's world answers.
    const m = /^wide:(\d+)$/.exec(x.new_string)
    const lines = m
      ? [...Array.from({ length: Number(m[1]) / 2 }, (_, k) => `-${String(k).padStart(4, '0')}${'x'.repeat(1096)}`),
        ...Array.from({ length: Number(m[1]) / 2 }, (_, k) => `+${String(k).padStart(4, '0')}${'y'.repeat(1096)}`)]
      : [`-${x.old_string}`, `+${x.new_string}`]
    return { result: { filePath: x.file_path, oldString: x.old_string, newString: x.new_string, originalFile: was,
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }],
      userModified: false, replaceAll: false } } as never
  })
  return w
}
type W = ReturnType<typeof world>

const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
const tenLines = Array.from({ length: 10 }, (_, k) => `l${k + 1}`).join('\n') + '\n'

// n edits that each rewrote 400 lines of 1100 characters: about 441 KB of list JSON each (9 of them 3.97 MB,
// 10 of them 4.41 MB).
const wide = async ($: $T, w: W, n: number) => {
  for (let k = 1; k <= n; k++) await edit($, 'a.txt', `l${k}`, 'wide:400')
  console.log(`${n} wide edits: list JSON sizes accepted by the state: ${w.stateSets.join(' ')}; last status: ${w.statuses.at(-1)}`)
}

test('review-gate C1: the tenth edit, which takes the list past 4 MiB of JSON, is listed and named in the status line', async ($, on) => {
  const w = world(on, { 'a.txt': tenLines })
  await start($)
  await wide($, w, 10)
  expect(await undo($, '')).toContain('#10 ')
  expect(w.statuses.at(-1)).toContain('#10 ')
})
test('review-gate C1 comparison: nine such edits (3.97 MB), the ninth is listed and named in the status line', async ($, on) => {
  const w = world(on, { 'a.txt': tenLines })
  await start($)
  await wide($, w, 9)
  expect(await undo($, '')).toContain('#9 ')
  expect(w.statuses.at(-1)).toContain('#9 ')
})
// C1b: from then on every edit of that size is lost the same way (a small one still fits until the cap is reached:
// the list does not shrink, and nothing says so).
test('review-gate C1b: an eleventh such edit after the tenth was lost is listed as #10', async ($, on) => {
  const w = world(on, { 'a.txt': tenLines + 'l11\n' })
  await start($)
  await wide($, w, 11)
  expect(await undo($, '')).toContain('#10 ')
})
test('review-gate C1b comparison: after nine such edits, a one-line edit of another file is listed as #10', async ($, on) => {
  const w = world(on, { 'a.txt': tenLines, 'b.txt': 'two\n' })
  await start($)
  await wide($, w, 9)
  await edit($, 'b.txt', 'two', 'TWO')
  expect(await undo($, '')).toContain('#10 ')
})
// One edit whose own diff is over the list's budget (4000 lines of 1100 characters, 4.4 MB) is listed as too
// large, as an edit over 4000 lines is, so the edit before it stays listed and the state is never refused.
test('one edit larger than the whole budget is listed as too large and the edit before it stays', async ($, on) => {
  const w = world(on, { 'a.txt': tenLines, 'b.txt': 'two\n' })
  await start($)
  await edit($, 'b.txt', 'two', 'TWO')
  await edit($, 'a.txt', 'l1', 'wide:4000')
  const text = await undo($, '')
  expect(text).toContain('#1 ')
  expect(text).toContain('#2 ')
  expect(w.statuses.at(-1)).toContain('#2 ')
  expect(Math.max(...w.stateSets)).toBeLessThan(4_194_304)
})
