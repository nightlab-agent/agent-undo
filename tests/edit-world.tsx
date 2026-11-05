// A world for the hunk undo: an in-memory disk under /proj, and Edit and Write that answer as the engine does
// (tests/engine.tsx). A test changes `files` itself where the person would save from their own editor.
import type { TestBody } from 'claude-code/testing'
import { editResult, writeResult } from './engine'
import { tempTools } from './temp-tools'

type On = Parameters<TestBody>[1]
type $T = Parameters<TestBody>[0]

export const ROOT = '/proj'
export const at = (file: string) => `${ROOT}/${file}`

type Answer = (result: Record<string, unknown>) => Record<string, unknown>

const rawBytes = new WeakMap<Map<string, string>, Map<string, number[] | 'unreadable'>>()
/** What `$.fs.read(path, { as: 'bytes' })` answers for a file, where it is not the text's UTF-8. */
export const bytesOf = (files: Map<string, string>) => rawBytes.get(files)!

/** `answer` changes a tool's result, for what the fake does not build itself (a diff that timed out). */
export const editWorld = (on: On, files0: Record<string, string> = {}, answer: Answer = r => r) => {
  const files = new Map(Object.entries(files0).map(([k, v]) => [at(k), v]))
  rawBytes.set(files, new Map())
  on('session.root', () => ({ value: ROOT }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'agent-undo' } }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const t = files.get(e.path)
    if (t === undefined) throw new Error('ENOENT')
    if ((e as { as?: string }).as !== 'bytes') return { value: t }
    const raw = bytesOf(files).get(e.path) ?? [...new TextEncoder().encode(t)]
    if (raw === 'unreadable') throw new Error('EIO')
    return { value: { base64: btoa(String.fromCharCode(...raw)) } } as never
  })
  on('fs.write', (_, e) => { files.set(e.path, e.text); return { value: undefined } })
  tempTools(on, files)
  on('tool.call', (_, e) => {
    const x = e as unknown as { tool: string; file_path: string; old_string?: string; new_string?: string; content?: string; replace_all?: boolean }
    const was = files.get(x.file_path)
    if (x.tool === 'Edit') {
      if (was === undefined || !was.replaceAll('\r\n', '\n').includes(x.old_string!)) return { result: 'String to replace not found', isError: true } as never
      const { disk, result } = editResult(was, x as Parameters<typeof editResult>[1])
      files.set(x.file_path, disk)
      return { result: answer(result) } as never
    }
    const result = writeResult(was, x as Parameters<typeof writeResult>[1])
    files.set(x.file_path, x.content!)
    return { result: answer(result) } as never
  })
  return files
}

export const start = ($: $T) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
export const edit = ($: $T, file: string, old_string: string, new_string: string, more: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Edit', file_path: at(file), old_string, new_string, ...more } as never)
export const write = ($: $T, file: string, content: string, more: Record<string, unknown> = {}) =>
  $.tool.call({ tool: 'Write', file_path: at(file), content, ...more } as never)
export const undo = async ($: $T, args: string) => ((await $.command.run({ command: 'agent-undo', args } as never)) as { text: string }).text
