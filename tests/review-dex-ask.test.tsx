import { expect, test } from 'claude-code/testing'
import { ROOT, edit, repoWorld, start } from './world'
import type { On, $T } from './world'

const at = (p: string) => `${ROOT}/${p}`
const call = ($: $T, ref = '1', more: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'mcp__agent-undo__undo', ref, ...more } as never) as Promise<{ result: string }>

// Each question has its own release, so answers can arrive in the opposite order.
const questions = (on: On) => {
  const pending: { answer: (s: string) => void }[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const { questions } = e as unknown as { questions: { question: string }[] }
    const answer = await new Promise<string>(answer => pending.push({ answer }))
    return { result: { questions, answers: { [questions[0]!.question]: answer } } } as never
  })
  const reached = async (n: number) => {
    while (pending.length < n) await new Promise(r => setTimeout(r, 1))
  }
  return { pending, reached }
}

test('Dex: asking twice undoes once and reports the second as already undone', async ($, on) => {
  const q = questions(on)
  const repo = repoWorld(on, { 'a.txt': 'one\n' })
  await start($); await edit($, 'a.txt', 'one', 'ONE'); repo.verdict = 'ask'
  const first = call($); await q.reached(1); q.pending[0]!.answer('Undo it')
  expect((await first).result).toContain('undid 1.1')
  const second = call($); await q.reached(2); q.pending[1]!.answer('Undo it')
  expect((await second).result).toContain('already undone')
  expect(repo.files.get(at('a.txt'))).toBe('one\n')
})

test('Dex: two questions for one ref, answered in reverse, undo once', async ($, on) => {
  const q = questions(on)
  const repo = repoWorld(on, { 'a.txt': 'one\n' })
  await start($); await edit($, 'a.txt', 'one', 'ONE'); repo.verdict = 'ask'
  const a = call($); await q.reached(1)
  const b = call($); await q.reached(2)
  q.pending[1]!.answer('Undo it'); expect((await b).result).toContain('undid 1.1')
  q.pending[0]!.answer('Undo it'); expect((await a).result).toContain('already undone')
  expect(repo.files.get(at('a.txt'))).toBe('one\n')
})

test('Dex: two questions for different refs keep their own answers', async ($, on) => {
  const q = questions(on)
  const repo = repoWorld(on, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  await start($); await edit($, 'a.txt', 'one', 'ONE'); await edit($, 'b.txt', 'two', 'TWO')
  repo.verdict = 'ask'
  const a = call($, '1'); await q.reached(1)
  const b = call($, '2'); await q.reached(2)
  q.pending[1]!.answer('Undo it'); await b
  q.pending[0]!.answer('Keep it'); await a
  expect(repo.files.get(at('a.txt'))).toBe('ONE\n')
  expect(repo.files.get(at('b.txt'))).toBe('two\n')
})

test('Dex: an edit landing while a question waits is checked before undo', async ($, on) => {
  const q = questions(on)
  const repo = repoWorld(on, { 'a.txt': 'one\n' })
  await start($); await edit($, 'a.txt', 'one', 'ONE'); repo.verdict = 'ask'
  const waiting = call($); await q.reached(1)
  repo.verdict = 'allow'; await edit($, 'a.txt', 'ONE', 'newer')
  q.pending[0]!.answer('Undo it')
  expect((await waiting).result).not.toContain('undid')
  expect(repo.files.get(at('a.txt'))).toBe('newer\n')
})

test('Dex: a save landing while a question waits is checked before undo', async ($, on) => {
  const q = questions(on)
  const repo = repoWorld(on, { 'a.txt': 'one\n' })
  await start($); await edit($, 'a.txt', 'one', 'ONE'); repo.verdict = 'ask'
  const waiting = call($); await q.reached(1)
  repo.files.set(at('a.txt'), 'my save\n')
  q.pending[0]!.answer('Undo it')
  expect((await waiting).result).not.toContain('undid')
  expect(repo.files.get(at('a.txt'))).toBe('my save\n')
})

test('Dex: a session end while its question waits makes its late yes harmless', async ($, on) => {
  const q = questions(on)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  const repo = repoWorld(on, { 'a.txt': 'one\n' })
  await start($); await edit($, 'a.txt', 'one', 'ONE'); repo.verdict = 'ask'
  const waiting = call($); await q.reached(1)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  q.pending[0]!.answer('Undo it')
  await waiting.catch(() => undefined)
  expect(repo.files.get(at('a.txt'))).toBe('ONE\n')
})

test('Dex comparison: a yes before session end performs the undo', async ($, on) => {
  const q = questions(on)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  const repo = repoWorld(on, { 'a.txt': 'one\n' })
  await start($); await edit($, 'a.txt', 'one', 'ONE'); repo.verdict = 'ask'
  const waiting = call($); await q.reached(1); q.pending[0]!.answer('Undo it')
  await waiting
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 's1', resume: { id: 's1' } })
  expect(repo.files.get(at('a.txt'))).toBe('one\n')
})

test('Dex: a clear while asking must not redirect the yes to the new session ref', async ($, on) => {
  const q = questions(on)
  let sid = 's1'
  const state = new Map<string, { value: unknown; version: number }>()
  const store = new Map<string, unknown>()
  on('session.id', () => ({ value: sid }))
  on('state.get', (_, e) => ({ value: state.get(e.key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    const version = state.get(e.key)?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } } as never
    state.set(e.key, { value: structuredClone(e.value), version: version + 1 })
    return { value: { isSet: true, version: version + 1 } } as never
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }) as never)
  on('store.set', (_, e) => { store.set(e.key, structuredClone(e.value)); return { value: undefined } })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', (_, e) => { store.delete(e.key); return { value: undefined } })
  on('session.end', (_, e) => {
    state.clear(); sid = 's2'
    return { sessionId: e.sessionId }
  })
  const repo = repoWorld(on, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  await start($); await edit($, 'a.txt', 'one', 'ONE'); repo.verdict = 'ask'
  const waiting = call($); await q.reached(1)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } })
  repo.verdict = 'allow'; await edit($, 'b.txt', 'two', 'TWO')
  q.pending[0]!.answer('Undo it'); await waiting.catch(() => undefined)
  expect(repo.files.get(at('b.txt'))).toBe('TWO\n')
  expect(repo.files.get(at('a.txt'))).toBe('ONE\n')
})

test('Dex: a question open beyond ten seconds leaves time for the undo', {
  timeoutMs: 20000,
  plugins: [{
    name: 'dex-long-answer', tier: 'append',
    register(on) {
      on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
        await $.fs.exists('/dex-answer-wait')
        await $.fs.exists('/dex-answer-wait')
        const { questions } = e as unknown as { questions: { question: string }[] }
        return { result: { questions, answers: { [questions[0]!.question]: 'Undo it' } } } as never
      })
    },
  }],
}, async ($, on) => {
  // Each simulated person's wait stays within that fs.exists hook's own budget;
  // the answer hook and the undo hook should not pay for these engine calls.
  on('fs.exists', { path: '/dex-answer-wait' }, async () => {
    await new Promise(r => setTimeout(r, 5500))
    return { value: true }
  })
  const repo = repoWorld(on, { 'a.txt': 'one\n' })
  await start($); await edit($, 'a.txt', 'one', 'ONE'); repo.verdict = 'ask'
  expect((await call($)).result).toContain('undid 1.1')
  expect(repo.files.get(at('a.txt'))).toBe('one\n')
})

