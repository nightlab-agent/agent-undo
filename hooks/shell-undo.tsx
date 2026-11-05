import type { EngineInterface } from 'claude-code'

import type { Change, ShellFile } from '../types'
import { touched, updateList } from './common'
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

/** The executable bit as the file has it now, where git tracks it; undefined where this cannot say. */
async function executable($: EngineInterface, top: string, path: string) {
  try {
    const off = await $.process.run(['git', 'config', '--type=bool', 'core.filemode'], { cwd: top })
    if (off.stdout.trim() === 'false') return undefined
    return (await $.process.run(['test', '-x', path], { cwd: top })).exitCode === 0
  } catch {
    return undefined
  }
}

/** Whether the file holds an executable bit git is told to ignore: `git restore` takes that bit away all the same. */
async function looseExecutable($: EngineInterface, top: string, path: string) {
  try {
    const off = await $.process.run(['git', 'config', '--type=bool', 'core.filemode'], { cwd: top })
    return off.stdout.trim() === 'false' && (await $.process.run(['test', '-x', path], { cwd: top })).exitCode === 0
  } catch {
    return false
  }
}

/** Why the file at `f` cannot be put back as it stands, or nothing. Runs right before the restore, after any wait for the index. */
async function refusal($: EngineInterface, c: Change, f: ShellFile, name: string, shown: (f: string) => string) {
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
  const x = await executable($, top, f.path)
  if (x !== undefined && x !== (f.exec === true)) return `the permissions of ${name} have changed since the ${c.tool === 'MCP' ? 'call' : 'command'}`
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
    let restoring = false
    try {
      // On the private index: the person's own git may hold the real one's lock.
      const repo = await repoOf($)
      if (!repo) throw new Error('the repo is no longer there')
      // The checks stand behind the wait for the index: a save made during that wait is seen.
      const no = await onIndex(async () => {
        const why = await refusal($, c, f, name, shown)
        if (why !== undefined) return why
        // An open window (a Bash command or MCP call running now) must not take this undo as its change.
        touched(spelled(c, f.path))
        const loose = await looseExecutable($, c.top!, f.path)
        restoring = true
        await git($, ['restore', `--source=${c.tree}`, '--worktree', '--', `:(literal)${f.path}`], c.top!, repo.env)
        if (loose && (await $.process.run(['chmod', '+x', `./${f.path}`], { cwd: c.top! })).exitCode !== 0) notes.push(`${ref}: ${name} lost its executable bit`)
        return undefined
      })
      if (no !== undefined) { notes.push(`${ref} left as is: ${no}`); continue }
      f.undone = true
      undone.push(k)
      if (f.status === 'D' && await filtered($, c.top, f.path).catch(() => false)) notes.push(`${ref}: ${name} came back through a git filter, so its bytes may differ from the deleted file`)
    } catch (err) {
      // git takes the old file away before it writes the new one, so a restore that failed may have lost it.
      const still = !restoring || f.status === 'D' || await sameAsLeft($, c.top, f).catch(() => false)
      notes.push(still ? `${ref} left as is: git said ${gitSaid(err)}`
        : `${ref} failed part way: ${name} no longer reads as it did and git said ${gitSaid(err)}. Its version from before the command: git restore --source=${c.tree} -- ${f.path}`)
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
