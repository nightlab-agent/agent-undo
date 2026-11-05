// The tools an Edit or Write undo goes through (hooks/register.tsx putBack), over a world's map of files. The real
// $.process.run rejects when a tool cannot start, and an undo then refuses: it has no second way to write the file.
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })

/** What `argv` answers if it is one of those tools; `moved` sees each file a rename lands on. */
export const tempTool = (files: Map<string, string>, argv: readonly string[], moved?: (path: string) => void) => {
  const [tool, ...args] = argv
  if (tool === 'mktemp') {
    const name = args[0]!.replace(/X+$/, 'tmp')
    files.set(name, '')
    return ok(`${name}\n`)
  }
  if (tool === 'cp' && args[0] === '-p') {
    const text = files.get(args[1]!)
    if (text === undefined) return { exitCode: 1, stdout: '', stderr: `cp: cannot stat '${args[1]}'` }
    files.set(args[2]!, text)
    return ok()
  }
  if (tool === 'mv' && args[0] === '-f') {
    files.set(args[2]!, files.get(args[1]!)!)
    files.delete(args[1]!)
    moved?.(args[2]!)
    return ok()
  }
  if (tool === 'rm' && args[0] === '-f') {
    files.delete(args[1]!)
    return ok()
  }
  return undefined
}

/** For a world with no other commands. */
export const tempTools = (on: On, files: Map<string, string>, moved?: (path: string) => void) =>
  on('process.run', (_, e) => {
    const r = tempTool(files, e.argv, moved)
    if (!r) throw new Error(`no such command here: ${e.argv.join(' ')}`)
    return { value: r as never }
  })
