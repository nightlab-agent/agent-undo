// A variant of world.tsx for the repo-top arithmetic: the session root, the top git reports
// (symlinks resolved), the prefix git reports, and which spellings of the top really are the
// repo (a git command run anywhere else fails, as real git does).
import type { On, $T, Script } from './world'
import { blob } from './world'

export type World2 = { files: Map<string, string>; scripts: Record<string, Script>; runs: string[][] }

export const world2 = (on: On, o: { root: string; gitTop: string; prefix: string; tops: string[] }, files0: Record<string, string>): World2 => {
  const { root, gitTop, prefix } = o
  const w: World2 = { files: new Map(Object.entries(files0).map(([k, v]) => [`${root}/${k}`, v])), scripts: {}, runs: [] }
  const IDX = `${gitTop}/.git/agent-undo.index`
  const trees = new Map<string, Map<string, string>>()
  const inRepo = (cwd: string) => cwd === root || o.tops.some(t => cwd === t || cwd.startsWith(`${t}/`))
  // Any spelling of a file in the repo, as the session's root spells it.
  const real = (p: string) => {
    for (const t of o.tops) if (p.startsWith(`${t}/${prefix}`)) return `${root}/${p.slice(t.length + 1 + prefix.length)}`
    return p
  }
  const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '' } })
  const fail = (stderr: string) => ({ value: { exitCode: 128, stdout: '', stderr } })
  on('session.root', () => ({ value: root }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('tool.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('fs.exists', (_, e) => ({ value: e.path === IDX ? false : w.files.has(real(e.path)) }))
  on('fs.read', (_, e) => {
    const t = w.files.get(real(e.path))
    if (t === undefined) throw new Error('ENOENT')
    return { value: t }
  })
  on('fs.write', (_, e) => { w.files.set(real(e.path), e.text); return { value: undefined } })
  on('process.run', async (_, e) => {
    const a = [...e.argv]
    w.runs.push(a)
    const s = a.join(' ')
    const cwd = String(e.init?.cwd ?? '')
    if (a[0] === 'git' && !inRepo(cwd)) return fail('fatal: not a git repository (or any of the parent directories): .git')
    const own = e.init?.env?.GIT_INDEX_FILE === IDX
    if (s === 'git rev-parse --show-toplevel --show-prefix') return ok(`${gitTop}\n${prefix}\n`)
    if (s === 'git rev-parse --path-format=absolute --git-path index --git-path agent-undo.index') return ok(`${gitTop}/.git/index\n${IDX}\n`)
    if (a[0] === 'cp') return ok()
    if (s === 'git add -A' && own) return ok()
    if (s === 'git write-tree' && own) {
      const snap = new Map([...w.files].map(([k, v]) => [`${prefix}${k.slice(root.length + 1)}`, v]))
      const id = blob([...snap].map(([k, v]) => `${k}=${v}`).join('|'))
      trees.set(id, snap)
      return ok(`${id}\n`)
    }
    if (a.slice(0, 5).join(' ') === 'git diff-tree -r -z --no-renames') {
      const [x, y] = [trees.get(a[5]!)!, trees.get(a[6]!)!]
      const O = '0'.repeat(40)
      let out = ''
      for (const p of [...new Set([...x.keys(), ...y.keys()])].sort()) {
        const [b, c] = [x.get(p), y.get(p)]
        if (b === c) continue
        const st = b === undefined ? 'A' : c === undefined ? 'D' : 'M'
        out += `:${b === undefined ? '000000' : '100644'} ${c === undefined ? '000000' : '100644'} ${b === undefined ? O : blob(b)} ${c === undefined ? O : blob(c)} ${st}\0${p}\0`
      }
      return ok(out)
    }
    if (a.slice(0, 3).join(' ') === 'git hash-object --') {
      const t = w.files.get(`${root}/${a[3]!.slice(prefix.length)}`)
      return t === undefined ? fail('fatal: no such file') : ok(`${blob(t)}\n`)
    }
    if (a[1] === 'restore' && a[5]?.startsWith(':(literal)')) {
      const p = a[5].slice(':(literal)'.length)
      const t = trees.get(a[2]!.slice('--source='.length))!.get(p)
      const k = `${root}/${p.slice(prefix.length)}`
      if (t === undefined) w.files.delete(k)
      else w.files.set(k, t)
      return ok()
    }
    throw new Error(`fake git: unexpected command: ${s} in ${cwd}`)
  })
  on('tool.call', async (_, e) => {
    const x = e as unknown as { tool: string; command?: string; file_path?: string; old_string?: string; new_string?: string }
    if (x.tool === 'Bash') {
      await w.scripts[x.command!]!(w.files)
      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    }
    if (x.tool === 'Edit') {
      const was = w.files.get(x.file_path!)!
      const now = was.replace(x.old_string!, x.new_string!)
      w.files.set(x.file_path!, now)
      return { result: { filePath: x.file_path, oldString: x.old_string, newString: x.new_string, originalFile: was,
        structuredPatch: [], userModified: false, replaceAll: false } } as never
    }
    throw new Error(`unexpected tool ${x.tool}`)
  })
  on('tool.check', () => ({ decision: 'allow' }) as never)
  return w
}

let n = 0
export const bash2 = async ($: $T, w: World2, command: string, f: Script) => {
  w.scripts[command] = f
  const tool_use_id = `toolu_w2_${++n}`
  await ($ as any).tool.check({ tool: 'Bash', input: { command }, tool_use_id })
  return $.tool.call({ tool: 'Bash', command, tool_use_id } as never)
}
