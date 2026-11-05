// Review probes: node --test tests/review-dex-030.test.mjs. No packages or network needed.
// Harness adapted from release-audit2; product sources remain unchanged.
// DEX_SOURCE selects a reconstructed base for the two inherited-fault comparisons.
// Compile the unchanged hooks into a disposable directory. Only atom/read/update
// and engine dispatch/state/store are doubles; files, links, chmod and Git are real.
// This does not claim to run a Claude session or reproduce engine cancellation.
import { after, test } from 'node:test'
import { getEventListeners } from 'node:events'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const source = process.env.DEX_SOURCE ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await fs.mkdtemp(join(tmpdir(), 'agent-undo-release-audit-'))
after(() => fs.rm(scratch, { recursive: true, force: true }))
const compiled = join(scratch, 'compiled')
const types = process.env.CC_TYPES ?? join(source, '.claude-plugin/types/claude-code/index.d.ts')
execFileSync(process.env.TSC ?? 'tsc', [
  '--target', 'es2023', '--module', 'node16', '--moduleResolution', 'node16',
  '--jsx', 'react', '--jsxFactory', 'h', '--skipLibCheck', '--strict',
  '--rootDir', source, '--outDir', compiled, types,
  ...['register', 'common', 'shared', 'hunks', 'shell', ...(process.env.DEX_SOURCE ? [] : ['shell-undo'])].map(n => join(source, `hooks/${n}.tsx`)),
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
      const started = Date.now()
      // As the engine has it: each read of `next.budget` is a new frozen snapshot.
      const next = Object.defineProperty(Object.assign(input => dispatchFrom(i + 1, input), { signal: w.signal ?? new AbortController().signal }), 'budget', { get: () => Object.freeze({ remainingMs: (w.budgetMs ?? 10000) - (Date.now() - started) }) })
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
const wrapRun = (w, f) => { const run = w.engine.process.run; w.engine.process.run = (a, i) => f(a, i, run) }
const shared = () => require(join(compiled, 'hooks/shared.js'))

for (const rejects of [false, true]) test(`inTurn job ${rejects ? 'rejects' : 'resolves'} and queue remains usable`, async t => {
  await world(t)
  const { inTurn, newTurn, serial } = shared()
  const turn = newTurn()
  const work = inTurn(turn, job => serial(undefined, job), async () => {
    if (rejects) throw new Error('job rejected')
    return 'done'
  }, why => why)
  if (rejects) await assert.rejects(work, /job rejected/)
  else assert.equal(await work, 'done')
  assert.equal(await serial(undefined, async () => 'next'), 'next')
})

for (const ends of ['before', 'during', 'never']) test(`inTurn turn ends ${ends} job begins`, async t => {
  await world(t)
  const { inTurn, newTurn, serial } = shared()
  const turn = newTurn(), release = gate()
  let ran = false
  const blocker = serial(undefined, () => release.p)
  const work = inTurn(turn, job => serial(undefined, job), async () => {
    ran = true
    if (ends === 'during') { turn.say('ended'); await Promise.resolve() }
    return 'done'
  }, why => why)
  if (ends === 'before') {
    turn.say('ended')
    assert.equal(await work, 'ended')
  }
  release.open(); await blocker
  assert.equal(await work, ends === 'before' ? 'ended' : 'done')
  assert.equal(ran, ends !== 'before')
})

for (const interrupt of [false, true]) test(`multi-file shell undo ${interrupt ? 'interrupted after first restore' : 'uninterrupted comparison'}`, async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  await w.bash("printf 'ONE\\n' > a.txt; printf 'TWO\\n' > b.txt")
  const ctrl = new AbortController(); w.signal = ctrl.signal
  wrapRun(w, async (a, i, run) => {
    const out = await run(a, i)
    if (interrupt && a[1] === 'restore' && a.at(-1) === ':(literal)a.txt') ctrl.abort()
    return out
  })
  const out = await w.undo('1')
  assert.match(out, /undid 1\.1/)
  assert.equal(await w.read('a.txt'), 'one\n')
  assert.equal(await w.read('b.txt'), interrupt ? 'TWO\n' : 'two\n')
  const list = await w.undo('list')
  assert.match(list, /1\.1 changed a.txt  \(undone\)/)
  if (interrupt) {
    assert.match(out, /1\.2 left as is: this undo was interrupted/)
    assert.doesNotMatch(list, /1\.2 changed b.txt  \(undone\)/)
  } else assert.match(list, /1\.2 changed b.txt  \(undone\)/)
  assert.equal(shared().ended.size, 0)
  assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
})

for (const stop of ['success', 'rejection', 'interrupt', 'end', 'budget', 'already-aborted']) test(`undo listeners cleaned on ${stop}`, async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const ctrl = new AbortController(); w.signal = ctrl.signal
  if (stop === 'already-aborted') ctrl.abort()
  let unblock, blocking
  if (['interrupt', 'end', 'budget'].includes(stop)) {
    const g = gate(); unblock = g.open
    blocking = shared().serial(undefined, () => g.p)
  }
  if (stop === 'rejection') w.engine.fs.exists = async () => { throw new Error('injected EIO') }
  if (stop === 'budget') w.budgetMs = 1520
  const work = w.undo('1')
  if (stop === 'interrupt' || stop === 'end') {
    await sleep(10)
    if (stop === 'interrupt') ctrl.abort()
    else for (const f of shared().ended) f()
  }
  await work
  assert.equal(shared().ended.size, 0)
  assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
  unblock?.(); await blocking
  await shared().serial(undefined, async () => {})
})

// Accelerate only HOLD_MS; the pending git restore remains alive across the bound.
for (const passBound of [false, true]) test(`Bash attribution ${passBound ? 'after HOLD_MS releases live restore' : 'inside HOLD_MS comparison'}`, async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  const realSleep = w.engine.clock.sleep
  w.engine.clock.sleep = (ms, o) => realSleep(ms === 180000 ? (passBound ? 30 : 5000) : ms, o)
  const restoring = gate(), finish = gate()
  wrapRun(w, async (a, i, run) => {
    if (a[1] === 'restore') { restoring.open(); await finish.p }
    return run(a, i)
  })
  const undo = w.undo('1'); await restoring.p
  if (passBound) await sleep(60)
  const running = gate(), done = gate()
  const command = w.dispatch('tool.call', { tool: 'Bash', tool_use_id: 'overlapping', command: 'change b only' }, async e => {
    await w.dispatch('tool.check', { tool: 'Bash', tool_use_id: e.tool_use_id, input: { command: e.command } }, async () => ({ decision: 'allow' }))
    running.open(); await done.p
    await w.write('b.txt', 'TWO\n')
    return { result: { exitCode: 0 } }
  })
  // The bound passes for a snapshot only: a restore keeps the queue, so the command waits behind it.
  if (passBound) await Promise.race([running.p, sleep(100)])
  finish.open(); await undo
  await running.p; done.open(); await command
  const list = await w.undo('list'); t.diagnostic(list)
  await w.undo('2')
  const finalA = await w.read('a.txt')
  t.diagnostic(`a.txt after undoing only command 2: ${JSON.stringify(finalA)}`)
  assert.deepEqual({ claimedA: /2\.1 changed a.txt/.test(list), finalA }, { claimedA: false, finalA: 'one\n' }, 'a shell must not claim or reverse an undo')
})

for (const end of [false, true]) test(`started job id check ${end ? 'turn ends while reading id' : 'uninterrupted comparison'}`, async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const entered = gate(), release = gate()
  const sid = await w.engine.session.id()
  let calls = 0
  w.engine.session.id = async () => {
    // command undo: initial captured id, then the id read inside the serial job.
    if (++calls === 2) { entered.open(); await release.p }
    return sid
  }
  const work = w.undo('1'); await entered.p
  if (end) for (const f of shared().ended) f()
  release.open()
  const out = await work
  t.diagnostic(out)
  // A job that began looks at its turn once more before its write.
  if (end) { assert.match(out, /has ended; nothing changed/); assert.equal(await w.read('a.txt'), 'ONE\n') }
  else { assert.match(out, /undid/); assert.equal(await w.read('a.txt'), 'one\n') }
})

for (const end of [false, true]) test(`multi-file shell undo ${end ? 'conversation switches during restore' : 'conversation unchanged comparison'}`, async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  let sid = 'B'
  w.engine.session.id = async () => sid
  await w.bash("printf 'TWO\\n' > b.txt")
  const swap = to => w.dispatch('session.end', { reason: 'resume', sessionId: sid }, async () => {
    sid = to; w.engine._atoms.clear(); return {}
  })
  await swap('A')
  await w.bash("printf 'ONE\\n' > a.txt")
  const entered = gate(), release = gate()
  wrapRun(w, async (a, i, run) => {
    if (a[1] === 'restore') { entered.open(); await release.p }
    return run(a, i)
  })
  const work = w.undo('1'); await entered.p
  if (end) {
    await swap('B')
    assert.match(await w.undo('list'), /1\.1 changed b.txt/)
  }
  release.open(); await work
  const list = await w.undo('list')
  t.diagnostic(list)
  if (end) assert.match(list, /1\.1 changed b.txt/, 'A must not replace B list with A files')
  else assert.match(list, /1\.1 changed a.txt  \(undone\)/)
})

for (const limited of [false, true]) test(`deleted-file shell undo ${limited ? 'git fails after partial recreation' : 'complete comparison'}`, async t => {
  const original = 'x'.repeat(300000)
  const w = await world(t, { 'a.txt': original })
  await w.bash('rm a.txt')
  if (limited) w.beforeProcess = a => {
    if (a[0] === 'git' && a[1] === 'restore') {
      const args = a.slice(1)
      a.splice(0, a.length, 'bash', '-c', 'ulimit -f 8; trap "" XFSZ; exec git "$@"', 'limited-restore', ...args)
    }
  }
  const out = await w.undo('1')
  if (limited) {
    assert.equal((await w.read('a.txt')).length, 8192)
    assert.match(out, /failed part way/, 'recreated partial file is a change')
    assert.doesNotMatch(out, /nothing changed|left as is/, out)
  } else { assert.match(out, /undid/); assert.equal(await w.read('a.txt'), original) }
})
