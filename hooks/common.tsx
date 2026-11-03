import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Change } from '../types'

const MAX_CHANGES = 300
const MAX_LINES = 4000
const MAX_FILES = 200

// What both records share: the session's list, the clock and path spellings, the one-at-a-time
// queue for undos and edits, and which files an Edit or Write is touching while a command runs.

// The session's list (the same plugin, key and shape in each file that reads or writes it: the
// engine's scan lists a module's state per file). Change the tag in both (and SHAPE in common.tsx) when a Change's
// fields change: it declines what an earlier version stored.
const changes = atom({ plugin: 'agent-undo', key: 'changes' } as const, [], { shape: 'changes-2' })
const SHAPE = 'changes-2'

// A copy of the list in the plugin's store, `changes:<session id>` = { shape, list }, so a new
// process for the same session finds it (`$.state` does not outlive the process). `sessions` names
// the stored ones, the most recently written last; only the last KEEP are kept.
const KEEP = 5
const keyOf = (id: string) => `changes:${id}`
let saving: Promise<unknown> = Promise.resolve()

/** Writes the session's list to the store as it stands now; a failure only leaves no copy. */
export function mirror($: EngineInterface): Promise<void> {
  const p = saving.then(() => save($)).catch(() => undefined)
  saving = p
  return p
}

async function save($: EngineInterface) {
  const id = await $.session.id()
  // Until this session's stored copy was read, writing would put a shorter list over it.
  if (restored !== id) return
  const list = await read($, changes)
  const was = await $.store.get('sessions')
  const ids = (Array.isArray(was) ? was.filter((x): x is string => typeof x === 'string') : []).filter(x => x !== id)
  ids.push(id)
  // Older sessions go first, so the store has room for this one's copy. Only ids this index
  // named are cleared: a key it does not name may be another process's save in progress.
  const evicted = ids.slice(0, -KEEP)
  for (const x of evicted) await $.store.delete(keyOf(x))
  let mine = true
  try {
    await $.store.set(keyOf(id), { shape: SHAPE, list })
  } catch {
    // Too large for the store: no copy rather than a stale one.
    await $.store.delete(keyOf(id))
    mine = false
  }
  // Read the index again just before writing it, keeping what another process added meanwhile.
  const fresh = await $.store.get('sessions')
  const others = [...(Array.isArray(fresh) ? fresh : []), ...ids]
    .filter((x): x is string => typeof x === 'string' && x !== id && !evicted.includes(x))
  const all = [...new Set(others)]
  if (mine) all.push(id)
  const kept = all.slice(-KEEP)
  for (const x of all.slice(0, -KEEP)) await $.store.delete(keyOf(x))
  if (JSON.stringify(fresh) !== JSON.stringify(kept)) await $.store.set('sessions', kept)
}

// Restored once per session id in this process: at the first read or change after a start.
let restoring: { id: string; done: Promise<void> } | undefined
// The session id whose stored copy was read (or found absent) and is now the list, so saving it
// writes nothing shorter; a failed read is tried again.
let restored: string | undefined

/** A start (a new process, or new code) looks in the store again at the first read. */
export const forgetRestore = () => { restoring = undefined; restored = undefined }

/**
 * An empty list takes this session's stored copy, if the store holds one under the same shape
 * tag. Restored entries are only listed: an undo still checks each file reads as the change left it.
 */
export async function restoreList($: EngineInterface): Promise<void> {
  try {
    const id = await $.session.id()
    if (!restoring || restoring.id !== id) {
      const mine: { id: string; done: Promise<void> } = {
        id,
        // A restore that settles after a newer one began (/clear: a new id, same process) is not this session's.
        done: restore($, id).then(
          may => { if (restoring === mine && may) restored = id },
          () => { if (restoring === mine) restoring = undefined },
        ),
      }
      restoring = mine
    }
    await restoring.done
  } catch {
    // No session id or no store: the list is this process's only.
  }
}

/** True when this process may write the session's copy: none was stored, or it is now the list. */
async function restore($: EngineInterface, id: string): Promise<boolean> {
  // One more try for a read refused once (the file busy); a second refusal leaves no copy written.
  const got = await $.store.get(keyOf(id)).catch(() => $.store.get(keyOf(id)))
  if (!got || typeof got !== 'object') return true
  const { shape, list } = got as { shape?: unknown; list?: unknown }
  if (shape !== SHAPE || !Array.isArray(list)) return true
  const ok = (list as unknown[]).filter((c): c is Change => {
    if (!c || typeof c !== 'object') return false
    const x = c as Partial<Change>
    if (typeof x.n !== 'number' || typeof x.file !== 'string' || typeof x.at !== 'string' || !Array.isArray(x.hunks)) return false
    const lines = x.hunks.reduce((s, h) => s + (h?.before?.length ?? 0) + (h?.after?.length ?? 0), 0)
    return lines <= MAX_LINES && (x.files?.length ?? 0) <= MAX_FILES
  }).slice(-MAX_CHANGES)
  if (ok.length === 0) return true
  // Edits listed while the store refused its reads keep their numbers (the user may have seen them),
  // so the stored copy is not merged in; nor is it written over: it outlives this process.
  let took = false
  await update($, changes, now => (now.length === 0 ? (took = true, ok) : now))
  return took
}

/** Changes the session's list, then mirrors it to the store. */
export async function updateList($: EngineInterface, f: (list: readonly Change[]) => Change[]) {
  await restoreList($)
  await update($, changes, f)
  await mirror($)
}

export const time = (iso: string) => {
  const d = new Date(iso)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':')
}

export const slashed = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** One file as one key however it is spelled: forward slashes, no doubled or final slash, drive letter upper case. */
export const fileKey = (p: string) => slashed(p).replace(/\/{2,}/g, '/').replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)

// One undo at a time, and no Edit or Write runs while one does: an undo reads a file and writes
// it back, and an edit landing in between would be lost.
let queue: Promise<unknown> = Promise.resolve()
export const serial = <T,>(f: () => Promise<T>): Promise<T> => {
  const p = queue.then(f, f)
  queue = p.catch(() => undefined)
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

/** Adds one change to the session's list, numbered after the highest so far. */
export async function record($: EngineInterface, c: Omit<Change, 'n'>) {
  if (c.tool !== 'Bash') touched(c.file)
  const lines = c.hunks.reduce((s, h) => s + h.before.length + h.after.length, 0)
  const kept = lines > MAX_LINES || (c.files?.length ?? 0) > MAX_FILES ? { ...c, hunks: [], files: c.files && [], tooLarge: true } : c
  await updateList($, list => {
    const n = list.reduce((m, x) => Math.max(m, x.n), 0) + 1
    return [...list, { ...kept, n }].slice(-MAX_CHANGES)
  })
  const all = await read($, changes)
  const last = all[all.length - 1]
  if (last && last.tool === 'Bash') $.ui.status(`#${last.n} Bash (${last.files?.length ?? 0} file${last.files?.length === 1 ? '' : 's'}) · /agent-undo`)
  else if (last) $.ui.status(`#${last.n} ${last.file.split(/[\\/]/).pop()} (${last.hunks.length} hunk${last.hunks.length === 1 ? '' : 's'}) · /agent-undo`)
}
