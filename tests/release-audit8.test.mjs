// A next with no budget at all: an undo held behind an Edit at its question must still give up in its 10 s.
// Run: node --test tests/release-audit8.test.mjs
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const source = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const scratch = await fs.mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'static-budget-'))
after(() => fs.rm(scratch, { recursive: true, force: true }))
const compiled = join(scratch, 'compiled')
const types = process.env.CC_TYPES ?? join(source, '.claude-plugin/types/claude-code/index.d.ts')
execFileSync('tsc', ['--target', 'es2023', '--module', 'node16', '--moduleResolution', 'node16', '--jsx', 'react', '--jsxFactory', 'h',
  '--skipLibCheck', '--strict', '--rootDir', source, '--outDir', compiled, types,
  ...['register', 'common', 'shared', 'hunks', 'shell', 'shell-undo'].map(n => join(source, `hooks/${n}.tsx`)),
  join(source, 'types/index.d.ts'), join(source, 'tests/engine.tsx')], { cwd: scratch, stdio: 'pipe' })
await fs.mkdir(join(compiled, 'node_modules/claude-code'), { recursive: true })
await fs.writeFile(join(compiled, 'node_modules/claude-code/index.js'), `
exports.atom = (address, initial) => ({ address, initial });
exports.read = async ($, a) => structuredClone($._atoms.get(a.address.key) ?? a.initial);
exports.update = async ($, a, f) => { const next = f(await exports.read($, a)); $._atoms.set(a.address.key, structuredClone(next)); };
`)
const require = createRequire(join(compiled, 'entry.cjs'))
const { register } = require(join(compiled, 'hooks/register.js'))
const { editResult } = require(join(compiled, 'tests/engine.js'))

for (const mode of ['absent']) test(`budget ${mode}: an undo held behind an Edit at its question gives up in its 10 s`, { timeout: 40000 }, async t => {
  const root = await fs.mkdtemp(join(scratch, 'repo-'))
  for (const [n, x] of Object.entries({ 'a.txt': 'one\n', 'b.txt': 'x\n' })) await fs.writeFile(join(root, n), x)
  const handlers = []
  register((event, filter, handler) => { if (typeof filter === 'function') [filter, handler] = [undefined, filter]; handlers.push({ event, filter, handler }) })
  const disk = new Map()
  const $ = {
    _atoms: new Map(), session: { root: async () => root, id: async () => 'sid' },
    store: { get: async k => structuredClone(disk.get(k)), set: async (k, v) => { disk.set(k, structuredClone(v)) }, delete: async k => { disk.delete(k) }, keys: async () => [...disk.keys()] },
    command: { register: async () => ({ command: 'agent-undo' }) }, tool: { register: async () => ({ tool: 'mcp__agent-undo__undo' }), check: async () => ({ decision: 'allow' }) },
    ui: { status: () => {} }, clock: { sleep: (ms, o) => sleep(ms, undefined, { signal: o?.signal }) },
    fs: { exists: async p => { try { await fs.stat(p); return true } catch { return false } },
      stat: async p => { const s = await fs.stat(p); return { kind: s.isFile() ? 'file' : 'dir', isLink: false, size: s.size, mtimeMs: s.mtimeMs } },
      read: async p => (await fs.readFile(p)).toString('utf8'), write: async (p, x) => { await fs.writeFile(p, x) } },
    process: { run: async () => ({ exitCode: 1, stdout: '', stderr: 'no git' }) },
  }
  const dispatch = (event, e, leaf) => {
    const matches = handlers.filter(h => h.event === event && (!h.filter || Object.entries(h.filter).every(([k, v]) => e[k] === v)))
    const run = i => i === matches.length ? leaf(e) : matches[i].handler($, e, Object.assign(() => run(i + 1), {
      signal: new AbortController().signal }))
    return run(0)
  }
  let n = 0
  const call = (args, hold) => dispatch('tool.call', { tool: 'Edit', tool_use_id: `t${++n}`, ...args }, async () => {
    await hold
    const was = await fs.readFile(args.file_path, 'utf8'); const out = editResult(was, args); await fs.writeFile(args.file_path, out.disk); return { result: out.result }
  })
  await dispatch('session.start', { cwd: root, surface: 'terminal', isInteractive: true }, async e => ({ cwd: e.cwd }))
  await call({ file_path: join(root, 'a.txt'), old_string: 'one', new_string: 'ONE' })
  let open; const gate = new Promise(r => { open = r })
  const held = call({ file_path: join(root, 'b.txt'), old_string: 'x', new_string: 'X' }, gate)
  await sleep(50)
  const t0 = Date.now()
  const out = await Promise.race([
    dispatch('command.run', { command: 'agent-undo', args: '1' }, async () => { throw new Error('unhandled') }).then(r => r.text),
    sleep(14000).then(() => 'NO ANSWER IN 14 s'),
  ])
  t.diagnostic(`${mode}: after ${Date.now() - t0} ms: ${out}`)
  open(); await held
  assert.match(out, /still waiting/)
})
