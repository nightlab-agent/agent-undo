import { stopped } from './shared'
import type { EngineInterface } from 'claude-code'

import type { Change, ShellFile } from '../types'
import { inTurn, touched, updateList } from './common'
import type { Turn, Why } from './shared'
import { git, gitSaid, onIndex, repoOf, spelled } from './shell'

// ---- A shell undo: each file back from the tree before the command, after the checks that it is still the command's.

/** The nearest parent of `path` that is no longer a folder: real git would replace it to bring the file back. */
async function inTheWay($: EngineInterface, top: string, path: string) {
  const parts = path.split('/').slice(0, -1)
  for (let i = 1; i <= parts.length; i++) {
    const parent = parts.slice(0, i).join('/')
    const s = await $.fs.stat(`${top}/${parent}`).catch(() => undefined)
    if (!s) return undefined
    if (s.isLink || s.kind !== 'dir') return parent
  }
  return undefined
}

/** The file's permission bits, by GNU's `stat` and then BSD's (`$.fs.stat` has no mode); undefined where neither answers. */
async function bitsOf($: EngineInterface, top: string, path: string) {
  for (const format of [['-c', '%a'], ['-f', '%Lp']]) {
    const r = await $.process.run(['stat', ...format, '--', path], { cwd: top }).catch(() => undefined)
    const text = r?.exitCode === 0 ? r.stdout.trim() : ''
    if (/^[0-7]{3,4}$/.test(text)) return parseInt(text, 8)
  }
  return undefined
}

/** The file's permissions before a restore: its bits, and its executable bit where git tracks one (`x`). */
type Perms = { bits: number | undefined; x: boolean | undefined }

/** Read before the last hash, so that nothing but the restore stands between that hash and the write. */
async function permissions($: EngineInterface, top: string, path: string): Promise<Perms> {
  const bits = await bitsOf($, top, path)
  try {
    const off = await $.process.run(['git', 'config', '--type=bool', 'core.filemode'], { cwd: top })
    if (off.stdout.trim() === 'false') return { bits, x: undefined }
    // git's own test of the bit: the owner's.
    return { bits, x: bits !== undefined ? (bits & 0o100) !== 0 : (await $.process.run(['test', '-x', path], { cwd: top })).exitCode === 0 }
  } catch {
    return { bits, x: undefined }
  }
}

/** The bits a restored file should have: the old ones, with the executable state git restored where the command changed it. */
const bitsBack = (old: number, restored: number | undefined, tracked: boolean) => {
  if (!tracked || restored === undefined) return old
  const x = (restored & 0o100) !== 0
  if (x === ((old & 0o100) !== 0)) return old
  return x ? old | ((old & 0o444) >> 2) : old & ~0o111
}

/** `git restore` recreated the file at the umask mode: puts its permissions back. The answer is what went wrong, if anything. */
async function keepBits($: EngineInterface, top: string, path: string, had: Perms, name: string) {
  if (had.bits === undefined) return undefined
  const now = await bitsOf($, top, path)
  const want = bitsBack(had.bits, now, had.x !== undefined)
  if (want === now) return undefined
  const why = await $.process.run(['chmod', want.toString(8), `./${path}`], { cwd: top })
    .then(r => (r.exitCode === 0 ? undefined : r.stderr.trim() || 'chmod failed'), (err: unknown) => String((err as Error)?.message ?? err))
  return why === undefined ? undefined : `${name} is back, but its permissions (${want.toString(8)}) are not: ${why.split('\n')[0]}`
}

/** Why the file at `f` cannot be put back as it stands, or nothing. Runs right before the restore, after any wait for the index. */
async function refusal($: EngineInterface, c: Change, f: ShellFile, name: string, shown: (f: string) => string, had: Perms) {
  const top = c.top!
  const path = `${top}/${f.path}`
  const there = await $.fs.exists(path)
  const parent = await inTheWay($, top, f.path)
  if (f.status === 'D') {
    // A stat, not exists: exists says no to a link that leads nowhere, and git would replace it.
    if (there || await $.fs.stat(path).catch(() => undefined)) return `there is a file at ${name} again`
    if (parent !== undefined) return `${shown(spelled(c, parent))} is no longer a folder; putting ${name} back would replace it`
    return undefined
  }
  if (parent !== undefined) return `${shown(spelled(c, parent))} is no longer a folder; putting ${name} back would replace it`
  if (await filtered($, top, f.path)) return `${name} goes through a git filter, which can hide a later change`
  const changed = `${name} has changed since the ${c.tool === 'MCP' ? 'call' : 'command'}`
  if (!there) return changed
  if ((await $.fs.stat(path)).isLink) return `${name} is now a link; putting it back would replace the link`
  // The bytes on disk: with its filters, git's hash hides a later change of line endings or an $Id$ keyword.
  if ((await git($, ['hash-object', '--no-filters', '--', f.path], top)).trim() !== f.after) {
    const same = (await git($, ['hash-object', '--', f.path], top)).trim() === f.after
    return same ? `git rewrites ${name} (its line endings or keywords), which can hide a later change` : changed
  }
  if (had.x !== undefined && had.x !== (f.exec === true)) return `the permissions of ${name} have changed since the ${c.tool === 'MCP' ? 'call' : 'command'}`
  return undefined
}

/** A clean filter (nbstripout, say) can make two different files hash the same, so a hash cannot show the file is unchanged. */
async function filtered($: EngineInterface, top: string, path: string) {
  const value = (await git($, ['check-attr', '-z', 'filter', '--', path], top)).split('\0')[2]
  return value !== undefined && value !== 'unspecified' && value !== 'unset'
}

async function sameAsLeft($: EngineInterface, top: string, f: ShellFile) {
  return (await $.fs.exists(`${top}/${f.path}`)) && (await git($, ['hash-object', '--no-filters', '--', f.path], top)).trim() === f.after
}

const leftBecause: Record<Why, string> = {
  budget: 'this undo ran out of time. Try again in a moment',
  interrupted: 'this undo was interrupted',
  ended: 'the conversation this undo belonged to has ended',
}

/**
 * Puts back files a shell command changed or deleted, each from the tree before the command,
 * only where the file still reads as the command left it (or, deleted, is still absent).
 */
export async function undoShell($: EngineInterface, c: Change, h: number | undefined, arg: string, shown: (f: string) => string, turn: Turn): Promise<string> {
  const files = (c.files ?? []).map(f => ({ ...f }))
  if (c.tooLarge || !c.top || !c.tree) return `agent-undo: #${c.n} changed too many files for a file-by-file record; nothing changed.`
  const picked = h === undefined ? files.map((_, k) => k) : [h - 1]
  if (picked.some(k => !files[k])) return `agent-undo: #${c.n} has ${files.length} file(s); no ${arg}.`
  const undone: number[] = []
  const notes: string[] = []
  let hurt = false
  for (const k of picked) {
    const f = files[k]!
    const ref = `${c.n}.${k + 1}`
    const name = shown(spelled(c, f.path))
    if (f.undone) { notes.push(`${ref} was already undone`); continue }
    if (f.fixed) { notes.push(`${ref} left as is: ${name} is ${f.fixed}`); continue }
    if (f.status === 'A') { notes.push(`${ref} left as is: ${name} is a new file; nothing was there before. Delete it yourself if you want it gone.`); continue }
    const why = stopped(turn)
    if (why) { notes.push(`${ref} left as is: ${leftBecause[why]}`); continue }
    let restoring = false
    try {
      // On the private index: the person's own git may hold the real one's lock.
      const repo = await repoOf($)
      if (!repo) throw new Error('the repo is no longer there')
      // The checks stand behind the wait for the index: a save made during that wait is seen.
      const no = await inTurn<string | undefined>(turn, job => onIndex($, job, false), async () => {
        // A deleted file has no permissions to keep.
        const had = f.status === 'D' ? { bits: undefined, x: undefined } : await permissions($, c.top!, f.path)
        const why = await refusal($, c, f, name, shown, had)
        if (why !== undefined) return why
        const stop = stopped(turn)
        if (stop) return leftBecause[stop]
        // An open window (a Bash command or MCP call running now) must not take this undo as its change.
        touched(spelled(c, f.path))
        restoring = true
        await git($, ['restore', `--source=${c.tree}`, '--worktree', '--', `:(literal)${f.path}`], c.top!, repo.env)
        const lost = await keepBits($, c.top!, f.path, had, name)
        if (lost !== undefined) notes.push(`${ref}: ${lost}`)
        return undefined
      }, why => leftBecause[why])
      if (no !== undefined) { notes.push(`${ref} left as is: ${no}`); continue }
      f.undone = true
      undone.push(k)
      if (f.status === 'D' && await filtered($, c.top, f.path).catch(() => false)) notes.push(`${ref}: ${name} came back through a git filter, so its bytes may differ from the deleted file`)
    } catch (err) {
      // git takes the old file away before it writes the new one, so a restore that failed may have lost it.
      // A deleted file was absent: a restore cut short can have left part of it there.
      const still = !restoring || (f.status === 'D' ? !(await $.fs.stat(`${c.top}/${f.path}`).catch(() => undefined)) : await sameAsLeft($, c.top, f).catch(() => false))
      hurt ||= !still
      notes.push(still ? `${ref} left as is: git said ${gitSaid(err)}`
        : `${ref} failed part way: ${name} no longer reads as it did and git said ${gitSaid(err)}. Its version from before the command: git restore --source=${c.tree} -- ${f.path}`)
    }
  }
  // The list is the next conversation's by now, and its numbers are not this one's.
  if (undone.length > 0) await updateList($, all => (turn.gone ? [...all] : all.map(x => (x.n === c.n && x.at === c.at ? { ...x, files } : x))))
  const did = undone.length > 0
    ? `undid ${undone.map(k => `${c.n}.${k + 1}`).join(', ')}: ${undone.map(k => shown(spelled(c, files[k]!.path))).join(', ')}`
    : hurt ? 'this undo failed part way' : 'nothing changed'
  return [`agent-undo: ${did}.`, ...notes].join('\n')
}
