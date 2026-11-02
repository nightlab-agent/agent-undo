import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Change, ShellFile } from '../types'
import { fileKey, inFlight, record, slashed, time, windows } from './common'

// The session's list (the same plugin, key and shape in each file that reads or writes it: the
// engine's scan lists a module's state per file). Change the tag in all three when a Change's
// fields change: it declines what an earlier version stored.
const changes = atom({ plugin: 'agent-undo', key: 'changes' } as const, [], { shape: 'changes-2' })

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
type Shell = { id: string; repo: Repo; before: string; mine: Set<string>; overlapped: boolean }
const shells = new Set<Shell>()
const pending = new Map<string, Shell>()
const asked = new Set<string>()
/** Every Bash call this hook is wrapping, recorded or not: a call running in a shell's window makes it overlapped. */
const running = new Set<string>()
/** Set when a command went on in the background: its later writes would land in any later record. */
let stopped: string | undefined

async function begin($: EngineInterface, id: string): Promise<Shell | undefined> {
  if (stopped) return undefined
  const repo = await repoOf($)
  if (!repo || !running.has(id)) return undefined
  const others = shells.size > 0 || [...running].some(r => r !== id)
  const sh: Shell = { id, repo, before: '', mine: new Set([...inFlight.keys()].filter(k => k !== '')), overlapped: others }
  for (const o of shells) o.overlapped = true
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
        if (now !== f.after) { notes.push(`${ref} left as is: ${name} has changed since the command`); continue }
      }
      // On the private index: the person's own git may hold the real one's lock.
      const repo = await repoOf($)
      if (!repo) throw new Error('the repo is no longer there')
      await onIndex(() => git($, ['restore', `--source=${c.tree}`, '--worktree', '--', `:(literal)${f.path}`], c.top!, repo.env))
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
    ? `undid ${undone.map(k => `${c.n}.${k + 1}`).join(', ')}: ${undone.map(k => shown(spelled(c, files[k]!.path))).join(', ')}`
    : 'nothing changed'
  return [`agent-undo: ${did}.`, ...notes].join('\n')
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
    return next(e)
  })

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    try {
      // The first decision for a call stands: a later "allow" for a call that was asked about (the
      // question answered) or already snapshotted starts nothing.
      const id = e.tool_use_id
      if (typeof id === 'string' && verdict.decision !== 'allow') asked.add(id)
      if (verdict.decision === 'allow' && typeof id === 'string' && !pending.has(id) && !asked.has(id)) {
        const sh = await begin($, id)
        if (sh) pending.set(id, sh)
      }
    } catch {
      // A failure of this mod never changes the verdict.
    }
    return verdict
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const id = typeof e.tool_use_id === 'string' ? e.tool_use_id : undefined
    // Only a call this hook wraps gets a snapshot (its check runs inside next(e)); while it runs,
    // every other shell's window is overlapped.
    if (id) {
      running.add(id)
      for (const o of shells) if (o.id !== id) o.overlapped = true
    }
    let done
    try {
      done = await next(e)
    } catch (err) {
      if (id) running.delete(id)
      const sh = take(id)
      if (sh) end(sh)
      throw err
    }
    if (id) running.delete(id)
    const sh = take(id)
    // Any command that goes on in the background, recorded or not (one approved at a prompt too),
    // could write into a later command's window.
    if (done.deny === undefined && (done.result as { backgroundTaskId?: unknown } | undefined)?.backgroundTaskId !== undefined && !stopped) {
      stopped = `a command went on in the background at ${time(new Date().toISOString())}, and its later writes would land in any later record`
      try { $.ui.status('agent-undo: shell commands no longer recorded (one runs in the background) · /agent-undo') } catch {}
    }
    if (!sh) return done
    try {
      if (done.deny !== undefined || stopped) return done
      const after = await snapshot(sh.repo, $)
      if (sh.overlapped) {
        $.ui.status('agent-undo: two shell commands ran at once; neither recorded · /agent-undo')
        return done
      }
      if (after === sh.before) return done
      const all = filesOf(await git($, ['diff-tree', '-r', '-z', '--no-renames', sh.before, after], sh.repo.top))
      const files = all.filter(f => !sh.mine.has(fileKey(spelled(sh.repo, f.path))))
      if (files.length === 0) return done
      await record($, {
        at: new Date().toISOString(), tool: 'Bash', file: commandLabel((e as { command?: unknown }).command),
        agent: e.agentId, hunks: [], top: sh.repo.top, root: sh.repo.root, prefix: sh.repo.prefix, tree: sh.before, files,
      })
    } catch {
      // A failure of this mod never changes the command.
    } finally {
      end(sh)
    }
    return done
  })

}
