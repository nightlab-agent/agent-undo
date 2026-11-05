// typescript-reviewer, 0.3.0 gate: once an undo's turn is over (budget), the files still to come each cost
// a repoOf (two git spawns) before their "left as is" line. Counts the git runs after the turn ended.
import { expect, test } from 'claude-code/testing'
import { ROOT, bash, repoWorld, start, tick, undo } from './world'
import type { On } from './world'

const at = (p: string) => `${ROOT}/${p}`
const ticks = async (n = 12) => { for (let i = 0; i < n; i++) await tick() }
const N = 60
const seeds = Object.fromEntries(Array.from({ length: N }, (_, k) => [`f${k}.txt`, 'a\n']))

// The repo world answers no clock.sleep (the kit refuses it, so the budget never fires there): a real timer here.
const clock = (on: On) => on('clock.sleep', (_, e) => new Promise(r => setTimeout(() => r({ value: undefined } as never), (e as { ms?: number }).ms ?? 0)) as never)

test('review-tsr A1: an undo whose turn ended behind a held index runs no git for the files still to come', { timeoutMs: 30000 }, async ($, on) => {
  const repo = repoWorld(on, seeds)
  clock(on)
  await start($)
  await bash($, repo, 'change all', f => { for (let k = 0; k < N; k++) f.set(at(`f${k}.txt`), 'b\n') })
  let open = () => {}
  const gate = new Promise<void>(r => { open = r })
  repo.onAdd = () => gate
  const running = bash($, repo, 'slow', f => { f.set(at('f0.txt'), 'c\n') })
  await ticks()
  const t = Date.now()
  const before = repo.runs.length
  const text = await undo($, '1')
  const secs = (Date.now() - t) / 1000
  const after = repo.runs.slice(before)
  const gitAfterTurn = after.filter(r => r[0] === 'git' && r[1] === 'rev-parse').length
  repo.onAdd = undefined
  open()
  await running
  expect(text).toContain('nothing changed')
  // Nothing was restored, so the only git the undo needed was the first file's repoOf: two rev-parse runs.
  expect(gitAfterTurn).toBeLessThanOrEqual(2)
})

test('review-tsr A1 comparison: the same undo with the index free restores every file', { timeoutMs: 30000 }, async ($, on) => {
  const repo = repoWorld(on, seeds)
  clock(on)
  await start($)
  await bash($, repo, 'change all', f => { for (let k = 0; k < N; k++) f.set(at(`f${k}.txt`), 'b\n') })
  const before = repo.runs.length
  const text = await undo($, '1')
  expect(text).toContain(`undid 1.1`)
  expect(repo.files.get(at('f59.txt'))).toBe('a\n')
})
