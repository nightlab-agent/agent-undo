// Review of e6f3701 (code-reviewer, s473): the compiled hooks' queue, driven the way tests/release-audit12.test.mjs drives it.
// Run: CC_TYPES=<engine declarations> node --test tests/release-audit15.test.mjs
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const source = resolve(import.meta.dirname, '..')
const scratch = await fs.mkdtemp(join(process.env.REVIEW_SCRATCH ?? tmpdir(), 'release-audit15-'))
after(() => fs.rm(scratch, { recursive: true, force: true }))
execFileSync(process.env.TSC ?? 'tsc', [
  '--target', 'es2023', '--module', 'node16', '--moduleResolution', 'node16',
  '--jsx', 'react', '--jsxFactory', 'h', '--skipLibCheck', '--strict',
  '--rootDir', source, '--outDir', scratch, process.env.CC_TYPES ?? join(source, '.claude-plugin/types/claude-code/index.d.ts'),
  ...['register', 'common', 'shared', 'hunks', 'shell', 'shell-undo'].map(n => join(source, `hooks/${n}.tsx`)),
  join(source, 'types/index.d.ts'),
], { cwd: scratch, stdio: 'pipe' })
await fs.mkdir(join(scratch, 'node_modules/claude-code'), { recursive: true })
await fs.writeFile(join(scratch, 'node_modules/claude-code/index.js'), `
exports.atom = (address, initial) => ({ address, initial });
exports.read = async ($, a) => a.initial;
exports.update = async () => {};
`)
const require = createRequire(join(scratch, 'entry.cjs'))
const gate = () => { let open; const p = new Promise(r => { open = r }); return { p, open } }
const tick = () => sleep(0)
const fresh = () => {
  for (const key of Object.keys(require.cache)) if (key.startsWith(scratch)) delete require.cache[key]
  return require(join(scratch, 'hooks/shared.js'))
}
const clock = (ms, o) => sleep(ms, undefined, { signal: o?.signal })
// A budget that runs down on the wall clock, read live through a getter (the shape tests/release-audit10 and 11 give an Edit).
const moving = total => { const t0 = Date.now(); return () => Math.max(0, total - (Date.now() - t0)) }

// Kind 8 (whose slot): a keyed job that leaves hands its file's queue to `whole` only (shared.tsx `ahead = whole`),
// not to the tails[k] it also waited on. Before this commit only an undo (keys undefined) could leave, and `whole`
// was all it waited on. Now an Edit leaves too, and its file's queue forgets the Edit of the same file ahead of it.
for (const leaves of [true, false]) test(`A: Edit of a.txt behind an undo and another Edit of a.txt ${leaves ? 'leaves at its budget: a later undo runs beside the first Edit' : 'stays (comparison): a later undo waits'}`, async t => {
  const { serial, heldByUndo } = fresh()
  const undo1 = gate(), e1Held = gate()
  const u1 = serial(undefined, () => undo1.p)
  let e1Running = false
  const e1 = heldByUndo(clock, ['a'], moving(1e6), async () => { e1Running = true; await e1Held.p; e1Running = false; return 'e1' })
  const e2 = heldByUndo(clock, ['a'], moving(leaves ? 1700 : 1e6), async () => 'e2')
  undo1.open(); await tick(); await tick()
  assert.equal(e1Running, true, 'the first Edit began once the undo finished')
  if (leaves) assert.match(String((await e2).deny), /still running/)
  else await sleep(300)
  let beside
  const u2 = serial(undefined, async () => { beside = e1Running; return 'u2' })
  await sleep(50)
  t.diagnostic(`second undo ran while the first Edit was still running: ${beside}`)
  e1Held.open()
  await Promise.all([u1, e1, e2, u2])
  assert.notEqual(beside, true, 'an undo ran beside an Edit of the same file (shared.tsx:15-16 says that loses the edit)')
})
