// Slow healthy tools. The engine's hook budget stands still while any `$` call of the hook's is in flight (claude-code index.d.ts
// 2.1.310: HookBudget "the clock stops while a next(e) call or any $ call of the hook's is in flight (a $.clock wait
// excepted)"; NextBudget.remainingMs "stands still while a next or $ call is in flight"). So an undo whose own tools are
// slow but healthy must not be refused as "ran out of time": the engine would have waited for it.
// Harness: tests/release-audit3.test.mjs's world, with a `$` whose calls take `w.callMs` each (a slow drive, the
// README's 1.1-1.4 s per git call on a Windows drive) and a budget read the engine's way (own time only).
// Run: node --test tests/release-audit7.test.mjs
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '..')
const scratch = await fs.mkdtemp(join(resolve(here, '..'), 'scratch-clock-'))
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
const HOOK_MS = 10000 // HookBudget.ms

async function world(t, initial = {}, options = {}) {
  for (const key of Object.keys(require.cache)) if (key.startsWith(compiled)) delete require.cache[key]
  const { register } = require(join(compiled, 'hooks/register.js'))
  const { editResult, writeResult } = require(join(compiled, 'tests/engine.js'))
  const root = await fs.mkdtemp(join(scratch, 'repo-'))
  for (const [name, text] of Object.entries(initial)) {
    await fs.mkdir(dirname(join(root, name)), { recursive: true })
    await fs.writeFile(join(root, name), text)
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test')
  git('config', 'core.autocrlf', 'false'); git('add', '-A'); git('commit', '-qm', 'initial', '--allow-empty')
  const handlers = []
  register((event, filter, handler) => {
    if (typeof filter === 'function') [filter, handler] = [undefined, filter]
    handlers.push({ event, filter, handler })
  })
  const disk = new Map()
  const sid = `review-${process.pid}-${++session}`
  const w = { root, git, commands: [], callMs: options.callMs ?? 0, busy: 0, busyMs: 0, calls: 0 }
  // The engine's clock for a hook: wall time minus the time its `$` calls were in flight (clock.sleep excepted).
  let hookStart = 0, busySince = 0
  const enter = () => { if (w.busy++ === 0) busySince = Date.now() }
  const leave = () => { if (--w.busy === 0) w.busyMs += Date.now() - busySince }
  const slow = f => async (...a) => {
    w.calls++
    enter()
    try { if (w.callMs) await sleep(w.callMs); return await f(...a) } finally { leave() }
  }
  const ownElapsed = () => Date.now() - hookStart - w.busyMs - (w.busy ? Date.now() - busySince : 0)
  const $ = {
    _atoms: new Map(),
    session: { root: slow(async () => root), id: slow(async () => sid) },
    store: {
      get: async key => structuredClone(disk.get(key)), set: async (key, value) => { disk.set(key, structuredClone(value)) },
      delete: async key => { disk.delete(key) }, keys: async () => [...disk.keys()],
    },
    command: { register: async () => ({ command: 'agent-undo' }) },
    tool: { register: async () => ({ tool: 'mcp__agent-undo__undo' }), check: async () => ({ decision: 'allow' }) },
    ui: { status: () => {} },
    clock: { sleep: (ms, o) => sleep(ms, undefined, { signal: o?.signal }) },
    fs: {
      exists: slow(async path => { try { await fs.stat(path); return true } catch { return false } }),
      stat: slow(async (path, o) => {
        const own = await fs.lstat(path)
        const s = await fs.stat(path).catch(() => undefined)
        return { kind: s?.isFile() ? 'file' : s?.isDirectory() ? 'dir' : 'other', isLink: own.isSymbolicLink(),
          size: s?.size ?? 0, mtimeMs: s?.mtimeMs ?? 0, ...(o?.resolve && s ? { realPath: await fs.realpath(path) } : {}) }
      }),
      read: slow(async (path, o) => {
        const b = await fs.readFile(path)
        return o?.as === 'bytes' ? { base64: b.toString('base64') } : b.toString('utf8')
      }),
      write: slow(async (path, text) => { await fs.writeFile(path, text) }),
    },
    process: { run: slow(async (argv, init) => {
      w.commands.push(argv)
      try {
        return { exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), { cwd: init?.cwd ?? root, env: { ...process.env, ...init?.env },
          encoding: 'utf8', timeout: init?.timeoutMs ?? 30000, stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '' }
      } catch (e) {
        if (typeof e.code === 'string') throw e
        return { exitCode: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message) }
      }
    }) },
  }
  async function dispatch(event, e, leaf) {
    const matches = handlers.filter(h => h.event === event && (!h.filter || Object.entries(h.filter).every(([k, v]) => e[k] === v)))
    const run = i => {
      if (i === matches.length) return leaf(e)
      const next = Object.assign(input => run(i + 1), {
        // As the engine reads it: the hook's own time only, never a `$` call's.
        budget: { get remainingMs() { return Math.max(0, HOOK_MS - ownElapsed()) } }, signal: new AbortController().signal,
      })
      return matches[i].handler($, e, next)
    }
    return run(0)
  }
  w.engine = $
  w.call = async (tool, args) => {
    const e = { tool, tool_use_id: `tool-${++session}`, ...args }
    return dispatch('tool.call', e, async () => {
      await dispatch('tool.check', { tool, tool_use_id: e.tool_use_id, input: args }, async () => ({ decision: 'allow' }))
      if (tool === 'Bash') {
        const result = await $.process.run(['bash', '-c', args.command], { cwd: root })
        return { result, ...(result.exitCode ? { isError: true } : {}) }
      }
      const was = await fs.readFile(args.file_path, 'utf8').catch(() => undefined)
      const out = editResult(was, args)
      await fs.writeFile(args.file_path, out.disk)
      return { result: out.result }
    })
  }
  w.undo = async ref => {
    const t0 = Date.now()
    hookStart = t0; w.busyMs = 0; w.calls = 0
    const out = await dispatch('command.run', { command: 'agent-undo', args: ref }, async () => { throw new Error('unhandled command') })
    w.last = { wallMs: Date.now() - t0, ownMs: ownElapsed(), engineRemainingMs: Math.max(0, HOOK_MS - ownElapsed()), calls: w.calls }
    t.diagnostic(`${out.text.replace(/\n/g, ' | ')}  ${JSON.stringify(w.last)}`)
    return out.text
  }
  w.read = name => fs.readFile(join(root, name), 'utf8')
  w.edit = (name, a, b) => w.call('Edit', { file_path: join(root, name), old_string: a, new_string: b })
  w.bash = command => w.call('Bash', { command })
  await dispatch('session.start', { cwd: root, surface: 'terminal', isInteractive: true }, async e => ({ cwd: e.cwd }))
  return w
}

// ---- C1: an Edit undo on a slow drive. Nine `$` calls stand before putBack's last look at the turn.
for (const callMs of [1000, 0]) {
  test(`C1${callMs ? '' : ' comparison'}: an Edit undo whose own \`$\` calls take ${callMs} ms each, the hook's budget unmoved, ${callMs ? 'is done' : 'is done'}`, { timeout: 60000 }, async t => {
    const w = await world(t, { 'a.txt': 'one\n' })
    await w.edit('a.txt', 'one', 'ONE')
    w.callMs = callMs
    let out = await w.undo('1')
    // The engine's own clock: the hook spent next to nothing of its 10 s, so the engine would not have gone on without it.
    assert.ok(w.last.engineRemainingMs > HOOK_MS - 1500, `engine budget left: ${w.last.engineRemainingMs}`)
    // README: "finish when you run it again". A one-file undo has the same nine calls on every try.
    if (!/undid/.test(out)) out = await w.undo('1')
    assert.match(out, /undid 1\.1/)
    assert.equal(await w.read('a.txt'), 'one\n')
  })
}

// ---- C2: a two-file shell undo on a slow drive. The second file's checks end past the wall-clock bound.
for (const callMs of [500, 0]) {
  test(`C2${callMs ? '' : ' comparison'}: a two-file shell undo whose own \`$\` calls take ${callMs} ms each, the hook's budget unmoved, ${callMs ? 'does both' : 'does both'}`, { timeout: 60000 }, async t => {
    const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
    await w.bash("printf 'ONE\\n' > a.txt; printf 'TWO\\n' > b.txt")
    w.callMs = callMs
    const out = await w.undo('1')
    assert.ok(w.last.engineRemainingMs > HOOK_MS - 1500, `engine budget left: ${w.last.engineRemainingMs}`)
    assert.match(out, /undid 1\.1, 1\.2/)
    assert.equal(await w.read('b.txt'), 'two\n')
  })
}
