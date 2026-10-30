import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Change, Hunk } from '../types'

const MAX_CHANGES = 300
const MAX_LINES = 4000

// Change the tag when a Change's fields change: it declines what an earlier version stored.
const changes = atom({ plugin: 'agent-undo', key: 'changes' } as const, [], { shape: 'changes-1' })

type Patch = { newStart: number; lines: string[] }[]

/** Each hunk of an engine diff as the lines before and after it, context included. */
export const hunksOf = (patch: Patch): Hunk[] =>
  patch.map(p => {
    const before: string[] = []
    const after: string[] = []
    for (const l of p.lines) {
      if (l.startsWith('\\')) continue
      const body = l.slice(1)
      if (l[0] !== '+') before.push(body)
      if (l[0] !== '-') after.push(body)
    }
    return { before, after, line: p.newStart }
  })

/**
 * The file's text with one hunk put back as it was, or why not. The hunk's after-lines must
 * still stand in the file, word for word: where the person (or a later edit) changed them,
 * nothing is touched. Found in more than one place, only the place the edit left them counts.
 */
export const undoHunk = (text: string, hunk: Hunk): { text: string } | { refused: string } => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const { before, after } = hunk
  if (after.length === 0) {
    if (text !== '') return { refused: 'the file is no longer empty, as the edit left it' }
    return { text: before.join(eol) }
  }
  const at: number[] = []
  for (let i = 0; i + after.length <= lines.length; i++) {
    if (after.every((l, j) => lines[i + j] === l)) at.push(i)
  }
  if (at.length === 0) return { refused: 'those lines have changed since the edit' }
  const expected = hunk.line - 1
  const i = at.length === 1 ? at[0] : at.includes(expected) ? expected : undefined
  if (i === undefined) return { refused: `those lines appear ${at.length} times and none where the edit left them` }
  lines.splice(i, after.length, ...before)
  return { text: lines.join(eol) }
}

/** The change number and hunk number of `3` or `3.2`. */
export const parseRef = (arg: string): { n: number; h?: number } | undefined => {
  const m = /^#?(\d+)(?:\.(\d+))?$/.exec(arg.trim())
  if (!m) return undefined
  return { n: Number(m[1]), h: m[2] === undefined ? undefined : Number(m[2]) }
}

const time = (iso: string) => iso.slice(11, 19)

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
  return { minus: removed.length, plus: added.length, first: first.length > 50 ? `${first.slice(0, 49)}…` : first }
}

/** The list, newest change first, each hunk numbered `<change>.<hunk>`. */
export const listing = (list: readonly Change[], shown: (file: string) => string, limit = 20): string => {
  if (list.length === 0) return 'agent-undo: no edits by Claude in this session yet.'
  const out: string[] = []
  for (const c of [...list].reverse().slice(0, limit)) {
    const who = c.agent ? ` (subagent ${c.agent.slice(0, 8)})` : ''
    const note = c.created ? ' (new file)' : c.tooLarge ? ' (too large to undo here)' : ''
    out.push(`#${c.n} ${time(c.at)} ${c.tool} ${shown(c.file)}${who}${note}`)
    c.hunks.forEach((h, k) => {
      const { minus, plus, first } = counted(h)
      out.push(`   ${c.n}.${k + 1} line ${h.line}: -${minus} +${plus}${first ? `  ${first}` : ''}${h.undone ? '  (undone)' : ''}`)
    })
  }
  if (list.length > limit) out.push(`… ${list.length - limit} older`)
  out.push('Undo one: /agent-undo 3.1   all of one edit: /agent-undo 3')
  return out.join('\n')
}

/** Adds one change to the session's list, numbered after the highest so far. */
async function record($: EngineInterface, c: Omit<Change, 'n'>) {
  const lines = c.hunks.reduce((s, h) => s + h.before.length + h.after.length, 0)
  const kept = lines > MAX_LINES ? { ...c, hunks: [], tooLarge: true } : c
  await update($, changes, list => {
    const n = list.reduce((m, x) => Math.max(m, x.n), 0) + 1
    return [...list, { ...kept, n }].slice(-MAX_CHANGES)
  })
  const all = await read($, changes)
  const last = all[all.length - 1]
  if (last) $.ui.status(`agent-undo: #${last.n} ${last.file.split(/[\\/]/).pop()} (${last.hunks.length} hunk${last.hunks.length === 1 ? '' : 's'}) · /agent-undo`)
}

/** What `/agent-undo <args>` and the undo tool answer: the list, or the outcome of one undo. */
async function run($: EngineInterface, args: string): Promise<string> {
  const root = (await $.session.root()).replace(/[\\/]+$/, '')
  const shown = (f: string) => (f.startsWith(`${root}/`) ? f.slice(root.length + 1) : f)
  const arg = args.trim()
  const list = await read($, changes)
  if (arg === '' || arg === 'list') return listing(list, shown)
  const ref = parseRef(arg)
  const c = ref && list.find(x => x.n === ref.n)
  if (!ref || !c) return `agent-undo: no edit "${arg}". Type /agent-undo to see the list.`
  if (c.created) return `agent-undo: #${c.n} created ${shown(c.file)}; nothing was there before. Delete it yourself if you want it gone.`
  if (c.tooLarge) return `agent-undo: #${c.n} was too large for a hunk-by-hunk record; nothing changed.`
  const picked = ref.h === undefined ? c.hunks.map((_, k) => k) : [ref.h - 1]
  if (picked.some(k => !c.hunks[k])) return `agent-undo: #${c.n} has ${c.hunks.length} hunk(s); no ${arg}.`
  if (!(await $.fs.exists(c.file))) return `agent-undo: ${shown(c.file)} is gone; nothing changed.`
  let text = await $.fs.read(c.file)
  const undone: number[] = []
  const notes: string[] = []
  // Last hunk first, so each recorded line number still points at its own hunk.
  for (const k of [...picked].sort((a, b) => b - a)) {
    const h = c.hunks[k]!
    if (h.undone) { notes.push(`${c.n}.${k + 1} was already undone`); continue }
    const got = undoHunk(text, h)
    if ('refused' in got) { notes.push(`${c.n}.${k + 1} left as is: ${got.refused}`); continue }
    text = got.text
    undone.push(k)
  }
  if (undone.length > 0) {
    await $.fs.write(c.file, text)
    await update($, changes, all => all.map(x => x.n !== c.n ? x : {
      ...x, hunks: x.hunks.map((h, k) => (undone.includes(k) ? { ...h, undone: true } : h)),
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
    const done = await next(e)
    try {
      if (done.deny !== undefined || done.isError || !done.result) return done
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
    const done = await next(e)
    try {
      if (done.deny !== undefined || done.isError || !done.result) return done
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

  on('command.run', { command: 'agent-undo' }, async ($, e) => ({ text: await run($, e.args) }))

  on('tool.call', { tool: 'mcp__agent-undo__undo' }, async ($, e) => {
    const ref = (e as unknown as { ref?: unknown }).ref
    return { result: await run($, typeof ref === 'string' ? ref : '') } as never
  })
}
