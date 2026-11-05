// One edit's hunks: taken from the engine's diff and the file's own text, and put back line by line.
import type { Hunk } from '../types'

export type Patch = { oldStart?: number; newStart: number; lines: string[] }[]

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

type Row = { t: string; e: string }

/** The file as lines, each with its own ending ('' for a last line without one). */
export const rowsOf = (text: string): Row[] => {
  const parts = text.split(/(\r\n|\n)/)
  const rows: Row[] = []
  for (let k = 0; k < parts.length; k += 2) rows.push({ t: parts[k] ?? '', e: parts[k + 1] ?? '' })
  const last = rows[rows.length - 1]
  if (last && last.t === '' && last.e === '') rows.pop()
  return rows
}

/** A line as the engine's diff shows it: `structuredPatch` is display text, each leading tab two spaces (convertTabs). */
const shownAs = (line: string) => line.replace(/^\t+/gm, tabs => '  '.repeat(tabs.length))

/**
 * The hunks of one edit with the file's own text. The diff gives the places and the shape; the words come from
 * `was` and `now`, the whole file before and after: a line's text is taken only where the diff shows the same
 * line. A before line that differs, or no `was` at all, leaves nothing proven: undefined, and the edit cannot be
 * undone. An after line that differs keeps the diff's text, and an undo then finds it only where the file really
 * reads so. `now` may be missing or a guess (an Edit's result does not hold the new file).
 */
export const hunksFrom = (patch: Patch, was: unknown, now: string | undefined): Hunk[] | undefined => {
  if (typeof was !== 'string') return undefined
  const [old, next] = [rowsOf(was), rowsOf(now ?? '')]
  const hunks = hunksOf(patch)
  for (const [k, h] of hunks.entries()) {
    const at = { old: (patch[k]!.oldStart ?? 0) - 1, next: h.line - 1 }
    const before = h.before.map((l, j) => { const t = old[at.old + j]?.t; return t !== undefined && shownAs(t) === l ? t : undefined })
    if (before.includes(undefined)) return undefined
    h.before = before as string[]
    // A Write keeps the CR of a CRLF `content` in the diff; `next` holds lines without their ending.
    h.after = h.after.map((l, j) => { const t = next[at.next + j]?.t; return t !== undefined && shownAs(t) === l.replace(/\r$/, '') ? t : l })
  }
  return hunks
}

/**
 * The file's text with one hunk put back as it was, and where, or why not. The hunk's
 * after-lines must still stand in the file, word for word: where the person (or a later edit)
 * changed them, nothing is touched. Found in more than one place, only the place the edit left
 * them counts. Every other line keeps its own line ending.
 */
export const undoAt = (text: string, hunk: Hunk): { text: string; at: number } | { refused: string } => {
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
