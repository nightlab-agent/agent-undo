// The engine beneath the Bash record, for tests: an in-memory repo at /proj, a strict fake git
// that answers only the commands the record is meant to run (tests/git-snapshot.sh runs the same
// ones on a real repo; any other command fails the test). `bash` decides each call first
// (tool.check with the call's id, as the engine does before it runs the tool), then runs it
// under the same id; on "ask" the host raises the question (classic.PermissionRequest), where
// the person acts, then says yes. The host refuses `$.tool.check` from a test's own hooks, so
// the decision is raised from the test. From the code review of 2026-11-02 (F1-F5): a script may be
// async (to overlap calls), a call may be backgrounded (the engine answers with backgroundTaskId
// while the command keeps running), a hook may run inside a snapshot's `git add -A`, and `top`
// lets the repo top git reports differ from the session root (a symlinked folder).
import type { TestBody } from 'claude-code/testing'
import { editResult } from './engine'

export type On = Parameters<TestBody>[1]
export type $T = Parameters<TestBody>[0]
export const ROOT = '/proj'

export const blob = (t: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0').repeat(5)
}

export type Script = (f: Map<string, string>) => unknown
export type Repo = {
  files: Map<string, string>
  runs: string[][]
  git: boolean
  scripts: Record<string, Script>
  adds: number
  onAdd?: (n: number) => Promise<void> | void
  /** The verdict core gives a Bash call; "ask" runs `person` first, as the person would while the question waits. */
  verdict: 'allow' | 'ask' | 'deny'
  person?: Script
  /** The person's own git holds .git/index.lock: a git command on the real index fails. */
  locked: boolean
  /** git gc removed objects the private index still names: its next write-tree fails until it is seeded again. */
  pruned: boolean
  /** Any other tool (an MCP tool, or an unknown one), by name: what it does to the files; 'error' answers an
   * error, 'read-only' answers as core does a call the tool held read-only (`isReadOnly`). */
  tools: Record<string, (f: Map<string, string>) => void | 'error' | 'read-only' | Promise<void | 'error' | 'read-only'>>
}

export const repoWorld = (on: On, files0: Record<string, string>, opts: { git?: boolean; top?: string } = {}): Repo => {
  const top = opts.top ?? ROOT
  const IDX = `${top}/.git/agent-undo.index`
  const repo: Repo = {
    files: new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v])),
    runs: [], git: opts.git ?? true, scripts: {}, adds: 0, verdict: 'allow', locked: false, pruned: false, tools: {},
  }
  const trees = new Map<string, Map<string, string>>()
  const rel = (p: string) => p.slice(ROOT.length + 1)
  const real = (p: string) => (p.startsWith(`${top}/`) ? `${ROOT}/${p.slice(top.length + 1)}` : p)
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } as never })
  const fail = (stderr: string) => ({ value: { exitCode: 128, stdout: '', stderr } as never })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  if (repo.git) repo.files.set(`${ROOT}/.git/index`, 'real index')
  on('fs.exists', (_, e) => ({ value: repo.files.has(real(e.path)) }))
  on('fs.read', (_, e) => {
    const t = repo.files.get(real(e.path))
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => { repo.files.set(real(e.path), e.text); return { value: undefined } })
  on('process.run', async (_, e) => {
    const a = [...e.argv]
    repo.runs.push(a)
    const s = a.join(' ')
    const own = e.init?.env?.GIT_INDEX_FILE === IDX
    if (!repo.git) return fail('fatal: not a git repository')
    if (s === 'git rev-parse --show-toplevel --show-prefix') return ok(`${top}\n\n`)
    if (s === 'git rev-parse --path-format=absolute --git-path index --git-path agent-undo.index') return ok(`${top}/.git/index\n${IDX}\n`)
    if (a[0] === 'cp' && a[1] === `${top}/.git/index` && a[2] === IDX) { repo.files.set(`${ROOT}/.git/agent-undo.index`, 'seeded'); repo.pruned = false; return ok() }
    if (s === 'git add -A' && own) {
      repo.adds++
      if (repo.onAdd) await repo.onAdd(repo.adds)
      return ok()
    }
    if (s === 'git write-tree' && own && repo.pruned) return fail('error: invalid object 100644 e700 for \'b.txt\'\nfatal: git-write-tree: error building trees')
    if (s === 'git write-tree' && own) {
      const snap = new Map([...repo.files].filter(([k]) => !k.startsWith(`${ROOT}/.git/`)).map(([k, v]) => [rel(k), v]))
      const id = blob([...snap].map(([k, v]) => `${k}=${v}`).join('|'))
      trees.set(id, snap)
      return ok(`${id}\n`)
    }
    if (a.slice(0, 5).join(' ') === 'git diff-tree -r -z --no-renames') {
      const [x, y] = [trees.get(a[5]!)!, trees.get(a[6]!)!]
      const paths = [...new Set([...x.keys(), ...y.keys()])].sort()
      const O = '0'.repeat(40)
      let out = ''
      for (const p of paths) {
        const [b, c] = [x.get(p), y.get(p)]
        if (b === c) continue
        const st = b === undefined ? 'A' : c === undefined ? 'D' : 'M'
        out += `:${b === undefined ? '000000' : '100644'} ${c === undefined ? '000000' : '100644'} ${b === undefined ? O : blob(b)} ${c === undefined ? O : blob(c)} ${st}\0${p}\0`
      }
      return ok(out)
    }
    if (a.slice(0, 3).join(' ') === 'git hash-object --') {
      const t = repo.files.get(`${ROOT}/${a[3]}`)
      return t === undefined ? fail('fatal: no such file') : ok(`${blob(t)}\n`)
    }
    if (a[1] === 'restore' && a[2]?.startsWith('--source=') && a[3] === '--worktree' && a[4] === '--' && a[5]?.startsWith(':(literal)')) {
      // Real git takes the index lock even for --worktree: the person's lock blocks it unless
      // the restore runs on the private index (tests/git-snapshot.sh shows both on real git).
      if (repo.locked && !own) return fail(`fatal: Unable to create '${top}/.git/index.lock': File exists.`)
      const p = a[5].slice(':(literal)'.length)
      const t = trees.get(a[2].slice('--source='.length))!.get(p)
      if (t === undefined) repo.files.delete(`${ROOT}/${p}`)
      else repo.files.set(`${ROOT}/${p}`, t)
      return ok()
    }
    throw new Error(`fake git: unexpected command: ${s}`)
  })
  on('tool.call', async (_, e) => {
    const x = e as unknown as { tool: string; tool_use_id?: string; command?: string; run_in_background?: boolean
      file_path?: string; old_string?: string; new_string?: string }
    if (x.tool === 'Bash') {
      const run = repo.scripts[x.command!]!
      if (x.run_in_background) {
        // The engine starts the command and answers at once; the command keeps running.
        void Promise.resolve().then(() => run(repo.files))
        return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } } as never
      }
      await run(repo.files)
      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    }
    if (x.tool === 'Edit') {
      const { disk, result } = editResult(repo.files.get(x.file_path!)!, x as Parameters<typeof editResult>[1])
      repo.files.set(x.file_path!, disk)
      return { result } as never
    }
    const tool = repo.tools[x.tool]
    if (tool) {
      // As core answers an MCP tool: its content blocks, or an error the model reads.
      const said = await tool(repo.files)
      if (said === 'error') return { isError: true, result: 'Error: boom', text: 'Error: boom' } as never
      return { result: [{ type: 'text', text: 'ok' }], text: 'ok', ...(said === 'read-only' ? { isReadOnly: true } : {}) } as never
    }
    throw new Error(`unexpected tool ${x.tool}`)
  })
  on('tool.check', () => ({ decision: repo.verdict }) as never)
  // The question: the host raises it inside $.tool.call when the verdict is "ask". The person
  // acts while it waits (repo.person), then says yes.
  on('classic.PermissionRequest' as never, (async () => {
    if (repo.person) await repo.person(repo.files)
    return { decision: { behavior: 'allow' } }
  }) as never)
  return repo
}

export const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
let calls = 0
export const bash = async ($: $T, repo: Repo, command: string, f: Script, more: Record<string, unknown> = {}) => {
  repo.scripts[command] = f
  const tool_use_id = `toolu_${++calls}`
  const v = (await ($ as any).tool.check({ tool: 'Bash', input: { command }, tool_use_id,
    ...(more.agentId ? { agentId: more.agentId } : {}) })) as { decision: string }
  if (v.decision === 'deny') return { deny: 'denied' }
  return $.tool.call({ tool: 'Bash', command, tool_use_id, ...more } as never)
}
/** Any other tool (an MCP tool), decided first and then run under one id, as `bash` is. A deny is the engine's. */
export const tool = async ($: $T, repo: Repo, name: string, f: Repo['tools'][string], args: Record<string, unknown> = {}) => {
  repo.tools[name] = f
  const tool_use_id = `toolu_${++calls}`
  await ($ as any).tool.check({ tool: name, input: args, tool_use_id })
  return $.tool.call({ tool: name, tool_use_id, ...args } as never)
}
export const edit = ($: $T, file: string, a: string, b: string) =>
  $.tool.call({ tool: 'Edit', file_path: `${ROOT}/${file}`, old_string: a, new_string: b } as never)
export const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
export const tick = () => new Promise(r => setTimeout(r, 5))
