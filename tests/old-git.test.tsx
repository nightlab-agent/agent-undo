import { expect, test } from 'claude-code/testing'
import { ROOT, bash, repoWorld, start, undo } from './world'

// The fake git here answers `rev-parse --path-format=absolute` in the shapes below. No git older than 2.31 ran:
// "as 2.30" is what the audit reports, and real 2.43 does echo a flag it does not know.
const addsOutsideThePrivateIndex = (runs: { argv: string[]; index?: string }[], own: string) =>
  runs.filter(r => r.argv.join(' ') === 'git add -A' && !r.index?.startsWith(`${own}.`))

const paths: Record<string, string> = {
  'as git 2.30 (the flag echoed, the paths relative)': '--path-format=absolute\n.git/index\n.git/agent-undo.index\n',
  'relative paths without the echo': '.git/index\n.git/agent-undo.index\n',
  'an absolute real index but a relative private one': `${ROOT}/.git/index\n.git/agent-undo.index\n`,
  'the two paths the same (GIT_INDEX_FILE set to the private name)': `${ROOT}/.git/agent-undo.index\n${ROOT}/.git/agent-undo.index\n`,
  'the same file spelled twice': `${ROOT}/.git/index\n${ROOT}//.git/index\n`,
  'a private path that is not the private file': `${ROOT}/.git/index\n${ROOT}/.git/other\n`,
  'one path only': `${ROOT}/.git/index\n`,
}

for (const [name, answer] of Object.entries(paths)) {
  test(`git answering ${name}: shell recording stops, nothing touches the real index, and the list says so`, async ($, on) => {
    const repo = repoWorld(on, { 'a.txt': 'a\n' })
    repo.gitPaths = answer
    await start($)
    await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
    expect(addsOutsideThePrivateIndex(repo.envs, `${ROOT}/.git/agent-undo.index`)).toEqual([])
    expect(repo.envs.filter(r => r.argv.join(' ') === 'git add -A')).toEqual([])
    expect(repo.runs.filter(a => a[0] === 'cp')).toEqual([])
    const text = await undo($, '')
    expect(text).not.toContain('Bash make')
    expect(text).toContain('Shell commands are no longer recorded in this session')
    expect(text).toContain('2.31')
  })
}

test('comparison: a current git keeps recording, on the private index only', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(addsOutsideThePrivateIndex(repo.envs, `${ROOT}/.git/agent-undo.index`)).toEqual([])
  expect(repo.envs.filter(r => r.argv.join(' ') === 'git add -A').length).toBe(2)
  const text = await undo($, '')
  expect(text).toContain('Bash make (1 file)')
  expect(text).not.toContain('no longer recorded')
})

test('comparison: a worktree, where both paths sit under the main repo, keeps recording', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  repo.gitPaths = `${ROOT}/.git/worktrees/w/index\n${ROOT}/.git/worktrees/w/agent-undo.index\n`
  await start($)
  await undo($, '')
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') }).catch(() => undefined)
  expect(await undo($, '')).not.toContain('no longer recorded')
})

test('comparison: a Windows path from git counts as absolute', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  repo.gitPaths = 'C:/work/p/.git/index\nC:/work/p/.git/agent-undo.index\n'
  await start($)
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') }).catch(() => undefined)
  expect(await undo($, '')).not.toContain('no longer recorded')
})

test('a command run after the record stopped is left alone, and an undo of an older entry does not touch the index', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'first', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  repo.gitPaths = '--path-format=absolute\n.git/index\n.git/agent-undo.index\n'
  const before = repo.envs.length
  const said = await undo($, '1')
  expect(said).toContain('1.1 left as is')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a2\n')
  expect(repo.envs.slice(before).filter(r => r.index !== undefined)).toEqual([])
})
