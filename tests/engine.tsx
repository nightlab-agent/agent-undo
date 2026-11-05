// What Claude Code's Edit and Write tools do to a file's text, for the test worlds. Read from the
// 2.1.312 binary on 2026-11-04 and written again here (see tests/ENGINE-NOTES.md for what was read and what
// this may still hide). The rule: `structuredPatch` is what the terminal shows, not what the file holds.

/** Each leading tab turned into two spaces, as the engine's convertTabs does to every diff line it shows. */
export const convertTabs = (line: string) => line.replace(/^\t+/gm, tabs => '  '.repeat(tabs.length))

/** A file as the engine reads it: every CRLF is LF in the text, the BOM stays, and the line ending of the
 * first 4096 characters decides how an Edit writes the whole file back (more CRLF than LF: all CRLF). */
export const readDisk = (disk: string) => {
  const head = disk.slice(0, 4096)
  const crlf = head.split('\r\n').length - 1
  return { text: disk.replaceAll('\r\n', '\n'), crlf: crlf > head.split('\n').length - 1 - crlf }
}
const writeDisk = (text: string, crlf: boolean) => (crlf ? text.replaceAll('\r\n', '\n').split('\n').join('\r\n') : text)

// Lines keep their "\n", so a last line without one differs from the same line with one, as in the engine.
const linesOf = (t: string) => t.match(/[^\n]*\n|[^\n]+$/g) ?? []

type Op = { kind: ' ' | '-' | '+'; count: number }

/** The runs that turn `a` into `b`: common head and tail first, a longest common subsequence between them. */
const opsOf = (a: string[], b: string[]): Op[] => {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const [x, y] = [a.slice(head, a.length - tail), b.slice(head, b.length - tail)]
  const width = y.length + 1
  const best = new Int32Array((x.length + 1) * width)
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      const k = i * width + j
      best[k] = x[i] === y[j] ? best[k + width + 1]! + 1 : Math.max(best[k + width]!, best[k + 1]!)
    }
  }
  const ops: Op[] = []
  const add = (kind: Op['kind'], count: number) => {
    const last = ops[ops.length - 1]
    if (count === 0) return
    if (last?.kind === kind) last.count += count
    else ops.push({ kind, count })
  }
  add(' ', head)
  let [i, j] = [0, 0]
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { add(' ', 1); i++; j++ }
    else if (i < x.length && (j === y.length || best[(i + 1) * width + j]! >= best[i * width + j + 1]!)) { add('-', 1); i++ }
    else { add('+', 1); j++ }
  }
  add(' ', tail)
  return ops
}

/** The engine's `structuredPatch` of `was` to `now`: three lines of context, runs of up to six unchanged lines
 * inside one hunk, "\ No newline at end of file" after a line without one, and every line through convertTabs. */
export const structuredPatch = (was: string, now: string) => {
  const CONTEXT = 3
  const [a, b] = [linesOf(was), linesOf(now)]
  const ops = opsOf(a, b)
  const hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[] = []
  let open: { lines: string[]; o: number; n: number } | undefined
  let [o, n] = [0, 0]
  ops.forEach((op, k) => {
    if (op.kind === ' ') {
      if (open) {
        const inside = op.count <= CONTEXT * 2 && k < ops.length - 1
        const take = inside ? op.count : Math.min(op.count, CONTEXT)
        for (let i = 0; i < take; i++) open.lines.push(` ${b[n + i]}`)
        if (!inside) {
          hunks.push({ oldStart: open.o + 1, oldLines: o + take - open.o, newStart: open.n + 1, newLines: n + take - open.n, lines: open.lines })
          open = undefined
        }
      }
      o += op.count
      n += op.count
      return
    }
    if (!open) {
      const take = Math.min(CONTEXT, k > 0 ? ops[k - 1]!.count : 0)
      open = { lines: [], o: o - take, n: n - take }
      for (let i = take; i > 0; i--) open.lines.push(` ${b[n - i]}`)
    }
    const from = op.kind === '+' ? b.slice(n, n + op.count) : a.slice(o, o + op.count)
    for (const l of from) open.lines.push(`${op.kind}${l}`)
    if (op.kind === '+') n += op.count
    else o += op.count
  })
  if (open) hunks.push({ oldStart: open.o + 1, oldLines: o - open.o, newStart: open.n + 1, newLines: n - open.n, lines: open.lines })
  for (const h of hunks) {
    h.lines = h.lines.flatMap(l => (l.endsWith('\n') ? [l.slice(0, -1)] : [l, '\\ No newline at end of file']))
      .map(l => l.slice(0, 1) + convertTabs(l.slice(1)))
  }
  return hunks
}

/** One Edit on a file's bytes as text: the new bytes and the tool's result. The search runs on the LF text. */
export const editResult = (disk: string, x: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }) => {
  const { text: was, crlf } = readDisk(disk)
  const put = (t: string, o: string) => (x.replace_all ? t.replaceAll(o, () => x.new_string) : t.replace(o, () => x.new_string))
  const dropsLine = x.new_string === '' && !x.old_string.endsWith('\n') && was.includes(`${x.old_string}\n`)
  const now = x.old_string === '' ? x.new_string : put(was, dropsLine ? `${x.old_string}\n` : x.old_string)
  return { disk: writeDisk(now, crlf), result: { filePath: x.file_path, oldString: x.old_string, newString: x.new_string, originalFile: was,
    structuredPatch: structuredPatch(was, now), userModified: false, replaceAll: x.replace_all ?? false } }
}

/** One Write: `content` goes to disk as given (no line ending conversion), over `disk` or as a new file. */
export const writeResult = (disk: string | undefined, x: { file_path: string; content: string }) => {
  if (disk === undefined) return { type: 'create', filePath: x.file_path, content: x.content, structuredPatch: [], originalFile: null, userModified: false }
  const was = readDisk(disk).text
  return { type: 'update', filePath: x.file_path, content: x.content, structuredPatch: structuredPatch(was, x.content), originalFile: was, userModified: false }
}
