import { expect, test } from 'claude-code/testing'
import { convertTabs, structuredPatch } from './engine'
import { at, edit, editWorld, start, undo, write } from './edit-world'

const GO = 'func a() int {\n\treturn 1\n}\n'

test('the test world shows tabs as the engine does: leading ones as two spaces, others as they are', () => {
  expect(convertTabs('\t\tx\ty')).toBe('    x\ty')
  expect(structuredPatch(GO, GO.replace('1', '10'))[0]!.lines).toEqual([' func a() int {', '-  return 1', '+  return 10', ' }'])
})

test('a tab-indented line changed by an Edit is undone, tabs and all', async ($, on) => {
  const files = editWorld(on, { 'f.go': GO })
  await start($)
  await edit($, 'f.go', '\treturn 1', '\treturn 10')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.go'))).toBe(GO)
})

test('an Edit that turned a tab into spaces gives the tab back, not two spaces', async ($, on) => {
  const files = editWorld(on, { 'f.py': 'if x:\n\tfoo()\n' })
  await start($)
  await edit($, 'f.py', '\tfoo()', '    foo()')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.py'))).toBe('if x:\n\tfoo()\n')
})

test('an Edit that turned spaces into a tab gives the spaces back', async ($, on) => {
  const files = editWorld(on, { 'f.py': 'if x:\n    foo()\n' })
  await start($)
  await edit($, 'f.py', '    foo()', '\tfoo()')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.py'))).toBe('if x:\n    foo()\n')
})

test('a Write over a tab-indented file is undone with its tabs', async ($, on) => {
  const files = editWorld(on, { 'f.go': GO })
  await start($)
  await write($, 'f.go', GO.replace('\treturn 1', '    return 2'))
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.go'))).toBe(GO)
})

test('tabs in the context lines stay tabs and the person keeps a change elsewhere', async ($, on) => {
  const files = editWorld(on, { 'f.go': 'a\n\tb\n\tc\n\td\n\te\n\tf\n\tg\nh\ni\nj\nk\n' })
  await start($)
  await edit($, 'f.go', '\td\n', '\tD\n')
  files.set(at('f.go'), files.get(at('f.go'))!.replace('k\n', 'mine\n'))
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.go'))).toBe('a\n\tb\n\tc\n\td\n\te\n\tf\n\tg\nh\ni\nj\nmine\n')
})

test('a person who turned the edited tab line into spaces is refused, and the file stays', async ($, on) => {
  const files = editWorld(on, { 'f.go': GO })
  await start($)
  await edit($, 'f.go', '\treturn 1', '\treturn 10')
  files.set(at('f.go'), GO.replace('\treturn 1', '  return 10'))
  expect(await undo($, '1')).toContain('1.1 left as is')
  expect(files.get(at('f.go'))).toBe(GO.replace('\treturn 1', '  return 10'))
})

test('a CRLF file with tabs comes back with both', async ($, on) => {
  const crlf = 'a\r\n\tb\r\nc\r\n'
  const files = editWorld(on, { 'f.txt': crlf })
  await start($)
  await edit($, 'f.txt', '\tb', '\tB')
  expect(files.get(at('f.txt'))).toBe('a\r\n\tB\r\nc\r\n')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(crlf)
})

test('a tab line at the end of a file with no final newline', async ($, on) => {
  const files = editWorld(on, { 'f.go': 'a\n\tb' })
  await start($)
  await edit($, 'f.go', '\tb', '\tB')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.go'))).toBe('a\n\tb')
})

test('a BOM on the first line stays, and tabs below it too', async ($, on) => {
  const text = '\uFEFFa\n\tb\nc\n'
  const files = editWorld(on, { 'f.txt': text })
  await start($)
  await edit($, 'f.txt', '\tb', '\tB')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(text)
})

test('replace_all: every tab line in both hunks comes back', async ($, on) => {
  const text = '\tx\n1\n2\n3\n4\n5\n6\n7\n8\n\tx\n'
  const files = editWorld(on, { 'f.txt': text })
  await start($)
  await edit($, 'f.txt', '\tx', '\ty', { replace_all: true })
  expect(await undo($, '1')).toContain('undid 1.1, 1.2')
  expect(files.get(at('f.txt'))).toBe(text)
})

test('an Edit that deleted a tab line puts the line back', async ($, on) => {
  const files = editWorld(on, { 'f.go': GO })
  await start($)
  await edit($, 'f.go', '\treturn 1', '')
  expect(files.get(at('f.go'))).toBe('func a() int {\n}\n')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.go'))).toBe(GO)
})

test('a new string the engine changed before writing (curly quotes) never writes spaces for a tab', async ($, on) => {
  const was = 'a\n\t\u201Cb\u201D\n'
  const now = 'a\n\t\u201Cc\u201D\n'
  const files = editWorld(on, { 'f.txt': now })
  on('tool.call', { tool: 'Edit' }, (() => ({ result: { filePath: at('f.txt'), oldString: '\t\u201Cb\u201D', newString: '\t"c"', originalFile: was,
    structuredPatch: structuredPatch(was, now), userModified: false, replaceAll: false } })) as never)
  await start($)
  await edit($, 'f.txt', '\t"b"', '\t"c"')
  await undo($, '1')
  expect(files.get(at('f.txt'))).toBe(now)
})

test('a result with no original text is listed but not undone: nothing proves what stood there', async ($, on) => {
  const now = 'a\n  b\n'
  const files = editWorld(on, { 'f.txt': now })
  on('tool.call', { tool: 'Edit' }, (() => ({ result: { filePath: at('f.txt'), oldString: 'x', newString: 'y', originalFile: null,
    structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-  x', '+  b'] }], userModified: false, replaceAll: false } })) as never)
  await start($)
  await edit($, 'f.txt', 'x', 'y')
  await undo($, '1')
  expect(files.get(at('f.txt'))).toBe(now)
})
