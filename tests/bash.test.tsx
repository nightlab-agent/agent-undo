import { expect, test } from 'claude-code/testing'
import { filesOf } from '../hooks/register'

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
    { path: 'run me.sh', status: 'A', after: B },
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
