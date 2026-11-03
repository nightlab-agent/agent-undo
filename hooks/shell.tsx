import type { EngineInterface, Register } from 'claude-code'

import type { Change, ShellFile } from '../types'
import { beginRecord, endRecord, fileKey, forgetRestore, inFlight, mirrorEnding, record, saved, slashed, time, touched, updateList, windows } from './common'

// The session's list is changed only through common.tsx (updateList), which mirrors it to the store.

const INDEX = 'agent-undo.index'
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

// ---- Bash: what a shell command changed, from git's view of the work tree before and after it.
// A private index (never the person's) takes `git add -A` and `write-tree`: no commit, no ref, and
// the person's staged changes stay as they are. Files git ignores are not seen.

/** `top`: git's own top (resolved), where git runs. `root` and `prefix`: the session's folder as the
 * session spells it and its place under the top, so a file reads as Claude's own paths do. */
type Repo = { top: string; root: string; prefix: string; index: string; real?: string; env: Record<string, string> }

/** A path from git (relative to its top) as the session spells it: under the session's folder
 * through its own spelling (a symbolic link to a subfolder included), elsewhere through git's top. */
export const spelled = (r: { top?: string; root?: string; prefix?: string }, p: string) =>
  r.root !== undefined && r.prefix !== undefined && p.startsWith(r.prefix) ? `${r.root}/${p.slice(r.prefix.length)}` : `${r.top}/${p}`

async function git($: EngineInterface, argv: string[], cwd: string, env?: Record<string, string>) {
  const r = await $.process.run(['git', ...argv], { cwd, timeoutMs: 20000, ...(env ? { env } : {}) })
  if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `git ${argv[0]} failed`)
  return r.stdout
}

/**
 * The repo around the session's folder, its top spelled as the session spells it (git resolves
 * symbolic links; Claude's file paths do not), with the private index seeded once from the real one.
 */
async function repoOf($: EngineInterface): Promise<Repo | undefined> {
  try {
    const root = slashed(await $.session.root())
    const [gitTop = '', prefix = ''] = (await git($, ['rev-parse', '--show-toplevel', '--show-prefix'], root)).split('\n')
    const top = slashed(gitTop.trim())
    const [real, index] = (await git($, ['rev-parse', '--path-format=absolute', '--git-path', 'index', '--git-path', INDEX], top)).trim().split('\n')
    if (!top || !real || !index) return undefined
    // A copy of the real index keeps git's file timestamps, so the first snapshot hashes only
    // what changed. Without one (no cp, no commit yet) the first snapshot reads every file.
    if (!(await $.fs.exists(index)) && (await $.fs.exists(real))) {
      await $.process.run(['cp', real, index], { cwd: top }).catch(() => undefined)
    }
    return { top, root, prefix: prefix.trim(), index, real, env: { GIT_INDEX_FILE: index } }
  } catch {
    return undefined
  }
}

// Snapshots and restores share one index file, so they take turns; the commands do not wait.
let snaps: Promise<unknown> = Promise.resolve()
const onIndex = <T,>(f: () => Promise<T>): Promise<T> => {
  const p = snaps.then(f)
  snaps = p.catch(() => undefined)
  return p
}
function snapshot(repo: Repo, $: EngineInterface): Promise<string> {
  return onIndex(async () => {
  const once = async () => {
    await git($, ['add', '-A'], repo.top, repo.env)
    return (await git($, ['write-tree'], repo.top, repo.env)).trim()
  }
  try {
    return await once()
  } catch {
    // `git gc` removes objects only the private index names (it does not know the index), and
    // write-tree then fails: seed it again from the real index, or empty it, and try once more.
    const r = repo.real ? await $.process.run(['cp', repo.real, repo.index], { cwd: repo.top }).catch(() => undefined) : undefined
    if (!r || r.exitCode !== 0) await git($, ['read-tree', '--empty'], repo.top, repo.env)
    return await once()
  }
  })
}


/**
 * One shell command between its two snapshots. Taken when the engine allows the call with no
 * question (tool.check), so nothing the person saves while a question waits is in it; a command
 * that runs only after a question is not recorded. Its window stays open until the second
 * snapshot is written. Two commands open at once are not recorded: each tree holds both.
 */
type Shell = { id: string; repo: Repo; before: string; mine: Set<string>; overlapped: boolean; maybe: Set<string> }
const shells = new Set<Shell>()
const pending = new Map<string, Shell>()
const asked = new Set<string>()
/** Every call this hook is wrapping, recorded or not, and its kind: a call running in a shell's window
 * makes it overlapped (a Bash command at once; an MCP call when it ends, unless it ended read-only). */
const running = new Map<string, 'Bash' | 'MCP'>()
/** Call `id` ran in `sh`'s window: a Bash command overlaps it now; an MCP call waits in `maybe` until it ends. */
const overlap = (sh: Shell, id: string) => {
  if (id === sh.id) return
  if (running.get(id) === 'MCP') sh.maybe.add(id)
  else sh.overlapped = true
}
/** An MCP call ended: read-only (the engine's `isReadOnly`), it overlapped nothing; otherwise every window it ran in is overlapped. */
const settle = (id: string, readOnly: boolean) => {
  for (const o of shells) {
    if (o.maybe.delete(id) && !readOnly) o.overlapped = true
  }
}
/** Set when a command went on in the background: its later writes would land in any later record. */
let stopped: string | undefined

async function begin($: EngineInterface, id: string): Promise<Shell | undefined> {
  if (stopped) return undefined
  const repo = await repoOf($)
  if (!repo || !running.has(id)) return undefined
  const sh: Shell = { id, repo, before: '', mine: new Set([...inFlight.keys()].filter(k => k !== '')), overlapped: false, maybe: new Set() }
  // A window still open after its call ended (its second snapshot running) counts too.
  for (const o of shells) { overlap(sh, o.id); overlap(o, id) }
  for (const r of running.keys()) overlap(sh, r)
  shells.add(sh)
  windows.add(sh.mine)
  try {
    sh.before = await snapshot(repo, $)
    // Its call ended while the snapshot ran (interrupted): nothing will take this one.
    if (!running.has(id)) { end(sh); return undefined }
    return sh
  } catch {
    end(sh)
    return undefined
  }
}
const end = (sh: Shell) => {
  shells.delete(sh)
  windows.delete(sh.mine)
}
const take = (id: unknown) => {
  const sh = typeof id === 'string' ? pending.get(id) : undefined
  if (typeof id === 'string') { pending.delete(id); asked.delete(id) }
  return sh
}

/** agent-undo's own model tool, exactly the name `$.tool.register` returned (its undo is not a change to
 * record); until it answers, the name its own hook serves. Only that name: a configured server that
 * happens to be named agent-undo is another server and is recorded. */
let own = 'mcp__agent-undo__undo'
export const ownTool = (name: unknown) => { if (typeof name === 'string' && name.startsWith('mcp__')) own = name }
/** An MCP tool's call, by its wire name, that is not this mod's own. */
export const isMcp = (tool: unknown): tool is string => typeof tool === 'string' && tool.startsWith('mcp__') && tool !== own
/** `mcp__filesystem__write_file` as `filesystem write_file`: one line, at most 60 characters. */
export const mcpLabel = (tool: string) => {
  const rest = tool.slice('mcp__'.length)
  const k = rest.indexOf('__')
  const name = (k < 0 ? rest : `${rest.slice(0, k)} ${rest.slice(k + 2)}`).replace(/[\u0000-\u001f\u007f]/g, ' ')
  return name.length > 60 ? `${name.slice(0, 59)}…` : name
}

const commandLabel = (command: unknown) => {
  const first = String(command ?? '').trim().split('\n')[0] ?? ''
  return first.length > 60 ? `${first.slice(0, 59)}…` : first
}
/**
 * Puts back files a shell command changed or deleted, each from the tree before the command,
 * only where the file still reads as the command left it (or, deleted, is still absent).
 */
export async function undoShell($: EngineInterface, c: Change, h: number | undefined, arg: string, shown: (f: string) => string): Promise<string> {
  const files = (c.files ?? []).map(f => ({ ...f }))
  if (c.tooLarge || !c.top || !c.tree) return `agent-undo: #${c.n} changed too many files for a file-by-file record; nothing changed.`
  const picked = h === undefined ? files.map((_, k) => k) : [h - 1]
  if (picked.some(k => !files[k])) return `agent-undo: #${c.n} has ${files.length} file(s); no ${arg}.`
  const undone: number[] = []
  const notes: string[] = []
  for (const k of picked) {
    const f = files[k]!
    const ref = `${c.n}.${k + 1}`
    const name = shown(spelled(c, f.path))
    if (f.undone) { notes.push(`${ref} was already undone`); continue }
    if (f.fixed) { notes.push(`${ref} left as is: ${name} is ${f.fixed}`); continue }
    if (f.status === 'A') { notes.push(`${ref} left as is: ${name} is a new file; nothing was there before. Delete it yourself if you want it gone.`); continue }
    try {
      const there = await $.fs.exists(`${c.top}/${f.path}`)
      if (f.status === 'D' && there) { notes.push(`${ref} left as is: there is a file at ${name} again`); continue }
      if (f.status !== 'D') {
        const now = there ? (await git($, ['hash-object', '--', f.path], c.top)).trim() : ''
        if (now !== f.after) { notes.push(`${ref} left as is: ${name} has changed since the ${c.tool === 'MCP' ? 'call' : 'command'}`); continue }
      }
      // On the private index: the person's own git may hold the real one's lock.
      const repo = await repoOf($)
      if (!repo) throw new Error('the repo is no longer there')
      // An open window (a Bash command or MCP call running now) must not take this undo as its change.
      touched(spelled(c, f.path))
      await onIndex(() => git($, ['restore', `--source=${c.tree}`, '--worktree', '--', `:(literal)${f.path}`], c.top!, repo.env))
      f.undone = true
      undone.push(k)
    } catch (err) {
      notes.push(`${ref} left as is: git said ${String((err as Error).message ?? err).split('\n')[0]}`)
    }
  }
  if (undone.length > 0) {
    await updateList($, all => all.map(x => (x.n !== c.n ? x : { ...x, files })))
  }
  const did = undone.length > 0
    ? `undid ${undone.map(k => `${c.n}.${k + 1}`).join(', ')}: ${undone.map(k => shown(spelled(c, files[k]!.path))).join(', ')}`
    : 'nothing changed'
  return [`agent-undo: ${did}.`, ...notes].join('\n')
}

type Verdict = { decision: string }
type Done = { deny?: unknown; isError?: unknown; result?: unknown }

/** The engine's decision for one wrapped call: an "allow" with no question first takes the before-snapshot. */
async function checked<V extends Verdict>($: EngineInterface, id: unknown, verdict: V): Promise<V> {
  try {
    // The first decision for a call stands: a later "allow" for a call that was asked about (the
    // question answered) or already snapshotted starts nothing.
    if (typeof id === 'string' && verdict.decision !== 'allow') asked.add(id)
    if (verdict.decision === 'allow' && typeof id === 'string' && !pending.has(id) && !asked.has(id)) {
      const sh = await begin($, id)
      if (sh) pending.set(id, sh)
    }
  } catch {
    // A failure of this mod never changes the verdict.
  }
  return verdict
}

/** One wrapped call: run it, then snapshot again and record the files that differ, as `tool` named `label`. */
async function around<D extends Done>($: EngineInterface, rawId: unknown, agent: string | undefined, tool: 'Bash' | 'MCP',
  label: string, call: () => Promise<D>): Promise<D> {
  const id = typeof rawId === 'string' ? rawId : undefined
  // Only a call this hook wraps gets a snapshot (its check runs inside the call); while it runs,
  // every other open window is overlapped (by an MCP call only if it does not end read-only).
  if (id) {
    running.set(id, tool)
    for (const o of shells) overlap(o, id)
  }
  let done: D
  try {
    done = await call()
  } catch (err) {
    if (id) { running.delete(id); settle(id, false) }
    const sh = take(id)
    if (sh) end(sh)
    throw err
  }
  if (id) { running.delete(id); settle(id, (done as { isReadOnly?: unknown }).isReadOnly === true) }
  const sh = take(id)
  // Any command that goes on in the background, recorded or not (one approved at a prompt too),
  // could write into a later command's window.
  if (done.deny === undefined && (done.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId !== undefined && !stopped) {
    stopped = `a command went on in the background at ${time(new Date().toISOString())}, and its later writes would land in any later record`
    try { $.ui.status('agent-undo: shell commands no longer recorded (one runs in the background) · /agent-undo') } catch {}
  }
  if (!sh) return done
  // From the tool result to record()'s list update the call counts as an edit on its way (the end's wait).
  beginRecord()
  try {
    // A failed command may still have changed files and is recorded; an MCP tool that answered an error is not.
    if (done.deny !== undefined || stopped || (tool === 'MCP' && done.isError)) return done
    const after = await snapshot(sh.repo, $)
    // An MCP call not yet ended in this window may still write into it.
    if (sh.overlapped || sh.maybe.size > 0) {
      $.ui.status(`agent-undo: two ${tool === 'MCP' ? 'tool calls' : 'shell commands'} ran at once; neither recorded · /agent-undo`)
      return done
    }
    if (after === sh.before) return done
    const all = filesOf(await git($, ['diff-tree', '-r', '-z', '--no-renames', sh.before, after], sh.repo.top))
    const files = all.filter(f => !sh.mine.has(fileKey(spelled(sh.repo, f.path))))
    if (files.length === 0) return done
    await record($, {
      at: new Date().toISOString(), tool, file: label,
      agent, hunks: [], top: sh.repo.top, root: sh.repo.root, prefix: sh.repo.prefix, tree: sh.before, files,
    })
  } catch {
    // A failure of this mod never changes the call.
  } finally {
    end(sh)
    endRecord()
  }
  return done
}

/** A new conversation (a start, or the process going on after /clear) starts with no shell state. */
export const resetShells = () => {
  stopped = undefined
  for (const sh of shells) end(sh)
  pending.clear()
  asked.clear()
  running.clear()
}

/** Why shell commands are no longer recorded in this session, if they are not. */
export const shellStopped = () => stopped

/** The Bash hooks: the first snapshot at the engine's decision, the second after the command. */
export const registerShell = (on: Parameters<Register>[0]) => {
  on('session.end', async ($, e, next) => {
    resetShells()
    // A /clear or /resume swaps the conversation in this process with no session.start: the next one's
    // list (an id seen before, too) is read from the store again, never taken for already loaded.
    // An exit (or logout) keeps it: the last edit's copy may still be on its way to the store.
    if (e.reason === 'clear' || e.reason === 'resume') {
      try { await mirrorEnding($, e.sessionId) } catch {}
      forgetRestore()
    }
    // The last edit's copy (and the ending list's, and every write passed by, as a /resume back waits for them)
    // lands before the end step, within the chain's short bound (tests/review-pr5.test.tsx).
    try { await saved($, Math.min(1000, next.budget.remainingMs - 250), next.signal, true, true) } catch {}
    // The status line names this conversation's newest change; after a /clear it is not the next one's.
    try { $.ui.status(undefined) } catch {}
    return next(e)
  })

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => checked($, e.tool_use_id, await next(e)))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) =>
    around($, e.tool_use_id, e.agentId, 'Bash', commandLabel((e as { command?: unknown }).command), () => next(e)))

  // MCP tools write files Claude Code's checkpoints do not track: each call is recorded as a Bash
  // command is, sharing its windows (a call beside a command or another call is not recorded, unless the other is an MCP call that ended
  // read-only, the engine's isReadOnly).
  // Every other tool passes straight on, untouched.
  on('tool.check', async ($, e, next) => (isMcp(e.tool) ? checked($, e.tool_use_id, await next(e)) : next(e)))

  on('tool.call', async ($, e, next) =>
    isMcp(e.tool) ? around($, e.tool_use_id, e.agentId, 'MCP', mcpLabel(e.tool), () => next(e)) : next(e))

}
