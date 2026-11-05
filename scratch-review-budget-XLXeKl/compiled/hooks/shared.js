"use strict";
// Small things both hooks share that hold no list: path keys, the clock line, the queues, the shell windows.
Object.defineProperty(exports, "__esModule", { value: true });
exports.editing = exports.touched = exports.inFlight = exports.windows = exports.ended = exports.inTurn = exports.stopped = exports.newTurn = exports.serial = exports.overdue = exports.fileKey = exports.slashed = exports.time = void 0;
const time = (iso) => {
    const d = new Date(iso);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join(':');
};
exports.time = time;
const slashed = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');
exports.slashed = slashed;
/** One file as one key however it is spelled: forward slashes, no doubled or final slash, drive letter upper case. */
const fileKey = (p) => (0, exports.slashed)(p).replace(/\/{2,}/g, '/').replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
exports.fileKey = fileKey;
// No Edit, Write or undo of a file runs beside another of the same file: an undo reads a file and writes it back, and
// an edit landing in between would be lost. Each file has its own queue, so an Edit waiting on its question holds
// back no other file's. `keys` undefined waits for every queue and holds them all: an undo. `left` lets go of the queue
// early, for a job that will not run: the jobs behind it then wait only for what they would have waited for without it.
const tails = new Map();
// When each file's waiting job began. A plain wait spends a hook's own time, so past its budget the engine runs that
// Edit itself, beside whatever holds the queue: a slow undo must not write over it.
const waiting = new Set();
const OWN_TIME_MS = 8500;
const overdue = () => [...waiting].some(w => Date.now() - w.since >= OWN_TIME_MS);
exports.overdue = overdue;
let whole = Promise.resolve();
const serial = (keys, f, left) => {
    const wait = { since: Date.now() };
    if (keys)
        waiting.add(wait);
    const p = Promise.allSettled(keys ? [whole, ...keys.map(k => tails.get(k))] : [whole, ...tails.values()]).then(() => {
        waiting.delete(wait);
        return f();
    });
    const settled = p.catch(() => undefined);
    // Leaving hands the queue to what stood ahead: a running undo is held only by this link.
    const ahead = whole;
    const done = left ? Promise.race([settled, left.then(() => ahead)]) : settled;
    if (!keys)
        whole = done;
    for (const k of keys ?? []) {
        tails.set(k, done);
        void done.then(() => { if (tails.get(k) === done)
            tails.delete(k); });
    }
    return p;
};
exports.serial = serial;
const newTurn = () => {
    let answer = () => { };
    const over = new Promise(r => { answer = r; });
    const turn = { over, say: why => { turn.why ??= why; answer(turn.why); } };
    return turn;
};
exports.newTurn = newTurn;
/** Why this undo must not write now: what its turn says, or an Edit behind it about to go on without it. */
const stopped = (turn) => {
    if ((0, exports.overdue)())
        turn.say('budget');
    return turn.why;
};
exports.stopped = stopped;
/** `job` in its queue, unless the turn goes first: then `late` answers at once and the job, still waiting, never runs and
 * leaves the queue. One that began is seen through, and looks at the turn itself before its last step. */
const inTurn = async (turn, queue, job, late) => {
    let began = false;
    let leave = () => { };
    const left = new Promise(r => { leave = r; });
    const work = queue(async () => {
        if (turn.why)
            return late(turn.why);
        began = true;
        return job();
    }, left);
    const first = await Promise.race([work.then(() => undefined), turn.over]);
    if (first === undefined || began)
        return work;
    leave();
    return late(first);
};
exports.inTurn = inTurn;
/** Run when a conversation ends. */
exports.ended = new Set();
/**
 * The files an Edit or Write touched while each shell command ran: theirs, not the command's.
 * Marked when the Edit or Write starts, and an open window takes the ones still running.
 */
exports.windows = new Set();
exports.inFlight = new Map();
const touched = (file) => {
    if (typeof file !== 'string' || file === '')
        return;
    for (const w of exports.windows)
        w.add((0, exports.fileKey)(file));
};
exports.touched = touched;
const editing = async (file, f) => {
    const k = typeof file === 'string' && file !== '' ? (0, exports.fileKey)(file) : '';
    (0, exports.touched)(k);
    exports.inFlight.set(k, (exports.inFlight.get(k) ?? 0) + 1);
    try {
        return await f();
    }
    finally {
        const left = (exports.inFlight.get(k) ?? 1) - 1;
        if (left > 0)
            exports.inFlight.set(k, left);
        else
            exports.inFlight.delete(k);
    }
};
exports.editing = editing;
