import { expect, test } from 'claude-code/testing'
import { filesOf, fileKey } from '../hooks/register'
import { ROOT, bash, repoWorld, start, undo } from './world'

const Z = (rows: string[][]) => rows.map(([meta, path]) => `${meta}\0${path}\0`).join('')
const A = 'a'.repeat(40), B = 'b'.repeat(40), O = '0'.repeat(40)

test('reads git diff-tree -z: changed, deleted, new, and a path with a space and a newline', async () => {
  const out = Z([
    [`:100644 100644 ${A} ${B} M`, 'src/a.ts'],
    [`:100644 000000 ${A} ${O} D`, 'gone.txt'],
    [`:000000 100755 ${O} ${B} A`, 'run me.sh'],
    [`:100644 100644 ${A} ${B} M`, 'odd\nname'],
  ])
  expect(filesOf(out)).toEqual([
    { path: 'src/a.ts', status: 'M', before: A, after: B },
    { path: 'gone.txt', status: 'D', before: A },
    { path: 'run me.sh', status: 'A', after: B, exec: true },
    { path: 'odd\nname', status: 'M', before: A, after: B },
  ])
})

test('a submodule or a symlink change is listed but marked as not undoable here', async () => {
  const out = Z([[`:160000 160000 ${A} ${B} M`, 'vendor/lib'], [`:120000 120000 ${A} ${B} M`, 'link']])
  expect(filesOf(out).map(f => f.fixed)).toEqual(['a submodule', 'a symbolic link'])
})

test('empty output is no files', async () => {
  expect(filesOf('')).toEqual([])
})


test('a shell command that changes, deletes and creates files is listed as one numbered change', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n', 'keep.txt': 'k\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', f => {
    f.set(`${ROOT}/a.txt`, 'a2\n'); f.delete(`${ROOT}/gone.txt`); f.set(`${ROOT}/new.txt`, 'n\n')
  })
  const text = await undo($, '')
  expect(text).toContain('Bash sh tidy.sh (3 files)')
  expect(text).toContain('1.1 changed a.txt')
  expect(text).toContain('1.2 deleted gone.txt')
  expect(text).toContain('1.3 new file new.txt')
  expect(text).not.toContain('keep.txt')
})

test('a shell command that changes nothing is not listed', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'ls', () => {})
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
})

test('outside a git work tree, a shell command is not recorded and the command still runs', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' }, { git: false })
  await start($)
  await bash($, repo, 'sed', f => f.set(`${ROOT}/a.txt`, 'b\n'))
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('b\n')
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
})

test('the private index is seeded once from the real one, and never the real index itself', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'one', f => f.set(`${ROOT}/a.txt`, 'b\n'))
  await bash($, repo, 'two', f => f.set(`${ROOT}/a.txt`, 'c\n'))
  const cp = repo.runs.filter(r => r[0] === 'cp')
  expect(cp.length).toBe(1)
  expect(cp[0]![1]).toBe(`${ROOT}/.git/index`)
  expect(cp[0]![2]).toStartWith(`${ROOT}/.git/agent-undo.index.`)
})

test('a file Claude edited with Edit while a shell command ran is left to the Edit record', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'slow', f => {
    f.set(`${ROOT}/a.txt`, 'a2\n')
    // Mid-command, an Edit lands on b.txt (parallel tool calls).
    void $.tool.call({ tool: 'Edit', file_path: `${ROOT}/b.txt`, old_string: 'b', new_string: 'B' } as never)
  })
  const text = await undo($, '')
  expect(text).toMatch(/Bash slow \(1 file\)/)
  expect(text).toContain('changed a.txt')
  expect(text).not.toMatch(/\d\.\d changed b\.txt/)
})

const tidy = (f: Map<string, string>) => {
  f.set(`${ROOT}/a.txt`, 'a2\n'); f.delete(`${ROOT}/gone.txt`); f.set(`${ROOT}/new.txt`, 'n\n')
}

test('undoes one file of a shell command; the command\'s other files stay', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', tidy)
  expect(await undo($, '1.1')).toContain('undid 1.1: a.txt')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a\n')
  expect(repo.files.has(`${ROOT}/gone.txt`)).toBe(false)
  expect(repo.files.get(`${ROOT}/new.txt`)).toBe('n\n')
  expect(await undo($, '')).toContain('1.1 changed a.txt  (undone)')
})

test('brings back a file the command deleted', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', tidy)
  expect(await undo($, '1.2')).toContain('undid 1.2: gone.txt')
  expect(repo.files.get(`${ROOT}/gone.txt`)).toBe('old\n')
})

test('all of one command: changed and deleted files come back, a new file is listed, never deleted', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', tidy)
  const text = await undo($, '1')
  expect(text).toContain('undid 1.1, 1.2: a.txt, gone.txt')
  expect(text).toContain('1.3 left as is: new.txt is a new file; nothing was there before. Delete it yourself if you want it gone.')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a\n')
  expect(repo.files.get(`${ROOT}/gone.txt`)).toBe('old\n')
  expect(repo.files.get(`${ROOT}/new.txt`)).toBe('n\n')
})

test('refuses a file the person changed since the command, and leaves it alone', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', tidy)
  repo.files.set(`${ROOT}/a.txt`, 'mine\n')
  repo.files.set(`${ROOT}/gone.txt`, 'mine too\n')
  const text = await undo($, '1')
  expect(text).toContain('1.1 left as is: a.txt has changed since the command')
  expect(text).toContain('1.2 left as is: there is a file at gone.txt again')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('mine\n')
  expect(repo.files.get(`${ROOT}/gone.txt`)).toBe('mine too\n')
})

test('out of order: an older command under a newer one is refused, then undone once the newer is', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'first', f => f.set(`${ROOT}/a.txt`, 'b\n'))
  await bash($, repo, 'second', f => f.set(`${ROOT}/a.txt`, 'c\n'))
  expect(await undo($, '1.1')).toContain('1.1 left as is: a.txt has changed since the command')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('c\n')
  expect(await undo($, '2.1')).toContain('undid 2.1')
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a\n')
})

test('a second undo of the same file says it was done; an unknown file number changes nothing', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', tidy)
  await undo($, '1.1')
  expect(await undo($, '1.1')).toContain('1.1 was already undone')
  expect(await undo($, '1.9')).toContain('#1 has 3 file(s); no 1.9.')
})

test('look-alikes: one file spelled two ways is one key; two files are two', async () => {
  expect(fileKey('c:\\proj\\b.txt')).toBe(fileKey('C:/proj/b.txt'))
  expect(fileKey('/proj/b.txt')).toBe(fileKey('/proj//b.txt/'))
  expect(fileKey('/proj/b.txt')).not.toBe(fileKey('/proj/B.txt'))
  expect(fileKey('C:/proj/b.txt')).not.toBe(fileKey('C:/proj/b.txt.bak'))
})

test('the list\'s footer names a number from the list, not a made-up one', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'one', f => { f.set(`${ROOT}/a.txt`, 'b\n') })
  const text = await undo($, '')
  expect(text).toContain('Undo one: /agent-undo 1.1   all of #1: /agent-undo 1')
  expect(text).not.toContain('3.1')
})
