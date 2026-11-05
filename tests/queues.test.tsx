import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { editResult } from './engine'
import { ROOT, at, start, undo } from './edit-world'
import { tempTools } from './temp-tools'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
type Call = { tool: string; file_path: string; old_string: string; new_string: string }

// An Edit of a file in `held` stays open (its permission question) until `release` is called.
const world = (on: On, files0: Record<string, string>, nest?: (x: Call) => Promise<unknown>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [at(k), v]))
  const held = new Map<string, () => void>()
  const hold = new Set<string>()
  const log: string[] = []
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path)! }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); log.push(`wrote ${e.path}`); return { value: undefined } })
  tempTools(on, files, path => log.push(`wrote ${path}`))
  on('tool.call', async (_, e) => {
    const x = e as unknown as Call
    log.push(`start ${x.file_path}`)
    if (hold.has(x.file_path)) await new Promise<void>(r => held.set(x.file_path, r))
    await nest?.(x)
    const { disk, result } = editResult(files.get(x.file_path)!, x as Parameters<typeof editResult>[1])
    files.set(x.file_path, disk)
    return { result } as never
  })
  return { files, held, hold, log }
}
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: at(file), old_string: a, new_string: b } as never)
const FAR = `one\n${'-\n'.repeat(9)}two\n`
const settled = () => new Promise<void>(r => setTimeout(r, 30))
const within = <T,>(p: Promise<T>, what: string) => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error(`${what} never finished`)), 1000))])

test('an Edit waiting on its question does not hold back an Edit of another file', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  await start($)
  w.hold.add(at('a.txt'))
  const first = edit($, 'a.txt', 'one', 'ONE')
  await settled()
  await within(edit($, 'b.txt', 'two', 'TWO'), 'the Edit of b.txt')
  expect(w.files.get(at('b.txt'))).toBe('TWO\n')
  w.held.get(at('a.txt'))!()
  await first
})

test('comparison: an Edit of the same file waits its turn', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  w.hold.add(at('a.txt'))
  const first = edit($, 'a.txt', 'one', 'ONE')
  await settled()
  w.hold.clear()
  const second = edit($, 'a.txt', 'two', 'TWO')
  await settled()
  expect(w.log.filter(l => l.startsWith('start'))).toHaveLength(1)
  w.held.get(at('a.txt'))!()
  await Promise.all([first, second])
  expect(w.files.get(at('a.txt'))).toBe('ONE\nTWO\n')
})

test('an Edit that makes an Edit of another file on its way does not wait for itself', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'two\n' }, async x => {
    if (x.file_path === at('a.txt')) await edit($, 'b.txt', 'two', 'TWO')
  })
  await start($)
  await within(edit($, 'a.txt', 'one', 'ONE'), 'the outer Edit')
  expect(w.files.get(at('b.txt'))).toBe('TWO\n')
})

test('known limit: an undo waits for an Edit of any file; the list answers at once', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  await start($)
  await edit($, 'b.txt', 'two', 'TWO')
  w.hold.add(at('a.txt'))
  const first = edit($, 'a.txt', 'one', 'ONE')
  await settled()
  const undoing = undo($, '1')
  expect(await within(undo($, ''), 'the list')).toContain('#1 ')
  await settled()
  expect(w.files.get(at('b.txt'))).toBe('TWO\n')
  w.held.get(at('a.txt'))!()
  await first
  expect(await undoing).toContain('undid')
})

test('comparison: an undo of the file being edited waits for the Edit, so neither is lost', async ($, on) => {
  const w = world(on, { 'a.txt': FAR })
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  w.hold.add(at('a.txt'))
  const second = edit($, 'a.txt', 'two', 'TWO')
  await settled()
  const undoing = undo($, '1')
  await settled()
  expect(w.log.some(l => l.startsWith('wrote'))).toBe(false)
  w.held.get(at('a.txt'))!()
  await second
  expect(await undoing).toContain('undid')
  expect(w.files.get(at('a.txt'))).toBe(FAR.replace('two', 'TWO'))
})

test('comparison: while an Edit runs, an undo that names no listed edit yet waits, and then finds it', async ($, on) => {
  const w = world(on, { 'a.txt': 'one\n' })
  await start($)
  w.hold.add(at('a.txt'))
  const first = edit($, 'a.txt', 'one', 'ONE')
  await settled()
  const undoing = undo($, '1')
  await settled()
  w.held.get(at('a.txt'))!()
  await first
  expect(await undoing).toContain('undid')
})
