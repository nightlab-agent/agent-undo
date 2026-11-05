import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import { editResult } from './engine'
import { ROOT, at, start, undo } from './edit-world'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]
type Call = { tool: string; file_path: string; old_string: string; new_string: string }
// Each Edit named in `ask` stands at its question that long (under the fake's own 10 s budget), one after another:
// a third call behind two of them waits as it would behind one question a person takes 18 s to answer.
const world = (on: On, files0: Record<string, string>, ask: Record<string, number>) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [at(k), v]))
  const log: string[] = []
  const t0 = Date.now()
  const say = (l: string) => log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${l}`)
  on('session.root', () => ({ value: ROOT }))
  on('clock.sleep', (_, e) => new Promise(r => setTimeout(() => r({ value: undefined } as never), (e as { ms?: number }).ms ?? 0)) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => ({ value: files.get(e.path)! }))
  on('fs.write', (_, e) => { files.set(e.path, e.text); say(`wrote ${e.path}`); return { value: undefined } })
  on('command.run' as never, (() => { say('command core reached'); return { text: 'CORE' } }) as never)
  on('tool.call', async (_, e) => {
    const x = e as unknown as Call
    say(`start ${x.old_string}`)
    await new Promise(r => setTimeout(r, ask[x.old_string] ?? 0))
    const { disk, result } = editResult(files.get(x.file_path)!, x as Parameters<typeof editResult>[1])
    files.set(x.file_path, disk)
    say(`done ${x.old_string}`)
    return { result } as never
  })
  return { files, log }
}
const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: at(file), old_string: a, new_string: b } as never)
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const TEXT = 'one\n-\n-\n-\n-\n-\n-\n-\n-\ntwo\n-\n-\n-\n-\n-\n-\n-\n-\nthree\n'

for (const [name, ms] of [['short', 1000], ['past the budget', 9000]] as const) {
  test(`an Edit behind two questions of one file, ${name}, stays behind them and is listed`, { timeoutMs: 30000 }, async ($, on) => {
    const w = world(on, { 'a.txt': TEXT }, { one: ms, two: ms })
    await start($)
    const calls = [edit($, 'a.txt', 'one', 'ONE'), edit($, 'a.txt', 'two', 'TWO')]
    await sleep(30)
    calls.push(edit($, 'a.txt', 'three', 'THREE'))
    const got = await Promise.allSettled(calls)
    await sleep(1500)
    console.log('PROBE', name, JSON.stringify(got.map(g => g.status === 'rejected' ? String(g.reason).slice(0, 90) : 'ok')))
    console.log('PROBE', name, JSON.stringify(w.log))
    const list = await undo($, '')
    console.log('PROBE', name, JSON.stringify(list))
    const order = w.log.filter(l => l.includes('start') || l.includes('done')).map(l => l.split(' ').slice(1).join(' '))
    // Past the budget the engine runs the third Edit without this hook: it lands, unrecorded, the README's known limit.
    if (ms === 1000) {
      expect(order).toEqual(['start one', 'done one', 'start two', 'done two', 'start three', 'done three'])
      expect(list).toContain('#3')
    } else expect(w.files.get(at('a.txt'))).toContain('THREE')
  })

  test(`an undo behind two questions, ${name}, answers once, with what it did`, { timeoutMs: 30000 }, async ($, on) => {
    const w = world(on, { 'a.txt': TEXT, 'b.txt': 'x\ny\n' }, { x: ms, y: ms })
    await start($)
    await edit($, 'a.txt', 'one', 'ONE')
    const calls = [edit($, 'b.txt', 'x', 'X'), edit($, 'b.txt', 'y', 'Y')]
    await sleep(30)
    const t = Date.now()
    const said = await undo($, '1').catch(e => `REJECTED ${String(e).slice(0, 120)}`)
    const secs = (Date.now() - t) / 1000
    const fileWhenAnswered = w.files.get(at('a.txt'))!.slice(0, 3)
    await Promise.allSettled(calls)
    await sleep(1500)
    console.log('PROBE', name, 'undo answered after', secs, JSON.stringify(said), 'file then', fileWhenAnswered, 'file now', w.files.get(at('a.txt'))!.slice(0, 3), JSON.stringify(w.log))
    if (ms === 1000) {
      expect(said).toContain('undid 1.1')
      expect(fileWhenAnswered).toBe('one')
    } else {
      // Gave up in its budget and said so; nothing lands after the answer.
      expect(said).toContain('still waiting')
      expect(w.files.get(at('a.txt'))!.slice(0, 3)).toBe('ONE')
    }
  })
}
