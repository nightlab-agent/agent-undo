import { expect, test } from 'claude-code/testing'
import { ROOT, bash, repoWorld, start, tick, undo } from './world'

// A command that keeps running stops the shell record for the session: when that holds, and what starts it again.

const end = ($: any, reason: string) => $.session.end({ reason, sessionId: 'test', resume: { id: 'test' } })

// The engine fires session.start again in a running process: "then once per fresh load of one (never /clear)".
test('a second session.start in a running process leaves recording off after a background command', async ($, on) => {
  const repo = repoWorld(on, { 'gen.txt': 'v1\n', 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'npm run dev', () => {}, { run_in_background: true })
  await tick()
  await start($)
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  const text = await undo($, '')
  expect(text).toContain('no longer recorded')
  expect(text).not.toContain('Bash make')
})

test('comparison: a second session.start with no background command changes nothing', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await start($)
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '')).toContain('Bash make (1 file)')
})

test('a command running across a second session.start is still recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'make', async f => { await start($); f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '')).toContain('Bash make (1 file)')
})

for (const reason of ['clear', 'resume']) {
  test(`comparison: a new conversation by ${reason} records again, with no session.start`, async ($, on) => {
    on('session.end', (_, e: any) => ({ sessionId: e.sessionId }) as never)
    const repo = repoWorld(on, { 'a.txt': 'a\n' })
    await start($)
    await bash($, repo, 'npm run dev', () => {}, { run_in_background: true })
    await tick()
    await end($, reason)
    await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
    const text = await undo($, '')
    expect(text).not.toContain('no longer recorded')
    expect(text).toContain('Bash make (1 file)')
  })
}
