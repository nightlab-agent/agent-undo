import { expect, test } from 'claude-code/testing'
import { ROOT, edit, repoWorld, start } from './world'

// The plan-mode verdict below was obtained from a real `$.tool.check` of a registered
// undo tool in Claude Code 2.1.312, with `--permission-mode plan`, without an answering tool.check hook
// (`sh tests/native-ask.sh`).
// This test still supplies the answer through a hook; it does not draw the native dialog.
test('an ask of unknown words is a no, so a changed wording cannot open a write', async ($, on) => {
  on('tool.check', { tool: 'mcp__agent-undo__undo' }, () => ({ decision: 'ask', reason: 'Some new reason.' }) as never)
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const { questions } = e as unknown as { questions: { question: string }[] }
    return { result: { questions, answers: { [questions[0]!.question]: 'Undo it' } } } as never
  })
  const repo = repoWorld(on, { 'a.txt': 'one\n' })
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '1' } as never)
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('ONE\n')
})

for (const plan of [true, false]) {
  test(`Dex ${plan ? 'plan mode' : 'comparison default mode'}: a yes respects the mode`, async ($, on) => {
    on('tool.check', { tool: 'mcp__agent-undo__undo' }, () => ({ decision: 'ask',
      reason: plan ? 'Cannot call mcp__agent-undo__undo while in plan mode.' : "Claude requested permissions to use mcp__agent-undo__undo, but you haven't granted it yet." }) as never)
    on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
      const { questions } = e as unknown as { questions: { question: string }[] }
      return { result: { questions, answers: { [questions[0]!.question]: 'Undo it' } } } as never
    })
    const repo = repoWorld(on, { 'a.txt': 'one\n' })
    await start($)
    await edit($, 'a.txt', 'one', 'ONE')
    await $.tool.call({ tool: 'mcp__agent-undo__undo', ref: '1' } as never)
    expect(repo.files.get(`${ROOT}/a.txt`)).toBe(plan ? 'ONE\n' : 'one\n')
  })
}
