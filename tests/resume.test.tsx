import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The list across a new process for the same session (`claude --resume`, as far as a test can
// tell it): the host's `$.state` is answered here and emptied by `restart`, as a new process
// starts with none; `$.store` (a disk shared by every process) and the session id stay unless
// the test changes them. Whether a real `--resume` keeps the session id is not known.

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]

const ROOT = '/proj'

const world = (on: On, files0: Record<string, string>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v]))
  const disk = new Map<string, unknown>()
  const w = { files, disk, sid: 's1', state: new Map<string, { value: unknown; version: number }>() }
  const at = (e: { plugin: string; key: string; id?: string }) => `${e.plugin}/${e.key}/${e.id ?? ''}`
  on('session.root', () => ({ value: ROOT }))
  on('session.id', () => ({ value: w.sid }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('state.get', (_, e) => ({ value: w.state.get(at(e)) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    const was = w.state.get(at(e))?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== was) return { value: { isSet: false, version: was } } as never
    w.state.set(at(e), { value: JSON.parse(JSON.stringify(e.value)), version: was + 1 })
    return { value: { isSet: true, version: was + 1 } } as never
  })
  on('store.get', (_, e) => ({ value: disk.has(e.key) ? JSON.parse(JSON.stringify(disk.get(e.key))) : undefined }) as never)
  on('store.set', (_, e) => { disk.set(e.key, JSON.parse(JSON.stringify(e.value))); return { value: undefined } as never })
  on('store.delete', (_, e) => { disk.delete(e.key); return { value: undefined } as never })
  on('store.keys', () => ({ value: [...disk.keys()] }) as never)
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('tool.call', (_, e) => {
    // A one-line Edit, answered with the engine's result shape (the one changed line as its hunk).
    const x = e as unknown as { file_path: string; old_string: string; new_string: string }
    const was = files.get(x.file_path)!
    const now = was.replace(x.old_string, x.new_string)
    files.set(x.file_path, now)
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
/** A new process: no `$.state`, the store and (unless changed) the session id as they were. */
const restart = async ($: $T, w: ReturnType<typeof world>, sid = w.sid) => {
  w.state.clear()
  w.sid = sid
  await start($)
}
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text

test('session.start still answers the cwd it was given', async ($, on) => {
  world(on, {})
  expect(await start($)).toEqual({ cwd: ROOT })
})

test('a new process for the same session lists the edits made before it, and undoes one', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\ntwo\n', 'b.txt': 'x\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  await edit($, 'b.txt', 'x', 'y')
  await restart($, w)
  const text = await undo($, '')
  expect(text).toContain('#1 ')
  expect(text).toContain('Edit a.txt')
  expect(text).toContain('#2 ')
  expect(text).toContain('Edit b.txt')
  expect(await undo($, '1')).toContain('undid 1.1 in a.txt')
  expect(w.files.get(`${ROOT}/a.txt`)).toBe('one\ntwo\n')
  expect(w.files.get(`${ROOT}/b.txt`)).toBe('y\n')
  // A new edit after the restart numbers on from the restored list, and the undo stays marked.
  await edit($, 'b.txt', 'y', 'z')
  await restart($, w)
  const again = await undo($, '')
  expect(again).toContain('#3 ')
  expect(again).toContain('1.1 line 2: -1 +1  TWO  (undone)')
})

test('comparison: a new process under another session id lists nothing', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  await restart($, w, 's2')
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
})

test('a sixth session pushes the oldest stored list out; the other five stay', async ($, on) => {
  const w = world(on, { 'a.txt': 'v0\n' })
  for (let i = 1; i <= 6; i++) {
    await restart($, w, `s${i}`)
    await edit($, 'a.txt', `v${i - 1}`, `v${i}`)
  }
  await restart($, w, 's1')
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
  await restart($, w, 's2')
  expect(await undo($, '')).toContain('Edit a.txt')
  await restart($, w, 's6')
  expect(await undo($, '')).toContain('Edit a.txt')
})

test('a stored list under another shape tag is declined, as the atom declines it', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  let tagged = 0
  for (const [k, v] of w.disk) {
    if (v && typeof v === 'object' && 'shape' in v) { w.disk.set(k, { ...v, shape: 'changes-1' }); tagged++ }
  }
  expect(tagged).toBe(1)
  await restart($, w)
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
})

test('a restored edit whose lines the person changed since is refused, and the file left alone', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  await restart($, w)
  w.files.set(`${ROOT}/a.txt`, 'one\n2\n')
  const text = await undo($, '1')
  expect(text).toContain('nothing changed in a.txt')
  expect(text).toContain('1.1 left as is: those lines have changed since the edit')
  expect(w.files.get(`${ROOT}/a.txt`)).toBe('one\n2\n')
})
