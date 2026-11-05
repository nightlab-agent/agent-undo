import { expect, test } from 'claude-code/testing'
import { ROOT, bash, repoWorld, start, tool, undo } from './world'

// When git cannot take a snapshot, the person is told why. The test kit runs no real process, so these replay real
// git's words; tests/git-wipe.sh checks those same words, with exit 128, on real repos (git 2.43).

const UNBORN = "error: 'sub/' does not have a commit checked out\nfatal: adding files failed"
const CRLF = 'fatal: CRLF would be replaced by LF in c.txt'

const make = ($: any, repo: ReturnType<typeof repoWorld>) => bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })

test('a nested repo with no commit: the list and the status line give the first line of git\'s error', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  repo.addFails = UNBORN
  await make($, repo)
  const text = await undo($, '')
  expect(text).toContain("The last command was not recorded: git said error: 'sub/' does not have a commit checked out.")
  expect(text).not.toContain('adding files failed')
  expect(repo.status.join('\n')).toContain("error: 'sub/' does not have a commit checked out")
  expect(text).not.toContain('Bash make')
})

test('core.safecrlf refusing a CRLF file is said too, and the call that tried still ran', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  repo.addFails = CRLF
  await make($, repo)
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a2\n')
  expect(await undo($, '')).toContain(`git said ${CRLF}.`)
})

test('an MCP call that cannot be snapshotted is said in the same words', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  repo.addFails = CRLF
  await tool($, repo, 'mcp__files__write', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '')).toContain(`git said ${CRLF}.`)
})

test('a failure of the second snapshot is said: the command ran and has no record', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  repo.addFails = CRLF
  repo.addsOk = 1
  await make($, repo)
  const text = await undo($, '')
  expect(text).toContain(`git said ${CRLF}.`)
  expect(text).not.toContain('Bash make')
})

test('a retry is the same as the first try: one line, however often it fails', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  repo.addFails = CRLF
  await make($, repo)
  await make($, repo)
  expect((await undo($, '')).split('git said').length).toBe(2)
})

test('once the cause is gone the next command is recorded, and the note and its status line go', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'first', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  repo.addFails = UNBORN
  await bash($, repo, 'blocked', f => { f.set(`${ROOT}/a.txt`, 'a3\n') })
  repo.addFails = undefined
  // A command that changes nothing has no record to replace the status line.
  await bash($, repo, 'ls', () => {})
  await new Promise(r => setTimeout(r, 5))
  expect(await undo($, '')).not.toContain('git said')
  expect(repo.status[repo.status.length - 1]).toContain('#1 Bash')
})

test('with no change yet to name, the status line is cleared once a snapshot works', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  repo.addFails = CRLF
  await bash($, repo, 'blocked', () => {})
  expect(repo.status[repo.status.length - 1]).toContain(CRLF)
  repo.addFails = undefined
  await bash($, repo, 'ls', () => {})
  await new Promise(r => setTimeout(r, 5))
  expect(repo.status[repo.status.length - 1]).toBe('undefined')
})

test('a warning before git\'s error is passed over, and a long line stops at 120 characters', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  const long = `fatal: ${'😀'.repeat(200)}`
  repo.addFails = `warning: in the working copy of 'c.txt', not this one\n${long}\nfatal: nor this`
  await make($, repo)
  const text = await undo($, '')
  expect(text).not.toContain('not this one')
  expect(text).not.toContain('nor this')
  const line = text.split('\n').find(l => l.includes('git said'))!
  const said = line.slice(line.indexOf('fatal:'), -1)
  expect([...said].length).toBe(120)
  expect(said.endsWith('😀')).toBe(true)
})

test('comparison: snapshots that work add no note', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await make($, repo)
  const text = await undo($, '')
  expect(text).toContain('Bash make (1 file)')
  expect(text).not.toContain('git said')
})

test('comparison: a folder that is no git repo stays silent, as nothing failed', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' }, { git: false })
  await start($)
  await make($, repo)
  expect(await undo($, '')).toBe('agent-undo: no edits by Claude in this session yet.')
})

test('a /clear forgets the failure with the rest of the shell state', async ($, on) => {
  on('session.end', (_, e: any) => ({ sessionId: e.sessionId }) as never)
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  repo.addFails = CRLF
  await make($, repo)
  await ($ as any).session.end({ reason: 'clear', sessionId: 'test', resume: { id: 'test' } })
  expect(await undo($, '')).not.toContain('git said')
})
