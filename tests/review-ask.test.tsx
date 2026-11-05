import { expect, test } from 'claude-code/testing'
import { ROOT, edit, repoWorld, start } from './world'
import type { On } from './world'

const at = (p: string) => `${ROOT}/${p}`

// ---- A person's question, where Claude Code would have asked one (default permission mode)

// Before repoWorld: its own tool.call hook throws on a tool it does not know.
const answering = (on: On, answer: string) => {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const { questions } = e as unknown as { questions: { question: string }[] }
    const question = questions[0]?.question ?? ''
    asked.push(question)
    return { result: { questions, answers: { [question]: answer } } } as never
  })
  return asked
}

test('where Claude Code would ask, a yes from the person undoes the edit', async ($, on) => {
  const asked = answering(on, 'Undo it')
  const repo = repoWorld(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  repo.verdict = 'ask'
  await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '1', tool_use_id: 'u1' } as never)
  expect(asked[0]).toContain('undo 1')
  expect(asked.length).toBe(1)
  expect(repo.files.get(at('a.txt'))).toBe('one\ntwo\n')
})

test('where Claude Code would ask, a no from the person changes no file', async ($, on) => {
  answering(on, 'Keep it')
  const repo = repoWorld(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  repo.verdict = 'ask'
  const out = await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '1', tool_use_id: 'u1' } as never) as { result: string }
  expect(repo.files.get(at('a.txt'))).toBe('one\nTWO\n')
  expect(out.result).toContain('nothing changed')
})

test('free text under Other is not a yes', async ($, on) => {
  answering(on, 'Undo it, but only the first line')
  const repo = repoWorld(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  repo.verdict = 'ask'
  await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '1', tool_use_id: 'u1' } as never)
  expect(repo.files.get(at('a.txt'))).toBe('one\nTWO\n')
})

test('with no one to ask, the undo refuses and changes no file', async ($, on) => {
  on('tool.call', { tool: 'AskUserQuestion' }, async () => { throw new Error('no one to ask') })
  const repo = repoWorld(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  repo.verdict = 'ask'
  const out = await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '1', tool_use_id: 'u1' } as never) as { result: string }
  expect(repo.files.get(at('a.txt'))).toBe('one\nTWO\n')
  expect(out.result).toContain('nothing changed')
})

test('a deny is never turned into a question', async ($, on) => {
  const asked = answering(on, 'Undo it')
  const repo = repoWorld(on, { 'a.txt': 'one\ntwo\n' })
  await start($)
  await edit($, 'a.txt', 'two', 'TWO')
  repo.verdict = 'deny'
  await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '1', tool_use_id: 'u1' } as never)
  expect(asked.length).toBe(0)
  expect(repo.files.get(at('a.txt'))).toBe('one\nTWO\n')
})
