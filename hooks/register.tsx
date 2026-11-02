import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Change, Hunk, ShellFile } from '../types'

const MAX_CHANGES = 300
const MAX_LINES = 4000
const MAX_FILES = 200
const INDEX = 'agent-undo.index'

// Change the tag when a Change's fields change: it declines what an earlier version stored.
const changes = atom({ plugin: 'agent-undo', key: 'changes' } as const, [], { shape: 'changes-2' })

type Patch = { newStart: number; lines: string[] }[]

/** Each hunk of an engine diff as the lines before and after it, context included. */
export const hunksOf = (patch: Patch): Hunk[] =>
  patch.map(p => {
    const h: Hunk = { before: [], after: [], line: p.newStart }
    let prev = ' '
    for (const l of p.lines) {
      // "\ No newline at end of file" follows the last line of the side(s) it belongs to.
      if (l.startsWith('\\')) {
        if (prev !== '+') h.beforeNoEol = true
        if (prev !== '-') h.afterNoEol = true
        continue
      }
      prev = l[0] ?? ' '
      if (prev !== '+') h.before.push(l.slice(1))
      if (prev !== '-') h.after.push(l.slice(1))
    }
    return h
  })

const ZERO = /^0+$/

/** The files of `git diff-tree -r -z --no-renames <a> <b>`: each status, path and both blobs. */
export const filesOf = (out: string): ShellFile[] => {
  const parts = out.split('\0')
  const files: ShellFile[] = []
  for (let k = 0; k + 1 < parts.length; k += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([MDAT])/.exec(parts[k]!)
    if (!m) continue
    const [, modeA, modeB, a, b, status] = m
    const f: ShellFile = { path: parts[k + 1]!, status: status as ShellFile['status'] }
    if (!ZERO.test(a!)) f.before = a
    if (!ZERO.test(b!)) f.after = b
    const modes = [modeA, modeB]
    if (modes.includes('160000')) f.fixed = 'a submodule'
    else if (modes.includes('120000')) f.fixed = 'a symbolic link'
    files.push(f)
  }
  return files
}

type Row = { t: string; e: string }

/** The file as lines, each with its own ending ('' for a last line without one). */
const rowsOf = (text: string): Row[] => {
  const parts = text.split(/(\r\n|\n)/)
  const rows: Row[] = []
  for (let k = 0; k < parts.length; k += 2) rows.push({ t: parts[k] ?? '', e: parts[k + 1] ?? '' })
  const last = rows[rows.length - 1]
  if (last && last.t === '' && last.e === '') rows.pop()
  return rows
}

/**
 * The file's text with one hunk put back as it was, and where, or why not. The hunk's
 * after-lines must still stand in the file, word for word: where the person (or a later edit)
 * changed them, nothing is touched. Found in more than one place, only the place the edit left
 * them counts. Every other line keeps its own line ending.
 */
const undoAt = (text: string, hunk: Hunk): { text: string; at: number } | { refused: string } => {
  const rows = rowsOf(text)
  const crlf = rows.filter(r => r.e === '\r\n').length
  const eol = crlf > rows.filter(r => r.e === '\n').length ? '\r\n' : '\n'
  const { before, after } = hunk
  const at: number[] = []
  if (after.length === 0) {
    if (rows.length > 0) return { refused: 'the file is no longer empty, as the edit left it' }
    at.push(0)
  }
  for (let i = 0; after.length > 0 && i + after.length <= rows.length; i++) {
    if (after.every((l, j) => rows[i + j]!.t === l)) at.push(i)
  }
  if (at.length === 0) return { refused: 'those lines have changed since the edit' }
  const expected = hunk.line - 1
  const i = at.length === 1 ? at[0]! : at.includes(expected) ? expected : undefined
  if (i === undefined) return { refused: `those lines appear ${at.length} times and none where the edit left them` }
  const atEnd = i + after.length === rows.length
  const put: Row[] = before.map((t, j) => {
    const e = j < after.length ? rows[i + j]!.e : eol
    return { t, e: e === '' ? eol : e }
  })
  const lastPut = put[put.length - 1]
  // The final newline: as the diff says the file had it before the edit; else as the file has it now.
  if (atEnd && lastPut) {
    lastPut.e = hunk.beforeNoEol ? '' : hunk.afterNoEol || rows.length === 0 ? eol : rows[rows.length - 1]!.e
  }
  rows.splice(i, after.length, ...put)
  return { text: rows.map(r => r.t + r.e).join(''), at: i }
}

export const undoHunk = (text: string, hunk: Hunk): { text: string } | { refused: string } => {
  const got = undoAt(text, hunk)
  return 'refused' in got ? got : { text: got.text }
}

/** The change number and hunk number of `3` or `3.2`. */
export const parseRef = (arg: string): { n: number; h?: number } | undefined => {
  const m = /^#?(\d+)(?:\.(\d+))?$/.exec(arg.trim())
  if (!m) return undefined
  return { n: Number(m[1]), h: m[2] === undefined ? undefined : Number(m[2]) }
}

const time = (iso: string) => {
  const d = new Date(iso)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':')
}

const slashed = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** One file as one key however it is spelled: forward slashes, no doubled or final slash, drive letter upper case. */
export const fileKey = (p: string) => slashed(p).replace(/\/{2,}/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)

// One undo at a time, and no Edit or Write runs while one does: an undo reads a file and writes
// it back, and an edit landing in between would be lost.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T,>(f: () => Promise<T>): Promise<T> => {
  const p = queue.then(f, f)
  queue = p.catch(() => undefined)
  return p
}

const counted = (h: Hunk) => {
  // Context lines are the common head and tail of before and after.
  let head = 0
  while (head < h.before.length && head < h.after.length && h.before[head] === h.after[head]) head++
  let tail = 0
  while (tail < h.before.length - head && tail < h.after.length - head &&
    h.before[h.before.length - 1 - tail] === h.after[h.after.length - 1 - tail]) tail++
  const added = h.after.slice(head, h.after.length - tail)
  const removed = h.before.slice(head, h.before.length - tail)
  const first = (added.find(l => l.trim() !== '') ?? removed.find(l => l.trim() !== '') ?? '').trim()
  return { head, minus: removed.length, plus: added.length, first: first.length > 50 ? `${first.slice(0, 49)}…` : first }
}

/** The list, newest change first, each hunk numbered `<change>.<hunk>`. */
export const listing = (list: readonly Change[], shown: (file: string) => string, limit = 20): string => {
  if (list.length === 0) return 'agent-undo: no edits by Claude in this session yet.'
  const out: string[] = []
  for (const c of [...list].reverse().slice(0, limit)) {
    const who = c.agent ? ` (subagent ${c.agent.slice(0, 8)})` : ''
    const note = c.created ? ' (new file)' : c.tooLarge ? ' (too large to undo here)' : ''
    if (c.tool === 'Bash') {
      const fs = c.files ?? []
      out.push(`#${c.n} ${time(c.at)} Bash ${c.file} (${c.tooLarge ? 'over 200' : fs.length} file${fs.length === 1 ? '' : 's'})${who}${note}`)
      fs.forEach((f, k) => {
        const what = f.status === 'A' ? 'new file' : f.status === 'D' ? 'deleted' : 'changed'
        const why = f.fixed ? ` (${f.fixed}: not undone here)` : ''
        out.push(`   ${c.n}.${k + 1} ${what} ${shown(`${c.top}/${f.path}`)}${why}${f.undone ? '  (undone)' : ''}`)
      })
      continue
    }
    out.push(`#${c.n} ${time(c.at)} ${c.tool} ${shown(c.file)}${who}${note}`)
    c.hunks.forEach((h, k) => {
      const { head, minus, plus, first } = counted(h)
      out.push(`   ${c.n}.${k + 1} line ${h.line + head}: -${minus} +${plus}${first ? `  ${first}` : ''}${h.undone ? '  (undone)' : ''}`)
    })
  }
  if (list.length > limit) out.push(`… ${list.length - limit} older`)
  out.push('Undo one: /agent-undo 3.1   all of one edit: /agent-undo 3')
  return out.join('\n')
}

// ---- Bash: what a shell command changed, from git's view of the work tree before and after it.
// A private index (never the person's) takes `git add -A` and `write-tree`: no commit, no ref, and
// the person's staged changes stay as they are. Files git ignores are not seen.

type Repo = { top: string; index: string; env: Record<string, string> }

const git = async ($: EngineInterface, argv: string[], cwd: string, env?: Record<string, string>) => {
  const r = await $.process.run(['git', ...argv], { cwd, timeoutMs: 20000, ...(env ? { env } : {}) })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git ${argv[0]} failed`)
  return r.stdout
}

/** The repo around the session's folder, with the private index seeded once from the real one. */
const repoOf = async ($: EngineInterface): Promise<Repo | undefined> => {
  try {
    const root = await $.session.root()
    const top = (await git($, ['rev-parse', '--show-toplevel'], root)).trim()
    const [real, index] = (await git($, ['rev-parse', '--path-format=absolute', '--git-path', 'index', '--git-path', INDEX], top)).trim().split('\n')
    if (!top || !real || !index) return undefined
    // A copy of the real index keeps git's file timestamps, so the first snapshot hashes only
    // what changed. Without one (no cp, no commit yet) the first snapshot reads every file.
    if (!(await $.fs.exists(index)) && (await $.fs.exists(real))) {
      await $.process.run(['cp', real, index], { cwd: top }).catch(() => undefined)
    }
    return { top, index, env: { GIT_INDEX_FILE: index } }
  } catch {
    return undefined
  }
}

// Snapshots share one index file, so they take turns; the commands themselves do not wait.
let snaps: Promise<unknown> = Promise.resolve()
const snapshot = (repo: Repo, $: EngineInterface): Promise<string> => {
  const p = snaps.then(async () => {
    await git($, ['add', '-A'], repo.top, repo.env)
    return (await git($, ['write-tree'], repo.top, repo.env)).trim()
  })
  snaps = p.catch(() => undefined)
  return p
}

/**
 * The files an Edit or Write touched while each shell command ran: theirs, not the command's.
 * Marked when the Edit or Write starts, and an open window takes the ones still running.
 */
const windows = new Set<Set<string>>()
const inFlight = new Map<string, number>()
const touched = (file: unknown) => {
  if (typeof file !== 'string' || file === '') return
  for (const w of windows) w.add(fileKey(file))
}
const editing = async <T,>(file: unknown, f: () => Promise<T>): Promise<T> => {
  const k = typeof file === 'string' && file !== '' ? fileKey(file) : ''
  touched(k)
  inFlight.set(k, (inFlight.get(k) ?? 0) + 1)
  try {
    return await f()
  } finally {
    const left = (inFlight.get(k) ?? 1) - 1
    if (left > 0) inFlight.set(k, left)
    else inFlight.delete(k)
  }
}

const commandLabel = (command: unknown) => {
  const first = String(command ?? '').trim().split('\n')[0] ?? ''
  return first.length > 60 ? `${first.slice(0, 59)}…` : first
}

/** Adds one change to the session's list, numbered after the highest so far. */
async function record($: EngineInterface, c: Omit<Change, 'n'>) {
  if (c.tool !== 'Bash') touched(c.file)
  const lines = c.hunks.reduce((s, h) => s + h.before.length + h.after.length, 0)
  const kept = lines > MAX_LINES || (c.files?.length ?? 0) > MAX_FILES ? { ...c, hunks: [], files: c.files && [], tooLarge: true } : c
  await update($, changes, list => {
    const n = list.reduce((m, x) => Math.max(m, x.n), 0) + 1
    return [...list, { ...kept, n }].slice(-MAX_CHANGES)
  })
  const all = await read($, changes)
  const last = all[all.length - 1]
  if (last && last.tool === 'Bash') $.ui.status(`#${last.n} Bash (${last.files?.length ?? 0} file${last.files?.length === 1 ? '' : 's'}) · /agent-undo`)
  else if (last) $.ui.status(`#${last.n} ${last.file.split(/[\\/]/).pop()} (${last.hunks.length} hunk${last.hunks.length === 1 ? '' : 's'}) · /agent-undo`)
}

/**
 * Puts back files a shell command changed or deleted, each from the tree before the command,
 * only where the file still reads as the command left it (or, deleted, is still absent).
 */
async function undoShell($: EngineInterface, c: Change, h: number | undefined, arg: string, shown: (f: string) => string): Promise<string> {
  const files = (c.files ?? []).map(f => ({ ...f }))
  if (c.tooLarge || !c.top || !c.tree) return `agent-undo: #${c.n} changed too many files for a file-by-file record; nothing changed.`
  const picked = h === undefined ? files.map((_, k) => k) : [h - 1]
  if (picked.some(k => !files[k])) return `agent-undo: #${c.n} has ${files.length} file(s); no ${arg}.`
  const undone: number[] = []
  const notes: string[] = []
  for (const k of picked) {
    const f = files[k]!
    const ref = `${c.n}.${k + 1}`
    const name = shown(`${c.top}/${f.path}`)
    if (f.undone) { notes.push(`${ref} was already undone`); continue }
    if (f.fixed) { notes.push(`${ref} left as is: ${name} is ${f.fixed}`); continue }
    if (f.status === 'A') { notes.push(`${ref} left as is: ${name} is a new file; nothing was there before. Delete it yourself if you want it gone.`); continue }
    try {
      const there = await $.fs.exists(`${c.top}/${f.path}`)
      if (f.status === 'D' && there) { notes.push(`${ref} left as is: there is a file at ${name} again`); continue }
      if (f.status !== 'D') {
        const now = there ? (await git($, ['hash-object', '--', f.path], c.top)).trim() : ''
        if (now !== f.after) { notes.push(`${ref} left as is: ${name} has changed since the command`); continue }
      }
      await git($, ['restore', `--source=${c.tree}`, '--worktree', '--', `:(literal)${f.path}`], c.top)
      f.undone = true
      undone.push(k)
    } catch (err) {
      notes.push(`${ref} left as is: git said ${String((err as Error).message ?? err).split('\n')[0]}`)
    }
  }
  if (undone.length > 0) {
    await update($, changes, all => all.map(x => (x.n !== c.n ? x : { ...x, files })))
  }
  const did = undone.length > 0
    ? `undid ${undone.map(k => `${c.n}.${k + 1}`).join(', ')}: ${undone.map(k => shown(`${c.top}/${files[k]!.path}`)).join(', ')}`
    : 'nothing changed'
  return [`agent-undo: ${did}.`, ...notes].join('\n')
}

/** What `/agent-undo <args>` and the undo tool answer: the list, or the outcome of one undo. */
async function run($: EngineInterface, args: string): Promise<string> {
  const root = slashed(await $.session.root())
  const shown = (f: string) => (slashed(f).startsWith(`${root}/`) ? slashed(f).slice(root.length + 1) : f)
  const arg = args.trim()
  const list = await read($, changes)
  if (arg === '' || arg === 'list') return listing(list, shown)
  const ref = parseRef(arg)
  const c = ref && list.find(x => x.n === ref.n)
  if (!ref || !c) return `agent-undo: no edit "${arg}". Type /agent-undo to see the list.`
  if (c.tool === 'Bash') return undoShell($, c, ref.h, arg, shown)
  if (c.created) return `agent-undo: #${c.n} created ${shown(c.file)}; nothing was there before. Delete it yourself if you want it gone.`
  if (c.tooLarge) return `agent-undo: #${c.n} was too large for a hunk-by-hunk record; nothing changed.`
  const picked = ref.h === undefined ? c.hunks.map((_, k) => k) : [ref.h - 1]
  if (picked.some(k => !c.hunks[k])) return `agent-undo: #${c.n} has ${c.hunks.length} hunk(s); no ${arg}.`
  if (!(await $.fs.exists(c.file))) return `agent-undo: ${shown(c.file)} is gone; nothing changed.`
  let text = await $.fs.read(c.file)
  const undone: number[] = []
  const notes: string[] = []
  const hs = c.hunks.map(h => ({ ...h }))
  // Last hunk first, so each recorded line number still points at its own hunk.
  for (const k of [...picked].sort((a, b) => b - a)) {
    const h = hs[k]!
    if (h.undone) { notes.push(`${c.n}.${k + 1} was already undone`); continue }
    const got = undoAt(text, h)
    if ('refused' in got) { notes.push(`${c.n}.${k + 1} left as is: ${got.refused}`); continue }
    text = got.text
    undone.push(k)
    // Later hunks of this edit moved by the lines this one put back.
    const delta = h.before.length - h.after.length
    for (const o of hs) if (o !== h && o.line - 1 > got.at) o.line += delta
  }
  if (undone.length > 0) {
    await $.fs.write(c.file, text)
    await update($, changes, all => all.map(x => x.n !== c.n ? x : {
      ...x, hunks: hs.map((h, k) => (undone.includes(k) ? { ...h, undone: true } : h)),
    }))
  }
  const did = undone.length > 0
    ? `undid ${[...undone].sort((a, b) => a - b).map(k => `${c.n}.${k + 1}`).join(', ')} in ${shown(c.file)}`
    : `nothing changed in ${shown(c.file)}`
  return [`agent-undo: ${did}.`, ...notes].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-undo',
      description: "List Claude's edits in this session, or undo one: /agent-undo 3.1 (one hunk) or /agent-undo 3",
    })
    await $.tool.register({
      name: 'undo',
      description: "Lists the edits you (and your subagents) made to files in this session, numbered, each hunk as <edit>.<hunk>, " +
        'or undoes one when the person asks: ref "" lists, "3" undoes all of edit 3, "3.2" one hunk. An undo puts back only ' +
        "lines that still read as your edit left them; the person's own later changes stay. List first, then undo the ref " +
        'that matches what the person asked for, and tell them the outcome line word for word.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string', description: '"" to list; "3" or "3.2" to undo' } } },
      isDeferred: false,
    })
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const done = await editing((e as { file_path?: unknown }).file_path, () => serial(() => next(e)))
    try {
      if (done.deny !== undefined || done.isError || !done.result || done.result.staged) return done
      const out = done.result
      const hunks = hunksOf(out.structuredPatch ?? [])
      await record($, {
        at: new Date().toISOString(), tool: 'Edit', file: out.filePath, agent: e.agentId,
        hunks, ...(hunks.length === 0 ? { tooLarge: true } : {}),
      })
    } catch {
      // A failure of this mod never changes the edit.
    }
    return done
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const done = await editing((e as { file_path?: unknown }).file_path, () => serial(() => next(e)))
    try {
      if (done.deny !== undefined || done.isError || !done.result || done.result.staged) return done
      const out = done.result
      const created = out.type === 'create'
      const hunks = created ? [] : hunksOf(out.structuredPatch ?? [])
      await record($, {
        at: new Date().toISOString(), tool: 'Write', file: out.filePath, agent: e.agentId, hunks,
        ...(created ? { created: true } : hunks.length === 0 && out.originalFile === null ? { tooLarge: true } : {}),
      })
    } catch {
      // A failure of this mod never changes the write.
    }
    return done
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const repo = await repoOf($)
    const before = repo && (await snapshot(repo, $).catch(() => undefined))
    if (!repo || !before) return next(e)
    const mine = new Set<string>([...inFlight.keys()].filter(k => k !== ''))
    windows.add(mine)
    let done
    try {
      done = await next(e)
    } finally {
      windows.delete(mine)
    }
    try {
      if (done.deny !== undefined) return done
      const after = await snapshot(repo, $)
      if (after === before) return done
      const all = filesOf(await git($, ['diff-tree', '-r', '-z', '--no-renames', before, after], repo.top))
      const files = all.filter(f => !mine.has(fileKey(`${repo.top}/${f.path}`)))
      if (files.length === 0) return done
      await record($, {
        at: new Date().toISOString(), tool: 'Bash', file: commandLabel((e as { command?: unknown }).command),
        agent: e.agentId, hunks: [], top: repo.top, tree: before, files,
      })
    } catch {
      // A failure of this mod never changes the command.
    }
    return done
  })

  on('command.run', { command: 'agent-undo' }, async ($, e) => ({ text: await serial(() => run($, e.args)) }))

  on('tool.call', { tool: 'mcp__agent-undo__undo' }, async ($, e) => {
    const ref = (e as unknown as { ref?: unknown }).ref
    return { result: await serial(() => run($, typeof ref === 'string' ? ref : '')) } as never
  })
}
