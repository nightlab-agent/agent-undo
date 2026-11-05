// Small things both hooks share that hold no list: path keys, the clock line, the queues, the shell windows.

export const time = (iso: string) => {
  const d = new Date(iso)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':')
}

export const slashed = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** One file as one key however it is spelled: forward slashes, no doubled or final slash, drive letter upper case. */
export const fileKey = (p: string) => slashed(p).replace(/\/{2,}/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)

// No Edit, Write or undo of a file runs beside another of the same file: an undo reads a file and writes it back, and
// an edit landing in between would be lost. Each file has its own queue, so an Edit waiting on its question holds
// back no other file's. `keys` undefined waits for every queue and holds them all: an undo. `left` lets go of the queue
// early, for a job that will not run: the jobs behind it then wait only for what they would have waited for without it.
const tails = new Map<string, Promise<unknown>>()
// When each file's waiting job began. A plain wait spends a hook's own time, so past its budget the engine runs that
// Edit itself, beside whatever holds the queue: a slow undo must not write over it.
const waiting = new Set<{ since: number }>()
const OWN_TIME_MS = 8500
export const overdue = () => [...waiting].some(w => Date.now() - w.since >= OWN_TIME_MS)
let whole: Promise<unknown> = Promise.resolve()
export const serial = <T,>(keys: readonly string[] | undefined, f: () => Promise<T>, left?: Promise<void>): Promise<T> => {
  const wait = { since: Date.now() }
  if (keys) waiting.add(wait)
  const p = Promise.allSettled(keys ? [whole, ...keys.map(k => tails.get(k))] : [whole, ...tails.values()]).then(() => {
    waiting.delete(wait)
    return f()
  })
  const settled = p.catch(() => undefined)
  // Leaving hands the queue to what stood ahead: a running undo is held only by this link.
  const ahead = whole
  const done = left ? Promise.race([settled, left.then(() => ahead)]) : settled
  if (!keys) whole = done
  for (const k of keys ?? []) {
    tails.set(k, done)
    void done.then(() => { if (tails.get(k) === done) tails.delete(k) })
  }
  return p
}

/** Why an undo that has not written yet must not write: its budget, an interrupt, or the end of its conversation. */
export type Why = 'budget' | 'interrupted' | 'ended'
/** An undo's time to write. `why` is set the moment that time is gone; `over` hands it to whatever waits. */
export type Turn = { why?: Why; over: Promise<Why>; say: (why: Why) => void; gone?: boolean }
export const newTurn = (): Turn => {
  let answer: (why: Why) => void = () => {}
  const over = new Promise<Why>(r => { answer = r })
  const turn: Turn = { over, say: why => { turn.why ??= why; answer(turn.why) } }
  return turn
}
/** Why this undo must not write now: what its turn says, or an Edit behind it about to go on without it. */
export const stopped = (turn: Turn) => {
  if (overdue()) turn.say('budget')
  return turn.why
}
/** `job` in its queue, unless the turn goes first: then `late` answers at once and the job, still waiting, never runs and
 * leaves the queue. One that began is seen through, and looks at the turn itself before its last step. */
export const inTurn = async <T,>(turn: Turn, queue: (job: () => Promise<T>, left: Promise<void>) => Promise<T>, job: () => Promise<T>, late: (why: Why) => T): Promise<T> => {
  let began = false
  let leave = () => {}
  const left = new Promise<void>(r => { leave = r })
  const work = queue(async () => {
    if (turn.why) return late(turn.why)
    began = true
    return job()
  }, left)
  const first = await Promise.race([work.then(() => undefined), turn.over])
  if (first === undefined || began) return work
  leave()
  return late(first)
}
/** Run when a conversation ends. */
export const ended = new Set<() => void>()

/**
 * The files an Edit or Write touched while each shell command ran: theirs, not the command's.
 * Marked when the Edit or Write starts, and an open window takes the ones still running.
 */
export const windows = new Set<Set<string>>()
export const inFlight = new Map<string, number>()
export const touched = (file: unknown) => {
  if (typeof file !== 'string' || file === '') return
  for (const w of windows) w.add(fileKey(file))
}
export const editing = async <T,>(file: unknown, f: () => Promise<T>): Promise<T> => {
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
