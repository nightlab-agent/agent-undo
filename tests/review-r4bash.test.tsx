import { expect, test } from 'claude-code/testing'
import { ROOT, bash, repoWorld, start, tick, undo } from './world'
test('R4 Bash variant (pre-existing?): an undo while a Bash command runs', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'one', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const call = bash($, repo, 'two', async f => { await held; f.set(`${ROOT}/b.txt`, 'b2\n') })
  await tick()
  expect(await undo($, '1')).toContain('undid 1.1: a.txt')
  release()
  await call
  expect(await undo($, '')).not.toContain('2.1 changed a.txt')
})
