import { expect, test } from 'claude-code/testing'
import { ROOT, bash, repoWorld, start, undo } from './world'

// A shell undo of a deleted file, where what stands in its way is not the file itself; and a change a git filter hides.
const at = (p: string) => `${ROOT}/${p}`
const gone = (f: Map<string, string>) => { f.delete(at('notes/todo.txt')) }

test('a deleted file whose folder is now a file: refused, the person\'s file stays', async ($, on) => {
  const repo = repoWorld(on, { 'notes/todo.txt': 'todo\n' })
  await start($)
  await bash($, repo, 'rm -rf notes', gone)
  repo.files.set(at('notes'), 'mine\n')
  const text = await undo($, '1.1')
  expect(text).toContain('1.1 left as is')
  expect(text).toContain('notes')
  expect(repo.files.get(at('notes'))).toBe('mine\n')
  expect(repo.runs.filter(a => a[1] === 'restore')).toEqual([])
})

test('the command itself made a file where the folder stood: refused, a created file is never deleted', async ($, on) => {
  const repo = repoWorld(on, { 'dir/a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'rm -rf dir && echo made > dir', f => { f.delete(at('dir/a.txt')); f.set(at('dir'), 'made\n') })
  expect(await undo($, '1')).toContain('left as is')
  expect(repo.files.get(at('dir'))).toBe('made\n')
  expect(repo.runs.filter(a => a[1] === 'restore')).toEqual([])
})

test('a deleted file whose folder is now a link: refused', async ($, on) => {
  const repo = repoWorld(on, { 'notes/todo.txt': 'todo\n', 'other/x.txt': 'x\n' })
  await start($)
  await bash($, repo, 'rm -rf notes', gone)
  repo.links.add(at('notes'))
  expect(await undo($, '1.1')).toContain('1.1 left as is')
  expect(repo.runs.filter(a => a[1] === 'restore')).toEqual([])
})

test('a link that leads nowhere stands where the file was: refused, though exists says no', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'rm a.txt', f => { f.delete(at('a.txt')) })
  repo.links.add(at('a.txt'))
  expect(await undo($, '1.1')).toContain('1.1 left as is')
  expect(repo.runs.filter(a => a[1] === 'restore')).toEqual([])
})

test('for comparison, the folder is gone too: the file and its folder come back', async ($, on) => {
  const repo = repoWorld(on, { 'notes/deep/todo.txt': 'todo\n' })
  await start($)
  await bash($, repo, 'rm -rf notes', f => { f.delete(at('notes/deep/todo.txt')) })
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(repo.files.get(at('notes/deep/todo.txt'))).toBe('todo\n')
})

test('for comparison, the folder still stands: the file comes back', async ($, on) => {
  const repo = repoWorld(on, { 'notes/todo.txt': 'todo\n', 'notes/keep.txt': 'keep\n' })
  await start($)
  await bash($, repo, 'rm notes/todo.txt', gone)
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(repo.files.get(at('notes/todo.txt'))).toBe('todo\n')
})

test('a file under a git filter: refused, since the filter can hide a later change', async ($, on) => {
  const repo = repoWorld(on, { 'n.nb': 'a\n' })
  repo.filters['n.nb'] = 'nbstripout'
  await start($)
  await bash($, repo, 'make', f => { f.set(at('n.nb'), 'b\n') })
  const text = await undo($, '1.1')
  expect(text).toContain('1.1 left as is')
  expect(text).toContain('filter')
  expect(repo.files.get(at('n.nb'))).toBe('b\n')
})

test('a deleted file under a git filter still comes back: nothing of the person\'s is there to lose', async ($, on) => {
  const repo = repoWorld(on, { 'n.nb': 'a\n' })
  repo.filters['n.nb'] = 'nbstripout'
  await start($)
  await bash($, repo, 'rm n.nb', f => { f.delete(at('n.nb')) })
  expect(await undo($, '1.1')).toContain('undid 1.1')
})

for (const value of ['unspecified', 'unset']) {
  test(`for comparison, filter ${value}: the undo goes ahead`, async ($, on) => {
    const repo = repoWorld(on, { 'a.txt': 'a\n' })
    repo.filters['a.txt'] = value
    await start($)
    await bash($, repo, 'make', f => { f.set(at('a.txt'), 'b\n') })
    expect(await undo($, '1.1')).toContain('undid 1.1')
    expect(repo.files.get(at('a.txt'))).toBe('a\n')
  })
}
