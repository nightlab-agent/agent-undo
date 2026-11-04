import { expect, test } from 'claude-code/testing'
import { ROOT, bash, repoWorld, start, tick, undo } from './world'

// Second-loop review of the Bash record (head 4fcef52). Each finding: a failing test beside a
// passing comparison. The engine raises tool.check inside the tool.call dispatch
// (claude-code.d.ts:4083-4085), so the test raises it from its body with the call's id, as world.tsx does.

const check = ($: any, command: string, tool_use_id: string) =>
  $.tool.check({ tool: 'Bash', input: { command }, tool_use_id }) as Promise<{ decision: string }>

// ---- R1 (kind 1/2): a pending entry whose tool.call never takes it stays in `shells` forever;
// every later command then counts as "overlapped" and is never recorded again in the process.

test('review2 R1a: a check that allowed but whose call never reached this hook does not stop later records', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  // allowed, then the call is lost before the tool.call hook (an interrupt, a managed hook's next.to)
  expect((await check($, 'make', 'toolu_lost')).decision).toBe('allow')
  await bash($, repo, 'later', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '')).toContain('Bash later (1 file)')
})

// R1b (the check's slow snapshot finishing after its interrupted call) is not modelled: the test
// kit holds a tool.call until the tool.check with its id has finished.

test('review2 R1 comparison: the same interrupted call, its check finished first: later commands are recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await check($, 'make', 'toolu_x')
  repo.scripts['make'] = () => { throw new Error('interrupted') }
  await $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 'toolu_x' } as never).catch(() => undefined)
  await bash($, repo, 'later', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '')).toContain('Bash later (1 file)')
})

// ---- R2 (kind 4): the hook reads the verdict BENEATH it; a hook above may turn that allow into
// an ask ("the last word up the chain is the decision", claude-code.d.ts:13748-13752). The
// snapshot is then taken before the question, and F3 is back. Modelled by order: the check
// beneath says allow, the question (from the hook above) waits, the person saves, the call runs.

// Note: this passes because the snapshot is now taken at the check inside the call
// (the host's own), after the person's save here. The real R2 case, another mod's hook above this
// one turning the allow into a question, cannot be seen by this mod; the README says so.
test('review2 R2: an allow beneath turned into an ask above: the person\'s save during the question is not undone', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'mine.txt': 'draft\n' })
  await start($)
  repo.scripts['make'] = f => { f.set(`${ROOT}/a.txt`, 'a2\n') }
  expect((await check($, 'make', 'toolu_q')).decision).toBe('allow') // this mod's view
  repo.files.set(`${ROOT}/mine.txt`, 'my own work\n') // while the hook above's question waits
  await $.tool.call({ tool: 'Bash', command: 'make', tool_use_id: 'toolu_q' } as never)
  await undo($, '1')
  expect(repo.files.get(`${ROOT}/mine.txt`)).toBe('my own work\n')
})

test('review2 R2 comparison: the ask from beneath (core, a rule): the save is kept', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'mine.txt': 'draft\n' })
  await start($)
  repo.verdict = 'ask'
  repo.person = f => { f.set(`${ROOT}/mine.txt`, 'my own work\n') }
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  await undo($, '1')
  expect(repo.files.get(`${ROOT}/mine.txt`)).toBe('my own work\n')
})

// ---- R3 (kind 4): `stopped` is module state; a /clear keeps the process and the module
// (claude-code.d.ts:4555, 11627-11629: "the process goes on under a new session id, and no
// session.start fires"). README: "stop being recorded for the rest of the session".

test('review2 R3: after a /clear, the new session records shell commands again', async ($, on) => {
  on('session.end', (_, e: any) => ({ sessionId: e.sessionId }) as never)
  const repo = repoWorld(on, { 'gen.txt': 'v1\n', 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'npm run dev', () => {}, { run_in_background: true })
  await tick()
  expect(await ($ as any).session.end({ reason: 'clear', sessionId: 'test', resume: { id: 'test' } })).toEqual({ sessionId: 'test' }) // the /clear, raised
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  const text = await undo($, '')
  expect(text).not.toContain('no longer recorded')
})

test('review2 R3 comparison: after a /clear with no background command, shell commands are recorded', async ($, on) => {
  on('session.end', (_, e: any) => ({ sessionId: e.sessionId }) as never)
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  expect(await ($ as any).session.end({ reason: 'clear', sessionId: 'test', resume: { id: 'test' } })).toEqual({ sessionId: 'test' }) // the /clear, raised
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  const text = await undo($, '')
  expect(text).not.toContain('no longer recorded')
  expect(text).toContain('Bash make (1 file)')
})

// The test kit runs the permission chain inside $.tool.call and denies an ask nobody answers
// (claude-code.d.ts testing, EngineToolCall: "a test's classic.PermissionRequest answers an ask").
// world.tsx's "ask" commands are therefore denied and never run; here a PermissionRequest hook
// says yes, after `person` acts (the question waiting), as a person or a host would.
// The world answers the question (classic.PermissionRequest) with the person's act, then yes.
const approving = (_on: unknown, person: { act?: () => void | Promise<void> } = {}) => person
const acts = (repo: { person?: (f: Map<string, string>) => unknown }, p: { act?: () => void | Promise<void> }) => {
  repo.person = async () => { await p.act?.() }
}

// ---- F3 re-check with a real yes (the repo's F3 test passes because its asked command is denied).

test('review2 F3 real: a command approved at a prompt runs, is not recorded, and the save made meanwhile is kept', async ($, on) => {
  const p = approving(on)
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'mine.txt': 'draft\n' })
  acts(repo, p)
  await start($)
  repo.verdict = 'ask'
  p.act = () => { repo.files.set(`${ROOT}/mine.txt`, 'my own work\n') }
  await bash($, repo, 'make', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a2\n') // it ran
  expect(await undo($, '')).not.toContain('Bash make')
  expect(repo.files.get(`${ROOT}/mine.txt`)).toBe('my own work\n')
})

// ---- R6 (kind 1, F1 not closed for asked commands): the background check sits after
// `if (!sh) return done` (register.tsx:469-477), so a command approved at a prompt (no snapshot)
// that goes on in the background never sets `stopped`; its later writes are booked to the next
// command that runs without a question.

test('review2 R6: an approved-at-a-prompt background command\'s writes are not booked to a later allowed command', async ($, on) => {
  approving(on)
  const repo = repoWorld(on, { 'gen.txt': 'v1\n' })
  await start($)
  let finish = () => {}
  repo.verdict = 'ask' // npm run dev is asked, the person says yes
  await bash($, repo, 'npm run dev', f => new Promise<void>(r => { finish = () => { f.set(`${ROOT}/gen.txt`, 'v2\n'); r() } }), { run_in_background: true })
  await tick()
  repo.verdict = 'allow' // ls has an allow rule
  await bash($, repo, 'ls', () => finish())
  const text = await undo($, '')
  expect(text).not.toContain('Bash ls')
  await undo($, '1')
  expect(repo.files.get(`${ROOT}/gen.txt`)).toBe('v2\n')
})

test('review2 R6 comparison: the same background command run without a question: ls is not booked', async ($, on) => {
  approving(on)
  const repo = repoWorld(on, { 'gen.txt': 'v1\n' })
  await start($)
  let finish = () => {}
  await bash($, repo, 'npm run dev', f => new Promise<void>(r => { finish = () => { f.set(`${ROOT}/gen.txt`, 'v2\n'); r() } }), { run_in_background: true })
  await tick()
  await bash($, repo, 'ls', () => finish())
  expect(await undo($, '')).not.toContain('Bash ls')
  expect(repo.files.get(`${ROOT}/gen.txt`)).toBe('v2\n')
})

// ---- R7 (kind 2, F4 not closed when one of the two was asked): only commands with a snapshot
// open a window (begin, register.tsx:261-276), so an approved command running inside an allowed
// one's window is invisible to the overlap check; its file is booked to the allowed command.

test('review2 R7: an approved command running inside an allowed one\'s window: its file is not booked to the allowed one', async ($, on) => {
  approving(on)
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const first = bash($, repo, 'long-a', async f => { await held; f.set(`${ROOT}/a.txt`, 'a2\n') }, { agentId: 'agent-aaaaaaaa' })
  await tick()
  repo.verdict = 'ask'
  await bash($, repo, 'short-b', f => { f.set(`${ROOT}/b.txt`, 'b2\n') }, { agentId: 'agent-bbbbbbbb' })
  repo.verdict = 'allow'
  release()
  await first
  expect(repo.files.get(`${ROOT}/b.txt`)).toBe('b2\n') // short-b ran
  const text = await undo($, '')
  expect(text).not.toMatch(/changed b\.txt/)
  await undo($, '1')
  expect(repo.files.get(`${ROOT}/b.txt`)).toBe('b2\n')
})

test('review2 R7 comparison: both allowed and overlapping: neither recorded, b.txt kept', async ($, on) => {
  approving(on)
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  let release = () => {}
  const held = new Promise<void>(r => { release = r })
  const first = bash($, repo, 'long-a', async f => { await held; f.set(`${ROOT}/a.txt`, 'a2\n') }, { agentId: 'agent-aaaaaaaa' })
  await tick()
  await bash($, repo, 'short-b', f => { f.set(`${ROOT}/b.txt`, 'b2\n') }, { agentId: 'agent-bbbbbbbb' })
  release()
  await first
  expect(await undo($, '')).not.toMatch(/changed b\.txt/)
  expect(repo.files.get(`${ROOT}/b.txt`)).toBe('b2\n')
})
