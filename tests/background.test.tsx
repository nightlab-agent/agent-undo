import { expect, test } from 'claude-code/testing'
import { ROOT, bash, repoWorld, start, tick, tool, undo } from './world'

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

// ---- Monitor. BuiltinToolInputs.Monitor: `command?: string`, `ws?: { url, protocols? }`, "Cannot be combined with command".
// BuiltinToolResults.Monitor: `taskId`, `timeoutMs`, `persistent?`. The tool answers at once and the command goes on.

const watch = { description: 'watch the build', timeout_ms: 300000 }
const LOG = `${ROOT}/out.log`
const started = () => ({ taskId: 'm1', timeoutMs: 300000 })
/** A Monitor, then a command during which the Monitor's own command writes `out.log`. */
const monitorThenMake = async ($: any, repo: ReturnType<typeof repoWorld>, f: Parameters<typeof tool>[3], input: object) => {
  await tool($, repo, 'Monitor', f, { ...watch, ...input })
  await bash($, repo, 'make', files => { files.set(`${ROOT}/a.txt`, 'a2\n'); files.set(LOG, 'written by the watch\n') })
  return undo($, '')
}

test('a Monitor command stops recording, and its writes are booked to no later command', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  const text = await monitorThenMake($, repo, started, { command: 'tail -f build.log' })
  expect(text).toContain('Shell commands are no longer recorded')
  expect(text).not.toContain('out.log')
  expect(text).not.toContain('Bash make')
})

test('a Monitor stops recording whatever its answer looks like: the declarations could change', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  const text = await monitorThenMake($, repo, () => ({ id: 'renamed' }), { command: 'tail -f build.log' })
  expect(text).toContain('Shell commands are no longer recorded')
})

test('a Monitor started while a command runs costs that command its record', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'make', async f => {
    await tool($, repo, 'Monitor', started, { ...watch, command: 'tail -f build.log' })
    f.set(`${ROOT}/a.txt`, 'a2\n')
  })
  expect(await undo($, '')).not.toContain('Bash make')
})

test('comparison: a Monitor on a socket runs no command here, and recording goes on', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  const text = await monitorThenMake($, repo, started, { ws: { url: 'wss://example.test/events' } })
  expect(text).not.toContain('no longer recorded')
  expect(text).toContain('Bash make (2 files)')
})

test('comparison: a Monitor that answered an error started nothing, and recording goes on', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  const text = await monitorThenMake($, repo, () => 'error', { command: 'tail -f build.log' })
  expect(text).not.toContain('no longer recorded')
  expect(text).toContain('Bash make (2 files)')
})

test('comparison: a Monitor that was denied started nothing, and recording goes on', async ($, on) => {
  on('tool.call', { tool: 'Monitor' }, () => ({ deny: 'no' }) as never)
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  const text = await monitorThenMake($, repo, started, { command: 'tail -f build.log' })
  expect(text).not.toContain('no longer recorded')
  expect(text).toContain('Bash make (2 files)')
})

test('comparison: a tool that only names a task, such as GetTask, does not stop recording', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await tool($, repo, 'GetTask', () => ({ taskId: 'm1', status: 'working' }), { taskId: 'm1' })
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  const text = await undo($, '')
  expect(text).not.toContain('no longer recorded')
  expect(text).toContain('Bash make (1 file)')
})

test('comparison: a Bash command that stays in front still records', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '')).toContain('Bash make (1 file)')
})
