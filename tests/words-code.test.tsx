import { expect, test } from 'claude-code/testing'
import { ROOT, bash, repoWorld, start, tick, undo } from './world'

// From the words critic of 0.2.0 (s313): two claims the code did not keep.

test('a command approved at a prompt that goes to the background still stops shell records', async ($, on) => {
  const repo = repoWorld(on, { 'gen.txt': 'v1\n', 'a.txt': 'a\n' })
  await start($)
  repo.verdict = 'ask'
  let finish = () => {}
  await bash($, repo, 'npm run dev', f => new Promise<void>(r => { finish = () => { f.set(`${ROOT}/gen.txt`, 'v2\n'); r() } }), { run_in_background: true })
  await tick()
  repo.verdict = 'allow'
  await bash($, repo, 'touch a', f => { f.set(`${ROOT}/a.txt`, 'a2\n'); finish() })
  const text = await undo($, '')
  expect(text).not.toContain('Bash touch a')
  expect(text).toContain('Shell commands are no longer recorded in this session')
})

test('comparison: an approved foreground command does not stop later records', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  repo.verdict = 'ask'
  await bash($, repo, 'asked', f => { f.set(`${ROOT}/a.txt`, 'a1\n') })
  repo.verdict = 'allow'
  await bash($, repo, 'auto', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '')).toContain('Bash auto (1 file)')
})

test('when the private index points at objects git gc removed, it is seeded again and the command is recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'first', f => { f.set(`${ROOT}/a.txt`, 'a1\n') })
  repo.pruned = true // the private index now names objects `git prune` removed
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '')).toContain('Bash make (1 file)')
})
