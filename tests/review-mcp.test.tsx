// Code review 2026-11-02 (s335) of 6de9a3c..51fe765: each finding is a failing test beside a
// passing comparison case of the nearest normal case.
import { expect, test } from 'claude-code/testing'
import { ROOT, bash, repoWorld, start, tick, tool, undo } from './world'

// R1 (kind 2/3). A read-only (core's isReadOnly; the world answers it for a script that returns 'read-only') MCP call (writes nothing) by a subagent, while the main loop's Bash
// command runs, now costs the Bash command its record; before 51fe765 it was recorded.
test('R1 fail: a read-only MCP call beside a Bash command leaves the Bash command recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const first = bash($, repo, 'build', async f => { await held; f.set(`${ROOT}/a.txt`, 'a2\n') })
  await tick()
  await tool($, repo, 'mcp__github__get_issue', () => 'read-only', { number: 1 })
  release()
  await first
  expect(await undo($, '')).toContain('Bash build (1 file)')
})
test('R1 comparison: a read-only built-in call (WebFetch) beside a Bash command leaves it recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const first = bash($, repo, 'build', async f => { await held; f.set(`${ROOT}/a.txt`, 'a2\n') })
  await tick()
  await tool($, repo, 'WebFetch', () => {}, { url: 'x' })
  release()
  await first
  expect(await undo($, '')).toContain('Bash build (1 file)')
})
test('R1 comparison: an MCP call not held read-only beside a Bash command, though it writes nothing, still costs it its record', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const first = bash($, repo, 'build', async f => { await held; f.set(`${ROOT}/a.txt`, 'a2\n') })
  await tick()
  await tool($, repo, 'mcp__github__get_issue', () => {}, { number: 1 })
  release()
  await first
  expect(await undo($, '')).not.toContain('Bash build')
})
test('R1 comparison: a read-only MCP call still running when the Bash command ends costs it its record', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const call = tool($, repo, 'mcp__github__get_issue', async () => { await held; return 'read-only' as const }, { number: 1 })
  await tick()
  await bash($, repo, 'build', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  release()
  await call
  expect(await undo($, '')).not.toContain('Bash build')
})

// R2 (kind 3). Our own tool is excluded by the server-name prefix, so any configured server named
// agent-undo (a different server) is never recorded. d.ts:6131 "Key trust on source, not on the
// name or the tool-name prefix."
test('R2 fail: a configured server named agent-undo that writes a file is recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await tool($, repo, 'mcp__agent-undo__write_file', f => { f.set(`${ROOT}/a.txt`, 'x\n') })
  expect(await undo($, '')).toContain('1.1 changed a.txt')
})
test('R2 comparison: a server named agent-undo-fork that writes a file is recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await tool($, repo, 'mcp__agent-undo-fork__write_file', f => { f.set(`${ROOT}/a.txt`, 'x\n') })
  expect(await undo($, '')).toContain('1.1 changed a.txt')
})

// R4 (kind 2). The person's /agent-undo while an MCP call runs: the undo's own restore lands in
// the MCP call's window and is recorded as the MCP call's change.
test("R4 fail: an undo run while an MCP call runs is not recorded as that call's change", async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'one', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const call = tool($, repo, 'mcp__filesystem__write_file', async f => { await held; f.set(`${ROOT}/b.txt`, 'b2\n') })
  await tick()
  expect(await undo($, '1')).toContain('undid 1.1: a.txt')
  release()
  await call
  const text = await undo($, '')
  expect(text).toContain('MCP filesystem write_file (1 file)')
  expect(text).not.toContain('2.1 changed a.txt')
})
test('R4 comparison: an undo before the MCP call; the call lists only its own file', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'one', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '1')).toContain('undid 1.1: a.txt')
  await tool($, repo, 'mcp__filesystem__write_file', f => { f.set(`${ROOT}/b.txt`, 'b2\n') })
  const text = await undo($, '')
  expect(text).toContain('MCP filesystem write_file (1 file)')
  expect(text).not.toContain('2.1 changed a.txt')
})
