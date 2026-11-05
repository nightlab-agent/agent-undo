import { expect, test } from 'claude-code/testing'
import { structuredPatch } from './engine'
import { at, edit, editWorld, start, undo, write } from './edit-world'

// Two seven-line blocks, the same but for one line; each edit's hunk is exactly seven lines with its context.
const block = (v: number) => `a\nb\nc\nv = ${v}\nd\ne\nf\n`
const TWO = `top\n${block(2)}${block(1)}`
const SECOND = 'f\na\nb\nc\nv = 1\n'
const lines = (n: number, name = 'new') => Array.from({ length: n }, (_, k) => `${name} ${k}\n`).join('')

test('the real lines changed and a look-alike stands elsewhere: refused, the look-alike stays', async ($, on) => {
  const files = editWorld(on, { 'f.txt': TWO })
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  const mine = `top\n${block(2)}${block(3)}`
  files.set(at('f.txt'), mine)
  expect(await undo($, '1.1')).toContain('1.1 left as is')
  expect(files.get(at('f.txt'))).toBe(mine)
})

test('a later edit adds lines above both blocks: the undo follows its own block', async ($, on) => {
  const files = editWorld(on, { 'f.txt': TWO })
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  await edit($, 'f.txt', 'top\n', `top\n${lines(7)}`)
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(`top\n${lines(7)}${block(2)}${block(1)}`)
})

test('a later Write above both blocks is followed too', async ($, on) => {
  const files = editWorld(on, { 'f.txt': TWO })
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  await write($, 'f.txt', `top\n${lines(7)}${block(2)}${block(2)}`)
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(`top\n${lines(7)}${block(2)}${block(1)}`)
})

test('a later edit removes lines above both blocks: followed', async ($, on) => {
  const start0 = `${lines(7, 'old')}${block(2)}${block(1)}`
  const files = editWorld(on, { 'f.txt': start0 })
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  await edit($, 'f.txt', lines(7, 'old'), '')
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(`${block(2)}${block(1)}`)
})

test('a later edit below the block moves nothing', async ($, on) => {
  const files = editWorld(on, { 'f.txt': `${TWO}end\n` })
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  await edit($, 'f.txt', 'end\n', `end\n${lines(5)}`)
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(`${TWO}end\n${lines(5)}`)
})

test('the later edit undone first puts the older hunk back on its own lines', async ($, on) => {
  const files = editWorld(on, { 'f.txt': TWO })
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  await edit($, 'f.txt', 'top\n', `top\n${lines(7)}`)
  expect(await undo($, '2')).toContain('undid 2.1')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(TWO)
})

test('an older edit undone first moves the newer hunk with it', async ($, on) => {
  const text = `top\n${block(2)}${block(1)}`
  const files = editWorld(on, { 'f.txt': text })
  await start($)
  await edit($, 'f.txt', 'top\n', `top\n${lines(7)}`)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(await undo($, '2')).toContain('undid 2.1')
  expect(files.get(at('f.txt'))).toBe(text)
})

test('the person adds lines above both blocks: position unproven, refused', async ($, on) => {
  const files = editWorld(on, { 'f.txt': TWO })
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  const mine = `top\n${lines(7, 'mine')}${block(2)}${block(2)}`
  files.set(at('f.txt'), mine)
  expect(await undo($, '1.1')).toContain('1.1 left as is')
  expect(files.get(at('f.txt'))).toBe(mine)
})

test('the person adds lines above and a later edit follows: still refused, the count stays off', async ($, on) => {
  const files = editWorld(on, { 'f.txt': `${TWO}end\n` })
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  files.set(at('f.txt'), `top\n${lines(7, 'mine')}${block(2)}${block(2)}end\n`)
  await edit($, 'f.txt', 'end\n', 'END\n')
  const mine = files.get(at('f.txt'))
  expect(await undo($, '1.1')).toContain('1.1 left as is')
  expect(files.get(at('f.txt'))).toBe(mine)
})

test('comparison: lines that stood once, the person adds above: found and undone', async ($, on) => {
  const text = 'q\nr\ns\nx = 1\nt\nu\nv\n'
  const files = editWorld(on, { 'f.txt': text })
  await start($)
  await edit($, 'f.txt', 'x = 1', 'x = 2')
  files.set(at('f.txt'), `mine\n${files.get(at('f.txt'))}`)
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(`mine\n${text}`)
})

test('comparison: lines that stood once, the person adds above and below: found and undone', async ($, on) => {
  const text = 'q\nr\ns\nx = 1\nt\nu\nv\n'
  const files = editWorld(on, { 'f.txt': text })
  await start($)
  await edit($, 'f.txt', 'x = 1', 'x = 2')
  files.set(at('f.txt'), `m1\nm2\n${files.get(at('f.txt'))}m3\n`)
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(`m1\nm2\n${text}m3\n`)
})

test('comparison: both blocks untouched, the undo takes the place the edit left them', async ($, on) => {
  const files = editWorld(on, { 'f.txt': TWO })
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(TWO)
})

test('lines that stood once, then a person pasted a copy above: two places, refused', async ($, on) => {
  const files = editWorld(on, { 'f.txt': 'q\nr\ns\nx = 1\nt\nu\nv\n' })
  await start($)
  await edit($, 'f.txt', 'x = 1', 'x = 2')
  const edited = files.get(at('f.txt'))!
  files.set(at('f.txt'), `${edited}${edited}`)
  expect(await undo($, '1')).toContain('1.1 left as is')
  expect(files.get(at('f.txt'))).toBe(`${edited}${edited}`)
})

test('a later edit copies the lines elsewhere, then the first copy changes: not taken for the first', async ($, on) => {
  const files = editWorld(on, { 'f.txt': 'q\nr\ns\nx = 1\nt\nu\nv\nend\n' })
  await start($)
  await edit($, 'f.txt', 'x = 1', 'x = 2')
  await edit($, 'f.txt', 'end\n', 'end\nq\nr\ns\nx = 2\nt\nu\nv\n')
  await edit($, 'f.txt', 's\nx = 2\nt', 's\nx = 3\nt')
  const now = files.get(at('f.txt'))
  expect(await undo($, '1')).toContain('1.1 left as is')
  expect(files.get(at('f.txt'))).toBe(now)
})

test('a later change with no diff (timed out) leaves the place unknown: look-alikes are refused', async ($, on) => {
  let quiet = false
  const files = editWorld(on, { 'f.txt': TWO }, r => (quiet ? { ...r, structuredPatch: [] } : r))
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  quiet = true
  const now = `top\n${lines(7)}${block(2)}${block(2)}`
  await write($, 'f.txt', now)
  expect(await undo($, '1.1')).toContain('1.1 left as is')
  expect(files.get(at('f.txt'))).toBe(now)
})

test('comparison: a later change with no diff, lines that stood once: found and undone', async ($, on) => {
  let quiet = false
  const text = 'q\nr\ns\nx = 1\nt\nu\nv\n'
  const files = editWorld(on, { 'f.txt': text }, r => (quiet ? { ...r, structuredPatch: [] } : r))
  await start($)
  await edit($, 'f.txt', 'x = 1', 'x = 2')
  quiet = true
  await write($, 'f.txt', `head\n${text.replace('x = 1', 'x = 2')}`)
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(`head\n${text}`)
})

test('a Write that changed nothing moves nothing', async ($, on) => {
  const files = editWorld(on, { 'f.txt': TWO })
  await start($)
  await edit($, 'f.txt', SECOND, 'f\na\nb\nc\nv = 2\n')
  await write($, 'f.txt', files.get(at('f.txt'))!)
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(files.get(at('f.txt'))).toBe(TWO)
})

test('the list shows a hunk at the line it now stands on', async ($, on) => {
  const files = editWorld(on, { 'f.txt': 'a\nb\nc\nd\ne\nf\ng\nh\n' })
  await start($)
  await edit($, 'f.txt', 'g\n', 'G\n')
  expect(await undo($, '')).toContain('1.1 line 7')
  await edit($, 'f.txt', 'a\n', `a\n${lines(2)}`)
  expect(await undo($, '')).toContain('1.1 line 9')
  expect(files.size).toBe(1)
})

test('several hunks of one edit, a later edit above them: each follows, all come back', async ($, on) => {
  const text = 'top\n1\n2\n3\n4\nx\n5\n6\n7\n8\n9\n10\n11\nx\n12\n'
  const files = editWorld(on, { 'f.txt': text })
  await start($)
  await edit($, 'f.txt', 'x\n', 'y\n', { replace_all: true })
  await edit($, 'f.txt', 'top\n', `top\n${lines(4)}`)
  expect(await undo($, '1')).toContain('undid 1.1, 1.2')
  expect(files.get(at('f.txt'))).toBe(`top\n${lines(4)}${text.slice(4)}`)
})

test('the test world gives one hunk for a change inside repeated blocks', () => {
  const got = structuredPatch(TWO, TWO.replace(SECOND, 'f\na\nb\nc\nv = 2\n'))
  expect(got.length).toBe(1)
  expect(got[0]!.lines.filter(l => l[0] !== ' ')).toEqual(['-v = 1', '+v = 2'])
})
