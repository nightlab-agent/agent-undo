// Tests for 0c47e4d..bdcad69: each probe beside its nearest normal case.
import { expect, test } from 'claude-code/testing'
import { ROOT, bash, edit, repoWorld, start, tick, tool, undo } from './world'

const patchOf = (before: string, after: string) => {
  // Lines as a diff counts them: a final newline ends the last line, it does not start another.
  const linesOf = (t: string) => (t === '' ? [] : (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n'))
  const a = linesOf(before)
  const b = linesOf(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const ctx0 = Math.max(0, head - 3)
  const lines = [
    ...a.slice(ctx0, head).map(l => ` ${l}`),
    ...a.slice(head, a.length - tail).map(l => `-${l}`),
    ...b.slice(head, b.length - tail).map(l => `+${l}`),
    ...a.slice(a.length - tail, Math.min(a.length, a.length - tail + 3)).map(l => ` ${l}`),
  ]
  const ctxEnd = Math.min(tail, 3)
  return [{ oldStart: ctx0 + 1, oldLines: head - ctx0 + (a.length - tail - head) + ctxEnd,
    newStart: ctx0 + 1, newLines: head - ctx0 + (b.length - tail - head) + ctxEnd, lines }]
}

const held = () => {
  let release = () => {}
  const p = new Promise<void>(r => { release = r })
  return { p, release }
}

// --- R1 one step later ---
test('P1 two read-only MCP calls, both ended inside one Bash command: the command is recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  const h = held()
  const first = bash($, repo, 'build', async f => { await h.p; f.set(`${ROOT}/a.txt`, 'a2\n') })
  await tick()
  await Promise.all([
    tool($, repo, 'mcp__github__get_issue', async () => { await tick(); return 'read-only' as const }, { number: 1 }),
    tool($, repo, 'mcp__github__list_prs', async () => { await tick(); return 'read-only' as const }, {}),
  ])
  h.release()
  await first
  expect(await undo($, '')).toContain('Bash build (1 file)')
})
test('P2 two MCP calls in one Bash command, one read-only, one not: the command is not recorded', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  const h = held()
  const first = bash($, repo, 'build', async f => { await h.p; f.set(`${ROOT}/a.txt`, 'a2\n') })
  await tick()
  await Promise.all([
    tool($, repo, 'mcp__github__get_issue', async () => { await tick(); return 'read-only' as const }, { number: 1 }),
    tool($, repo, 'mcp__filesystem__write_file', async f => { await tick(); f.set(`${ROOT}/b.txt`, 'b2\n') }, {}),
  ])
  h.release()
  await first
  expect(await undo($, '')).not.toContain('Bash build')
})

test('F1 comparison: the same writing call not marked read-only: nothing is recorded for the command', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  const h = held()
  const first = bash($, repo, 'build', async f => { await h.p; f.set(`${ROOT}/a.txt`, 'a2\n') })
  await tick()
  await tool($, repo, 'mcp__notes__save', f => { f.set(`${ROOT}/b.txt`, 'server wrote\n') }, {})
  h.release()
  await first
  expect(await undo($, '')).not.toContain('changed b.txt')
})

// --- R4 one step later: the hunk-undo path (no test in the repo) ---
const hunkEdits = (on: Parameters<typeof repoWorld>[0], files: () => Map<string, string>) =>
  on('tool.call', { tool: 'Edit' }, (async (_: unknown, e: { file_path: string; old_string: string; new_string: string }) => {
    const f = files(); const was = f.get(e.file_path)!; const now = was.replace(e.old_string, e.new_string)
    f.set(e.file_path, now)
    return { result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: was,
      structuredPatch: patchOf(was, now), userModified: false, replaceAll: false } }
  }) as never)
test('P3 an Edit hunk undone while a Bash command runs is not recorded as the command\'s change', async ($, on) => {
  let r: { files: Map<string, string> } | undefined
  hunkEdits(on, () => r!.files)
  const repo = repoWorld(on, { 'a.txt': 'one\n', 'b.txt': 'b\n' }); r = repo
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  const h = held()
  const call = bash($, repo, 'two', async f => { await h.p; f.set(`${ROOT}/b.txt`, 'b2\n') })
  await tick()
  expect(await undo($, '1')).toContain('undid')
  h.release()
  await call
  const text = await undo($, '')
  expect(text).toContain('Bash two (1 file)')
  expect(text).not.toContain('changed a.txt')
})
test('P4 an undo during two open windows (Bash + MCP) is taken by neither', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'one', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  const h = held()
  const c1 = bash($, repo, 'two', async f => { await h.p })
  const c2 = tool($, repo, 'mcp__filesystem__write_file', async f => { await h.p })
  await tick()
  expect(await undo($, '1')).toContain('undid 1.1')
  h.release()
  await Promise.all([c1, c2])
  expect(await undo($, '')).not.toContain('2.1 changed a.txt')
})

// R4 one step earlier: the undo marks open windows, then awaits its git restore; a Bash command
// whose window opens during that await (a subagent's) is not marked, and its before-snapshot
// predates the restore. Edits use inFlight for this; the undo does not.
test('P5 (passes: snapshots queue behind the restore on the private index): a Bash window that opens while an undo\'s restore runs does not take the restore as its change', async ($, on) => {
  let gate: Promise<void> | undefined
  let opened = () => {}
  // The world's own git, with its restore held open (the world registers process.run once).
  const wrapped = ((name: string, ...rest: unknown[]) => {
    if (name !== 'process.run') return (on as any)(name, ...rest)
    const inner = rest[rest.length - 1] as (x: unknown, e: { argv: string[] }) => Promise<unknown>
    return (on as any)(name, async (x: unknown, e: { argv: string[] }) => {
      if (e.argv[1] === 'restore' && gate) { opened(); await gate }
      return inner(x, e)
    })
  }) as typeof on
  const repo = repoWorld(wrapped, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'one', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  const h = held()
  gate = h.p
  const restoring = new Promise<void>(r => { opened = r })
  const u = undo($, '1')
  await restoring
  const h2 = held()
  const call = bash($, repo, 'two', async f => { await h2.p; f.set(`${ROOT}/b.txt`, 'b2\n') })
  await tick(); await tick()
  h.release()
  expect(await u).toContain('undid 1.1')
  h2.release()
  await call
  const text = await undo($, '')
  expect(text).toContain('Bash two')
  expect(text).not.toContain('2.1 changed a.txt')
})
test('F2 comparison: the same Bash window opened just after the undo finished lists only b.txt', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'one', f => { f.set(`${ROOT}/a.txt`, 'a2\n') })
  expect(await undo($, '1')).toContain('undid 1.1')
  await bash($, repo, 'two', f => { f.set(`${ROOT}/b.txt`, 'b2\n') })
  const text = await undo($, '')
  expect(text).toContain('Bash two')
  expect(text).not.toContain('2.1 changed a.txt')
})

// The hunk path (R4 has no test for it): touched(c.file), then `await $.fs.write` outside the
// private-index queue. A Bash window that opens while that write is in flight snapshots before it.
const holdWrites = (on: Parameters<typeof repoWorld>[0], ctl: { gate?: Promise<void>; opened: () => void }) =>
  ((name: string, ...rest: unknown[]) => {
    if (name !== 'fs.write') return (on as any)(name, ...rest)
    const inner = rest[rest.length - 1] as (x: unknown, e: unknown) => unknown
    return (on as any)(name, async (x: unknown, e: unknown) => {
      if (ctl.gate) { const g = ctl.gate; ctl.gate = undefined; ctl.opened(); await g }
      return inner(x, e)
    })
  }) as typeof on
test('F3 fail: a Bash window that opens while a hunk undo\'s write is in flight does not take it as its change', async ($, on) => {
  const ctl: { gate?: Promise<void>; opened: () => void } = { opened: () => {} }
  const w = holdWrites(on, ctl)
  let r: { files: Map<string, string> } | undefined
  hunkEdits(w, () => r!.files)
  const repo = repoWorld(w, { 'a.txt': 'one\n', 'b.txt': 'b\n' }); r = repo
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  const h = held()
  ctl.gate = h.p
  const writing = new Promise<void>(res => { ctl.opened = res })
  const u = undo($, '1')
  await writing
  const h2 = held()
  const call = bash($, repo, 'two', async f => { await h2.p; f.set(`${ROOT}/b.txt`, 'b2\n') })
  await tick(); await tick()
  h.release()
  expect(await u).toContain('undid')
  h2.release()
  await call
  const text = await undo($, '')
  expect(text).toContain('Bash two')
  expect(text).not.toContain('2.1 changed a.txt')
})
test('F3 comparison: the Bash window opened just after the hunk undo lists only b.txt', async ($, on) => {
  let r: { files: Map<string, string> } | undefined
  hunkEdits(on, () => r!.files)
  const repo = repoWorld(on, { 'a.txt': 'one\n', 'b.txt': 'b\n' }); r = repo
  await start($)
  await edit($, 'a.txt', 'one', 'ONE')
  expect(await undo($, '1')).toContain('undid')
  await bash($, repo, 'two', f => { f.set(`${ROOT}/b.txt`, 'b2\n') })
  const text = await undo($, '')
  expect(text).toContain('Bash two')
  expect(text).not.toContain('2.1 changed a.txt')
})
