// Review probes: node --test tests/review-dex-current.test.mjs. No packages or network needed.
// Harness adapted from release-audit4; product sources remain unchanged.
// Compile the unchanged hooks into a disposable directory. Only atom/read/update
// and engine dispatch/state/store are doubles; files, links, chmod and Git are real.
// This does not claim to run a Claude session or reproduce engine cancellation.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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

const gate = () => { let open; const p = new Promise(r => { open = r }); return { p, open } }
const shared = () => require(join(compiled, 'hooks/shared.js'))

for (const tool of ['Edit', 'Write']) for (const cancelSecond of [false, true]) test(`queue: ${cancelSecond ? 'cancelled second undo' : 'one undo comparison'} retains the live undo before ${tool}`, async t => {
  const w = await world(t, { 'a.txt': 'one\nkeep\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const entered = gate(), release = gate()
  w.beforeProcess = async a => {
    if (a[0] === 'mv') { entered.open(); await release.p }
  }
  const first = w.undo('1'); await entered.p
  if (cancelSecond) {
    const ctrl = new AbortController(); w.signal = ctrl.signal
    const second = w.undo('1'); ctrl.abort()
    assert.match(await second, /interrupted/)
    w.signal = undefined
  }
  const write = tool === 'Edit' ? w.edit('a.txt', 'keep', 'LATER')
    : w.call('Write', { file_path: join(w.root, 'a.txt'), content: 'LATER\n' })
  const wroteEarly = await Promise.race([write.then(() => true), sleep(30).then(() => false)])
  release.open(); await first; await write
  const final = await w.read('a.txt')
  t.diagnostic(JSON.stringify({ wroteEarly, final }))
  assert.deepEqual({ wroteEarly, final }, { wroteEarly: false, final: tool === 'Edit' ? 'one\nLATER\n' : 'LATER\n' })
})

for (const stop of ['none', 'interrupt', 'end', 'budget']) test(`final read: ${stop} before rename`, async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const ctrl = new AbortController(); w.signal = ctrl.signal
  let reads = 0
  w.afterRead = async path => {
    if (path !== join(w.root, 'a.txt') || ++reads !== 2) return
    // This is putBack's last moved() read, before any rename is started.
    if (stop === 'interrupt') ctrl.abort()
    if (stop === 'end') for (const f of shared().ended) f()
    if (stop === 'budget') await sleep(40)
  }
  if (stop === 'budget') w.budgetMs = 1520
  const out = await w.undo('1')
  const final = await w.read('a.txt')
  t.diagnostic(JSON.stringify({ final, out }))
  if (stop === 'none') { assert.match(out, /undid/); assert.equal(final, 'one\n') }
  else {
    assert.equal(final, 'ONE\n', 'a stopped turn must not start a rename')
    assert.doesNotMatch(out, /undid/)
  }
})

for (const tool of ['Edit', 'Bash']) for (const swapDuringUpdate of [false, true]) test(`list ownership: ${tool}, ${swapDuringUpdate ? 'resume during list update' : 'unchanged comparison'}`, async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  let sid = 'B', armed = false
  const entered = gate(), release = gate()
  w.engine.session.id = async () => {
    if (armed) { armed = false; entered.open(); await release.p }
    return sid
  }
  const swap = to => w.dispatch('session.end', { reason: 'resume', sessionId: sid }, async () => {
    sid = to; w.engine._atoms.clear(); return {}
  })
  if (tool === 'Edit') await w.edit('b.txt', 'two', 'TWO')
  else await w.bash("printf 'TWO\\n' > b.txt")
  await swap('A')
  if (tool === 'Edit') await w.edit('a.txt', 'one', 'ONE')
  else await w.bash("printf 'ONE\\n' > a.txt")
  const run = w.engine.process.run
  w.engine.process.run = async (a, i) => {
    const out = await run(a, i)
    if (swapDuringUpdate && (tool === 'Edit' ? a[0] === 'mv' : a[1] === 'restore')) armed = true
    return out
  }
  const undo = w.undo('1')
  if (swapDuringUpdate) {
    await entered.p
    await swap('B')
    assert.match(await w.undo('list'), /b.txt/)
    release.open()
  }
  await undo
  const list = await w.undo('list')
  if (swapDuringUpdate) {
    assert.match(list, /b.txt/)
    assert.doesNotMatch(list, /\(undone\)/, 'A must not mark B undone')
  } else assert.match(list, /a.txt.*\(undone\)|ONE  \(undone\)/)
})

for (const file of ['a.txt', 'b.txt']) test(`Edit after cancelled undo: ${file === 'a.txt' ? 'same file stays queued' : 'another file proceeds'}`, async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'one\n' })
  const entered = gate(), release = gate()
  const first = w.dispatch('tool.call', { tool: 'Edit', file_path: join(w.root, 'a.txt') }, async () => {
    entered.open(); await release.p; return { deny: 'no' }
  })
  await entered.p
  const ctrl = new AbortController(); w.signal = ctrl.signal
  const undo = w.undo('1'); ctrl.abort(); await undo; w.signal = undefined
  const second = w.edit(file, 'one', 'ONE')
  const ranEarly = await Promise.race([second.then(() => true), sleep(30).then(() => false)])
  release.open(); await first; await second
  assert.equal(ranEarly, file !== 'a.txt')
  assert.equal(await w.read(file), 'ONE\n')
})

for (const stop of ['none', 'interrupt', 'end']) test(`shell final hash: ${stop} before restore`, async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  const ctrl = new AbortController(); w.signal = ctrl.signal
  w.afterHash = async () => {
    if (stop === 'interrupt') ctrl.abort()
    if (stop === 'end') for (const f of shared().ended) f()
  }
  const out = await w.undo('1')
  assert.equal(await w.read('a.txt'), stop === 'none' ? 'one\n' : 'ONE\n')
  assert.match(out, stop === 'none' ? /undid/ : /nothing changed/)
})

for (const birthGap of [false, true]) test(`temporary attribution: ${birthGap ? 'mktemp result held' : 'cp held comparison'}`, { todo: birthGap ? 'known limit, the instant between mktemp and its mark' : false }, async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const commandStarted = gate(), commandFinish = gate()
  const command = w.dispatch('tool.call', { tool: 'Bash', tool_use_id: 'temp-window', command: 'change b only' }, async e => {
    await w.dispatch('tool.check', { tool: 'Bash', tool_use_id: e.tool_use_id, input: { command: e.command } }, async () => ({ decision: 'allow' }))
    commandStarted.open(); await commandFinish.p
    await w.write('b.txt', 'TWO\n'); return { result: { exitCode: 0 } }
  })
  await commandStarted.p
  const created = gate(), release = gate()
  const run = w.engine.process.run
  w.engine.process.run = async (a, i) => {
    if (!birthGap && a[0] === 'cp' && a[1] === '-p') { created.open(); await release.p }
    const out = await run(a, i)
    if (birthGap && a[0] === 'mktemp') { created.open(); await release.p }
    return out
  }
  const undo = w.undo('1'); await created.p
  commandFinish.open(); await command
  release.open(); await undo
  const list = await w.undo('list')
  assert.doesNotMatch(list, /\.agent-undo-/, 'a command must not claim the undo temporary file')
})


