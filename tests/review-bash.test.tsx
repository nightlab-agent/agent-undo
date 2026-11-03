import { expect, test } from 'claude-code/testing'
import { ROOT, bash, edit, repoWorld, start, tick, undo } from './world'

// The code review of the Bash record (2026-11-02, commits 393ff8c..84245ca): each finding as a
// failing test beside a passing comparison. F3 is modelled as the engine runs it: the verdict
// "ask" puts the question before the command, and the person may save a file meanwhile.

// ---- F1 (kind 4/1): a backgrounded command's later writes are booked to the next Bash call.

test('review F1: a background command\'s writes are not booked to a later, read-only command', async ($, on) => {
  const repo = repoWorld(on, { 'gen.txt': 'v1\n' })
  await start($)
  let finish = () => {}
  await bash($, repo, 'npm run gen', f => new Promise<void>(r => { finish = () => { f.set(`${ROOT}/gen.txt`, 'v2\n'); r() } }), { run_in_background: true })
  await tick()
  // the background job (a build, a dev server) writes gen.txt while the next command runs
  await bash($, repo, 'ls', () => finish())
  const text = await undo($, '')
  expect(text).not.toContain('Bash ls')
  // and undoing "ls" must not put back the background job's output
  await undo($, '1')
  expect(repo.files.get(`${ROOT}/gen.txt`)).toBe('v2\n')
})

test('review F1 comparison: a foreground command\'s writes are its own; a later ls is not listed', async ($, on) => {
  const repo = repoWorld(on, { 'gen.txt': 'v1\n' })
  await start($)
  await bash($, repo, 'npm run gen', f => { f.set(`${ROOT}/gen.txt`, 'v2\n') })
  await bash($, repo, 'ls', () => {})
  const text = await undo($, '')
  expect(text).toContain('Bash npm run gen (1 file)')
  expect(text).not.toContain('Bash ls')
})

// ---- F2 (kind 1/2): an Edit that lands after the command ends but before the second snapshot.

test('review F2: an Edit landing between the command\'s end and the after-snapshot is not undone with the command', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  repo.onAdd = async n => { if (n === 2) { repo.onAdd = undefined; await edit($, 'b.txt', 'b', 'B') } }
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  const text = await undo($, '')
  expect(text).not.toMatch(/\d\.\d changed b\.txt/)
  await undo($, '2') // the Bash record (the Edit is #1)
  expect(repo.files.get(`${ROOT}/b.txt`)).toBe('B\n')
})

test('review F2 comparison: an Edit landing while the command runs is left to the Edit record', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'make', async f => { f.set(`${ROOT}/a.txt`, 'a2\n'); await edit($, 'b.txt', 'b', 'B') })
  const text = await undo($, '')
  expect(text).not.toMatch(/\d\.\d changed b\.txt/)
  await undo($, '2')
  expect(repo.files.get(`${ROOT}/b.txt`)).toBe('B\n')
})

// ---- F3 (kind 4): the person edits a file while the permission prompt waits (next(e) holds the
// prompt: claude-code.d.ts:4072-4073); the before-snapshot was taken ahead of it.

test('review F3: a change the person makes while the permission prompt waits is not booked to the command', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'mine.txt': 'draft\n' })
  await start($)
  repo.verdict = 'ask'
  repo.person = f => { f.set(`${ROOT}/mine.txt`, 'my own work\n') } // in their editor, before they press Yes
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  await undo($, '1')
  expect(repo.files.get(`${ROOT}/mine.txt`)).toBe('my own work\n')
})

test('review F3 comparison: a change the person makes after the command finished is refused by undo', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'mine.txt': 'draft\n' })
  await start($)
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  repo.files.set(`${ROOT}/mine.txt`, 'my own work\n')
  await undo($, '1')
  expect(repo.files.get(`${ROOT}/mine.txt`)).toBe('my own work\n')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a\n')
})

// ---- F4 (kind 2): two subagents' Bash calls overlap; the longer one books the shorter one's file.

test('review F4: two overlapping Bash calls (two subagents): neither is recorded, so neither can put back the other\'s file', async ($, on) => {
  // Each tree holds both commands' writes, so no record could say whose a file is: none is kept.
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const first = bash($, repo, 'long-a', async f => { await held; f.set(`${ROOT}/a.txt`, 'a2\n') }, { agentId: 'agent-aaaaaaaa' })
  await tick()
  await bash($, repo, 'short-b', f => { f.set(`${ROOT}/b.txt`, 'b2\n') }, { agentId: 'agent-bbbbbbbb' })
  release()
  await first
  const text = await undo($, '')
  expect(text).not.toContain('Bash long-a')
  expect(text).not.toContain('Bash short-b')
  await undo($, '1')
  expect(repo.files.get(`${ROOT}/b.txt`)).toBe('b2\n')
  // The next command on its own is recorded again.
  await bash($, repo, 'later', f => { f.set(`${ROOT}/a.txt`, 'a3\n') })
  expect(await undo($, '')).toContain('Bash later (1 file)')
})

test('review F4 comparison: the same two calls one after the other each list only their own file', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'short-b', f => { f.set(`${ROOT}/b.txt`, 'b2\n') }, { agentId: 'agent-bbbbbbbb' })
  await bash($, repo, 'long-a', f => { f.set(`${ROOT}/a.txt`, 'a2\n') }, { agentId: 'agent-aaaaaaaa' })
  const text = await undo($, '')
  const a = text.split('\n#').find(s => s.includes('Bash long-a'))!
  expect(a).toContain('changed a.txt')
  expect(a).not.toContain('b.txt')
})

// ---- F5 (kind 3): git reports the repo top with symlinks resolved; Edit's file_path keeps the
// session's spelling, so the exclusion key misses.

test('review F5: an Edit during a command, in a repo reached through a symlink, is still left to the Edit record', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, { top: '/real/proj' })
  await start($)
  await bash($, repo, 'make', async f => { f.set(`${ROOT}/a.txt`, 'a2\n'); await edit($, 'b.txt', 'b', 'B') })
  const text = await undo($, '')
  expect(text).not.toMatch(/\d\.\d changed .*b\.txt/)
})

test('review F5 comparison: the same, in a repo whose top is spelled as the session root', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'make', async f => { f.set(`${ROOT}/a.txt`, 'a2\n'); await edit($, 'b.txt', 'b', 'B') })
  const text = await undo($, '')
  expect(text).not.toMatch(/\d\.\d changed .*b\.txt/)
})

// ---- F6: the person's own git holds .git/index.lock (a commit with its editor open).

test('review F6: an undo works while the person\'s git holds the index lock', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  repo.locked = true
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a\n')
})

test('review F6 comparison: the same undo without a lock', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '1.1')).toContain('undid 1.1')
})

test('a command that runs only after a question is not recorded; one that runs without is', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  repo.verdict = 'ask'
  await bash($, repo, 'asked', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  repo.verdict = 'allow'
  await bash($, repo, 'auto', f => { f.set(`${ROOT}/a.txt`, 'a3\n') })
  const text = await undo($, '')
  expect(text).not.toContain('Bash asked')
  expect(text).toContain('#1 ')
  expect(text).toContain('Bash auto (1 file)')
})
