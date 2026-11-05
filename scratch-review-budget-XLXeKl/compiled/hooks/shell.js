"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerShell = exports.sessionEnds = exports.shellNote = exports.mcpLabel = exports.isMcp = exports.ownTool = exports.gitSaid = exports.spelled = exports.filesOf = exports.INDEX_TAG = void 0;
exports.git = git;
exports.repoOf = repoOf;
exports.onIndex = onIndex;
const common_1 = require("./common");
// The session's list is changed only through common.tsx (updateList), which mirrors it to the store.
const INDEX = 'agent-undo.index';
/** This process's own index file beside that name: two sessions on one checkout must not reseed each other's. */
exports.INDEX_TAG = Math.random().toString(36).slice(2, 10);
const ZERO = /^0+$/;
/** The files of `git diff-tree -r -z --no-renames <a> <b>`: each status, path and both blobs. */
const filesOf = (out) => {
    const parts = out.split('\0');
    const files = [];
    for (let k = 0; k + 1 < parts.length; k += 2) {
        const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([MDAT])/.exec(parts[k]);
        if (!m)
            continue;
        const [, modeA, modeB, a, b, status] = m;
        const f = { path: parts[k + 1], status: status };
        if (!ZERO.test(a))
            f.before = a;
        if (!ZERO.test(b))
            f.after = b;
        if (modeB === '100755')
            f.exec = true;
        const modes = [modeA, modeB];
        if (modes.includes('160000'))
            f.fixed = 'a submodule';
        else if (modes.includes('120000'))
            f.fixed = 'a symbolic link';
        files.push(f);
    }
    return files;
};
exports.filesOf = filesOf;
/** A path from git (relative to its top) as the session spells it: under the session's folder
 * through its own spelling (a symbolic link to a subfolder included), elsewhere through git's top. */
const spelled = (r, p) => r.root !== undefined && r.prefix !== undefined && p.startsWith(r.prefix) ? `${r.root}/${p.slice(r.prefix.length)}` : `${r.top}/${p}`;
exports.spelled = spelled;
async function git($, argv, cwd, env) {
    // A first snapshot of a large repo can take 30 s or more.
    const r = await $.process.run(['git', ...argv], { cwd, timeoutMs: 60000, ...(env ? { env } : {}) });
    if (r.exitCode !== 0)
        throw new Error(r.stderr.trim() || `git ${argv[0]} failed`);
    return r.stdout;
}
/**
 * Two absolute paths, different, the second the private file. Before 2.31 git does not know --path-format: it
 * echoes the flag and prints relative paths, so by position the private index would be the person's own. A
 * GIT_INDEX_FILE that names the private file makes the two one file. Anything else is not trusted.
 */
const safeIndex = (paths) => {
    const [real, index] = paths.map(common_1.fileKey);
    const absolute = (p) => /^(?:[A-Za-z]:)?\//.test(p);
    return paths.length === 2 && !!real && !!index && absolute(real) && absolute(index) && real !== index && index.endsWith(`/${INDEX}`);
};
/**
 * The repo around the session's folder, its top spelled as the session spells it (git resolves
 * symbolic links; Claude's file paths do not), with the private index seeded once from the real one.
 */
async function repoOf($) {
    try {
        const root = (0, common_1.slashed)(await $.session.root());
        const [gitTop = '', prefix = ''] = (await git($, ['rev-parse', '--show-toplevel', '--show-prefix'], root)).split('\n');
        const top = (0, common_1.slashed)(gitTop.trim());
        const paths = (await git($, ['rev-parse', '--path-format=absolute', '--git-path', 'index', '--git-path', INDEX], top)).trim().split('\n');
        if (!top)
            return undefined;
        const [real, base] = paths;
        if (!real || !base || !safeIndex(paths)) {
            stop($, 'git named no private index, and the real one is never written (git 2.31 or newer is needed)', 'agent-undo: shell commands not recorded (needs git 2.31 or newer) · /agent-undo');
            return undefined;
        }
        const index = `${base}.${exports.INDEX_TAG}`;
        // A copy of the real index keeps git's file timestamps, so the first snapshot hashes only
        // what changed. Without one (no cp, no commit yet) the first snapshot reads every file.
        if (!(await $.fs.exists(index)) && (await $.fs.exists(real))) {
            await $.process.run(['cp', real, index], { cwd: top }).catch(() => undefined);
            // What a killed session left behind. A live session's file past this age is seeded again at its next command.
            const dir = base.slice(0, base.lastIndexOf('/'));
            await $.process.run(['find', dir, '-maxdepth', '1', '-name', `${INDEX}*`, '-mtime', '+7', '-delete'], { cwd: top }).catch(() => undefined);
        }
        lastIndex = index;
        return { top, root, prefix: prefix.trim(), index, real, env: { GIT_INDEX_FILE: index } };
    }
    catch (err) {
        // No repo here is the plain case; a repo git refuses (dubious ownership) is said, as a failed snapshot is.
        if (!/not a git repository|ENOENT/i.test(String(err?.message ?? err))) {
            failed = (0, exports.gitSaid)(err);
            try {
                $.ui.status(`agent-undo: last command not recorded: ${failed} · /agent-undo`);
            }
            catch { }
        }
        return undefined;
    }
}
// Snapshots and restores share one index file, so they take turns; the commands do not wait.
let snaps = Promise.resolve();
let lastIndex;
// Each git call ends at its own timeout, so this bound is for a snapshot whose git never comes back: the queue goes on
// without it. An undo has no bound: a command let in beside a live restore would record the restore as its own change.
const HOLD_MS = 180000;
function onIndex($, f, held = true) {
    const p = snaps.then(f);
    snaps = snaps.then(async () => {
        const turn = p.catch(() => undefined);
        if (!held)
            return turn;
        const stop = new AbortController();
        // A sleep refused (a mod above denies it) is no bound: the queue waits for the turn, as it did before there was one.
        await Promise.race([turn, $.clock.sleep(HOLD_MS, { signal: stop.signal }).catch(() => turn)]);
        stop.abort();
    });
    return p;
}
/** git's own line for a failure, at most 120 characters: its first `error:` or `fatal:` line (a warning can stand before
 * one), or its first line. */
const gitSaid = (err) => {
    const lines = String(err?.message ?? err).split('\n').map(l => l.trim());
    return [...(lines.find(l => /^(?:error|fatal):/.test(l)) ?? lines[0] ?? '')].slice(0, 120).join('');
};
exports.gitSaid = gitSaid;
/** What git said when the newest snapshot failed. Each call tries again, and one that works clears this. */
let failed;
function snapshot(repo, $) {
    return onIndex($, async () => {
        const once = async () => {
            await git($, ['add', '-A'], repo.top, repo.env);
            return (await git($, ['write-tree'], repo.top, repo.env)).trim();
        };
        // `git gc` removes objects only the private index names (it does not know the index), and
        // write-tree then fails: seed it again from the real index, or empty it, and try once more.
        const again = async () => {
            const r = repo.real ? await $.process.run(['cp', repo.real, repo.index], { cwd: repo.top }).catch(() => undefined) : undefined;
            if (!r || r.exitCode !== 0)
                await git($, ['read-tree', '--empty'], repo.top, repo.env);
            return once();
        };
        try {
            const tree = await once().catch(again);
            if (failed !== undefined) {
                failed = undefined;
                try {
                    $.ui.status(undefined);
                }
                catch { }
                void (0, common_1.showNewest)($).catch(() => { });
            }
            return tree;
        }
        catch (err) {
            failed = (0, exports.gitSaid)(err);
            try {
                $.ui.status(`agent-undo: last command not recorded: ${failed} · /agent-undo`);
            }
            catch { }
            throw err;
        }
    });
}
const shells = new Set();
const pending = new Map();
const asked = new Set();
/** Every call this hook is wrapping, recorded or not, and its kind: a call running in a shell's window
 * makes it overlapped (a Bash command at once; an MCP call when it ends, unless it ended read-only). */
const running = new Map();
/** Call `id` ran in `sh`'s window: a Bash command overlaps it now; an MCP call waits in `maybe` until it ends. */
const overlap = (sh, id) => {
    if (id === sh.id)
        return;
    if (running.get(id) === 'MCP')
        sh.maybe.add(id);
    else
        sh.overlapped = true;
};
/** An MCP call ended: read-only (the engine's `isReadOnly`), it overlapped nothing; otherwise every window it ran in is overlapped. */
const settle = (id, readOnly) => {
    for (const o of shells) {
        if (o.maybe.delete(id) && !readOnly)
            o.overlapped = true;
    }
};
/** Set when a command went on in the background: its later writes would land in any later record. */
let stopped;
const stop = ($, why, status) => {
    if (stopped)
        return;
    stopped = why;
    try {
        $.ui.status(status);
    }
    catch { }
};
async function begin($, id) {
    if (stopped)
        return undefined;
    const repo = await repoOf($);
    if (!repo || !running.has(id))
        return undefined;
    const sh = { id, repo, before: '', mine: new Set([...common_1.inFlight.keys()].filter(k => k !== '')), overlapped: false, maybe: new Set() };
    // A window still open after its call ended (its second snapshot running) counts too.
    for (const o of shells) {
        overlap(sh, o.id);
        overlap(o, id);
    }
    for (const r of running.keys())
        overlap(sh, r);
    shells.add(sh);
    common_1.windows.add(sh.mine);
    try {
        sh.before = await snapshot(repo, $);
        // Its call ended while the snapshot ran (interrupted): nothing will take this one.
        if (!running.has(id)) {
            end(sh);
            return undefined;
        }
        return sh;
    }
    catch {
        end(sh);
        return undefined;
    }
}
const end = (sh) => {
    shells.delete(sh);
    common_1.windows.delete(sh.mine);
};
/** Where a path lands by the system's own walk (a link's `..` is its target's parent, so no string can say). A file that
 * is gone lands through its folder; a path that leads nowhere stays as spelled. */
const landed = async ($, path) => {
    const real = async (p) => (await $.fs.stat(p, { resolve: true }).catch(() => undefined))?.realPath;
    const cut = path.lastIndexOf('/');
    const own = await real(path);
    if (own !== undefined)
        return (0, common_1.fileKey)(own);
    const folder = await real(path.slice(0, cut + 1));
    return (0, common_1.fileKey)(folder === undefined ? path : `${folder}/${path.slice(cut + 1)}`);
};
/** The files an Edit, Write or undo did not take: `mine` holds each by the path it was given, a link's perhaps, and git
 * names each by its real path under its top. */
const commandsOwn = async ($, sh, all) => {
    const files = all.filter(f => !sh.mine.has((0, common_1.fileKey)((0, exports.spelled)(sh.repo, f.path))));
    if (files.length === 0 || sh.mine.size === 0)
        return files;
    const theirs = new Set(await Promise.all([...sh.mine].map(k => landed($, k))));
    const top = await landed($, sh.repo.top);
    return files.filter(f => !theirs.has((0, common_1.fileKey)(`${top}/${f.path}`)));
};
const take = (id) => {
    const sh = typeof id === 'string' ? pending.get(id) : undefined;
    if (typeof id === 'string') {
        pending.delete(id);
        asked.delete(id);
    }
    return sh;
};
/** agent-undo's own model tool, exactly the name `$.tool.register` returned (its undo is not a change to
 * record); until it answers, the name its own hook serves. Only that name: a configured server that
 * happens to be named agent-undo is another server and is recorded. */
let own = 'mcp__agent-undo__undo';
const ownTool = (name) => { if (typeof name === 'string' && name.startsWith('mcp__'))
    own = name; };
exports.ownTool = ownTool;
/** An MCP tool's call, by its wire name, that is not this mod's own. */
const isMcp = (tool) => typeof tool === 'string' && tool.startsWith('mcp__') && tool !== own;
exports.isMcp = isMcp;
/** `mcp__filesystem__write_file` as `filesystem write_file`: one line, at most 60 characters. */
const mcpLabel = (tool) => {
    const rest = tool.slice('mcp__'.length);
    const k = rest.indexOf('__');
    const name = (k < 0 ? rest : `${rest.slice(0, k)} ${rest.slice(k + 2)}`).replace(/[\u0000-\u001f\u007f]/g, ' ');
    return name.length > 60 ? `${name.slice(0, 59)}…` : name;
};
exports.mcpLabel = mcpLabel;
const commandLabel = (command) => {
    const first = String(command ?? '').trim().split('\n')[0] ?? '';
    return first.length > 60 ? `${first.slice(0, 59)}…` : first;
};
/** Bash answers with this id when a command goes on (`run_in_background`, or moved there later). */
const backgrounded = (done) => done.result?.backgroundTaskId !== undefined;
/** The engine's decision for one wrapped call: an "allow" with no question first takes the before-snapshot. */
async function checked($, id, verdict) {
    try {
        // The first decision for a call stands: a later "allow" for a call that was asked about (the
        // question answered) or already snapshotted starts nothing.
        if (typeof id === 'string' && verdict.decision !== 'allow')
            asked.add(id);
        if (verdict.decision === 'allow' && typeof id === 'string' && !pending.has(id) && !asked.has(id)) {
            const sh = await begin($, id);
            if (sh)
                pending.set(id, sh);
        }
    }
    catch {
        // A failure of this mod never changes the verdict.
    }
    return verdict;
}
/** One wrapped call: run it, then snapshot again and record the files that differ, as `tool` named `label`. */
async function around($, rawId, agent, tool, label, call, goesOn = backgrounded) {
    const id = typeof rawId === 'string' ? rawId : undefined;
    // Only a call this hook wraps gets a snapshot (its check runs inside the call); while it runs,
    // every other open window is overlapped (by an MCP call only if it does not end read-only).
    if (id) {
        running.set(id, tool);
        for (const o of shells)
            overlap(o, id);
    }
    let done;
    try {
        done = await call();
    }
    catch (err) {
        if (id) {
            running.delete(id);
            settle(id, false);
        }
        const sh = take(id);
        if (sh)
            end(sh);
        throw err;
    }
    if (id) {
        running.delete(id);
        settle(id, done.isReadOnly === true);
    }
    const sh = take(id);
    // Any command that goes on in the background, recorded or not (one approved at a prompt too),
    // could write into a later command's window.
    if (done.deny === undefined && goesOn(done)) {
        stop($, `a command went on in the background at ${(0, common_1.time)(new Date().toISOString())}, and its later writes would land in any later record`, 'agent-undo: shell commands no longer recorded (one runs in the background) · /agent-undo');
    }
    if (!sh)
        return done;
    // From the tool result to record()'s list update the call counts as an edit on its way (the end's wait).
    (0, common_1.beginRecord)();
    try {
        // A failed command may still have changed files and is recorded; an MCP tool that answered an error is not.
        if (done.deny !== undefined || stopped || (tool === 'MCP' && done.isError))
            return done;
        const after = await snapshot(sh.repo, $);
        // An MCP call not yet ended in this window may still write into it.
        if (sh.overlapped || sh.maybe.size > 0) {
            $.ui.status(`agent-undo: two ${tool === 'MCP' ? 'tool calls' : 'shell commands'} ran at once; neither recorded · /agent-undo`);
            return done;
        }
        if (after === sh.before)
            return done;
        const all = (0, exports.filesOf)(await git($, ['diff-tree', '-r', '-z', '--no-renames', sh.before, after], sh.repo.top));
        const files = await commandsOwn($, sh, all);
        if (files.length === 0)
            return done;
        await (0, common_1.record)($, {
            at: new Date().toISOString(), tool, file: label,
            agent, hunks: [], top: sh.repo.top, root: sh.repo.root, prefix: sh.repo.prefix, tree: sh.before, files,
        });
    }
    catch {
        // A failure of this mod never changes the call.
    }
    finally {
        end(sh);
        (0, common_1.endRecord)();
    }
    return done;
}
/** A new conversation (the process going on after /clear or a resume) starts with no shell state. */
const resetShells = () => {
    stopped = undefined;
    failed = undefined;
    for (const sh of shells)
        end(sh);
    pending.clear();
    asked.clear();
    running.clear();
};
/** The list's line when shell commands are not being recorded, if they are not. */
const shellNote = () => (stopped ? `Shell commands are no longer recorded in this session: ${stopped}.`
    : failed !== undefined ? `The last command was not recorded: git said ${failed}.` : undefined);
exports.shellNote = shellNote;
let ends = 0;
/** How many conversations have ended in this process: an open question compares it across its wait. */
const sessionEnds = () => ends;
exports.sessionEnds = sessionEnds;
/** The Bash hooks: the first snapshot at the engine's decision, the second after the command. */
const registerShell = (on) => {
    on('session.end', async ($, e, next) => {
        ends += 1;
        for (const f of common_1.ended)
            f();
        resetShells();
        // A /clear or /resume swaps the conversation in this process with no session.start: the next one's
        // list (an id seen before, too) is read from the store again, never taken for already loaded.
        // An exit (or logout) keeps it: the last edit's copy may still be on its way to the store.
        if (e.reason === 'clear' || e.reason === 'resume') {
            try {
                await (0, common_1.mirrorEnding)($, e.sessionId);
            }
            catch { }
            (0, common_1.forgetRestore)();
        }
        // The last edit's copy (and the ending list's, and every write passed by, as a /resume back waits for them)
        // lands before the end step, within the chain's short bound (tests/review-pr5.test.tsx).
        try {
            await (0, common_1.saved)($, Math.min(1000, next.budget.remainingMs - 250), next.signal, true, true);
        }
        catch { }
        if (e.reason !== 'clear' && e.reason !== 'resume' && lastIndex) {
            const gone = lastIndex;
            lastIndex = undefined;
            await $.process.run(['rm', '-f', gone]).catch(() => undefined);
        }
        // The status line names this conversation's newest change; after a /clear it is not the next one's.
        try {
            $.ui.status(undefined);
        }
        catch { }
        return next(e);
    });
    on('tool.check', { tool: 'Bash' }, async ($, e, next) => checked($, e.tool_use_id, await next(e)));
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => around($, e.tool_use_id, e.agentId, 'Bash', commandLabel(e.command), () => next(e)));
    // A Monitor's command goes on after the tool answers. Any answer but an error counts, so a renamed field in its
    // result cannot turn this off; a `ws` watch runs no command here. The declared fields are in tests/background.test.tsx.
    on('tool.call', { tool: 'Monitor' }, async ($, e, next) => (e.ws !== undefined && e.command === undefined ? next(e)
        : around($, e.tool_use_id, e.agentId, 'Bash', 'Monitor', () => next(e), done => !done.isError)));
    // MCP tools write files Claude Code's checkpoints do not track: each call is recorded as a Bash
    // command is, sharing its windows (a call beside a command or another call is not recorded, unless the other is an MCP call that ended
    // read-only, the engine's isReadOnly).
    // Every other tool passes straight on, untouched.
    on('tool.check', async ($, e, next) => ((0, exports.isMcp)(e.tool) ? checked($, e.tool_use_id, await next(e)) : next(e)));
    on('tool.call', async ($, e, next) => (0, exports.isMcp)(e.tool) ? around($, e.tool_use_id, e.agentId, 'MCP', (0, exports.mcpLabel)(e.tool), () => next(e)) : next(e));
};
exports.registerShell = registerShell;
