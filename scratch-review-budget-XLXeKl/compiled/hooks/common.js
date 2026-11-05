"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.snapped = exports.touched = exports.windows = exports.time = exports.slashed = exports.serial = exports.newTurn = exports.inTurn = exports.inFlight = exports.fileKey = exports.ended = exports.editing = exports.forgetRestore = exports.endRecord = exports.beginRecord = void 0;
exports.mirror = mirror;
exports.mirrorEnding = mirrorEnding;
exports.saved = saved;
exports.restoreList = restoreList;
exports.updateList = updateList;
exports.record = record;
exports.showNewest = showNewest;
const claude_code_1 = require("claude-code");
const shared_1 = require("./shared");
Object.defineProperty(exports, "touched", { enumerable: true, get: function () { return shared_1.touched; } });
const MAX_CHANGES = 300;
const MAX_LINES = 4000;
const MAX_FILES = 200;
// Claude Code refuses a state value over 4,194,304 characters of JSON (its own error names the limit), and a
// refused list update loses the edit with no word: the list stays under it with room to spare.
const MAX_CHARS = 4_000_000;
/** The newest MAX_CHANGES entries, then the oldest dropped until the list's JSON fits under MAX_CHARS or one entry remains. */
function fit(list) {
    let out = list.slice(-MAX_CHANGES);
    let size = JSON.stringify(out).length;
    while (out.length > 1 && size > MAX_CHARS) {
        size -= JSON.stringify(out[0]).length + 1;
        out = out.slice(1);
    }
    return out;
}
// What both records share: the session's list, the clock and path spellings, the one-at-a-time
// queue for undos and edits, and which files an Edit or Write is touching while a command runs.
// The session's list (the same plugin, key and shape in each file that reads or writes it: the
// engine's scan lists a module's state per file). Change the tag in both (and SHAPE in common.tsx) when a Change's
// fields change: it declines what an earlier version stored.
const changes = (0, claude_code_1.atom)({ plugin: 'agent-undo', key: 'changes' }, [], { shape: 'changes-3' });
const SHAPE = 'changes-3';
// The session id whose list `changes` already is in this process. It lives in `$.state`, so a reload,
// enable or worker respawn (session.start again, the list kept) does not read the store copy again.
const listed = (0, claude_code_1.atom)({ plugin: 'agent-undo', key: 'listed' }, '', { shape: 'listed-1' });
// A copy of the list in the plugin's store, `changes:<session id>` = { shape, list }, so a new
// process for the same session finds it (`$.state` does not outlive the process). Each copy has its
// own write time, `at:<session id>`, written first; there is no shared index to lose an entry from.
// The KEEP newest are kept; when the store refuses a copy twice and is measured full (4 MiB in all), the
// oldest other one goes.
const KEEP = 5;
const keyOf = (id) => `changes:${id}`;
const atOf = (id) => `at:${id}`;
let saving = Promise.resolve();
const settled = new WeakSet([saving]);
// An edit's save waits for the one before it a second at most (restore's bound), so a write that never lands
// holds neither the later saves nor the Edit and Write hooks that wait for them. A write passed by is kept in
// `passed` until it lands: the ending conversation's copy and scrub() wait for those too, so a late write of
// theirs never lands over a newer list. A save already done costs no timer; a refused sleep waits as before.
// A write already passed by is not waited for again: its landing queues the next save itself.
const passed = new Set();
function after($, prev) {
    if (settled.has(prev))
        return prev;
    if (passed.has(prev))
        return Promise.resolve();
    const late = Symbol('late');
    const stop = new AbortController();
    return Promise.race([prev, $.clock.sleep(1000, { signal: stop.signal }).then(() => late, () => prev)]).then(got => {
        stop.abort();
        // Passed by: once it lands, the list is saved again, so the newest copy is written last.
        if (got === late) {
            passed.add(prev);
            void prev.then(() => { passed.delete(prev); return mirror($); });
        }
    });
}
let queued = 0;
const order = new WeakMap();
const enqueue = (p) => { saving = p; order.set(p, ++queued); void p.then(() => settled.add(p)); return p; };
// The queue, then every write it passed by: read once the queue settles, since a save still in its wait adds
// the write it passes when its second is up. Never waited for until `passed` is empty: a later save may pass
// the waiting write itself.
// Only writes queued before this one: a later save may have passed this very chain, and it must not wait for itself.
const whole = () => { const before = queued; return saving.then(() => Promise.all([...passed].filter(p => (order.get(p) ?? 0) <= before))); };
/** Writes the session's list to the store as it stands now; a failure only leaves no copy. */
function mirror($) {
    return enqueue(after($, saving).then(() => save($)).catch(() => undefined));
}
/** Every stored session id with its write time, oldest first. A copy with no time counts as oldest; a time
 * read refused twice (the file busy) counts as newest, so a copy that could not be read is never the one evicted. */
async function copies($) {
    const ids = new Set();
    for (const k of await $.store.keys()) {
        const m = /^(?:changes|at):(.+)$/.exec(k);
        if (m)
            ids.add(m[1]);
    }
    const out = [];
    for (const id of ids) {
        const busy = Symbol('busy');
        const at = await $.store.get(atOf(id)).catch(() => $.store.get(atOf(id))).catch(() => busy);
        out.push({ id, at: at === busy ? Number.MAX_SAFE_INTEGER : typeof at === 'number' ? at : 0 });
    }
    return out.sort((a, b) => a.at - b.at);
}
async function drop($, id) {
    await $.store.delete(keyOf(id));
    await $.store.delete(atOf(id));
}
// The store's cap: 4 MiB of JSON text in all (claude-code.d.ts, store.set). The engine counts it in characters
// of the whole store as compact JSON, not in bytes, so text with accents or CJK fits as many characters.
const CAP = 4 * 1024 * 1024;
/** True when the store with `value` under `key` would be over its cap, counted as the engine counts it: the
 * characters of the whole store as compact JSON. */
async function over($, key, value) {
    const all = {};
    for (const k of await $.store.keys())
        if (k !== key)
            all[k] = await $.store.get(k);
    all[key] = value;
    return JSON.stringify(all).length > CAP;
}
/** Sets `key`. A refusal is tried once more as it is: claude-code.d.ts names three refusals for store.set (a
 * function, a cycle, the 4 MiB cap), and a refusal it does not name (a mod above that refuses it, a file the
 * system holds) is not room to make either. Refused twice, the oldest other session's copy goes only when the
 * store is measured full, then the next oldest, until the value fits. */
async function put($, id, key, value) {
    try {
        await $.store.set(key, value);
        return;
    }
    catch { /* tried again below */ }
    try {
        await $.store.set(key, value);
        return;
    }
    catch (e) {
        if (!(await over($, key, value)))
            throw e;
    }
    const others = (await copies($)).filter(c => c.id !== id);
    for (const oldest of others) {
        await drop($, oldest.id);
        if (await over($, key, value))
            continue;
        await $.store.set(key, value);
        return;
    }
    throw new Error('store full');
}
/** At a /clear or /resume: the ending conversation's list, read in session.end (before the engine's end step
 * swaps it; the engine's own example saves there, claude-code.d.ts 'session.end'), is written as its copy
 * after the saves already queued. */
async function mirrorEnding($, id) {
    if (restored !== id)
        return;
    exports.ended = ended = id;
    const ending = { id, list: await (0, claude_code_1.read)($, changes) };
    // A conversation with no edits has nothing to keep; its empty copy would count toward KEEP and evict a real one.
    if (ending.list.length === 0)
        return;
    enqueue(whole().then(() => save($, ending)).catch(() => undefined));
}
/** Waits for the queued saves, at most `ms` (the engine's own example saves in session.end before its end step);
 * true when the queue stood still before the bound. With `all`, also the writes passed by (restore's read). */
async function saved($, ms, signal, records = false, all = false) {
    if (!(ms > 0) || signal?.aborted)
        return false;
    // Ends at the bound or at the chain's abort. The engine's declarations type no timer but $.clock's (and a hot
    // reload cancels only those), so a sleep refused for another reason (a mod above denies it) leaves the abort
    // to end it, the hook's own budget then the cap; with no signal to wait for, the wait ends at once.
    const bound = new Promise(done => {
        signal?.addEventListener('abort', () => done(), { once: true });
        if (Number.isFinite(ms))
            $.clock.sleep(ms, { signal }).then(done, () => { if (!signal || signal.aborted)
                done(); });
    });
    return Promise.race([quiet(records, all).then(() => true), bound.then(() => false)]);
}
// With `records`, also the edits between their tool result and their mirror() (the end's wait; never restore's,
// which runs inside one and would wait for itself).
const quiet = async (records, all) => { for (;;) {
    await still(all);
    if (!records || recording === 0)
        return;
    await idle;
} };
let recording = 0;
let idle = Promise.resolve();
let idleDone = () => { };
const beginRecord = () => { if (recording++ === 0)
    idle = new Promise(r => { idleDone = r; }); };
exports.beginRecord = beginRecord;
const endRecord = () => { if (--recording === 0)
    idleDone(); };
exports.endRecord = endRecord;
// A save queued during the wait (an edit landing while the conversation ends) replaces `saving`: this settles when
// the queue stands still. With `all`, also every write passed by: a cleanup restore() stopped waiting for still
// writes the copy, and its landing queues a save, so `saving` moves.
const still = async (all = false) => {
    for (let p = saving;; p = saving) {
        await p;
        if (all)
            await Promise.all([...passed]);
        if (p === saving)
            return;
    }
};
async function save($, ending) {
    const id = ending?.id ?? await $.session.id();
    // Until this session's stored copy was read, writing would put a shorter list over it.
    if (!ending && restored !== id && id !== ended)
        return;
    const list = ending?.list ?? await (0, claude_code_1.read)($, changes);
    // A /clear or /resume during that read (forgetRestore) left the next conversation's list there: the
    // ending one's copy is mirrorEnding's, queued after this, so this writes nothing. An edit of the ending
    // conversation whose list update landed after mirrorEnding's read still writes while `listed` (swapped
    // with the state) names it: read after the list, a swap between the two reads refuses.
    if (!ending && restored !== id && !(id === ended && (await (0, claude_code_1.read)($, listed)) === id))
        return;
    try {
        await put($, id, atOf(id), Date.now());
        await put($, id, keyOf(id), { shape: SHAPE, list });
    }
    catch {
        // Refused twice and not room to make (a busy file), or too large even with room made: no copy rather than a
        // stale one; the next save writes it again.
        await drop($, id);
        return;
    }
    for (const c of (await copies($)).filter(c => c.id !== id).slice(0, -(KEEP - 1))) {
        // Another session may have saved since the scan: only a stamp still as scanned goes.
        const now = await $.store.get(atOf(c.id)).catch(() => undefined);
        if ((typeof now === 'number' ? now : 0) === c.at)
            await drop($, c.id);
    }
}
// Restored once per session id in this process: at the first read or change after a start.
let restoring;
// The session id whose stored copy was read (or found absent) and is now the list, so saving it
// writes nothing shorter; a failed read is tried again.
let restored;
// The id mirrorEnding was last called for: its late saves may still write (see save()).
let ended;
/** A start (a new process, or new code) looks in the store again at the first read. */
const forgetRestore = () => { restoring = undefined; restored = undefined; };
exports.forgetRestore = forgetRestore;
/**
 * An empty list takes this session's stored copy, if the store holds one under the same shape
 * tag. Restored entries are only listed: an undo still checks each file reads as the change left it.
 */
async function restoreList($) {
    try {
        const id = await $.session.id();
        if (!restoring || restoring.id !== id) {
            const mine = {
                id,
                // A restore that settles after a newer one began (/clear: a new id, same process) is not this session's.
                done: restore($, id).then(async (got) => {
                    if (restoring !== mine)
                        return;
                    // A give-up is not kept: the next read or change looks again (the list may be cleaned by then).
                    if (!got.may) {
                        restoring = undefined;
                        return;
                    }
                    restored = id;
                    await (0, claude_code_1.update)($, listed, () => id);
                    // Stored entries went in before ones already listed: the copy is written with both. Not awaited: a write
                    // that never lands would hold this promise, and every later edit and /agent-undo waits on it. The write is
                    // queued, so the next save, exit and /clear still wait for it, bounded.
                    if (got.grew)
                        void mirror($);
                }, () => { if (restoring === mine)
                    restoring = undefined; }),
            };
            restoring = mine;
        }
        await restoring.done;
    }
    catch {
        // No session id or no store: the list is this process's only.
    }
}
/** `may`: this process may write the session's copy (none was stored, or all of it is now in the list);
 * `grew`: stored entries went in before entries already listed, so the copy lacks those. */
async function restore($, id) {
    const yes = { may: true, grew: false }, no = { may: false, grew: false };
    if ((await (0, claude_code_1.read)($, listed)) === id)
        return yes;
    // A save of this id's copy still queued (a /clear and a /resume back in the same window) lands before the read,
    // a second at most: this runs in the queue every Edit and Write waits in, so a write that never lands holds none.
    // A design choice: past the second the copy is read as it stands, and this conversation's edits are stored from
    // then on. A write that lands later (the store held over a second) is then written over, so the edits only it
    // carried leave the undo list; their files keep them. Waiting for it instead kept every later edit out of the copy
    // and the copy refused for colliding numbers once it landed (tests/review-undo15.test.tsx).
    // Every write passed by (a slow edit save, or a cleanup another restore stopped waiting for) is waited for under
    // the same second (tests/review-cr4.test.tsx).
    await saved($, 1000, undefined, false, true);
    // One more try for a read refused once (the file busy); a second refusal leaves no copy written.
    const got = await $.store.get(keyOf(id)).catch(() => $.store.get(keyOf(id)));
    if (!got || typeof got !== 'object')
        return yes;
    const { shape, list } = got;
    if (shape !== SHAPE || !Array.isArray(list))
        return yes;
    const valid = list.filter((c) => {
        if (!c || typeof c !== 'object')
            return false;
        const x = c;
        if (typeof x.n !== 'number' || typeof x.file !== 'string' || typeof x.at !== 'string' || !Array.isArray(x.hunks))
            return false;
        const lines = x.hunks.reduce((s, h) => s + (h?.before?.length ?? 0) + (h?.after?.length ?? 0), 0);
        return lines <= MAX_LINES && (x.files?.length ?? 0) <= MAX_FILES;
    });
    const ok = fit(valid);
    if (ok.length === 0)
        return yes;
    // Edits listed while the store refused its reads keep their numbers (the user may have seen them),
    // so a stored entry is merged in only when it is numbered below every listed one; otherwise the
    // copy is not written over either: it outlives this process.
    // A /clear while the store was read (a new id, the same process, no session.start) makes this copy
    // another conversation's: it is not taken.
    if ((await $.session.id()) !== id)
        return no;
    // An entry is known by its number, time and file: an undo marks a hunk undone, and the entry is
    // still the one stored.
    let added = [], had = false;
    // update() may call its function more than once, so each call decides afresh.
    await (0, claude_code_1.update)($, changes, now => {
        added = [];
        had = false;
        if (now.length === 0)
            return (added = ok, ok);
        const listedKeys = new Set(now.map(entryKey));
        const missing = ok.filter(c => !listedKeys.has(entryKey(c)));
        // An earlier restore of this session in this process (one a /clear and /resume overtook) filled it.
        if (missing.length === 0)
            return (had = true, now);
        const low = Math.min(...now.map(c => c.n));
        return missing.every(c => c.n < low) ? (added = missing, fit([...missing, ...now])) : now;
    });
    if (had)
        return (await $.session.id()) === id ? yes : no;
    if (added.length === 0)
        return no;
    // A /clear between that check and the write put the copy into the new conversation's list:
    // asked again, the id says so, and exactly the entries taken come out (its own edits stay).
    if ((await $.session.id()) === id)
        return { may: true, grew: added !== ok };
    const mine = new Set(added.map(entryKey));
    await (0, claude_code_1.update)($, changes, now => now.filter(c => !mine.has(entryKey(c))));
    // The new conversation's edits in that gap mirrored the copy into its store, and a second /clear
    // may have come since: every other session's stored copy loses the taken entries. Waited for a
    // second at most, as a save is: the cleanup waits for passed-by writes, which may never land.
    await after($, scrub($, id, mine));
    await mirror($);
    return no;
}
const entryKey = (c) => `${c.n}|${c.at}|${c.file}`;
/** Takes `keys` out of every stored copy but `owner`'s, in the save queue. A read refused twice, or a
 * write refused, drops that copy: no copy rather than one that lists another conversation's edits. */
function scrub($, owner, keys) {
    const p = whole().then(async () => {
        for (const { id } of await copies($)) {
            if (id === owner)
                continue;
            try {
                const got = await $.store.get(keyOf(id)).catch(() => $.store.get(keyOf(id)));
                const list = got?.list;
                if (got?.shape !== SHAPE || !Array.isArray(list))
                    continue;
                // An element that is not an object is no entry restore() would take: it goes too.
                const kept = list.filter(c => !!c && typeof c === 'object' && !keys.has(entryKey(c)));
                if (kept.length !== list.length)
                    await $.store.set(keyOf(id), { shape: SHAPE, list: kept });
            }
            catch {
                await drop($, id).catch(() => undefined);
            }
        }
    }).catch(() => undefined);
    return enqueue(p);
}
/** Changes the session's list, then mirrors it to the store. */
async function updateList($, f) {
    (0, exports.beginRecord)();
    let p;
    try {
        await restoreList($);
        await (0, claude_code_1.update)($, changes, list => fit(f(list)));
        p = mirror($);
    }
    finally {
        (0, exports.endRecord)();
    }
    // Its own write waited for a second at most, as a save waits for the one before it: the undo and the Edit
    // and Write hooks wait here, inside the queue every Edit and Write runs in, so a write that never landed
    // would hold them all. It stays in `saving`, which an exit, a /clear and the next save wait for.
    // A refused sleep waits as before, as after() does: the bound is the engine's timer, and without it
    // there is nothing to end the wait early (the plugin test kit answers no sleep, so it must not end at once).
    if (p === undefined || settled.has(p))
        return;
    const stop = new AbortController();
    await Promise.race([p, $.clock.sleep(1000, { signal: stop.signal }).catch(() => p)]);
    stop.abort();
}
var shared_2 = require("./shared");
Object.defineProperty(exports, "editing", { enumerable: true, get: function () { return shared_2.editing; } });
Object.defineProperty(exports, "ended", { enumerable: true, get: function () { return shared_2.ended; } });
Object.defineProperty(exports, "fileKey", { enumerable: true, get: function () { return shared_2.fileKey; } });
Object.defineProperty(exports, "inFlight", { enumerable: true, get: function () { return shared_2.inFlight; } });
Object.defineProperty(exports, "inTurn", { enumerable: true, get: function () { return shared_2.inTurn; } });
Object.defineProperty(exports, "newTurn", { enumerable: true, get: function () { return shared_2.newTurn; } });
Object.defineProperty(exports, "serial", { enumerable: true, get: function () { return shared_2.serial; } });
Object.defineProperty(exports, "slashed", { enumerable: true, get: function () { return shared_2.slashed; } });
Object.defineProperty(exports, "time", { enumerable: true, get: function () { return shared_2.time; } });
Object.defineProperty(exports, "windows", { enumerable: true, get: function () { return shared_2.windows; } });
/** A change recorded from git snapshots around the call (a Bash command, an MCP tool call): files, not hunks. */
const snapped = (c) => c.tool === 'Bash' || c.tool === 'MCP';
exports.snapped = snapped;
/** Adds one change to the session's list, numbered after the highest so far; `moved` first updates what it moves. */
async function record($, c, moved) {
    if (!(0, exports.snapped)(c))
        (0, shared_1.touched)(c.file);
    const lines = c.hunks.reduce((s, h) => s + h.before.length + h.after.length, 0);
    const big = lines > MAX_LINES || (c.files?.length ?? 0) > MAX_FILES || JSON.stringify(c).length > MAX_CHARS;
    const kept = big ? { ...c, hunks: [], files: c.files && [], tooLarge: true } : c;
    await updateList($, list => {
        const n = list.reduce((m, x) => Math.max(m, x.n), 0) + 1;
        return [...(moved ? moved(list) : list), { ...kept, n }];
    });
    await showNewest($);
}
/** The status line names the session's newest change (also after a resume, from the restored list). */
async function showNewest($) {
    const all = await (0, claude_code_1.read)($, changes);
    const last = all[all.length - 1];
    if (last && (0, exports.snapped)(last))
        $.ui.status(`#${last.n} ${last.tool === 'MCP' ? `MCP ${last.file}` : 'Bash'} (${last.files?.length ?? 0} file${last.files?.length === 1 ? '' : 's'}) · /agent-undo`);
    else if (last)
        $.ui.status(`#${last.n} ${last.file.split(/[\\/]/).pop()} (${last.hunks.length} hunk${last.hunks.length === 1 ? '' : 's'}) · /agent-undo`);
}
