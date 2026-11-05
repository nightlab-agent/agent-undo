// Run with node --test tests/release-audit.test.mjs. No packages or network needed.
// Compile the unchanged hooks into a disposable directory. Only atom/read/update
// and engine dispatch/state/store are doubles; files, links, chmod and Git are real.
// This does not claim to run a Claude session or reproduce engine cancellation.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await fs.mkdtemp('/tmp/agent-undo-release-audit-')
after(() => fs.rm(scratch, { recursive: true, force: true }))
const compiled = join(scratch, 'compiled')
const types = process.env.CC_TYPES ?? join(source, '.claude-plugin/types/claude-code/index.d.ts')
execFileSync(process.env.TSC ?? 'tsc', [
  '--target', 'es2023', '--module', 'node16', '--moduleResolution', 'node16',
  '--jsx', 'react', '--jsxFactory', 'h', '--skipLibCheck', '--strict',
  '--rootDir', source, '--outDir', compiled, types,
  ...['register', 'common', 'shared', 'hunks', 'shell', 'shell-undo'].map(n => join(source, `hooks/${n}.tsx`)),
  join(source, 'types/index.d.ts'), join(source, 'tests/engine.tsx'),
], { cwd: scratch, stdio: 'pipe' })
await fs.mkdir(join(compiled, 'node_modules/claude-code'), { recursive: true })
await fs.writeFile(join(compiled, 'node_modules/claude-code/index.js'), `
exports.atom = (address, initial) => ({ address, initial });
exports.read = async ($, a) => structuredClone($._atoms.get(a.address.key) ?? a.initial);
exports.update = async ($, a, f) => {
  const next = f(await exports.read($, a));
  $._atoms.set(a.address.key, structuredClone(next));
};
`)
const require = createRequire(join(compiled, 'entry.cjs'))
let session = 0

async function world(t, initial = {}) {
  // Module queues and shell windows are process-local in the real tool too.
  for (const key of Object.keys(require.cache)) if (key.startsWith(compiled)) delete require.cache[key]
  const { register } = require(join(compiled, 'hooks/register.js'))
  const { editResult, writeResult } = require(join(compiled, 'tests/engine.js'))
  const root = await fs.mkdtemp(join(scratch, 'repo-'))
  for (const [name, text] of Object.entries(initial)) {
    await fs.mkdir(dirname(join(root, name)), { recursive: true })
    await fs.writeFile(join(root, name), text)
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  git('config', 'core.autocrlf', 'false')
  git('add', '-A')
  git('commit', '-qm', 'initial', '--allow-empty')
  const handlers = []
  register((event, filter, handler) => {
    if (typeof filter === 'function') [filter, handler] = [undefined, filter]
    handlers.push({ event, filter, handler })
  })
  const disk = new Map()
  const sid = `audit-${++session}`
  const w = { root, git, disk, beforeWrite: undefined, afterRead: undefined, afterHash: undefined, afterStoreGet: undefined }
  const $ = {
    _atoms: new Map(),
    session: { root: async () => root, id: async () => sid },
    store: {
      get: async key => {
        const value = structuredClone(disk.get(key))
        await w.afterStoreGet?.(key)
        return value
      },
      set: async (key, value) => { disk.set(key, structuredClone(value)) },
      delete: async key => { disk.delete(key) }, keys: async () => [...disk.keys()],
    },
    command: { register: async () => ({ command: 'agent-undo' }) },
    tool: { register: async () => ({ tool: 'mcp__agent-undo__undo' }) },
    ui: { status: () => {} },
    clock: { sleep: (ms, options) => sleep(ms, undefined, { signal: options?.signal }) },
    fs: {
      exists: async path => { try { await fs.stat(path); return true } catch { return false } },
      stat: async (path, options) => {
        const own = await fs.lstat(path)
        const s = await fs.stat(path).catch(() => undefined)
        return { kind: s?.isFile() ? 'file' : s?.isDirectory() ? 'dir' : 'other',
          isLink: own.isSymbolicLink(), size: s?.size ?? 0, mtimeMs: s?.mtimeMs ?? 0,
          ...(options?.resolve && s ? { realPath: await fs.realpath(path) } : {}) }
      },
      read: async (path, options) => {
        const b = await fs.readFile(path)
        if (b.length > 4 * 1024 * 1024) throw new Error('read over 4 MiB')
        if (options?.as === 'bytes') return { base64: b.toString('base64') }
        await w.afterRead?.(path)
        return b.toString('utf8')
      },
      write: async (path, text) => {
        if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('write over 4 MiB')
        await w.beforeWrite?.(path, text)
        await fs.mkdir(dirname(path), { recursive: true })
        await fs.writeFile(path, text)
      },
    },
    process: { run: async (argv, init) => {
      let r
      try {
        r = { exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), {
          cwd: init?.cwd ?? root, env: { ...process.env, ...init?.env },
          encoding: 'utf8', timeout: init?.timeoutMs ?? 30000, stdio: ['pipe', 'pipe', 'pipe'],
        }), stderr: '' }
      } catch (e) {
        r = { exitCode: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message) }
      }
      if (argv[1] === 'hash-object') await w.afterHash?.()
      return r
    } },
  }
  async function dispatch(event, e, leaf) {
    const matches = handlers.filter(h => h.event === event && (!h.filter || Object.entries(h.filter).every(([k, v]) => e[k] === v)))
    const run = i => {
      if (i === matches.length) return leaf(e)
      const next = Object.assign(input => dispatchFrom(i + 1, input), {
        budget: { remainingMs: 10000 }, signal: new AbortController().signal,
      })
      return matches[i].handler($, e, next)
    }
    const dispatchFrom = (i, input) => {
      assert.equal(input, e, 'hooks preserve the call object')
      return run(i)
    }
    return run(0)
  }
  w.call = async (tool, args) => {
    const e = { tool, tool_use_id: `tool-${++session}`, ...args }
    return dispatch('tool.call', e, async () => {
      await dispatch('tool.check', { tool, tool_use_id: e.tool_use_id, input: args }, async () => ({ decision: 'allow' }))
      if (tool === 'Bash') {
        const result = await $.process.run(['bash', '-c', args.command], { cwd: root })
        return { result, ...(result.exitCode ? { isError: true } : {}) }
      }
      const path = args.file_path
      const was = await fs.readFile(path, 'utf8').catch(() => undefined)
      if (tool === 'Edit') {
        const out = editResult(was, args)
        await fs.writeFile(path, out.disk)
        return { result: out.result }
      }
      const result = writeResult(was, args)
      await fs.writeFile(path, args.content)
      return { result }
    })
  }
  w.undo = async ref => {
    const out = await dispatch('command.run', { command: 'agent-undo', args: ref }, async () => { throw new Error('unhandled command') })
    t.diagnostic(out.text)
    return out.text
  }
  w.read = name => fs.readFile(join(root, name), 'utf8')
  w.write = (name, text) => fs.writeFile(join(root, name), text)
  w.edit = (name, a, b) => w.call('Edit', { file_path: join(root, name), old_string: a, new_string: b })
  w.bash = command => w.call('Bash', { command })
  await dispatch('session.start', { cwd: root, surface: 'terminal', isInteractive: true }, async e => ({ cwd: e.cwd }))
  return w
}

test('A1: a save after the undo read must survive', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  w.afterRead = () => w.write('a.txt', 'MY UNSAVED WORK\n')
  await w.undo('1')
  assert.equal(await w.read('a.txt'), 'MY UNSAVED WORK\n')
})
test('A1 comparison: a save before the undo read is refused', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  await w.write('a.txt', 'MY UNSAVED WORK\n')
  assert.match(await w.undo('1'), /nothing changed/)
  assert.equal(await w.read('a.txt'), 'MY UNSAVED WORK\n')
})
// Open on purpose: git has no compare-and-restore, so a save in the milliseconds between this hash and the restore is
// lost. README, Limits. A save during the wait for the index is seen: tests/review-crz.test.tsx.
test('A1 shell: a save after hash-object must survive too', { todo: 'known limit, a window of one process start' }, async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  w.afterHash = () => w.write('a.txt', 'MY SAVED WORK\n')
  await w.undo('1')
  assert.equal(await w.read('a.txt'), 'MY SAVED WORK\n')
})
test('A1 shell comparison: a save before hash-object is refused', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  await w.write('a.txt', 'MY SAVED WORK\n')
  assert.match(await w.undo('1'), /nothing changed/)
  assert.equal(await w.read('a.txt'), 'MY SAVED WORK\n')
})

test('A2: a shell undo must keep a later CRLF conversion that git normalizes away', async t => {
  const w = await world(t, { 'a.txt': 'one\n', '.gitattributes': '*.txt text eol=lf\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  await w.write('a.txt', 'ONE\r\n')
  await w.undo('1')
  assert.equal(await w.read('a.txt'), 'ONE\r\n')
})
test('A2 comparison: a later textual change has a different git hash and is refused', async t => {
  const w = await world(t, { 'a.txt': 'one\n', '.gitattributes': '*.txt text eol=lf\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  await w.write('a.txt', 'mine\r\n')
  assert.match(await w.undo('1'), /nothing changed/)
  assert.equal(await w.read('a.txt'), 'mine\r\n')
})
test('A2 ident: a later note inside an Id expansion must not be normalized away', async t => {
  const w = await world(t, { 'a.txt': 'one\n$Id$\n', '.gitattributes': '*.txt ident\n' })
  await w.bash("printf 'ONE\\n$Id$\\n' > a.txt")
  await w.write('a.txt', 'ONE\n$Id: MY NOTES $\n')
  await w.undo('1')
  assert.equal(await w.read('a.txt'), 'ONE\n$Id: MY NOTES $\n')
})
test('A2 ident comparison: a note outside the Id expansion is refused', async t => {
  const w = await world(t, { 'a.txt': 'one\n$Id$\n', '.gitattributes': '*.txt ident\n' })
  await w.bash("printf 'ONE\\n$Id$\\n' > a.txt")
  await w.write('a.txt', 'ONE\nMY NOTES\n$Id$\n')
  assert.match(await w.undo('1'), /nothing changed/)
  assert.equal(await w.read('a.txt'), 'ONE\nMY NOTES\n$Id$\n')
})

test('A3: an Edit undo must not follow a replacement symlink into another file', async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'personal.txt': 'ONE\n' })
  await w.edit('a.txt', 'one', 'ONE')
  await fs.unlink(join(w.root, 'a.txt'))
  await fs.symlink('personal.txt', join(w.root, 'a.txt'))
  await w.undo('1')
  assert.equal(await w.read('personal.txt'), 'ONE\n')
})
test('A3 comparison: an undo of the original regular file leaves the other file alone', async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'personal.txt': 'ONE\n' })
  await w.edit('a.txt', 'one', 'ONE')
  assert.match(await w.undo('1'), /undid/)
  assert.equal(await w.read('a.txt'), 'one\n')
  assert.equal(await w.read('personal.txt'), 'ONE\n')
})

test('A4: a shell undo must not delete a replacement symlink with matching target bytes', async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'personal.txt': 'ONE\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  await fs.unlink(join(w.root, 'a.txt'))
  await fs.symlink('personal.txt', join(w.root, 'a.txt'))
  await w.undo('1')
  assert.equal((await fs.lstat(join(w.root, 'a.txt'))).isSymbolicLink(), true)
})
test('A4 comparison: a replacement symlink with different target bytes is refused', async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'personal.txt': 'mine\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  await fs.unlink(join(w.root, 'a.txt'))
  await fs.symlink('personal.txt', join(w.root, 'a.txt'))
  assert.match(await w.undo('1'), /nothing changed/)
  assert.equal((await fs.lstat(join(w.root, 'a.txt'))).isSymbolicLink(), true)
})

test('A5: a shell undo must keep permissions the person changed afterwards', async t => {
  const w = await world(t, { 'run.sh': 'echo one\n' })
  await w.bash("printf 'echo ONE\\n' > run.sh")
  await fs.chmod(join(w.root, 'run.sh'), 0o755)
  await w.undo('1')
  assert.equal((await fs.stat(join(w.root, 'run.sh'))).mode & 0o111, 0o111)
})
test('A5 comparison: an unchanged executable file is restored and remains executable', async t => {
  const w = await world(t, { 'run.sh': 'echo one\n' })
  await fs.chmod(join(w.root, 'run.sh'), 0o755)
  await w.bash("printf 'echo ONE\\n' > run.sh")
  assert.match(await w.undo('1'), /undid/)
  assert.equal((await fs.stat(join(w.root, 'run.sh'))).mode & 0o111, 0o111)
})

// ENGINE-NOTES.md says the engine uses writeFile, which truncates before writing.
// Kill that real file operation immediately after open('w'); state/store still run
// in this harness, so this tests on-disk crash safety, not Claude's signal handling.
test('A6: a write killed after truncation must not lose the whole file', async t => {
  const original = 'one\n' + 'context\n'.repeat(12)
  const w = await world(t, { 'a.txt': original })
  await w.edit('a.txt', 'one', 'ONE')
  await w.write('a.txt', await w.read('a.txt') + 'UNCOMMITTED PERSONAL WORK\n')
  assert.equal(w.git('show', 'HEAD:a.txt').includes('UNCOMMITTED'), false)
  const before = await w.read('a.txt')
  w.beforeWrite = path => execFileSync(process.execPath, ['-e',
    "require('node:fs').openSync(process.argv[1], 'w'); process.kill(process.pid, 'SIGKILL')", path])
  await assert.rejects(w.undo('1'))
  assert.equal(await w.read('a.txt'), before)
})
test('A6 comparison: a write refused before opening the file preserves its content', async t => {
  const original = 'one\n' + 'context\n'.repeat(12)
  const w = await world(t, { 'a.txt': original })
  await w.edit('a.txt', 'one', 'ONE')
  await w.write('a.txt', await w.read('a.txt') + 'UNCOMMITTED PERSONAL WORK\n')
  const before = await w.read('a.txt')
  w.beforeWrite = () => { throw new Error('EACCES before open') }
  await assert.rejects(w.undo('1'))
  assert.equal(await w.read('a.txt'), before)
})

test('repeat: a completed undo is not applied twice', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  assert.match(await w.undo('1'), /undid/)
  assert.match(await w.undo('1'), /already undone/)
  assert.equal(await w.read('a.txt'), 'one\n')
})
test('concurrent: two undos in one process take turns', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const answers = await Promise.all([w.undo('1'), w.undo('1')])
  assert.match(answers[0], /undid/)
  assert.match(answers[1], /already undone/)
  assert.equal(await w.read('a.txt'), 'one\n')
})

let archiveFiles
const packedFiles = () => {
  if (!archiveFiles) {
    const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', scratch], {
      cwd: source, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }))
    archiveFiles = execFileSync('tar', ['-tzf', join(scratch, pack.filename)], { encoding: 'utf8' })
      .trim().split('\n').map(path => path.replace(/^package\//, ''))
  }
  return archiveFiles
}
test('A7: the npm package must ship the hunk module imported by register', () => {
  assert.ok(packedFiles().includes('hooks/hunks.tsx'), 'npm archive is missing hooks/hunks.tsx')
})
test('A7 comparison: the npm package ships the other hook modules', () => {
  const files = packedFiles()
  for (const name of ['register', 'common', 'shared', 'shell']) assert.ok(files.includes(`hooks/${name}.tsx`))
})

// The unrun review5-later.test.txt already describes this interleaving. Model
// another writer's completed two-key save at the boundary of a store.get reply;
// store has no transaction or compare-and-delete in CC_TYPES:3452-3480.
async function eviction(t, late) {
  const w = await world(t, { 'a.txt': 'one\n' })
  for (let n = 1; n <= 5; n++) {
    w.disk.set(`at:old${n}`, n * 1000)
    w.disk.set(`changes:old${n}`, { shape: 'changes-3', list: [] })
  }
  const refresh = () => {
    w.disk.set('at:old1', Date.now())
    w.disk.set('changes:old1', { shape: 'changes-3', list: [{
      n: 1, at: new Date().toISOString(), tool: 'Edit', file: 'fresh.txt', hunks: [],
    }] })
  }
  if (late) {
    w.afterStoreGet = key => {
      if (key !== 'at:old1') return
      w.afterStoreGet = undefined
      refresh()
    }
  } else refresh()
  await w.edit('a.txt', 'one', 'ONE')
  return w
}
test('A8: eviction must keep a session refreshed after its timestamp was read', async t => {
  const w = await eviction(t, true)
  assert.equal(w.disk.get('changes:old1')?.list[0]?.file, 'fresh.txt')
})
test('A8 comparison: eviction keeps a session refreshed before its timestamp was read', async t => {
  const w = await eviction(t, false)
  assert.equal(w.disk.get('changes:old1')?.list[0]?.file, 'fresh.txt')
  assert.equal(w.disk.has('changes:old2'), false)
})
