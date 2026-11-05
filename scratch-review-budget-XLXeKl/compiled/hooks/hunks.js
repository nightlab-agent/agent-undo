"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.acrossUndo = exports.followed = exports.undoHunk = exports.undoAt = exports.hunksFrom = exports.onceIn = exports.rowsOf = exports.hunksOf = void 0;
const shared_1 = require("./shared");
/** Each hunk of an engine diff as the lines before and after it, context included. */
const hunksOf = (patch) => patch.map(p => {
    const h = { before: [], after: [], line: p.newStart };
    let prev = ' ';
    for (const l of p.lines) {
        // "\ No newline at end of file" follows the last line of the side(s) it belongs to.
        if (l.startsWith('\\')) {
            if (prev !== '+')
                h.beforeNoEol = true;
            if (prev !== '-')
                h.afterNoEol = true;
            continue;
        }
        prev = l[0] ?? ' ';
        if (prev !== '+')
            h.before.push(l.slice(1));
        if (prev !== '-')
            h.after.push(l.slice(1));
    }
    return h;
});
exports.hunksOf = hunksOf;
/** The file as lines, each with its own ending ('' for a last line without one). */
const rowsOf = (text) => {
    const parts = text.split(/(\r\n|\n)/);
    const rows = [];
    for (let k = 0; k < parts.length; k += 2)
        rows.push({ t: parts[k] ?? '', e: parts[k + 1] ?? '' });
    const last = rows[rows.length - 1];
    if (last && last.t === '' && last.e === '')
        rows.pop();
    return rows;
};
exports.rowsOf = rowsOf;
/** Every place `after` stands in `rows`, word for word. */
const places = (rows, after) => {
    const at = [];
    for (let i = 0; after.length > 0 && i + after.length <= rows.length; i++) {
        if (after.every((l, j) => rows[i + j].t === l))
            at.push(i);
    }
    return at;
};
const standsOnce = (rows) => {
    const by = new Map();
    for (const [i, r] of rows.entries()) {
        const seen = by.get(r.t);
        if (seen)
            seen.push(i);
        else
            by.set(r.t, [i]);
    }
    return after => {
        let found = 0;
        for (const i of by.get(after[0]) ?? []) {
            if (after.every((l, j) => rows[i + j]?.t === l) && ++found > 1)
                return false;
        }
        return found === 1;
    };
};
/** The same check on a file's text. */
const onceIn = (text) => standsOnce((0, exports.rowsOf)(text));
exports.onceIn = onceIn;
/** A line as the engine's diff shows it: `structuredPatch` is display text, each leading tab two spaces (convertTabs). */
const shownAs = (line) => line.replace(/^\t+/gm, tabs => '  '.repeat(tabs.length));
/**
 * The hunks of one edit with the file's own text. The diff gives the places and the shape; the words come from
 * `was` and `now`, the whole file before and after: a line's text is taken only where the diff shows the same
 * line. A before line that differs, or no `was` at all, leaves nothing proven: undefined, and the edit cannot be
 * undone. An after line that differs keeps the diff's text, and an undo then finds it only where the file really
 * reads so. `now` may be missing or a guess (an Edit's result does not hold the new file).
 */
const hunksFrom = (patch, was, now) => {
    if (typeof was !== 'string')
        return undefined;
    const [old, next] = [(0, exports.rowsOf)(was), (0, exports.rowsOf)(now ?? '')];
    const hunks = (0, exports.hunksOf)(patch);
    const once = standsOnce(next);
    for (const [k, h] of hunks.entries()) {
        const at = { old: (patch[k].oldStart ?? 0) - 1, next: h.line - 1 };
        const before = h.before.map((l, j) => { const t = old[at.old + j]?.t; return t !== undefined && shownAs(t) === l ? t : undefined; });
        if (before.includes(undefined))
            return undefined;
        h.before = before;
        // A Write keeps the CR of a CRLF `content` in the diff; `next` holds lines without their ending.
        h.after = h.after.map((l, j) => { const t = next[at.next + j]?.t; return t !== undefined && shownAs(t) === l.replace(/\r$/, '') ? t : l; });
        if (now !== undefined) {
            h.total = next.length;
            if (once(h.after))
                h.alone = true;
        }
    }
    return hunks;
};
exports.hunksFrom = hunksFrom;
/**
 * The file's text with one hunk put back as it was, and where, or why not. The hunk's after-lines must still stand
 * in the file, word for word, and the place must be provable; every other line keeps its own line ending. Proof is
 * one of two. The place this mod followed, with the file's length as it followed it: nothing else moved the lines
 * by a count it can see. Or the lines stood once when the edit left them and stand once now: only they can be these.
 * Anything else may be a look-alike, and a look-alike is refused: a person's change elsewhere can leave one at the
 * old place.
 */
const undoAt = (text, hunk) => {
    const rows = (0, exports.rowsOf)(text);
    const crlf = rows.filter(r => r.e === '\r\n').length;
    const eol = crlf > rows.filter(r => r.e === '\n').length ? '\r\n' : '\n';
    const { before, after } = hunk;
    if (after.length === 0 && rows.length > 0)
        return { refused: 'the file is no longer empty, as the edit left it' };
    const at = after.length === 0 ? [0] : places(rows, after);
    if (at.length === 0)
        return { refused: 'those lines have changed since the edit' };
    const expected = hunk.line - 1;
    const followed = at.includes(expected) && (hunk.total === undefined || hunk.total === rows.length);
    const only = at.length === 1 && (hunk.alone === true || after.length === 0);
    const i = followed ? expected : only ? at[0] : undefined;
    if (i === undefined) {
        return { refused: at.length > 1 ? `those lines appear ${at.length} times and none is proven to be the edit's` : 'lines like those stand elsewhere, not where the edit left them' };
    }
    const atEnd = i + after.length === rows.length;
    const put = before.map((t, j) => {
        const e = j < after.length ? rows[i + j].e : eol;
        return { t, e: e === '' ? eol : e };
    });
    const lastPut = put[put.length - 1];
    // The final newline: as the diff says the file had it before the edit; else as the file has it now.
    if (atEnd && lastPut) {
        lastPut.e = hunk.beforeNoEol ? '' : hunk.afterNoEol || rows.length === 0 ? eol : rows[rows.length - 1].e;
    }
    rows.splice(i, after.length, ...put);
    return { text: rows.map(r => r.t + r.e).join(''), at: i };
};
exports.undoAt = undoAt;
const undoHunk = (text, hunk) => {
    const got = (0, exports.undoAt)(text, hunk);
    return 'refused' in got ? got : { text: got.text };
};
exports.undoHunk = undoHunk;
const movedBy = (patch, line) => {
    let by = 0;
    for (const p of patch) {
        let o = (p.oldStart ?? 0) - 1;
        for (const l of p.lines) {
            if (l[0] === ' ')
                o++;
            else if (l[0] === '-') {
                if (o < line)
                    by--;
                o++;
            }
            else if (l[0] === '+' && o <= line)
                by++;
        }
    }
    return by;
};
const tracked = (h, line, grown, once) => {
    const { alone, ...rest } = h;
    const still = alone === true && once !== undefined && once(h.after);
    return { ...rest, line, ...(h.total === undefined ? {} : { total: h.total + grown }), ...(still ? { alone: true } : {}) };
};
/** Every listed hunk of `file` after a later edit: each moves with the lines above it, whatever happened to the file's
 * length otherwise stays visible in `total`. With no diff to follow (it timed out), its place is unknown: line 0. */
const followed = (list, file, patch, now) => {
    const once = now === undefined ? undefined : (0, exports.onceIn)(now);
    const grown = movedBy(patch, Infinity);
    return list.map(c => ((0, shared_1.fileKey)(c.file) !== (0, shared_1.fileKey)(file) ? c : {
        ...c, hunks: c.hunks.map(h => tracked(h, patch.length > 0 ? h.line + movedBy(patch, h.line - 1) : 0, grown, once)),
    }));
};
exports.followed = followed;
/** One hunk after an undo in its file: `moves` in the order they were made, `once` asked of the file as it stands. */
const acrossUndo = (h, moves, once) => {
    let line = h.line - 1;
    for (const m of moves)
        if (line >= m.at + m.cut)
            line += m.put - m.cut;
    return tracked(h, line + 1, moves.reduce((s, m) => s + m.put - m.cut, 0), once);
};
exports.acrossUndo = acrossUndo;
