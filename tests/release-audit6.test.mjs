// Review probes: node --test tests/release-audit6.test.mjs. No packages or network needed.
// Harness adapted from release-audit5; product sources remain unchanged.
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
  let next = f(await exports.read($, a));
  if ($._retryUpdate && a.address.key === 'changes') {
    const retry = $._retryUpdate;
    $._retryUpdate = undefined;
    await retry();
    // The declarations specify optimistic update retries on an ifVersion miss.
    next = f(await exports.read($, a));
  }
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

for (const fails of [false, true]) test(`two abandoned undo links retain a live undo that ${fails ? 'fails' : 'finishes'}`, async t => {
  const w = await world(t, { 'a.txt': 'one\nkeep\n', 'b.txt': 'two\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const entered = gate(), release = gate()
  const run = w.engine.process.run
  w.engine.process.run = async (a, i) => {
    if (a[0] === 'mv') {
      entered.open(); await release.p
      if (fails) return { exitCode: 1, stdout: '', stderr: 'mv refused' }
    }
    return run(a, i)
  }
  const first = w.undo('1'); await entered.p
  for (let i = 0; i < 2; i++) {
    const ctrl = new AbortController(); w.signal = ctrl.signal
    const abandoned = w.undo('1'); ctrl.abort()
    assert.match(await abandoned, /interrupted/)
  }
  w.signal = undefined
  const later = [w.edit('a.txt', 'keep', 'LATER'), w.edit('b.txt', 'two', 'TWO')]
  const ranEarly = await Promise.race([...later.map(p => p.then(() => true)), sleep(30).then(() => false)])
  release.open(); await first; await Promise.all(later)
  assert.equal(ranEarly, false, 'both files must wait for the live global undo')
  assert.equal(await w.read('a.txt'), `${fails ? 'ONE' : 'one'}\nLATER\n`)
  assert.equal(await w.read('b.txt'), 'TWO\n')
})

for (const entry of ['command', 'tool']) for (const interrupt of [false, true]) test(`last-read cancellation and retry: ${entry}, ${interrupt ? 'interrupt' : 'normal comparison'}`, async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const ctrl = new AbortController(); w.signal = ctrl.signal
  let reads = 0
  w.afterRead = async path => {
    if (path === join(w.root, 'a.txt') && ++reads === 2 && interrupt) ctrl.abort()
  }
  const undo = async () => entry === 'command' ? w.undo('1') : (await w.toolUndo('1')).result
  const out = await undo()
  assert.equal(await w.read('a.txt'), interrupt ? 'ONE\n' : 'one\n')
  assert.equal(w.commands.filter(c => c.argv[0] === 'mv').length, interrupt ? 0 : 1)
  assert.match(out, interrupt ? /interrupted/ : /undid/)
  assert.deepEqual((await fs.readdir(w.root)).filter(n => n.startsWith('.agent-undo-')), [])
  w.signal = undefined
  const again = await undo()
  assert.match(again, interrupt ? /undid/ : /already undone/)
  assert.equal(await w.read('a.txt'), 'one\n')
  assert.equal(w.commands.filter(c => c.argv[0] === 'mv').length, 1, 'a retry writes once in total')
})

for (const tool of ['Edit', 'Bash']) for (const ends of [false, true]) test(`list callback retried: ${tool}, ${ends ? 'conversation ends on retry' : 'same conversation comparison'}`, async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  const change = tool === 'Edit' ? () => w.edit('a.txt', 'one', 'ONE') : () => w.bash("printf 'ONE\\n' > a.txt")
  await change()
  const original = structuredClone(w.engine._atoms.get('changes'))
  // Collide on both number and millisecond timestamp, so only the turn flag protects the next list.
  // No stored list is restored here; this isolates the callback's optimistic retry.
  const next = structuredClone(original)
  next[0].file = tool === 'Edit' ? join(w.root, 'b.txt') : 'new command'
  const run = w.engine.process.run
  let retries = 0
  w.engine.process.run = async (a, i) => {
    const out = await run(a, i)
    if (tool === 'Edit' ? a[0] === 'mv' : a[1] === 'restore') {
      w.engine._retryUpdate = async () => {
        retries++
        if (ends) {
          for (const f of shared().ended) f()
          w.engine._atoms.set('changes', structuredClone(next))
        }
      }
    }
    return out
  }
  await w.undo('1')
  assert.equal(retries, 1)
  const all = w.engine._atoms.get('changes')
  if (ends) assert.deepEqual(all, next, 'a retry must preserve the new conversation entry byte for byte')
  else assert.equal(tool === 'Edit' ? all[0].hunks[0].undone : all[0].files[0].undone, true)
})

for (const stop of ['none', 'interrupt', 'budget']) test(`many-file retry completes remaining files: ${stop}`, async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  await w.bash("printf 'ONE\\n' > a.txt; printf 'TWO\\n' > b.txt")
  const ctrl = new AbortController(); w.signal = ctrl.signal
  const expired = gate(), clockSleep = w.engine.clock.sleep
  // Fire this bound at a known point; a 20 ms timer can expire before the first restore on a busy disk.
  if (stop === 'budget') w.engine.clock.sleep = (ms, options) => ms === 8500 ? expired.p : clockSleep(ms, options)
  const run = w.engine.process.run
  w.engine.process.run = async (a, i) => {
    const out = await run(a, i)
    if (a[1] === 'restore' && a.at(-1) === ':(literal)a.txt') {
      if (stop === 'interrupt') ctrl.abort()
      if (stop === 'budget') expired.open()
    }
    return out
  }
  const first = await w.undo('1')
  assert.equal(await w.read('a.txt'), 'one\n')
  assert.equal(await w.read('b.txt'), stop === 'none' ? 'two\n' : 'TWO\n')
  if (stop !== 'none') assert.match(first, /1\.2 left as is: this undo (was interrupted|ran out of time)/)
  w.signal = undefined; w.engine.clock.sleep = clockSleep
  const second = await w.undo('1')
  assert.match(second, stop === 'none' ? /nothing changed/ : /undid 1\.2/)
  assert.equal(await w.read('b.txt'), 'two\n')
  assert.equal(w.commands.filter(c => c.argv[1] === 'restore').length, 2, 'each file is restored once across retries')
  assert.equal(w.engine._atoms.get('changes')[0].files.every(f => f.undone), true)
})
