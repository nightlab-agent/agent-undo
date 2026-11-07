import { stopped } from './shared'
import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Change, Hunk } from '../types'
import { acrossUndo, followed, hunksFrom, onceIn, undoAt } from './hunks'
import type { Move, Patch } from './hunks'
import { editing, ended, fileKey, forgetRestore, budgetEnds, heldByUndo, inTurn, makingCopy, newTurn, record, restoreList, serial, showNewest, undoAhead, slashed, snapped, time, updateList } from './common'
import type { Turn, Why } from './shared'
import { UNDO_COPY, ownTool, registerShell, sessionEnds, shellNote, spelled } from './shell'
import { undoShell } from './shell-undo'

// The session's list (the same plugin, key and shape in each file that reads or writes it: the
// engine's scan lists a module's state per file). Change the tag in both (and SHAPE in common.tsx) when a Change's
// fields change: it declines what an earlier version stored.
const changes = atom({ plugin: 'agent-undo', key: 'changes' } as const, [], { shape: 'changes-3' })

export { fileKey } from './common'
export { filesOf, isMcp, mcpLabel } from './shell'
export { hunksOf, undoHunk } from './hunks'

/** The fields of an Edit or Write result read here, typed whether or not the engine's tool results are declared. */
type FileOut = { filePath: string; structuredPatch?: Patch; staged?: unknown; type?: string; originalFile?: string | null
  content?: string; oldString?: string; newString?: string; replaceAll?: boolean }

/** The new file an Edit left, worked out as the engine works it out: the result does not hold it. The engine may have
 * changed the new string first (curly quotes), and hunksFrom takes no line this gets wrong. */
const editedText = (o: FileOut): string | undefined => {
  const { originalFile: was, oldString: a, newString: b, replaceAll: all } = o
  if (typeof was !== 'string' || typeof a !== 'string' || typeof b !== 'string') return undefined
  if (a === '') return b
  const from = b === '' && !a.endsWith('\n') && was.includes(`${a}\n`) ? `${a}\n` : a
  return all ? was.replaceAll(from, () => b) : was.replace(from, () => b)
}

/**
 * Whether each U+FFFD in `text` is one the file really holds: a byte that is not UTF-8 reads as U+FFFD too, and
 * writing the text back would replace it. Bytes that cannot be read prove nothing, and the answer is no.
 */
const holdsItsBytes = async ($: EngineInterface, file: string, text: string) => {
  try {
    // `$.fs.read` documents this form for its bytes; TypeScript's own libraries leave it out.
    const decode = Uint8Array as unknown as { fromBase64(base64: string): Uint8Array }
    const b = decode.fromBase64((await $.fs.read(file, { as: 'bytes' })).base64)
    let real = 0
    for (let i = 0; i + 2 < b.length; i++) if (b[i] === 0xef && b[i + 1] === 0xbf && b[i + 2] === 0xbd) real++
    return real === text.split('\uFFFD').length - 1
  } catch {
    return false
  }
}

/** An Edit or Write run on an attached machine (`_host`, tests/ENGINE-NOTES.md): the file an undo here would touch is another file. */
const elsewhere = (e: unknown) => {
  const host = (e as { _host?: unknown })._host
  return typeof host === 'string' && !['', 'container', 'this-machine'].includes(host.trim())
}

/** Where a file really is, when that is not how Claude spelled it: a later undo must land on the same file. */
async function reached($: EngineInterface, file: string) {
  const real = (await $.fs.stat(file, { resolve: true }).catch(() => undefined))?.realPath
  return real !== undefined && fileKey(real) !== fileKey(file) ? { real } : {}
}

const stoppedBy: Record<Why, string> = { budget: 'this undo ran out of time', interrupted: 'this undo was interrupted', ended: 'the conversation this undo belonged to has ended' }

const firstLine = (err: unknown) => String((err as Error)?.message ?? err).split('\n')[0] ?? ''

/**
 * The file as `text`, in one step: a new temporary file beside it with its permissions, then a rename, so an undo killed
 * halfway leaves the file whole (`$.fs.write` empties it first). `real` is where the checks found it. The answer is why
 * the file stayed as it was, or undefined once it is done. There is no second way: `$.process.run` rejects alike for a
 * machine without these tools, a command that could not start and one out of time, and a plain write killed halfway empties the file.
 */
async function putBack($: EngineInterface, file: string, real: string, was: string, text: string, turn: Turn) {
  const folder = real.slice(0, real.lastIndexOf('/') + 1)
  const run = (...argv: string[]) => $.process.run(argv, { cwd: folder || '.' })
    .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: firstLine(err) }))
  const said = (r: { stderr: string }) => r.stderr.trim().split('\n')[0]
  const moved = async () => ((await $.fs.stat(file, { resolve: true }).catch(() => undefined))?.realPath ?? file) !== real ||
    (await $.fs.read(real).catch(() => undefined)) !== was
  const changed = 'changed during this undo'
  // mktemp makes the name its own, however long the file's is, and never takes a name already there.
  const made = await makingCopy(() => run('mktemp', `${folder}${UNDO_COPY}XXXXXXXX`))
  const tmp = made.stdout.trim()
  if (made.exitCode !== 0 || !tmp) return `could not get a temporary copy beside it (${said(made)})`
  // editing(), not touched(): a window that opens while the copy exists must not take it as a new file.
  return editing(tmp, async () => { try {
    const copy = await run('cp', '-p', real, tmp)
    if (copy.exitCode !== 0) return `could not be copied (${said(copy)})`
    // cp -p makes the copy read-only with a read-only file, and the write fails there, as it should.
    try {
      // user file: the temporary copy beside it, renamed over it or removed.
      await $.fs.write(tmp, text)
    } catch (err) {
      return `could not be written (${firstLine(err)})`
    }
    if (await moved()) return changed
    const why = stopped(turn)
    if (why) return `stayed as it was: ${stoppedBy[why]}`
    const mv = await run('mv', '-f', tmp, real)
    return mv.exitCode !== 0 ? `could not be put in place (${said(mv)})` : undefined
  } finally {
    await run('rm', '-f', tmp)
  } })
}

/** The change number and hunk number of `3` or `3.2`. */
export const parseRef = (arg: string): { n: number; h?: number } | undefined => {
  const m = /^#?(\d+)(?:\.(\d+))?$/.exec(arg.trim())
  if (!m) return undefined
  return { n: Number(m[1]), h: m[2] === undefined ? undefined : Number(m[2]) }
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
  const note = shellNote()
  if (list.length === 0) return `agent-undo: no edits by Claude in this session yet.${note ? `\n${note}` : ''}`
  const out: string[] = []
  for (const c of [...list].reverse().slice(0, limit)) {
    const who = c.agent ? ` (subagent ${c.agent.slice(0, 8)})` : ''
    const note = c.created ? ' (new file)' : c.tooLarge ? ' (too large to undo here)' : ''
    if (snapped(c)) {
      const fs = c.files ?? []
      out.push(`#${c.n} ${time(c.at)} ${c.tool} ${c.file} (${c.tooLarge ? 'over 200' : fs.length} file${fs.length === 1 ? '' : 's'})${who}${note}`)
      fs.forEach((f, k) => {
        const what = f.status === 'A' ? 'new file' : f.status === 'D' ? 'deleted' : 'changed'
        const why = f.fixed ? ` (${f.fixed}: not undone here)` : ''
        out.push(`   ${c.n}.${k + 1} ${what} ${shown(spelled(c, f.path))}${why}${f.undone ? '  (undone)' : ''}`)
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
  if (note) out.push(note)
  const newest = list[list.length - 1]!.n
  out.push(`Undo one: /agent-undo ${newest}.1   all of #${newest}: /agent-undo ${newest}`)
  return out.join('\n')
}



/** What `/agent-undo <args>` and the undo tool answer: the list, or the outcome of one undo. */
async function run($: EngineInterface, args: string, turn = newTurn()): Promise<string> {
  const root = slashed(await $.session.root())
  const shown = (f: string) => (slashed(f).startsWith(`${root}/`) ? slashed(f).slice(root.length + 1) : f)
  const arg = args.trim()
  await restoreList($)
  const list = await read($, changes)
  if (arg === '' || arg === 'list') return listing(list, shown)
  const ref = parseRef(arg)
  const c = ref && list.find(x => x.n === ref.n)
  if (!ref || !c) return `agent-undo: no edit "${arg}". Type /agent-undo to see the list.`
  if (snapped(c)) return undoShell($, c, ref.h, arg, shown, turn)
  if (c.created) return `agent-undo: #${c.n} created ${shown(c.file)}; nothing was there before. Delete it yourself if you want it gone.`
  if (c.tooLarge) return `agent-undo: #${c.n} was too large for a hunk-by-hunk record; nothing changed.`
  const picked = ref.h === undefined ? c.hunks.map((_, k) => k) : [ref.h - 1]
  if (picked.some(k => !c.hunks[k])) return `agent-undo: #${c.n} has ${c.hunks.length} hunk(s); no ${arg}.`
  if (!(await $.fs.exists(c.file))) return `agent-undo: ${shown(c.file)} is gone; nothing changed.`
  // The undo must land where the edit landed: a link put there since leads to a file the edit never touched.
  const lands = await $.fs.stat(c.file, { resolve: true }).catch(() => undefined)
  if (lands?.realPath ? fileKey(lands.realPath) !== fileKey(c.real ?? c.file) : lands?.isLink) {
    return `agent-undo: ${shown(c.file)} now leads to another file; nothing changed.`
  }
  let text: string
  try {
    text = await $.fs.read(c.file)
  } catch (err) {
    return `agent-undo: ${shown(c.file)} could not be read (${firstLine(err)}); nothing changed.`
  }
  const was = text
  if (text.includes('\uFFFD') && !(await holdsItsBytes($, c.file, text))) {
    return `agent-undo: ${shown(c.file)} has bytes that are not UTF-8 and writing it would replace them; nothing changed.`
  }
  const undone: number[] = []
  const notes: string[] = []
  const moves: Move[] = []
  // Only a line this undo put back can make a look-alike of a hunk still to come.
  const back = new Set<string>()
  const clear = (after: string[]) => !after.some(l => back.has(l))
  // Last hunk first, so each recorded line number still points at its own hunk.
  for (const k of [...picked].sort((a, b) => b - a)) {
    const h = acrossUndo(c.hunks[k]!, moves, clear)
    if (h.undone) { notes.push(`${c.n}.${k + 1} was already undone`); continue }
    const got = undoAt(text, h)
    if ('refused' in got) { notes.push(`${c.n}.${k + 1} left as is: ${got.refused}`); continue }
    text = got.text
    undone.push(k)
    // Every hunk below moved by the lines this one put back, and every hunk's count of the file's lines changed.
    const { head, minus, plus } = counted(h)
    moves.push({ at: got.at + head, cut: plus, put: minus })
    for (const l of h.before) back.add(l)
  }
  if (undone.length > 0) {
    // An open window (a Bash command or MCP call running now) must not take this undo as its change.
    // editing() also covers a window that opens while the write is in flight.
    // user file: an undo puts the user's own file back as it was.
    const stayed = await editing(c.file, () => putBack($, c.file, lands?.realPath ?? c.file, was, text, turn))
    if (stayed !== undefined) return `agent-undo: ${shown(c.file)} ${stayed}; nothing changed.`
    const once = onceIn(text)
    const gone = new Set(undone)
    const hunks = c.hunks.map((o, k) => { const h = acrossUndo(o, moves, once); return gone.has(k) ? { ...h, undone: true } : h })
    // The list is the next conversation's by now, and its numbers are not this one's.
    await updateList($, all => turn.gone ? [...all] : all.map(x => x.n === c.n && x.at === c.at ? { ...x, hunks }
      : fileKey(x.file) === fileKey(c.file) ? { ...x, hunks: x.hunks.map(h => acrossUndo(h, moves, once)) } : x))
  }
  const did = undone.length > 0
    ? `undid ${[...undone].sort((a, b) => a - b).map(k => `${c.n}.${k + 1}`).join(', ')} in ${shown(c.file)}`
    : `nothing changed in ${shown(c.file)}`
  return [`agent-undo: ${did}.`, ...notes].join('\n')
}

/** An undo's outcome line, always: a hook that throws is skipped, and the person would get the engine's words for plugin authors. */
const outcome = ($: EngineInterface, args: string, turn: Turn) => run($, args, turn).catch((err: unknown) =>
  `agent-undo: this undo stopped: ${firstLine(err)}. Read the file before you try again: it may already be changed.`)

/** An Edit or Write with its entry in the list, in its file's queue: an undo behind it finds the entry. */
const queued = <T,>($: EngineInterface, e: unknown, next: { budget?: { remainingMs?: number } }, f: () => Promise<T>) => {
  const file = (e as { file_path?: unknown }).file_path
  const key = [typeof file === 'string' ? fileKey(file) : '']
  return editing(file, () => undoAhead() ? heldByUndo((ms, o) => $.clock.sleep(ms, o), key, () => next.budget?.remainingMs, f) : serial(key, f))
}


/** An undo waits for every Edit and Write and holds them all; a listing waits for nothing. */
// The dialog rejects when dismissed and in a -p run, where no one can answer; free text under Other is not a yes.
const UNDO_IT = 'Undo it'
const confirmed = async ($: EngineInterface, ref: string) => {
  try {
    return await $.ui.ask(`Let Claude undo ${ref.trim().slice(0, 40)}, putting those lines back?`, { options: [UNDO_IT, 'Keep it'], header: 'agent-undo' }) === UNDO_IT
  } catch {
    return false
  }
}

// The engine's ask carries no field for why. Its reason is the only mark: plan mode asks with its own words, and a yes
// must not override that. An unknown reason is treated as a no; tests/native-ask.sh checks both wordings at each release.
const askable = (verdict: { reason?: string; plugin?: string }) =>
  !/plan mode/i.test(verdict.reason ?? '') && (verdict.plugin !== undefined || /requested permissions/i.test(verdict.reason ?? ''))

// A conversation ended under an open question: its "1" is not the "1" of what came after, so the yes is spent.
const sessionId = ($: EngineInterface) => $.session.id().catch(() => undefined)

const notUndone: Record<Why, string> = {
  budget: 'agent-undo: an edit ahead of this undo is still waiting (at a question, perhaps); nothing changed. Try again in a moment.',
  interrupted: 'agent-undo: this undo was interrupted; nothing changed.',
  ended: 'agent-undo: the conversation this undo belonged to has ended; nothing changed.',
}

const undoing = async ($: EngineInterface, args: string, left: () => number | undefined, signal?: AbortSignal) => {
  if (['', 'list'].includes(args.trim())) return run($, args)
  // A hook has its budget and then the engine goes on without it, an interrupt ends its call, and a /resume makes its
  // "1" another conversation's. So an undo still waiting at any of those gives up, and cannot write after its answer.
  const turn = newTurn()
  const interrupted = () => turn.say('interrupted')
  const conversationEnded = () => { turn.gone = true; turn.say('ended') }
  const stop = new AbortController()
  if (signal?.aborted) interrupted()
  signal?.addEventListener('abort', interrupted, { once: true })
  ended.add(conversationEnded)
  void budgetEnds((ms, o) => $.clock.sleep(ms, o), left, turn, stop.signal).catch(() => {})
  const id = sessionId($)
  try {
    return await inTurn(turn, (job, left) => serial(undefined, job, left), async () => (await id === await sessionId($) ? outcome($, args, turn) : notUndone.ended), why => notUndone[why])
  } finally {
    stop.abort()
    ended.delete(conversationEnded)
    signal?.removeEventListener('abort', interrupted)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // No shell reset: this fires again in a running process (a reload), where a command may still be in the
    // background. A new conversation goes through session.end (hooks/shell.tsx), which does reset.
    forgetRestore()
    await $.command.register({
      name: 'agent-undo',
      description: "List Claude's edits in this session, or undo one: /agent-undo 3.1 (one hunk) or /agent-undo 3",
    })
    const reg = await $.tool.register({
      name: 'undo',
      description: "Lists the edits you (and your subagents) made to files in this session, numbered, each hunk as <edit>.<hunk>; " +
        'for a Bash command, each file it changed, deleted or created as <command>.<file>; ' +
        'or undoes one when the person asks: ref "" lists, "3" undoes all of edit 3, "3.2" one hunk. An undo puts back only ' +
        "lines that still read as your edit left them; the person's own later changes stay. List first, then undo the ref " +
        'that matches what the person asked for, and tell them the outcome line word for word.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string', description: '"" to list; "3" or "3.2" to undo' } } },
      isDeferred: false,
    })
    ownTool((reg as { tool?: unknown } | undefined)?.tool)
    // After a resume the status line names the newest stored change; the start never waits on the store.
    void restoreList($).then(() => showNewest($)).catch(() => {})
    return next(e)
  })

  on('tool.call', { tool: 'Edit' }, ($, e, next) => queued($, e, next, async () => {
    const done = await next(e)
    try {
      const out = done.deny === undefined && !done.isError ? (done.result as FileOut | undefined) : undefined
      if (!out || out.staged || elsewhere(e)) return done
      const now = editedText(out)
      const patch = out.structuredPatch ?? []
      const hunks = hunksFrom(patch, out.originalFile, now) ?? []
      await record($, {
        at: new Date().toISOString(), tool: 'Edit', file: out.filePath, agent: e.agentId, ...(await reached($, out.filePath)),
        hunks, ...(hunks.length === 0 ? { tooLarge: true } : {}),
      }, list => followed(list, out.filePath, patch, now))
    } catch {
      // A failure of this mod never changes the edit.
    }
    return done
  }))

  on('tool.call', { tool: 'Write' }, ($, e, next) => queued($, e, next, async () => {
    const done = await next(e)
    try {
      const out = done.deny === undefined && !done.isError ? (done.result as FileOut | undefined) : undefined
      if (!out || out.staged || elsewhere(e)) return done
      const created = out.type === 'create'
      const patch = out.structuredPatch ?? []
      const hunks = created ? [] : hunksFrom(patch, out.originalFile, out.content)
      await record($, {
        at: new Date().toISOString(), tool: 'Write', file: out.filePath, agent: e.agentId, ...(await reached($, out.filePath)), hunks: hunks ?? [],
        ...(created ? { created: true } : hunks ? {} : { tooLarge: true }),
      // A Write that changed nothing has an empty diff and moved nothing.
      }, out.content === out.originalFile ? undefined : list => followed(list, out.filePath, patch, out.content))
    } catch {
      // A failure of this mod never changes the write.
    }
    return done
  }))

  registerShell(on)

  on('command.run', { command: 'agent-undo' }, async ($, e, next) => ({ text: await undoing($, e.args, () => next.budget?.remainingMs, next.signal) }))

  // A tool served here never reaches the engine's permission step, so that step is asked first, and where the engine
  // would put a question to the person it is put here. A person's own /agent-undo needs no such check.
  on('tool.call', { tool: 'mcp__agent-undo__undo' }, async ($, e, next) => {
    const raw = (e as unknown as { ref?: unknown }).ref
    const ref = typeof raw === 'string' ? raw : ''
    if (!['', 'list'].includes(ref.trim())) {
      // Counted before the check: a conversation that ends during it or under the question spends the yes.
      const endsBefore = sessionEnds()
      const idBefore = await sessionId($)
      // A check that fails is no allow, and a hook that throws would leave the person no line.
      const verdict = await $.tool.check({ tool: e.tool as string, input: { ref } }).catch((): { decision: string; reason?: string; plugin?: string } => ({ decision: 'failed' }))
      const yes = verdict.decision === 'allow' || (verdict.decision === 'ask' && askable(verdict) && await confirmed($, ref))
      if (!yes || sessionEnds() !== endsBefore || await sessionId($) !== idBefore) {
        return { result: `agent-undo: Claude Code did not allow this undo; nothing changed. You can type /agent-undo ${ref.trim().slice(0, 40)} yourself.` } as never
      }
    }
    return { result: await undoing($, ref, () => next.budget?.remainingMs, next.signal) } as never
  })
}
