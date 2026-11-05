// Run: node --test tests/release-audit14.test.mjs
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const source = resolve(import.meta.dirname, '..')
const scratch = await fs.mkdtemp(join(tmpdir(), 'dex-tail-'))
after(() => fs.rm(scratch, { recursive: true, force: true }))
execFileSync(process.env.TSC ?? 'tsc', [
  '--target', 'es2023', '--module', 'node16', '--moduleResolution', 'node16',
  '--jsx', 'react', '--skipLibCheck', '--strict', '--rootDir', source,
  '--outDir', scratch, join(source, 'hooks/shared.tsx'),
], { cwd: scratch, stdio: 'pipe' })
const require = createRequire(join(scratch, 'entry.cjs'))
const gate = () => { let open, refuse; const p = new Promise((r, j) => { open = r; refuse = j }); return { p, open, refuse } }
const tick = () => sleep(0)

for (const cancel of [false, true]) test(`file queue: ${cancel ? 'denied waiter' : 'no denial comparison'} preserves the running Edit`, async t => {
  const path = join(scratch, 'hooks/shared.js')
  delete require.cache[path]
  const s = require(path), undoGate = gate(), editGate = gate(), timer = gate()
  const undo = s.serial(undefined, () => undoGate.p)
  const first = s.heldByUndo(() => new Promise(() => {}), ['/a'], () => undefined, () => editGate.p)
  const second = s.heldByUndo(() => timer.p, ['/a'], () => undefined, async () => ({}))
  await tick(); undoGate.open(); await undo; await tick()
  assert.equal(s.undoAhead(), false)
  if (cancel) {
    timer.refuse(new Error('clock refused'))
    assert.match((await second).deny, /still running/)
  }
  let began = false
  const third = s.serial(['/a'], async () => { began = true })
  await tick()
  const beside = began
  editGate.open(); await Promise.all([first, second, third])
  t.diagnostic(`third Edit ran beside first: ${beside}`)
  assert.equal(beside, false, 'giving up must retain the preceding file tail')
})
