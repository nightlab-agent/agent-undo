import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { undoHunk } from '../hooks/register'

// Review tests (critic pass, 2026-10-30). Each finding: a FAILING test beside a PASSING
// comparison case of the nearest normal case. Same harness style as agent-undo.test.tsx.

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]

const ROOT = '/proj'

// One-hunk diff in the engine's structuredPatch shape (copied from agent-undo.test.tsx).
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

type Opts = {
  root?: string
  // Replaces the engine's answer to a tool call (to give real-engine shapes the base world lacks).
  answer?: (x: { tool: string; file_path: string; content?: string }, files: Map<string, string>) => unknown
  // Runs inside fs.read before it answers (to let another call land in the middle).
  onRead?: (path: string) => Promise<void>
}

const world = (on: On, files0: Record<string, string> = {}, o: Opts = {}) => {
  const files = new Map(Object.entries(files0))
  on('session.root', () => ({ value: o.root ?? ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', async (_, e) => {
    const t = files.get(e.path)
    if (o.onRead) await o.onRead(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('tool.call', (_, e) => {
    const x = e as unknown as { tool: string; file_path: string; old_string?: string; new_string?: string; content?: string }
    if (o.answer) return o.answer(x, files) as never
    const was = files.get(x.file_path)
    if (x.tool === 'Edit') {
      if (was === undefined || !was.includes(x.old_string!)) return { result: 'String to replace not found', isError: true } as never
      const now = was.replace(x.old_string!, x.new_string!)
      files.set(x.file_path, now)
      return { result: { filePath: x.file_path, oldString: x.old_string, newString: x.new_string, originalFile: was,
        structuredPatch: patchOf(was, now), userModified: false, replaceAll: false } } as never
    }
    files.set(x.file_path, x.content!)
    return { result: was === undefined
      ? { type: 'create', filePath: x.file_path, content: x.content, structuredPatch: [], originalFile: null }
      : { type: 'update', filePath: x.file_path, content: x.content, structuredPatch: patchOf(was, x.content!), originalFile: was } } as never
  })
  return files
}

const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const edit = ($: $T, file: string, old_string: string, new_string: string, root = ROOT, sep = '/') =>
  $.tool.call({ tool: 'Edit', file_path: `${root}${sep}${file}`, old_string, new_string } as never)
const write = ($: $T, file: string, content: string) =>
  $.tool.call({ tool: 'Write', file_path: `${ROOT}/${file}`, content } as never)
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text

const APP = ['import x', '', 'function a() {', '  return 1', '}', '', 'function b() {', '  return 2', '}', ''].join('\n')

// ---- Kind 4: a staged edit (held for review, file unchanged) is listed as made ----------------
// Engine types 2.1.312, claude-code.d.ts:21752 (Edit) and :22662 (Write):
// "staged?: boolean  True when the edit was held for the machine owner to review instead of written; the file is unchanged"
test('review K4a FAIL: a staged Edit (file unchanged) is not listed as an edit Claude made', async ($, on) => {
  const files = world(on, { [`${ROOT}/app.ts`]: APP }, {
    answer: x => ({ result: { filePath: x.file_path, oldString: '  return 2', newString: '  return 20', originalFile: APP,
      structuredPatch: patchOf(APP, APP.replace('  return 2', '  return 20')), userModified: false, replaceAll: false, staged: true } }),
  })
  await start($)
  await edit($, 'app.ts', '  return 2', '  return 20')
  expect(files.get(`${ROOT}/app.ts`)).toBe(APP)
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
})

test('review K4a comparison PASS: an Edit that was written is listed', async ($, on) => {
  world(on, { [`${ROOT}/app.ts`]: APP })
  await start($)
  await edit($, 'app.ts', '  return 2', '  return 20')
  expect(await undo($, '')).toContain('#1 ')
})

test('review K4b FAIL: a staged Write of a new file is not listed as "(new file)"', async ($, on) => {
  const files = world(on, {}, {
    answer: x => ({ result: { type: 'create', filePath: x.file_path, content: x.content, structuredPatch: [], originalFile: null, staged: true } }),
  })
  await start($)
  await write($, 'new.ts', 'hi\n')
  expect(files.has(`${ROOT}/new.ts`)).toBe(false)
  expect(await undo($, '')).not.toContain('(new file)')
})

// ---- Kind 4: "\ No newline at end of file" is dropped, so an undo keeps the newline the edit added ----
// jsdiff's structuredPatch (the engine's diff) writes that marker line after the line that lacks a newline.
test('review K4c FAIL: undoing a Write that added the final newline gives back the file without it', async ($, on) => {
  const was = 'x\ny'
  const now = 'x\nY\n'
  const files = world(on, { [`${ROOT}/f.txt`]: was }, {
    answer: (x, fs) => {
      fs.set(x.file_path, x.content!)
      return { result: { type: 'update', filePath: x.file_path, content: x.content, originalFile: was,
        structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' x', '-y', '\\ No newline at end of file', '+Y'] }] } }
    },
  })
  await start($)
  await write($, 'f.txt', now)
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(`${ROOT}/f.txt`)).toBe(was)
})

test('review K4c comparison PASS: undoing a Write where both versions end in a newline gives back the file', async ($, on) => {
  const was = 'x\ny\n'
  const files = world(on, { [`${ROOT}/f.txt`]: was })
  await start($)
  await write($, 'f.txt', 'x\nY\n')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(`${ROOT}/f.txt`)).toBe(was)
})

test('review K4d FAIL: undoing a Write that emptied a file gives back its final newline', () => {
  // structuredPatch('a\nb\n' -> ''): one hunk, lines ['-a', '-b'].
  expect(undoHunk('', { before: ['a', 'b'], after: [], line: 0 })).toEqual({ text: 'a\nb\n' })
})

test('review K4d comparison PASS: a hunk with lines left in the file keeps the final newline', () => {
  expect(undoHunk('a\nB\n', { before: ['a', 'b'], after: ['a', 'B'], line: 1 })).toEqual({ text: 'a\nb\n' })
})

// ---- README "Your edits elsewhere in the file stay": one CRLF line turns the whole file CRLF ----
test('review EOL FAIL: an undo in a file with one CRLF line leaves the other lines\' endings alone', () => {
  const text = 'k\r\nl\nm\nB\nn\n'
  expect(undoHunk(text, { before: ['m', 'b', 'n'], after: ['m', 'B', 'n'], line: 3 })).toEqual({ text: 'k\r\nl\nm\nb\nn\n' })
})

test('review EOL comparison PASS: the same undo in an all-LF file', () => {
  expect(undoHunk('k\nl\nm\nB\nn\n', { before: ['m', 'b', 'n'], after: ['m', 'B', 'n'], line: 3 })).toEqual({ text: 'k\nl\nm\nb\nn\n' })
})

// ---- Kind 2: two undos at once on one file; read-modify-write across an await, no lock -------
const TWO = (() => {
  const l = ['p0', 'p1', 'p2', 'p3', 'A', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'B', 'p14', 'p15', 'p16', '']
  return l.join('\n')
})()

test('review K2a FAIL: two undos of two edits in one file at once both stay undone', async ($, on) => {
  const files = world(on, { [`${ROOT}/t.txt`]: TWO })
  await start($)
  await edit($, 't.txt', 'A', 'AA')
  await edit($, 't.txt', 'B', 'BB')
  const [r1, r2] = await Promise.all([undo($, '1'), undo($, '2')])
  expect(r1).toContain('undid 1.1')
  expect(r2).toContain('undid 2.1')
  expect(files.get(`${ROOT}/t.txt`)).toBe(TWO)
})

test('review K2a comparison PASS: the same two undos one after the other', async ($, on) => {
  const files = world(on, { [`${ROOT}/t.txt`]: TWO })
  await start($)
  await edit($, 't.txt', 'A', 'AA')
  await edit($, 't.txt', 'B', 'BB')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(await undo($, '2')).toContain('undid 2.1')
  expect(files.get(`${ROOT}/t.txt`)).toBe(TWO)
})

test('review K2b FAIL: an Edit by Claude (or a subagent) that lands while an undo reads the file is kept', async ($, on) => {
  // The Edit starts while the undo is reading. It is not awaited inside the read: the engine's
  // fs.read never waits on a tool call (awaiting it here would deadlock on the mod's own queue).
  let during: (() => Promise<unknown>) | undefined
  let landed: Promise<unknown> | undefined
  const files = world(on, { [`${ROOT}/t.txt`]: TWO }, {
    onRead: async () => { const f = during; during = undefined; if (f) landed = f() },
  })
  await start($)
  await edit($, 't.txt', 'A', 'AA')
  during = () => edit($, 't.txt', 'p16', 'p16 // subagent')
  expect(await undo($, '1')).toContain('undid 1.1')
  await landed
  expect(files.get(`${ROOT}/t.txt`)).toBe(TWO.replace('p16', 'p16 // subagent'))
})

test('review K2b comparison PASS: the same Edit landing just before the undo is kept', async ($, on) => {
  const files = world(on, { [`${ROOT}/t.txt`]: TWO })
  await start($)
  await edit($, 't.txt', 'A', 'AA')
  await edit($, 't.txt', 'p16', 'p16 // subagent')
  expect(await undo($, '1')).toContain('undid 1.1')
  expect(files.get(`${ROOT}/t.txt`)).toBe(TWO.replace('p16', 'p16 // subagent'))
})

// ---- Kind 3/4: replace_all with several identical hunks; one undo moves the others off their line ----
// Engine types :21741 "replaceAll: boolean"; :21731 structuredPatch is an array (one hunk per changed run).
const SEC = ['s', 's', 's', 's', 'old', 's', 's', 's', 's']
const RA_BEFORE = ['top', ...SEC, ...SEC, ...SEC, 'end', ''].join('\n')
const RA_AFTER = RA_BEFORE.split('old').join('new1\nnew2')
const raHunk = (newStart: number, oldStart: number) =>
  ({ oldStart, oldLines: 7, newStart, newLines: 8, lines: [' s', ' s', ' s', '-old', '+new1', '+new2', ' s', ' s', ' s'] })
const raWorld = (on: On) => world(on, { [`${ROOT}/r.txt`]: RA_BEFORE }, {
  answer: (x, fs) => {
    fs.set(x.file_path, RA_AFTER)
    return { result: { filePath: x.file_path, oldString: 'old', newString: 'new1\nnew2', originalFile: RA_BEFORE,
      structuredPatch: [raHunk(3, 3), raHunk(13, 12), raHunk(23, 21)], userModified: false, replaceAll: true } }
  },
})

test('review K3 FAIL: replace_all, undo 1.1 then 1.3; 1.3\'s lines are untouched and undo', async ($, on) => {
  const files = raWorld(on)
  await start($)
  await edit($, 'r.txt', 'old', 'new1\nnew2')
  expect(files.get(`${ROOT}/r.txt`)).toBe(RA_AFTER)
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(await undo($, '1.3')).toContain('undid 1.3')
})

test('review K3 comparison PASS: replace_all, undo 1.3 then 1.1', async ($, on) => {
  const files = raWorld(on)
  await start($)
  await edit($, 'r.txt', 'old', 'new1\nnew2')
  expect(await undo($, '1.3')).toContain('undid 1.3')
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(await undo($, '1.2')).toContain('undid 1.2')
  expect(files.get(`${ROOT}/r.txt`)).toBe(RA_BEFORE)
})

// ---- Kind 6: on Windows (the owner's machine, E:\nightlab) paths are not shown from the project ----
test('review K6 FAIL: a Windows path is listed from the project root', async ($, on) => {
  const WROOT = 'C:\\proj'
  world(on, { [`${WROOT}\\app.ts`]: APP }, { root: WROOT })
  await start($)
  await edit($, 'app.ts', '  return 2', '  return 20', WROOT, '\\')
  expect(await undo($, '')).toContain('Edit app.ts')
})

test('review K6 comparison PASS: a POSIX path is listed from the project root', async ($, on) => {
  world(on, { [`${ROOT}/app.ts`]: APP })
  await start($)
  await edit($, 'app.ts', '  return 2', '  return 20')
  expect(await undo($, '')).toContain('Edit app.ts')
})
