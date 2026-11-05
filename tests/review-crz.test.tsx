import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { ROOT, bash, edit, repoWorld, start, tick, undo } from './world'
import type { On } from './world'

const at = (p: string) => `${ROOT}/${p}`
const ticks = async (n = 12) => { for (let i = 0; i < n; i++) await tick() }

// ---- Claude's undo tool and the person's permissions

test('with Claude Code refusing the call, the undo tool changes no file', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  repo.verdict = 'deny'
  await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '1', tool_use_id: 'u1' } as never)
  expect(repo.files.get(at('a.txt'))).toBe('one\nTWO\n')
})

test('comparison: with Claude Code refusing the call, an Edit changes no file', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  repo.verdict = 'deny'
  await edit($, 'a.txt', 'one', 'ONE')
  expect(repo.files.get(at('a.txt'))).toBe('one\nTWO\n')
})

// ---- A shell undo: its check, then a wait in the index queue, then git

const slowUndo = async ($: Parameters<TestBody>[0], repo: ReturnType<typeof repoWorld>) => {
  await bash($, repo, 'change a', f => { f.set(at('a.txt'), 'a2\n') })
  let open = () => {}
  const gate = new Promise<void>(r => { open = r })
  repo.onAdd = () => gate
  const running = bash($, repo, 'slow', f => { f.set(at('b.txt'), 'b2\n') })
  await ticks()
  return { running, open }
}

test('a save made while the undo waits behind a running snapshot stays', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  const { running, open } = await slowUndo($, repo)
  const undone = undo($, '1')
  await ticks()
  repo.files.set(at('a.txt'), 'my save\n')
  repo.onAdd = undefined
  open()
  const text = await undone
  await running
  expect(repo.files.get(at('a.txt'))).toBe('my save\n')
  expect(text).toContain('left as is')
})

test('comparison: the same save before the undo starts stays', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  const { running, open } = await slowUndo($, repo)
  repo.files.set(at('a.txt'), 'my save\n')
  const undone = undo($, '1')
  await ticks()
  repo.onAdd = undefined
  open()
  const text = await undone
  await running
  expect(repo.files.get(at('a.txt'))).toBe('my save\n')
  expect(text).toContain('left as is')
})

// ---- A changed file whose folder is now a link. Real git replaces the link (tests/review-crz-realgit.sh, case 1).
// In this fake the file reads through the link, as `$.fs.exists` and `git hash-object` do on a real disk.

test('a changed file under a folder that is now a link is left as is', async ($, on) => {
  const repo = repoWorld(on, { 'src/f.txt': 'one\n', 'src/g.txt': 'keep\n' })
  await start($)
  await bash($, repo, 'change f', f => { f.set(at('src/f.txt'), 'two\n') })
  repo.links.add(at('src'))
  const text = await undo($, '1')
  expect(repo.runs.some(r => r[1] === 'restore')).toBe(false)
  expect(text).toContain('left as is')
})

test('comparison: a deleted file under a folder that is now a link is left as is', async ($, on) => {
  const repo = repoWorld(on, { 'src/f.txt': 'one\n', 'src/g.txt': 'keep\n' })
  await start($)
  await bash($, repo, 'delete f', f => { f.delete(at('src/f.txt')) })
  repo.links.add(at('src'))
  const text = await undo($, '1')
  expect(repo.runs.some(r => r[1] === 'restore')).toBe(false)
  expect(text).toContain('left as is')
})

// ---- git refusing the repo: `fatal: detected dubious ownership` (real git's words, GIT_TEST_ASSUME_DIFFERENT_OWNER=1).
// A repo on a Windows drive under WSL, or mounted into a container, is the usual way to meet it.

const dubious = (on: On, onlyAdd = false) => ((name: string, f: (h: unknown, e: { argv: string[] }) => unknown) => {
  if (name !== 'process.run') return (on as any)(name, f)
  return (on as any)(name, (h: unknown, e: { argv: string[] }) => (!onlyAdd && e.argv[1] === 'rev-parse'
    ? { value: { exitCode: 128, stdout: '', stderr: "fatal: detected dubious ownership in repository at '/proj'\n" } } : f(h, e)))
}) as unknown as On

test('a repo git refuses: the list gives git\'s line, as for a failed snapshot', async ($, on) => {
  const repo = repoWorld(dubious(on), { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'rm a', f => { f.delete(at('a.txt')) })
  expect(await undo($, '')).toContain('dubious ownership')
})

test('comparison: a failed git add gives git\'s line in the list', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  repo.addFails = "fatal: detected dubious ownership in repository at '/proj'"
  await start($)
  await bash($, repo, 'rm a', f => { f.delete(at('a.txt')) })
  expect(await undo($, '')).toContain('dubious ownership')
})

// ---- An Edit run on another machine (`_host`, read from the 2.1.312 binary; tests/ENGINE-NOTES.md). The local file
// reads the same; an undo here changes a file the edit never touched.

test('an Edit on another machine is not undone on this one', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: at('a.txt'), old_string: 'two', new_string: 'TWO', _host: 'laptop' } as never)
  const text = await undo($, '1')
  expect(repo.files.get(at('a.txt'))).toBe('one\nTWO\n')
  expect(text).not.toContain('undid')
})

test('comparison: an Edit here is undone here', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  const text = await undo($, '1')
  expect(repo.files.get(at('a.txt'))).toBe('one\ntwo\n')
  expect(text).toContain('undid')
})

// ---- The README's first snapshot of "30 s or more", under the 20 s the code gives git. The engine kills a child at
// timeoutMs and the call rejects (engine declarations, ProcessRunInit.timeoutMs).

const slowFirst = (on: On, need: number) => ((name: string, f: (h: unknown, e: { argv: string[]; init?: { timeoutMs?: number } }) => unknown) => {
  if (name !== 'process.run') return (on as any)(name, f)
  return (on as any)(name, (h: unknown, e: { argv: string[]; init?: { timeoutMs?: number } }) => {
    if (e.argv[1] === 'add' && (e.init?.timeoutMs ?? 30000) < need) throw new Error('timed out')
    return f(h, e)
  })
}) as unknown as On

test('a first snapshot of 30 s, which the README allows, is recorded', async ($, on) => {
  const repo = repoWorld(slowFirst(on, 30000), { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'rm a', f => { f.delete(at('a.txt')) })
  expect(await undo($, '')).toContain('Bash rm a')
})

test('comparison: a snapshot of 12 ms is recorded', async ($, on) => {
  const repo = repoWorld(slowFirst(on, 12), { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'rm a', f => { f.delete(at('a.txt')) })
  expect(await undo($, '')).toContain('Bash rm a')
})

// ---- git stops after it took the file away (real git: tests/review-crz-realgit.sh, case 5).

const cutShort = (on: On, gone: boolean, files: () => Map<string, string>) => ((name: string, f: (h: unknown, e: { argv: string[] }) => unknown) => {
  if (name !== 'process.run') return (on as any)(name, f)
  return (on as any)(name, (h: unknown, e: { argv: string[] }) => {
    if (e.argv[1] !== 'restore') return f(h, e)
    if (gone) files().delete(at('a.txt'))
    return { value: { exitCode: 255, stdout: '', stderr: 'error: unable to read sha1 file of a.txt\n' } }
  })
}) as unknown as On

test('a git restore that took the file away is not called left as is', async ($, on) => {
  let got = new Map<string, string>()
  const repo = repoWorld(cutShort(on, true, () => got), { 'a.txt': 'a\n' })
  got = repo.files
  await start($)
  await bash($, repo, 'change a', f => { f.set(at('a.txt'), 'a2\n') })
  const text = await undo($, '1')
  expect(repo.files.has(at('a.txt'))).toBe(false)
  expect(text).not.toContain('left as is')
})

test('comparison: a git restore that stopped first is left as is', async ($, on) => {
  let got = new Map<string, string>()
  const repo = repoWorld(cutShort(on, false, () => got), { 'a.txt': 'a\n' })
  got = repo.files
  await start($)
  await bash($, repo, 'change a', f => { f.set(at('a.txt'), 'a2\n') })
  const text = await undo($, '1')
  expect(repo.files.get(at('a.txt'))).toBe('a2\n')
  expect(text).toContain('left as is')
})
