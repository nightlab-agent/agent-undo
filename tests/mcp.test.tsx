// MCP tools: Claude Code's checkpoints track only its own Edit and Write; a file an MCP server's
// tool writes is recorded here the way a Bash command is (git snapshots around the call), and its
// undo is the shell undo. agent-undo's own tool and any non-MCP tool are left alone.
import { expect, test } from 'claude-code/testing'
import { isMcp, mcpLabel } from '../hooks/register'
import { ownTool } from '../hooks/shell'
import { ROOT, bash, repoWorld, start, tick, tool, undo } from './world'

const WRITE = 'mcp__filesystem__write_file'

test('an MCP tool that writes a file is listed with its file, readably named, and undone', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  const done = await tool($, repo, WRITE, f => { f.set(`${ROOT}/a.txt`, 'from mcp\n') }, { path: 'a.txt', content: 'from mcp\n' })
  // The call and its answer are the tool's own.
  expect((done as { text?: string }).text).toBe('ok')
  const text = await undo($, '')
  expect(text).toMatch(/#1 \d\d:\d\d:\d\d MCP filesystem write_file \(1 file\)/)
  expect(text).toContain('1.1 changed a.txt')
  // The person's own git holds the real index's lock: the undo runs on the private index.
  repo.locked = true
  expect(await undo($, '1')).toContain('undid 1.1: a.txt')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a\n')
})

test('an MCP tool that creates a file: listed as new, and the undo never deletes it', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await tool($, repo, WRITE, f => { f.set(`${ROOT}/new.txt`, 'n\n') })
  expect(await undo($, '')).toContain('1.1 new file new.txt')
  expect(await undo($, '1')).toContain('new.txt is a new file; nothing was there before')
  expect(repo.files.get(`${ROOT}/new.txt`)).toBe('n\n')
})

test('a non-MCP tool this mod does not know is passed through and not recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  const done = await tool($, repo, 'NotebookEdit', f => { f.set(`${ROOT}/a.txt`, 'b\n') })
  expect((done as { text?: string }).text).toBe('ok')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('b\n')
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
  expect(repo.runs.some(r => r.join(' ') === 'git add -A')).toBe(false)
})

test("agent-undo's own tool is not recorded, though its undo changes a file", async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'one', f => { f.set(`${ROOT}/a.txt`, 'b\n') })
  const id = 'toolu_own_1'
  await ($ as any).tool.check({ tool: 'mcp__agent-undo__undo', input: { ref: '1' }, tool_use_id: id })
  const done = await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '1', tool_use_id: id } as never) as { result?: unknown }
  expect(String(done.result)).toContain('undid 1.1: a.txt')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a\n')
  const text = await undo($, '')
  expect(text).not.toContain('#2')
  expect(text).not.toContain('MCP agent-undo')
})

test('an MCP call running while a Bash command runs: neither is recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const first = bash($, repo, 'long-a', async f => { await held; f.set(`${ROOT}/a.txt`, 'a2\n') })
  await tick()
  await tool($, repo, WRITE, f => { f.set(`${ROOT}/b.txt`, 'b2\n') })
  release()
  await first
  const text = await undo($, '')
  expect(text).not.toContain('Bash long-a')
  expect(text).not.toContain('MCP filesystem')
  // The next call on its own is recorded again.
  await tool($, repo, WRITE, f => { f.set(`${ROOT}/b.txt`, 'b3\n') })
  expect(await undo($, '')).toContain('MCP filesystem write_file (1 file)')
})

test('two MCP calls at once: neither is recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const first = tool($, repo, WRITE, async f => { await held; f.set(`${ROOT}/a.txt`, 'a2\n') })
  await tick()
  await tool($, repo, 'mcp__filesystem__edit_file', f => { f.set(`${ROOT}/b.txt`, 'b2\n') })
  release()
  await first
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
})

test('an MCP call that is denied, asked about, or answers an error records nothing', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  repo.verdict = 'deny'
  await tool($, repo, WRITE, f => { f.set(`${ROOT}/a.txt`, 'denied\n') })
  repo.verdict = 'ask'
  await tool($, repo, WRITE, f => { f.set(`${ROOT}/a.txt`, 'asked\n') })
  repo.verdict = 'allow'
  const done = await tool($, repo, WRITE, f => { f.set(`${ROOT}/a.txt`, 'half\n'); return 'error' })
  // The error is the tool's, passed on as it was.
  expect((done as { isError?: boolean }).isError).toBe(true)
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
})

test('a change by the person after the MCP call makes its undo refuse and touch nothing', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await tool($, repo, WRITE, f => { f.set(`${ROOT}/a.txt`, 'from mcp\n') })
  repo.files.set(`${ROOT}/a.txt`, 'mine\n')
  expect(await undo($, '1')).toContain('1.1 left as is: a.txt has changed since')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('mine\n')
})

// The test host raises no tool.check for a plugin's own tool, so the test above cannot see a
// snapshot around it; which names are wrapped is checked here directly.
test("which tools are wrapped: every mcp__ tool but agent-undo's own; nothing else", async () => {
  expect(isMcp('mcp__filesystem__write_file')).toBe(true)
  expect(isMcp('mcp__claude_ai_Claude_Docs__update')).toBe(true)
  expect(isMcp('mcp__agent-undo__undo')).toBe(false)
  // Only the exact name: another tool under a server named agent-undo is another server's.
  expect(isMcp('mcp__agent-undo__anything')).toBe(true)
  expect(isMcp('mcp__agent-undo-fork__undo')).toBe(true)
  expect(isMcp('Bash')).toBe(false)
  expect(isMcp('NotebookEdit')).toBe(false)
  expect(isMcp(undefined)).toBe(false)
})

test('the name $.tool.register returned is the one left alone, not the default', async () => {
  ownTool('mcp__plugin_agent-undo_agent-undo__undo')
  try {
    expect(isMcp('mcp__plugin_agent-undo_agent-undo__undo')).toBe(false)
    expect(isMcp('mcp__agent-undo__undo')).toBe(true)
  } finally {
    ownTool('mcp__agent-undo__undo')
  }
})

test('the label names the server and the tool on one line', async () => {
  expect(mcpLabel('mcp__filesystem__write_file')).toBe('filesystem write_file')
  expect(mcpLabel('mcp__srv__a__b')).toBe('srv a__b')
  expect(mcpLabel('mcp__bad\nname__x')).toBe('bad name x')
  expect(mcpLabel(`mcp__${'s'.repeat(80)}__x`).length).toBe(60)
})
