import { expect, test } from 'claude-code/testing'
import { ROOT, bash, edit, repoWorld, start, undo } from './world'

// An Edit made through a link to a folder while a command runs. git names the file by its real path and the Edit by the
// path it was given, so only where each lands shows them to be one file.
const at = (p: string) => `${ROOT}/${p}`

test('an Edit through a linked folder during a command stays with the Edit', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'real/b.txt': 'b\n' })
  repo.folderLinks[at('link')] = at('real')
  await start($)
  await bash($, repo, 'make', async f => {
    f.set(at('a.txt'), 'a2\n')
    await edit($, 'link/b.txt', 'b', 'B')
  })
  const text = await undo($, '')
  expect(repo.files.get(at('real/b.txt'))).toBe('B\n')
  expect(text).toContain('Bash make (1 file)')
  expect(text).toContain('changed a.txt')
  expect(text).not.toContain('changed real/b.txt')
})

test('comparison: the same Edit by the real path', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'real/b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'make', async f => {
    f.set(at('a.txt'), 'a2\n')
    await edit($, 'real/b.txt', 'b', 'B')
  })
  const text = await undo($, '')
  expect(text).toContain('Bash make (1 file)')
  expect(text).not.toContain('changed real/b.txt')
})

// The engine folds `..` in a tool's path as text (`path.normalize`, read from the binary), so this Edit writes c.txt at
// the top, not in the link's target's parent. tests/ENGINE-NOTES.md.
test('an Edit with a .. after a link is matched where the engine writes it', async ($, on) => {
  const repo = repoWorld(on, { 'c.txt': 'c\n', 'deep/c.txt': 'c\n', 'deep/real/d.txt': 'd\n' })
  repo.folderLinks[at('link')] = at('deep/real')
  await start($)
  await bash($, repo, 'make', async f => {
    f.set(at('deep/c.txt'), 'the command\n')
    await edit($, 'link/../c.txt', 'c', 'C')
  })
  expect(repo.files.get(at('c.txt'))).toBe('C\n')
  const text = await undo($, '')
  expect(text).toContain('Bash make (1 file)')
  expect(text).toContain('changed deep/c.txt')
  expect(text).not.toContain('changed c.txt')
})

test('a file the Edit changed and the command then deleted is placed through its folder', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'real/b.txt': 'b\n', 'real/keep.txt': 'k\n' })
  repo.folderLinks[at('link')] = at('real')
  await start($)
  await bash($, repo, 'make', async f => {
    f.set(at('a.txt'), 'a2\n')
    await edit($, 'link/b.txt', 'b', 'B')
    f.delete(at('real/b.txt'))
  })
  const text = await undo($, '')
  expect(text).toContain('Bash make (1 file)')
  expect(text).not.toContain('real/b.txt')
})

test('comparison: a file of the same name elsewhere is still the command\'s', async ($, on) => {
  const repo = repoWorld(on, { 'other/b.txt': 'o\n', 'real/b.txt': 'b\n' })
  repo.folderLinks[at('link')] = at('real')
  await start($)
  await bash($, repo, 'make', async f => {
    f.set(at('other/b.txt'), 'o2\n')
    await edit($, 'link/b.txt', 'b', 'B')
  })
  const text = await undo($, '')
  expect(text).toContain('Bash make (1 file)')
  expect(text).toContain('changed other/b.txt')
  expect(text).not.toContain('changed real/b.txt')
})

test('comparison: a path that lands nowhere stays as spelled, and the command is still recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'make', async f => {
    f.set(at('a.txt'), 'a2\n')
    await $.tool.call({ tool: 'Write', file_path: at('gone/x.txt'), content: 'x' } as never).catch(() => undefined)
  })
  expect(await undo($, '')).toContain('Bash make (1 file)')
})
