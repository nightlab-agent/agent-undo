import { expect, test } from 'claude-code/testing'
import { editResult, writeResult } from './engine'
import type { TestBody } from 'claude-code/testing'
import { hunksOf, undoHunk } from '../hooks/register'
import { tempTools } from './temp-tools'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]

const ROOT = '/proj'

// The engine beneath: an in-memory disk, and Edit/Write tools that change it and answer
// with the engine's result shape.
const world = (on: On, files0: Record<string, string> = {}) => {
  const files = new Map(Object.entries(files0))
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  tempTools(on, files)
  on('tool.call', (_, e) => {
    const x = e as unknown as { tool: string; file_path: string; old_string?: string; new_string?: string; content?: string }
    const was = files.get(x.file_path)
    if (x.tool === 'Edit') {
      if (was === undefined || !was.includes(x.old_string!)) return { result: 'String to replace not found', isError: true } as never
      const { disk, result } = editResult(was, x as Parameters<typeof editResult>[1])
      files.set(x.file_path, disk)
      return { result } as never
    }
    files.set(x.file_path, x.content!)
    return { result: writeResult(was, x as Parameters<typeof writeResult>[1]) } as never
  })
  return files
}

const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const edit = ($: $T, file: string, old_string: string, new_string: string, agentId?: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string, new_string, ...(agentId ? { agentId } : {}) } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text

const APP = ['import x', '', 'function a() {', '  return 1', '}', '', 'function b() {', '  return 2', '}', ''].join('\n')

test('lists each edit with its hunks, newest first, paths from the project', async ($, on) => {
  world(on, { [`${ROOT}/app.ts`]: APP })
  await start($)
  await edit($, 'app.ts', '  return 1', '  return 10')
  await edit($, 'app.ts', '  return 2', '  return 20\n  // two')
  const text = await undo($, '')
  expect(text.indexOf('#2 ')).toBeLessThan(text.indexOf('#1 '))
  expect(text).toContain('Edit app.ts')
  expect(text).toContain('2.1 line 8: -1 +2  return 20')
  expect(text).toContain('1.1 line 4: -1 +1  return 10')
})

test('undoes one hunk and keeps the person\'s own change elsewhere in the file', async ($, on) => {
  const files = world(on, { [`${ROOT}/app.ts`]: APP })
  await start($)
  await edit($, 'app.ts', '  return 2', '  return 20')
  // The person edits the top of the file by hand afterwards.
  files.set(`${ROOT}/app.ts`, files.get(`${ROOT}/app.ts`)!.replace('import x', 'import y'))
  expect(await undo($, '1.1')).toContain('undid 1.1 in app.ts')
  expect(files.get(`${ROOT}/app.ts`)).toBe(APP.replace('import x', 'import y'))
})

test('refuses where the person changed the edited lines since, and leaves the file alone', async ($, on) => {
  const files = world(on, { [`${ROOT}/app.ts`]: APP })
  await start($)
  await edit($, 'app.ts', '  return 2', '  return 20')
  const mine = files.get(`${ROOT}/app.ts`)!.replace('  return 20', '  return 21')
  files.set(`${ROOT}/app.ts`, mine)
  const text = await undo($, '1')
  expect(text).toContain('nothing changed in app.ts')
  expect(text).toContain('1.1 left as is: those lines have changed since the edit')
  expect(files.get(`${ROOT}/app.ts`)).toBe(mine)
})

test('out of order: an older edit under a newer one is refused, then undone once the newer is', async ($, on) => {
  const files = world(on, { [`${ROOT}/app.ts`]: APP })
  await start($)
  await edit($, 'app.ts', '  return 2', '  return 20')
  await edit($, 'app.ts', '  return 20', '  return 200')
  expect(await undo($, '1.1')).toContain('left as is')
  expect(await undo($, '2.1')).toContain('undid 2.1')
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(files.get(`${ROOT}/app.ts`)).toBe(APP)
})

test('two at once: edits that land together get distinct numbers and both undo', async ($, on) => {
  const files = world(on, { [`${ROOT}/a.ts`]: APP, [`${ROOT}/b.ts`]: APP })
  await start($)
  await Promise.all([edit($, 'a.ts', '  return 1', '  return 9'), edit($, 'b.ts', '  return 2', '  return 8')])
  const text = await undo($, '')
  expect(text).toContain('#1 ')
  expect(text).toContain('#2 ')
  expect(await undo($, '1')).toContain('undid')
  expect(await undo($, '2')).toContain('undid')
  expect(files.get(`${ROOT}/a.ts`)).toBe(APP)
  expect(files.get(`${ROOT}/b.ts`)).toBe(APP)
})

test('look-alikes: the same lines in two places, only the place the edit left them is undone', () => {
  const block = ['x', 'y', 'z']
  const h = { before: ['x', 'Y', 'z'], after: block, line: 9 }
  const text = ['a', 'b', 'c', 'd', ...block, 'e', ...block].join('\n')
  const got = undoHunk(text, h)
  expect('text' in got && got.text).toEqual( ['a', 'b', 'c', 'd', ...block, 'e', 'x', 'Y', 'z'].join('\n'))
  // Moved off its line and found twice: no guess.
  const moved = ['q', ...text.split('\n')].join('\n')
  expect('refused' in undoHunk(moved, h)).toBe(true)
})

test('keeps Windows line endings', () => {
  const h = hunksOf([{ newStart: 1, lines: [' a', '-b', '+B', ' c'] }])[0]!
  const got = undoHunk('a\r\nB\r\nc\r\n', h)
  expect('text' in got && got.text).toBe('a\r\nb\r\nc\r\n')
})

test('a subagent\'s edit is listed with its agent, and undoes like any other', async ($, on) => {
  const files = world(on, { [`${ROOT}/app.ts`]: APP })
  await start($)
  await edit($, 'app.ts', '  return 1', '  return 7', 'a1b2c3d4e5f6')
  expect(await undo($, '')).toContain('(subagent a1b2c3d4)')
  await undo($, '1')
  expect(files.get(`${ROOT}/app.ts`)).toBe(APP)
})

test('a failed edit is not listed; a new file is listed and not deleted', async ($, on) => {
  const files = world(on, { [`${ROOT}/app.ts`]: APP })
  await start($)
  await edit($, 'app.ts', 'not in the file', 'x')
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/new.ts`, content: 'hi\n' } as never)
  expect(await undo($, '')).toContain('Write new.ts (new file)')
  expect(await undo($, '1')).toContain('Delete it yourself')
  expect(files.get(`${ROOT}/new.ts`)).toBe('hi\n')
})

test('a Write over a file undoes hunk by hunk; a second undo says it was done', async ($, on) => {
  const files = world(on, { [`${ROOT}/app.ts`]: APP })
  await start($)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/app.ts`, content: APP.replace('return 2', 'return 5') } as never)
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(`${ROOT}/app.ts`)).toBe(APP)
  expect(await undo($, '1.1')).toContain('1.1 was already undone')
})

test('an unknown number or hunk changes nothing and says so', async ($, on) => {
  world(on, { [`${ROOT}/app.ts`]: APP })
  await start($)
  await edit($, 'app.ts', '  return 1', '  return 10')
  expect(await undo($, '9')).toContain('no edit "9"')
  expect(await undo($, '1.4')).toContain('has 1 hunk(s); no 1.4')
  expect(await undo($, 'abc')).toContain('no edit "abc"')
})

test('Claude can list and undo through its own tool, with the same words', async ($, on) => {
  const files = world(on, { [`${ROOT}/app.ts`]: APP })
  on('tool.register', () => ({ value: undefined as never }))
  on('tool.check', () => ({ decision: 'allow' }) as never)
  await start($)
  await edit($, 'app.ts', '  return 2', '  return 20')
  const listed = (await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '' } as never)) as { result: string }
  expect(listed.result).toContain('1.1 line')
  const did = (await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '1.1' } as never)) as { result: string }
  expect(did.result).toContain('undid 1.1 in app.ts')
  expect(files.get(`${ROOT}/app.ts`)).toBe(APP)
})
