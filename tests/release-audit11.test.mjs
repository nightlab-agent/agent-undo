// The undo's bound counts the hook's own time, and a slow undo does not write over an Edit that went on without it. Harness: tests/release-audit7.test.mjs's
// world (real files, real git, slow `$` calls, a budget read the engine's way), plus one engine fact that world leaves out:
// a hook past its own-time budget is absent and the engine runs `next(e)` on its behalf (claude-code index.d.ts 2.1.312,
// HookBudget.ms: "past it the hook is absent (its `.catch` asked, else `next(e)` run on its behalf)"). An Edit queued
// behind an undo waits on a plain promise, not a `$` call, so its clock runs while the undo's stands still.
// Run: node --test tests/review-dex-deadlines.test.mjs
import { tmpdir } from 'node:os'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const source = process.env.DEX_REVIEW_SOURCE ?? resolve(here, '..')
const scratch = await fs.mkdtemp(join(process.env.REVIEW_SCRATCH ?? tmpdir(), 'scratch-review-budget-'))
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

const gate = () => { let open; const p = new Promise(r => { open = r }); return { p, open } }

async function world(t, initial = {}, options = {}) {
  for (const key of Object.keys(require.cache)) if (key.startsWith(compiled)) delete require.cache[key]
  const { register } = require(join(compiled, 'hooks/register.js'))
  const { editResult } = require(join(compiled, 'tests/engine.js'))
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
  const w = { root, git, commands: [], callMs: options.callMs ?? 0, busy: 0, busyMs: 0, calls: 0, sleeps: [], absent: [] }
  let hookStart = 0, busySince = 0
  const enter = () => { if (w.busy++ === 0) busySince = performance.now() }
  const leave = () => { if (--w.busy === 0) w.busyMs += performance.now() - busySince }
  const slow = f => async (...a) => {
    w.calls++
    enter()
    try { if (w.callMs) await sleep(w.callMs); return await f(...a) } finally { leave() }
  }
  const ownElapsed = () => performance.now() - hookStart - w.busyMs - (w.busy ? performance.now() - busySince : 0)
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
    // Non-finite ms is refused, as the engine's is (refs/code-typescript.md 2026-11-05).
    clock: { sleep: (ms, o) => { w.sleeps.push(ms); if (!Number.isFinite(ms)) return Promise.reject(new Error('non-finite')); return sleep(ms, undefined, { signal: o?.signal }) } },
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
      if (w.before) await w.before(argv)
      try {
        return { exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), { cwd: init?.cwd ?? root, env: { ...process.env, ...init?.env },
          encoding: 'utf8', timeout: init?.timeoutMs ?? 30000, stdio: ['pipe', 'pipe', 'pipe'] }), stderr: '' }
      } catch (e) {
        if (typeof e.code === 'string') throw e
        return { exitCode: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message) }
      }
    }) },
  }
  // `budgetOf` makes each dispatch's `next.budget`; the undo's reads own time, an Edit's (no `$` call before its next) is wall time.
  async function dispatch(event, e, leaf, budgetOf = () => ({ get remainingMs() { return Math.max(0, HOOK_MS - ownElapsed()) } }), signal = new AbortController().signal) {
    const matches = handlers.filter(h => h.event === event && (!h.filter || Object.entries(h.filter).every(([k, v]) => e[k] === v)))
    const run = i => {
      if (i === matches.length) return leaf(e)
      const next = Object.assign(input => run(i + 1), { budget: budgetOf(), signal })
      return matches[i].handler($, e, next)
    }
    return run(0)
  }
  w.engine = $
  const leafOf = async (tool, args) => {
    await dispatch('tool.check', { tool, tool_use_id: 'x', input: args }, async () => ({ decision: 'allow' }))
    if (w.holdLeaf) await w.holdLeaf
    const was = await fs.readFile(args.file_path, 'utf8').catch(() => undefined)
    const out = editResult(was, args)
    await fs.writeFile(args.file_path, out.disk)
    return { result: out.result }
  }
  // An Edit as the engine runs it: its hook has HookBudget.ms of its own time; past it the engine runs the step itself.
  w.editAsEngine = async (name, a, b) => {
    const args = { file_path: join(root, name), old_string: a, new_string: b }
    const e = { tool: 'Edit', tool_use_id: `tool-${++session}`, ...args }
    const started = performance.now(), ctrl = new AbortController(), timer = new AbortController()
    // One core execution, including when the timed-out hook eventually calls next.
    let core
    const leaf = () => core ??= leafOf('Edit', args)
    const hook = dispatch('tool.call', e, leaf, () => ({ get remainingMs() { return Math.max(0, HOOK_MS - (performance.now() - started)) } }), ctrl.signal)
    w.lastEditHook = hook
    const absent = sleep(HOOK_MS, undefined, { signal: timer.signal }).then(() => { ctrl.abort(); w.absent.push('Edit'); return leaf() })
    try { return await Promise.race([hook, absent]) } finally { timer.abort() }
  }

  w.undo = async (ref, budgetOf) => {
    const t0 = performance.now()
    hookStart = t0; w.busyMs = 0; w.calls = 0
    const out = await dispatch('command.run', { command: 'agent-undo', args: ref }, async () => { throw new Error('unhandled command') }, budgetOf)
    w.last = { wallMs: performance.now() - t0, ownMs: ownElapsed(), engineRemainingMs: Math.max(0, HOOK_MS - ownElapsed()), calls: w.calls }
    t.diagnostic(`${out.text.replace(/\n/g, ' | ')}  ${JSON.stringify(w.last)}`)
    return out.text
  }
  w.read = name => fs.readFile(join(root, name), 'utf8')
  w.edit = (name, a, b) => dispatch('tool.call', { tool: 'Edit', tool_use_id: `tool-${++session}`, file_path: join(root, name), old_string: a, new_string: b },
    () => leafOf('Edit', { file_path: join(root, name), old_string: a, new_string: b }))
  w.bash = command => {
    const id = `tool-${++session}`
    return dispatch('tool.call', { tool: 'Bash', tool_use_id: id, command }, async () => {
      await dispatch('tool.check', { tool: 'Bash', tool_use_id: id, input: { command } }, async () => ({ decision: 'allow' }))
      return { result: await $.process.run(['bash', '-c', command], { cwd: root }) }
    })
  }
  w.list = () => $._atoms.get('changes') ?? []
  await dispatch('session.start', { cwd: root, surface: 'terminal', isInteractive: true }, async e => ({ cwd: e.cwd }))
  return w
}

for (const source of ['Edit', 'Bash']) for (const slow of [false, true]) test(`${source} undo write in flight: ${slow ? 'Edit times out' : 'fast comparison'} preserves the Edit`, { timeout: 20000 }, async t => {
  const w = await world(t, { 'a.txt': 'one\nkeep\n' })
  if (source === 'Edit') await w.edit('a.txt', 'one', 'ONE')
  else await w.bash("printf 'ONE\\nkeep\\n' > a.txt")
  const entered = gate(), release = gate()
  w.before = async argv => {
    if (source === 'Edit' ? argv[0] === 'mv' : argv[0] === 'git' && argv[1] === 'restore') { entered.open(); await release.p }
  }
  const undo = w.undo('1')
  await entered.p // stopped() has already passed; no Edit was waiting then.
  const edit = w.editAsEngine('a.txt', 'keep', 'KEEP')
  if (slow) await edit
  release.open()
  const out = await undo
  const answer = await edit
  await w.lastEditHook
  const text = await w.read('a.txt')
  t.diagnostic(JSON.stringify({ out, text, answer, absent: w.absent }))
  // An Edit that outwaits the undo refuses itself in time, or it runs after the undo: never beside it.
  if (slow) { assert.match(String(answer.deny), /still running/); assert.doesNotMatch(text, /KEEP/); assert.deepEqual(w.absent, []) }
  else assert.match(text, /KEEP/)
})

for (const jump of [0, 60000]) test(`wall clock: ${jump ? 'forward correction' : 'unchanged comparison'} permits a healthy undo`, async t => {
  const w = await world(t, { 'a.txt': 'one\nkeep\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const entered = gate(), release = gate()
  const read = w.engine.fs.read
  let reads = 0
  w.engine.fs.read = async (...args) => {
    const text = await read(...args)
    if (args[0] === join(w.root, 'a.txt') && ++reads === 2) { entered.open(); await release.p }
    return text
  }
  // Stay inside a $ read while correcting the epoch; own time remains healthy.
  const undo = w.undo('1', () => ({ remainingMs: 10000 }))
  await entered.p
  const edit = w.edit('a.txt', 'keep', 'KEEP')
  const now = Date.now
  let out
  try {
    Date.now = () => now() + jump
    release.open()
    out = await undo
  } finally {
    Date.now = now
    await Promise.all([undo, edit])
  }
  t.diagnostic(`fresh waiter, clock correction ${jump}, outcome=${out}`)
  assert.match(out, /undid 1\.1/)
  assert.equal(await w.read('a.txt'), 'one\nKEEP\n')
})

