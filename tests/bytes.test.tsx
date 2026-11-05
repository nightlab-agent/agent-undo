import { expect, test } from 'claude-code/testing'
import { at, bytesOf, edit, editWorld, start, undo } from './edit-world'

// `$.fs.read` gives text as UTF-8 with U+FFFD for what is not, so writing that text back would lose the bytes.
const SEVEN = Array.from({ length: 7 }, (_, k) => `l${k}\n`).join('')

test('a byte that is not UTF-8 elsewhere in the file: the undo refuses and the file stays', async ($, on) => {
  const files = editWorld(on, { 'f.txt': SEVEN })
  await start($)
  await edit($, 'f.txt', 'l1\n', 'one\n')
  const now = files.get(at('f.txt'))!
  bytesOf(files).set(at('f.txt'), [...new TextEncoder().encode(now), 0xe9, 0x0a])
  files.set(at('f.txt'), `${now}�\n`)
  expect(await undo($, '1')).toContain('nothing changed')
  expect(files.get(at('f.txt'))).toBe(`${now}�\n`)
})

test('comparison: a real U+FFFD in the file, good UTF-8: the undo goes ahead and keeps it', async ($, on) => {
  const files = editWorld(on, { 'f.txt': `${SEVEN}�\n` })
  await start($)
  await edit($, 'f.txt', 'l1\n', 'one\n')
  expect(await undo($, '1')).toContain('undid')
  expect(files.get(at('f.txt'))).toBe(`${SEVEN}�\n`)
})

test('the bytes cannot be read: a file showing U+FFFD is left alone', async ($, on) => {
  const files = editWorld(on, { 'f.txt': `${SEVEN}�\n` })
  await start($)
  await edit($, 'f.txt', 'l1\n', 'one\n')
  bytesOf(files).set(at('f.txt'), 'unreadable')
  const now = files.get(at('f.txt'))
  expect(await undo($, '1')).toContain('nothing changed')
  expect(files.get(at('f.txt'))).toBe(now)
})

test('no U+FFFD in the text: the bytes are not asked for', async ($, on) => {
  const files = editWorld(on, { 'f.txt': SEVEN })
  await start($)
  await edit($, 'f.txt', 'l1\n', 'one\n')
  bytesOf(files).set(at('f.txt'), 'unreadable')
  expect(await undo($, '1')).toContain('undid')
  expect(files.get(at('f.txt'))).toBe(SEVEN)
})
