// Run with node --test tests/release-audit2.test.mjs. No packages or network needed.
// Compile the unchanged hooks into a disposable directory. Only atom/read/update
// and engine dispatch/state/store are doubles; files, links, chmod and Git are real.
// This does not claim to run a Claude session or reproduce engine cancellation.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await fs.mkdtemp(join(tmpdir(), 'agent-undo-release-audit-'))
after(() => fs.rm(scratch, { recursive: true, force: true }))
const compiled = join(scratch, 'compiled')
const types = process.env.CC_TYPES ?? join(source, '.claude-plugin/types/claude-code/index.d.ts')
execFileSync(process.env.TSC ?? 'tsc', [
  '--target', 'es2023', '--module', 'node16', '--moduleResolution', 'node16',
  '--jsx', 'react', '--jsxFactory', 'h', '--skipLibCheck', '--strict',
  '--rootDir', source, '--outDir', compiled, types,
  ...['register', 'common', 'shared', 'hunks', 'shell', 'shell-undo'].map(n => join(source, `hooks/${n}.tsx`)),
  join(source, 'types/index.d.ts'), join(source, 'tests/engine.tsx'),
], { cwd: scratch, stdio: 'pipe' })
await fs.mkdir(join(compiled, 'node_modules/claude-code'), { recursive: true })
await fs.writeFile(join(compiled, 'node_modules/claude-code/index.js'), `
exports.atom = (address, initial) => ({ address, initial });
exports.read = async ($, a) => structuredClone($._atoms.get(a.address.key) ?? a.initial);
exports.update = async ($, a, f) => {
  const next = f(await exports.read($, a));
  $._atoms.set(a.address.key, structuredClone(next));
};
`)
const require = createRequire(join(compiled, 'entry.cjs'))
let session = 0

async function world(t, initial = {}, options = {}) {
  // Module queues and shell windows are process-local in the real tool too.
  for (const key of Object.keys(require.cache)) if (key.startsWith(compiled)) delete require.cache[key]
  const { register } = require(join(compiled, 'hooks/register.js'))
  const { editResult, writeResult } = require(join(compiled, 'tests/engine.js'))
  const root = options.root ?? await fs.mkdtemp(join(scratch, 'repo-'))
  for (const [name, text] of Object.entries(initial)) {
    await fs.mkdir(dirname(join(root, name)), { recursive: true })
    await fs.writeFile(join(root, name), text)
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  if (!options.root) {
    git('init', '-q')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'test')
    git('config', 'core.autocrlf', 'false')
    git('add', '-A')
    git('commit', '-qm', 'initial', '--allow-empty')
  }
  const handlers = []
  register((event, filter, handler) => {
    if (typeof filter === 'function') [filter, handler] = [undefined, filter]
    handlers.push({ event, filter, handler })
  })
  const disk = new Map()
  const sid = `audit-${process.pid}-${++session}`
  const w = { root, git, disk, commands: [], results: [], permission: 'allow', beforeWrite: undefined, afterRead: undefined, afterHash: undefined, afterStoreGet: undefined }
  const $ = {
    _atoms: new Map(),
    session: { root: async () => root, id: async () => sid },
    store: {
      get: async key => {
        const value = structuredClone(disk.get(key))
        await w.afterStoreGet?.(key)
        return value
      },
      set: async (key, value) => { disk.set(key, structuredClone(value)) },
      delete: async key => { disk.delete(key) }, keys: async () => [...disk.keys()],
    },
    command: { register: async () => ({ command: 'agent-undo' }) },
    tool: { register: async () => ({ tool: 'mcp__agent-undo__undo' }), check: async e => { w.checks.push(e); if (w.permission instanceof Error) throw w.permission; return { decision: w.permission } } },
    ui: { status: () => {} },
    clock: { sleep: (ms, options) => sleep(ms, undefined, { signal: options?.signal }) },
    fs: {
      exists: async path => { try { await fs.stat(path); return true } catch { return false } },
      stat: async (path, options) => {
        const own = await fs.lstat(path)
        const s = await fs.stat(path).catch(() => undefined)
        return { kind: s?.isFile() ? 'file' : s?.isDirectory() ? 'dir' : 'other',
          isLink: own.isSymbolicLink(), size: s?.size ?? 0, mtimeMs: s?.mtimeMs ?? 0,
          ...(options?.resolve && s ? { realPath: await fs.realpath(path) } : {}) }
      },
      read: async (path, options) => {
        const b = await fs.readFile(path)
        if (b.length > 4 * 1024 * 1024) throw new Error('read over 4 MiB')
        if (options?.as === 'bytes') return { base64: b.toString('base64') }
        await w.afterRead?.(path)
        return b.toString('utf8')
      },
      write: async (path, text) => {
        if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('write over 4 MiB')
        await w.beforeWrite?.(path, text)
        await fs.mkdir(dirname(path), { recursive: true })
        await fs.writeFile(path, text)
      },
    },
    process: { run: async (argv, init) => {
      w.commands.push({ argv, init })
      await w.beforeProcess?.(argv, init)
      let r
      try {
        r = { exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), {
          cwd: init?.cwd ?? root, env: { ...process.env, ...init?.env },
          encoding: 'utf8', timeout: init?.timeoutMs ?? 30000, stdio: ['pipe', 'pipe', 'pipe'],
        }), stderr: '' }
      } catch (e) {
        // As $.process.run: it rejects when a command cannot start or is still running at the timeout (a spawn error or
        // ETIMEDOUT here), and a child ended by a signal reads as exit code 1.
        if (typeof e.code === 'string') throw e
        r = { exitCode: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message) }
      }
      w.results.push({ argv: [...argv], ...r })
      if (argv[1] === 'hash-object') await w.afterHash?.()
      return r
    } },
  }
  async function dispatch(event, e, leaf) {
    const matches = handlers.filter(h => h.event === event && (!h.filter || Object.entries(h.filter).every(([k, v]) => e[k] === v)))
    const run = i => {
      if (i === matches.length) return leaf(e)
      const next = Object.assign(input => dispatchFrom(i + 1, input), {
        budget: { remainingMs: w.budgetMs ?? 10000 }, signal: w.signal ?? new AbortController().signal,
      })
      return matches[i].handler($, e, next)
    }
    const dispatchFrom = (i, input) => {
      assert.equal(input, e, 'hooks preserve the call object')
      return run(i)
    }
    return run(0)
  }
  w.checks = []
  w.handlers = handlers
  w.plainRun = $.process.run
  w.engine = $
  w.tag = require(join(compiled, 'hooks/shell.js')).INDEX_TAG
  w.dispatch = dispatch
  w.end = () => dispatch('session.end', { reason: 'exit', sessionId: sid }, async () => ({}))
  w.toolUndo = ref => dispatch('tool.call', { tool: 'mcp__agent-undo__undo', ref }, async () => { throw new Error('undo leaked to engine') })
  w.call = async (tool, args) => {
    const e = { tool, tool_use_id: `tool-${++session}`, ...args }
    return dispatch('tool.call', e, async () => {
      await dispatch('tool.check', { tool, tool_use_id: e.tool_use_id, input: args }, async () => ({ decision: 'allow' }))
      if (tool === 'Bash') {
        const result = await $.process.run(['bash', '-c', args.command], { cwd: root })
        return { result, ...(result.exitCode ? { isError: true } : {}) }
      }
      const path = args.file_path
      const was = await fs.readFile(path, 'utf8').catch(() => undefined)
      if (tool === 'Edit') {
        const out = editResult(was, args)
        await fs.writeFile(path, out.disk)
        return { result: out.result }
      }
      const result = writeResult(was, args)
      await fs.writeFile(path, args.content)
      return { result }
    })
  }
  w.undo = async ref => {
    const out = await dispatch('command.run', { command: 'agent-undo', args: ref }, async () => { throw new Error('unhandled command') })
    t.diagnostic(out.text)
    return out.text
  }
  w.read = name => fs.readFile(join(root, name), 'utf8')
  w.write = (name, text) => fs.writeFile(join(root, name), text)
  w.edit = (name, a, b) => w.call('Edit', { file_path: join(root, name), old_string: a, new_string: b })
  w.bash = command => w.call('Bash', { command })
  await dispatch('session.start', { cwd: root, surface: 'terminal', isInteractive: true }, async e => ({ cwd: e.cwd }))
  return w
}

// Each child loads its own module state and drives the same hooks on one checkout.
// IPC barriers hold a real command between its before and after snapshots.
if (process.argv[2] === '--worker') {
  const w = await world({ diagnostic() {} }, {}, { root: process.argv[3] })
  process.on('message', async message => {
    try {
      let value
      if (message.op === 'repo') {
        const { repoOf } = require(join(compiled, 'hooks/shell.js'))
        value = (await repoOf({ ...w.engine }))?.index
      } else if (message.op === 'bash') value = await w.bash(message.command)
      else if (message.op === 'edit') value = await w.edit('a.txt', 'one', 'ONE')
      else if (message.op === 'kill-before-rename') {
        w.beforeProcess = async argv => {
          if (argv[0] !== 'mv') return
          process.kill(process.pid, 'SIGKILL')
          await new Promise(() => {})
        }
        value = await w.undo('1')
      }
      else if (message.op === 'undo') value = await w.undo(message.ref)
      else if (message.op === 'list') value = await w.undo('list')
      else if (message.op === 'end') value = await w.end()
      process.send({ id: message.id, value, commands: w.commands })
    } catch (e) { process.send({ id: message.id, error: String(e) }) }
  })
  process.send({ ready: true, scratch })
} else {
}
if (process.argv[2] !== '--worker') {
const mode = async (w, n) => (await fs.stat(join(w.root, n))).mode & 0o7777
const wrapRun = (w, f) => { const run = w.engine.process.run; w.engine.process.run = (argv, init) => f(argv, init, run) }
const tick = (ms = 40) => sleep(ms)
const gate = () => { let open; const p = new Promise(r => { open = r }); return { p, open } }
const conversations = w => {
  const c = { id: 'B' }
  w.engine.session.id = async () => c.id
  c.swap = (to, reason) => w.dispatch('session.end', { reason, sessionId: c.id }, async () => { c.id = to; w.engine._atoms.clear(); return {} })
  return c
}
const heldEdit = (w, file) => {
  const g = gate()
  const done = w.dispatch('tool.call', { tool: 'Edit', tool_use_id: `held-${Math.random()}`, file_path: join(w.root, file) },
    async () => { await g.p; return { deny: 'the person said no' } })
  return { open: g.open, done }
}


// ---- P0: a refused sleep opens the index queue (common.tsx updateList keeps it shut; tests/review-cr2 and review-crz go red on it).
for (const refused of [true, false]) {
  test(`${refused ? 'P0' : 'P0 comparison'}: with the clock ${refused ? 'refusing' : 'answering'}, a restore stays behind a running snapshot`, async t => {
    const w = await world(t, { 'a.txt': 'one\n' })
    await w.bash("printf 'ONE\\n' > a.txt")
    const hold = gate(), at = gate()
    if (refused) w.engine.clock.sleep = (ms, o) => ms === 180000 ? Promise.reject(new Error('refused')) : sleep(ms, undefined, { signal: o?.signal })
    let restored = 0, adding = false
    wrapRun(w, async (argv, init, run) => {
      if (argv[1] === 'add') { adding = true; at.open(); await hold.p; adding = false }
      if (argv[1] === 'restore' && adding) restored++
      return run(argv, init)
    })
    const bash = w.bash('echo x >> c.txt'); await at.p
    const out = w.undo('1'); await tick(300)
    const beside = restored
    hold.open(); await bash; await out
    assert.equal(beside, 0, 'restores that ran beside the snapshot')
  })
}

// ---- P1: an undo that began goes on past the end of its conversation: its list update lands on the next one's number.
for (const late of [true, false]) {
  test(`${late ? 'P1 shell' : 'P1 shell comparison'}: a conversation ending ${late ? 'during' : 'after'} the restore leaves the next list's #1 its own`, async t => {
    const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
    const c = conversations(w)
    await w.bash("printf 'TWO\\n' > b.txt")           // B's #1
    await c.swap('A', 'clear')
    await w.bash("printf 'ONE\\n' > a.txt")           // A's #1
    const hold = gate(), at = gate()
    if (late) wrapRun(w, async (argv, init, run) => { if (argv[1] === 'restore') { at.open(); await hold.p } return run(argv, init) })
    const undo = w.undo('1')
    if (late) await at.p; else await undo
    await c.swap('B', 'resume')
    hold.open(); await undo; await tick()
    const list = await w.undo('list')
    assert.match(list, /1\.1 changed b\.txt/, `B's list: ${list}`)
    assert.doesNotMatch(list, /\(undone\)/, `B's list: ${list}`)
  })
  test(`${late ? 'P1 edit' : 'P1 edit comparison'}: a conversation ending ${late ? 'during' : 'after'} the write leaves the next list's #1 its own`, async t => {
    const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
    const c = conversations(w)
    await w.edit('b.txt', 'two', 'TWO')
    await c.swap('A', 'clear')
    await w.edit('a.txt', 'one', 'ONE')
    const hold = gate(), at = gate()
    if (late) wrapRun(w, async (argv, init, run) => { if (argv[0] === 'mv') { at.open(); await hold.p } return run(argv, init) })
    const undo = w.undo('1')
    if (late) await at.p; else await undo
    await c.swap('B', 'resume')
    hold.open(); await undo; await tick()
    const again = await w.undo('1')
    assert.equal(await w.read('b.txt'), 'two\n', `B's own undo: ${again}`)
  })
}

// ---- P2: the Edit path never looks at its turn once the queue let it in.
test('P2: an Edit undo interrupted before it writes does not write', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const hold = gate(), at = gate()
  wrapRun(w, async (argv, init, run) => { if (argv[0] === 'mktemp') { at.open(); await hold.p } return run(argv, init) })
  const ctrl = new AbortController(); w.signal = ctrl.signal
  const undo = w.undo('1'); await at.p
  w.signal = undefined; ctrl.abort(); await tick()
  hold.open(); const out = await undo
  assert.equal(await w.read('a.txt'), 'ONE\n', `after interrupt: ${out}`)
})
test('P2 comparison: a shell undo interrupted before it writes does not write', async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  await w.bash("printf 'ONE\\n' > a.txt; printf 'TWO\\n' > b.txt")
  const hold = gate(), at = gate()
  let first = true
  wrapRun(w, async (argv, init, run) => { if (argv[1] === 'restore' && first) { first = false; at.open(); await hold.p } return run(argv, init) })
  const ctrl = new AbortController(); w.signal = ctrl.signal
  const undo = w.undo('1'); await at.p
  w.signal = undefined; ctrl.abort(); await tick()
  hold.open(); const out = await undo
  assert.equal(await w.read('b.txt'), 'TWO\n', `after interrupt: ${out}`)
})

// ---- P3: an undo that gave up its turn still holds every file's queue.
for (const undoAsked of [true, false]) {
  test(`${undoAsked ? 'P3' : 'P3 comparison'}: ${undoAsked ? 'an undo that gave up' : 'no undo'}, an Edit of another file goes on past a question on the first`, async t => {
    const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
    await w.edit('a.txt', 'one', 'ONE')
    const held = heldEdit(w, 'a.txt'); await tick()
    if (undoAsked) {
      w.budgetMs = 1700
      assert.match(await w.undo('1'), /still waiting/)
    }
    const other = w.edit('b.txt', 'two', 'TWO')
    const first = await Promise.race([other.then(() => 'edited'), tick(500).then(() => 'still held')])
    held.open(); await held.done; await other
    assert.equal(first, 'edited')
  })
}

// ---- P4: the budget's note names a snapshot where none runs.
test('P4: a many-file undo cut by its own time does not blame a snapshot', async t => {
  const w = await world(t, { 'a.txt': '1\n', 'b.txt': '2\n', 'c.txt': '3\n' })
  await w.bash("echo x >> a.txt; echo x >> b.txt; echo x >> c.txt")
  wrapRun(w, async (argv, init, run) => { if (argv[1] === 'restore') await tick(350); return run(argv, init) })
  w.budgetMs = 1700
  const out = await w.undo('1')
  assert.match(out, /undid 1\.1/)
  assert.doesNotMatch(out, /snapshot ahead/, out)
})
test('P4 comparison: the same undo with time left does all three', async t => {
  const w = await world(t, { 'a.txt': '1\n', 'b.txt': '2\n', 'c.txt': '3\n' })
  await w.bash("echo x >> a.txt; echo x >> b.txt; echo x >> c.txt")
  assert.match(await w.undo('1'), /undid 1\.1, 1\.2, 1\.3/)
})

// ---- P6: a command that starts while an Edit undo holds its temporary copy.
for (const opensFirst of [false, true]) {
  test(`${opensFirst ? 'P6 comparison' : 'P6'}: a command ${opensFirst ? 'open before' : 'starting during'} an undo does not list the temporary copy`, async t => {
    const w = await world(t, { 'a.txt': 'one\n', 'c.txt': 'c\n' })
    await w.edit('a.txt', 'one', 'ONE')
    const copying = gate(), go = gate()
    let undo
    wrapRun(w, async (argv, init, run) => {
      if (argv[0] === 'cp' && argv[1] === '-p') { copying.open(); await go.p }
      if (argv[0] === 'bash') {
        if (opensFirst) { undo = w.undo('1'); await copying.p }
        go.open(); await undo; await tick()
      }
      return run(argv, init)
    })
    if (!opensFirst) { undo = w.undo('1'); await copying.p }
    await w.bash('echo x >> c.txt')
    const list = await w.undo('list')
    assert.doesNotMatch(list, /\.agent-undo-/, list)
  })
}
}
