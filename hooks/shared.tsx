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
// back no other file's. `keys` undefined waits for every queue and holds them all: an undo.
const tails = new Map<string, Promise<unknown>>()
let whole: Promise<unknown> = Promise.resolve()
export const serial = <T,>(keys: readonly string[] | undefined, f: () => Promise<T>): Promise<T> => {
  const p = Promise.allSettled(keys ? [whole, ...keys.map(k => tails.get(k))] : [whole, ...tails.values()]).then(f)
  const done = p.catch(() => undefined)
  if (!keys) {
    whole = done
    tails.clear()
  }
  for (const k of keys ?? []) {
    tails.set(k, done)
    void done.then(() => { if (tails.get(k) === done) tails.delete(k) })
  }
  return p
}

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
