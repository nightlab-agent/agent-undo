type Sleep = (ms: number, options: { signal: AbortSignal }) => Promise<unknown>

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
// Undos not finished. A plain wait spends a hook's own time, so past its budget the engine runs that Edit itself, beside
// whatever holds the queue, and no look before a write can see that coming while the write runs. So an Edit that stands
// behind an undo gives up first: see `heldByUndo` in hooks/register.tsx.
let undos = 0
export const undoAhead = () => undos > 0
let whole: Promise<unknown> = Promise.resolve()
export const serial = <T,>(keys: readonly string[] | undefined, f: () => Promise<T>, left?: Promise<void>): Promise<T> => {
  const p = Promise.allSettled(keys ? [whole, ...keys.map(k => tails.get(k))] : [whole, ...tails.values()]).then(() => f())
  const settled = p.catch(() => undefined)
  // Leaving hands the queue to what stood ahead: a running undo is held only by this link.
  const ahead = whole
  const done = left ? Promise.race([settled, left.then(() => ahead)]) : settled
  if (!keys) {
    whole = done
    undos++
    void done.then(() => { undos-- })
  }
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
/** Why this undo must not write now. */
export const stopped = (turn: Turn) => turn.why
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

/**
 * Waits out the hook's own time: the engine's budget stands still during a `$` call, so a wall clock alone would stop
 * an undo on a slow drive. With no budget to read it waits once. The floor keeps a budget paused just above the
 * margin from spinning the clock, and applies only once a look found it had not moved, so a running budget is met on
 * time; the ceiling keeps an unmetered Infinity out of a sleep the engine refuses.
 */
export const budgetEnds = async (sleep: Sleep, left: () => number | undefined, turn: Turn, signal: AbortSignal) => {
  let ms = (left() ?? 10000) - 1500, floor = 0
  while (ms > 0) {
    await sleep(Math.min(Math.max(ms, floor), 60000), { signal })
    const next = (left() ?? 0) - 1500
    floor = next < ms ? 0 : 250
    ms = next
  }
  turn.say('budget')
}

/**
 * An Edit behind an undo. Past its budget the engine would run it beside the undo, and the undo's write, already under
 * way, would land over it. So it stops first and says so: the agent can try again, and nothing is lost. A wait that was
 * refused has not waited, so it stops then too.
 */
export const heldByUndo = async <T,>(sleep: Sleep, key: string[], budget: { remainingMs?: number } | undefined, f: () => Promise<T>) => {
  const turn = newTurn()
  const stop = new AbortController()
  void budgetEnds(sleep, () => budget?.remainingMs, turn, stop.signal).catch(() => { if (!stop.signal.aborted) turn.say('budget') })
  try {
    return await inTurn<T>(turn, (job, left) => serial(key, job, left), f, () => ({ deny: EDIT_WAITED }) as T)
  } finally {
    stop.abort()
  }
}
const EDIT_WAITED = 'agent-undo: an undo of this session is still running, so this edit did not run. Read the file, then try again.'
