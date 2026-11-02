import { expect, test } from 'claude-code/testing'
import { filesOf } from '../hooks/register'

const Z = (rows: string[][]) => rows.map(([meta, path]) => `${meta}\0${path}\0`).join('')
const A = 'a'.repeat(40), B = 'b'.repeat(40), O = '0'.repeat(40)

test('reads git diff-tree -z: changed, deleted, new, and a path with a space and a newline', async () => {
  const out = Z([
    [`:100644 100644 ${A} ${B} M`, 'src/a.ts'],
    [`:100644 000000 ${A} ${O} D`, 'gone.txt'],
    [`:000000 100755 ${O} ${B} A`, 'run me.sh'],
    [`:100644 100644 ${A} ${B} M`, 'odd\nname'],
  ])
  expect(filesOf(out)).toEqual([
    { path: 'src/a.ts', status: 'M', before: A, after: B },
    { path: 'gone.txt', status: 'D', before: A },
    { path: 'run me.sh', status: 'A', after: B },
    { path: 'odd\nname', status: 'M', before: A, after: B },
  ])
})

test('a submodule or a symlink change is listed but marked as not undoable here', async () => {
  const out = Z([[`:160000 160000 ${A} ${B} M`, 'vendor/lib'], [`:120000 120000 ${A} ${B} M`, 'link']])
  expect(filesOf(out).map(f => f.fixed)).toEqual(['a submodule', 'a symbolic link'])
})

test('empty output is no files', async () => {
  expect(filesOf('')).toEqual([])
})

// ---- The engine beneath, for Bash: an in-memory repo at /proj and a strict fake git. ----
// It answers only the commands the record is meant to run (tests/git-snapshot.sh runs the same
// ones on a real repo); any other command fails the test.

type On = Parameters<import('claude-code/testing').TestBody>[1]
type $T = Parameters<import('claude-code/testing').TestBody>[0]
const ROOT = '/proj'
const IDX = `${ROOT}/.git/agent-undo.index`

const blob = (t: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0').repeat(5)
}

type Repo = { files: Map<string, string>; runs: string[][]; git: boolean; scripts: Record<string, (f: Map<string, string>) => void> }

const repoWorld = (on: On, files0: Record<string, string>, opts: { git?: boolean } = {}): Repo => {
  const repo: Repo = { files: new Map(Object.entries(files0).map(([k, v]) => [`${ROOT}/${k}`, v])), runs: [], git: opts.git ?? true, scripts: {} }
  const trees = new Map<string, Map<string, string>>()
  const rel = (p: string) => p.slice(ROOT.length + 1)
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  if (repo.git) repo.files.set(`${ROOT}/.git/index`, 'real index')
  on('fs.exists', (_, e) => ({ value: repo.files.has(e.path) }))
  on('fs.read', (_, e) => {
    const t = repo.files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => { repo.files.set(e.path, e.text); return { value: undefined } })
  on('process.run', (_, e) => {
    const a = [...e.argv]
    repo.runs.push(a)
    const s = a.join(' ')
    if (!repo.git) return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } }
    if (s === 'git rev-parse --show-toplevel') return ok(`${ROOT}\n`)
    if (s === 'git rev-parse --path-format=absolute --git-path index --git-path agent-undo.index') return ok(`${ROOT}/.git/index\n${IDX}\n`)
    if (a[0] === 'cp') { repo.files.set(IDX, 'seeded'); return ok() }
    if (s === 'git add -A' && e.init?.env?.GIT_INDEX_FILE === IDX) return ok()
    if (s === 'git write-tree' && e.init?.env?.GIT_INDEX_FILE === IDX) {
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
      return t === undefined ? { value: { exitCode: 128, stdout: '', stderr: 'fatal: no such file' } } : ok(`${blob(t)}\n`)
    }
    if (a[1] === 'restore' && a[2]?.startsWith('--source=') && a[3] === '--worktree' && a[4] === '--' && a[5]?.startsWith(':(literal)')) {
      const p = a[5].slice(':(literal)'.length)
      const t = trees.get(a[2].slice('--source='.length))!.get(p)
      if (t === undefined) repo.files.delete(`${ROOT}/${p}`)
      else repo.files.set(`${ROOT}/${p}`, t)
      return ok()
    }
    throw new Error(`fake git: unexpected command: ${s}`)
  })
  on('tool.call', (_, e) => {
    const x = e as unknown as { tool: string; command?: string; file_path?: string; old_string?: string; new_string?: string }
    if (x.tool === 'Bash') {
      repo.scripts[x.command!]!(repo.files)
      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    }
    if (x.tool === 'Edit') {
      const was = repo.files.get(x.file_path!)!
      const now = was.replace(x.old_string!, x.new_string!)
      repo.files.set(x.file_path!, now)
      return { result: { filePath: x.file_path, oldString: x.old_string, newString: x.new_string, originalFile: was,
        structuredPatch: [], userModified: false, replaceAll: false } } as never
    }
    throw new Error(`unexpected tool ${x.tool}`)
  })
  return repo
}

const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
const bash = ($: $T, repo: Repo, command: string, f: (files: Map<string, string>) => void, agentId?: string) => {
  repo.scripts[command] = f
  return $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) } as never)
}
const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text

test('a shell command that changes, deletes and creates files is listed as one numbered change', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n', 'keep.txt': 'k\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', f => {
    f.set(`${ROOT}/a.txt`, 'a2\n'); f.delete(`${ROOT}/gone.txt`); f.set(`${ROOT}/new.txt`, 'n\n')
  })
  const text = await undo($, '')
  expect(text).toContain('Bash sh tidy.sh (3 files)')
  expect(text).toContain('1.1 changed a.txt')
  expect(text).toContain('1.2 deleted gone.txt')
  expect(text).toContain('1.3 new file new.txt')
  expect(text).not.toContain('keep.txt')
})

test('a shell command that changes nothing is not listed', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'ls', () => {})
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
})

test('outside a git work tree, a shell command is not recorded and the command still runs', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' }, { git: false })
  await start($)
  await bash($, repo, 'sed', f => f.set(`${ROOT}/a.txt`, 'b\n'))
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('b\n')
  expect(await undo($, '')).toContain('no edits by Claude in this session yet')
})

test('the private index is seeded once from the real one, and never the real index itself', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'one', f => f.set(`${ROOT}/a.txt`, 'b\n'))
  await bash($, repo, 'two', f => f.set(`${ROOT}/a.txt`, 'c\n'))
  expect(repo.runs.filter(r => r[0] === 'cp')).toEqual([['cp', `${ROOT}/.git/index`, IDX]])
})

test('a file Claude edited with Edit while a shell command ran is left to the Edit record', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($)
  await bash($, repo, 'slow', f => {
    f.set(`${ROOT}/a.txt`, 'a2\n')
    // Mid-command, an Edit lands on b.txt (parallel tool calls).
    void $.tool.call({ tool: 'Edit', file_path: `${ROOT}/b.txt`, old_string: 'b', new_string: 'B' } as never)
  })
  const text = await undo($, '')
  expect(text).toMatch(/Bash slow \(1 file\)/)
  expect(text).toContain('changed a.txt')
  expect(text).not.toMatch(/\d\.\d changed b\.txt/)
})

const tidy = (f: Map<string, string>) => {
  f.set(`${ROOT}/a.txt`, 'a2\n'); f.delete(`${ROOT}/gone.txt`); f.set(`${ROOT}/new.txt`, 'n\n')
}

test('undoes one file of a shell command; the command\'s other files stay', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', tidy)
  expect(await undo($, '1.1')).toContain('undid 1.1: a.txt')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a\n')
  expect(repo.files.has(`${ROOT}/gone.txt`)).toBe(false)
  expect(repo.files.get(`${ROOT}/new.txt`)).toBe('n\n')
  expect(await undo($, '')).toContain('1.1 changed a.txt  (undone)')
})

test('brings back a file the command deleted', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', tidy)
  expect(await undo($, '1.2')).toContain('undid 1.2: gone.txt')
  expect(repo.files.get(`${ROOT}/gone.txt`)).toBe('old\n')
})

test('all of one command: changed and deleted files come back, a new file is listed, never deleted', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', tidy)
  const text = await undo($, '1')
  expect(text).toContain('undid 1.1, 1.2: a.txt, gone.txt')
  expect(text).toContain('1.3 left as is: new.txt is a new file; nothing was there before. Delete it yourself if you want it gone.')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a\n')
  expect(repo.files.get(`${ROOT}/gone.txt`)).toBe('old\n')
  expect(repo.files.get(`${ROOT}/new.txt`)).toBe('n\n')
})

test('refuses a file the person changed since the command, and leaves it alone', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', tidy)
  repo.files.set(`${ROOT}/a.txt`, 'mine\n')
  repo.files.set(`${ROOT}/gone.txt`, 'mine too\n')
  const text = await undo($, '1')
  expect(text).toContain('1.1 left as is: a.txt has changed since the command')
  expect(text).toContain('1.2 left as is: there is a file at gone.txt again')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('mine\n')
  expect(repo.files.get(`${ROOT}/gone.txt`)).toBe('mine too\n')
})

test('out of order: an older command under a newer one is refused, then undone once the newer is', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n' })
  await start($)
  await bash($, repo, 'first', f => f.set(`${ROOT}/a.txt`, 'b\n'))
  await bash($, repo, 'second', f => f.set(`${ROOT}/a.txt`, 'c\n'))
  expect(await undo($, '1.1')).toContain('1.1 left as is: a.txt has changed since the command')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('c\n')
  expect(await undo($, '2.1')).toContain('undid 2.1')
  expect(await undo($, '1.1')).toContain('undid 1.1')
  expect(repo.files.get(`${ROOT}/a.txt`)).toBe('a\n')
})

test('a second undo of the same file says it was done; an unknown file number changes nothing', async ($, on) => {
  const repo = repoWorld(on, { 'a.txt': 'a\n', 'gone.txt': 'old\n' })
  await start($)
  await bash($, repo, 'sh tidy.sh', tidy)
  await undo($, '1.1')
  expect(await undo($, '1.1')).toContain('1.1 was already undone')
  expect(await undo($, '1.9')).toContain('#1 has 3 file(s); no 1.9.')
})
