// Run with node --test tests/release-audit2.test.mjs. No packages or network needed.
// Compile the unchanged hooks into a disposable directory. Only atom/read/update
// and engine dispatch/state/store are doubles; files, links, chmod and Git are real.
// This does not claim to run a Claude session or reproduce engine cancellation.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, fork } from 'node:child_process'
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

async function world(t, initial = {}, options = {}) {
  // Module queues and shell windows are process-local in the real tool too.
  for (const key of Object.keys(require.cache)) if (key.startsWith(compiled)) delete require.cache[key]
  const { register } = require(join(compiled, 'hooks/register.js'))
  const { editResult, writeResult } = require(join(compiled, 'tests/engine.js'))
  const root = options.root ?? await fs.mkdtemp(join(scratch, 'repo-'))
  for (const [name, text] of Object.entries(initial)) {
    await fs.mkdir(dirname(join(root, name)), { recursive: true })
    await fs.writeFile(join(root, name), text)
  }
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  if (!options.root) {
    git('init', '-q')
    git('config', 'user.email', 'test@example.invalid')
    git('config', 'user.name', 'test')
    git('config', 'core.autocrlf', 'false')
    git('add', '-A')
    git('commit', '-qm', 'initial', '--allow-empty')
  }
  const handlers = []
  register((event, filter, handler) => {
    if (typeof filter === 'function') [filter, handler] = [undefined, filter]
    handlers.push({ event, filter, handler })
  })
  const disk = new Map()
  const sid = `audit-${process.pid}-${++session}`
  const w = { root, git, disk, commands: [], results: [], permission: 'allow', beforeWrite: undefined, afterRead: undefined, afterHash: undefined, afterStoreGet: undefined }
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
    tool: { register: async () => ({ tool: 'mcp__agent-undo__undo' }), check: async e => { w.checks.push(e); if (w.permission instanceof Error) throw w.permission; return { decision: w.permission } } },
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
      w.commands.push({ argv, init })
      await w.beforeProcess?.(argv, init)
      let r
      try {
        r = { exitCode: 0, stdout: execFileSync(argv[0], argv.slice(1), {
          cwd: init?.cwd ?? root, env: { ...process.env, ...init?.env },
          encoding: 'utf8', timeout: init?.timeoutMs ?? 30000, stdio: ['pipe', 'pipe', 'pipe'],
        }), stderr: '' }
      } catch (e) {
        // As $.process.run: it rejects when a command cannot start or is still running at the timeout (a spawn error or
        // ETIMEDOUT here), and a child ended by a signal reads as exit code 1.
        if (typeof e.code === 'string') throw e
        r = { exitCode: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? e.message) }
      }
      w.results.push({ argv: [...argv], ...r })
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
  w.checks = []
  w.engine = $
  w.tag = require(join(compiled, 'hooks/shell.js')).INDEX_TAG
  w.dispatch = dispatch
  w.end = () => dispatch('session.end', { reason: 'exit', sessionId: sid }, async () => ({}))
  w.toolUndo = ref => dispatch('tool.call', { tool: 'mcp__agent-undo__undo', ref }, async () => { throw new Error('undo leaked to engine') })
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

// Each child loads its own module state and drives the same hooks on one checkout.
// IPC barriers hold a real command between its before and after snapshots.
if (process.argv[2] === '--worker') {
  const w = await world({ diagnostic() {} }, {}, { root: process.argv[3] })
  process.on('message', async message => {
    try {
      let value
      if (message.op === 'repo') {
        const { repoOf } = require(join(compiled, 'hooks/shell.js'))
        value = (await repoOf({ ...w.engine }))?.index
      } else if (message.op === 'bash') value = await w.bash(message.command)
      else if (message.op === 'edit') value = await w.edit('a.txt', 'one', 'ONE')
      else if (message.op === 'kill-before-rename') {
        w.beforeProcess = async argv => {
          if (argv[0] !== 'mv') return
          process.kill(process.pid, 'SIGKILL')
          await new Promise(() => {})
        }
        value = await w.undo('1')
      }
      else if (message.op === 'undo') value = await w.undo(message.ref)
      else if (message.op === 'list') value = await w.undo('list')
      else if (message.op === 'end') value = await w.end()
      process.send({ id: message.id, value, commands: w.commands })
    } catch (e) { process.send({ id: message.id, error: String(e) }) }
  })
  process.send({ ready: true, scratch })
} else {

async function worker(t, root) {
  const child = fork(fileURLToPath(import.meta.url), ['--worker', root], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let errors = ''
  child.stderr.on('data', b => { errors += b })
  t.after(() => child.kill('SIGKILL'))
  const started = await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('exit', code => reject(new Error(`worker exited ${code}: ${errors}`)))
    child.once('error', reject)
  })
  t.after(() => fs.rm(started.scratch, { recursive: true, force: true }))
  let id = 0
  return {
    child,
    rpc(op, args = {}) {
      const request = ++id
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.off('message', answer); reject(new Error(`worker ${op} timed out: ${errors}`)) }, 20000)
        const answer = message => {
          if (message.id !== request) return
          clearTimeout(timer)
          child.off('message', answer)
          if (message.error) reject(new Error(message.error))
          else resolve(message)
        }
        child.on('message', answer)
        child.send({ op, id: request, ...args })
      })
    },
  }
}

async function untilFile(path) {
  for (let n = 0; n < 1000; n++) {
    if (await fs.stat(path).catch(() => undefined)) return
    await sleep(10)
  }
  throw new Error(`barrier not reached: ${path}`)
}

for (const name of ['a.txt', '.hidden', '-dash', 'two words.txt']) {
  test(`putBack: filename ${name.slice(0, 30)} restores bytes and mode through rename`, async t => {
    const w = await world(t, { [name]: 'one\n' })
    await fs.chmod(join(w.root, name), 0o751)
    await w.edit(name, 'one', 'ONE')
    assert.match(await w.undo('1'), /undid/)
    assert.equal(await w.read(name), 'one\n')
    assert.equal((await fs.stat(join(w.root, name))).mode & 0o777, 0o751)
    assert.ok(w.commands.some(c => c.argv[0] === 'mv'), 'atomic rename must run')
  })
}

test('putBack: a linked folder keeps its link and writes the original target', async t => {
  const w = await world(t, { 'real/a.txt': 'one\n' })
  await fs.symlink('real', join(w.root, 'linked'))
  await w.edit('linked/a.txt', 'one', 'ONE')
  assert.match(await w.undo('1'), /undid/)
  assert.equal(await w.read('real/a.txt'), 'one\n')
  assert.equal((await fs.lstat(join(w.root, 'linked'))).isSymbolicLink(), true)
  assert.ok(w.commands.some(c => c.argv[0] === 'mv'))
})

test('putBack: a link replaced during the first read must not undo an unrelated target', async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'personal.txt': 'ONE\n' })
  await w.edit('a.txt', 'one', 'ONE')
  w.afterRead = async path => {
    if (path !== join(w.root, 'a.txt')) return
    w.afterRead = undefined
    await fs.unlink(path)
    await fs.symlink('personal.txt', path)
  }
  await w.undo('1')
  assert.equal(await w.read('personal.txt'), 'ONE\n')
})

for (const readonly of [false, true]) {
  test(`putBack crash: ${readonly ? 'read-only' : 'writable comparison'} folder`, async t => {
    const w = await world(t, { 'dir/a.txt': 'one\n' })
    await w.edit('dir/a.txt', 'one', 'ONE')
    await fs.chmod(join(w.root, 'dir'), readonly ? 0o555 : 0o755)
    // A real process dies just after truncating whichever path putBack writes.
    w.beforeWrite = path => execFileSync(process.execPath, ['-e',
      "require('node:fs').openSync(process.argv[1], 'w'); process.kill(process.pid, 'SIGKILL')", path])
    try {
      if (readonly) assert.match(await w.undo('1'), /nothing changed/)
      else await assert.rejects(w.undo('1'))
      assert.equal(await w.read('dir/a.txt'), 'ONE\n', 'a killed undo must leave the user file whole')
    } finally { await fs.chmod(join(w.root, 'dir'), 0o755) }
  })
}

test('putBack: a writable file in a read-only folder is refused: no write that empties it first', async t => {
  const w = await world(t, { 'dir/a.txt': 'one\n' })
  await w.edit('dir/a.txt', 'one', 'ONE')
  await fs.chmod(join(w.root, 'dir'), 0o555)
  try {
    assert.match(await w.undo('1'), /could not get a temporary copy beside it.*nothing changed/)
    assert.equal(await w.read('dir/a.txt'), 'ONE\n')
  } finally { await fs.chmod(join(w.root, 'dir'), 0o755) }
})

test('putBack: mode and inode on an ordinary completed rename', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  await fs.chmod(join(w.root, 'a.txt'), 0o640)
  const before = await fs.stat(join(w.root, 'a.txt'))
  assert.match(await w.undo('1'), /undid/)
  const after = await fs.stat(join(w.root, 'a.txt'))
  assert.equal(after.mode & 0o777, 0o640)
  assert.notEqual(after.ino, before.ino)
  assert.deepEqual((await fs.readdir(w.root)).filter(n => n.startsWith('.agent-undo-')), [])
})

test('putBack crash: a long valid filename must also remain whole', async t => {
  const name = 'x'.repeat(240)
  const w = await world(t, { [name]: 'one\n' })
  await w.edit(name, 'one', 'ONE')
  w.beforeWrite = path => execFileSync(process.execPath, ['-e',
    "require('node:fs').openSync(process.argv[1], 'w'); process.kill(process.pid, 'SIGKILL')", path])
  await assert.rejects(w.undo('1'))
  t.diagnostic(JSON.stringify(w.results.filter(r => r.argv[0] === 'cp')))
  assert.equal(await w.read(name), 'ONE\n')
})

test('putBack comparison: the same long filename completes when uninterrupted', async t => {
  const name = 'x'.repeat(240)
  const w = await world(t, { [name]: 'one\n' })
  await w.edit(name, 'one', 'ONE')
  assert.match(await w.undo('1'), /undid/)
  assert.equal(await w.read(name), 'one\n')
})

for (const collision of ['file', 'link']) {
  test(`putBack: existing temp-name ${collision} must not be overwritten`, async t => {
    const w = await world(t, { 'a.txt': 'one\n', 'personal.txt': 'MY WORK\n' })
    await w.edit('a.txt', 'one', 'ONE')
    const tmp = join(w.root, `.agent-undo-${w.tag}-a.txt`)
    if (collision === 'link') await fs.symlink('personal.txt', tmp)
    else await fs.writeFile(tmp, 'MY WORK\n')
    await w.undo('1')
    assert.equal(await w.read('personal.txt'), 'MY WORK\n')
    assert.equal(await fs.readFile(tmp, 'utf8'), 'MY WORK\n')
  })
}

for (const converted of [false, true]) {
  test(`refusal: text=auto ${converted ? 'later CRLF save' : 'unchanged LF comparison'}`, async t => {
    const w = await world(t, { '.gitattributes': '* text=auto\n', 'a.txt': 'one\n' })
    await w.bash("printf 'ONE\\n' > a.txt")
    if (converted) await w.write('a.txt', 'ONE\r\n')
    assert.match(await w.undo('1'), converted ? /nothing changed/ : /undid/)
    assert.equal(await w.read('a.txt'), converted ? 'ONE\r\n' : 'one\n')
  })
}

for (const autocrlf of ['true', 'input']) {
  test(`refusal: core.autocrlf=${autocrlf} preserves later CRLF bytes`, async t => {
    const w = await world(t, { 'a.txt': 'one\n' })
    w.git('config', 'core.autocrlf', autocrlf)
    await w.bash("printf 'ONE\\n' > a.txt")
    await w.write('a.txt', 'ONE\r\n')
    assert.match(await w.undo('1'), /nothing changed/)
    assert.equal(await w.read('a.txt'), 'ONE\r\n')
  })
}

test('refusal comparison: initial CRLF in text=auto returns with git line endings', async t => {
  const w = await world(t, { '.gitattributes': '* text=auto\n', 'a.txt': 'one\r\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  assert.match(await w.undo('1'), /undid/)
  assert.equal(await w.read('a.txt'), 'one\n')
})

for (const filemode of [true, false]) {
  test(`refusal: later chmod with core.filemode=${filemode}`, async t => {
    const w = await world(t, { 'a.txt': 'one\n' })
    w.git('config', 'core.filemode', String(filemode))
    await w.bash("printf 'ONE\\n' > a.txt")
    await fs.chmod(join(w.root, 'a.txt'), 0o755)
    const out = await w.undo('1')
    assert.equal((await fs.stat(join(w.root, 'a.txt'))).mode & 0o111, 0o111, out)
  })
}

test('refusal comparison: the command itself changes executable mode, undo restores it', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt; chmod +x a.txt")
  assert.match(await w.undo('1'), /undid/)
  assert.equal(await w.read('a.txt'), 'one\n')
  assert.equal((await fs.stat(join(w.root, 'a.txt'))).mode & 0o111, 0)
})

for (const deleted of [false, true]) {
  test(`refusal: ${deleted ? 'deleted' : 'modified'} file beneath a replacement parent link`, async t => {
    const w = await world(t, { 'dir/a.txt': 'one\n', 'dir/keep.txt': 'keep\n' })
    await w.bash(deleted ? 'rm dir/a.txt' : "printf 'ONE\\n' > dir/a.txt")
    await fs.rename(join(w.root, 'dir'), join(w.root, 'moved'))
    await fs.symlink('moved', join(w.root, 'dir'))
    assert.match(await w.undo('1'), /nothing changed/)
    assert.equal((await fs.lstat(join(w.root, 'dir'))).isSymbolicLink(), true)
    assert.equal(await w.read('dir/keep.txt'), 'keep\n')
    if (!deleted) assert.equal(await w.read('dir/a.txt'), 'ONE\n')
    else await assert.rejects(w.read('dir/a.txt'), { code: 'ENOENT' })
  })
}

test('refusal: unreadable file is retained and a retry after chmod succeeds', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  await fs.chmod(join(w.root, 'a.txt'), 0)
  try {
    await assert.rejects(w.read('a.txt'), { code: 'EACCES' })
    assert.match(await w.undo('1'), /nothing changed/)
  } finally { await fs.chmod(join(w.root, 'a.txt'), 0o644) }
  assert.equal(await w.read('a.txt'), 'ONE\n')
  assert.match(await w.undo('1'), /undid/)
})

test('shell restore: real git write failure reports the partially changed file', async t => {
  const w = await world(t, { 'a.txt': 'x'.repeat(300000) })
  await w.bash("printf 'small\\n' > a.txt")
  w.beforeProcess = argv => {
    if (argv[0] === 'git' && argv[1] === 'restore') {
      const args = argv.slice(1)
      argv.splice(0, argv.length, 'bash', '-c', 'ulimit -f 8; trap "" XFSZ; exec git "$@"', 'restore-under-limit', ...args)
    }
  }
  assert.match(await w.undo('1'), /failed part way/)
  assert.notEqual(await w.read('a.txt'), 'small\n')
})

test('shell restore comparison: a missing tree is reported without changing the file', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  w.beforeProcess = argv => {
    if (argv[0] === 'git' && argv[1] === 'restore') argv[2] = '--source=' + 'f'.repeat(40)
  }
  assert.match(await w.undo('1'), /left as is: git said/)
  assert.equal(await w.read('a.txt'), 'ONE\n')
})

for (const decision of ['allow', 'ask', 'deny', 'passthrough']) {
  test(`undo tool: permission ${decision} before file access`, async t => {
    const w = await world(t, { 'a.txt': 'one\n' })
    await w.edit('a.txt', 'one', 'ONE')
    w.permission = decision
    const out = await w.toolUndo('1')
    assert.equal(w.checks.length, 1)
    assert.deepEqual(w.checks[0], { tool: 'mcp__agent-undo__undo', input: { ref: '1' } })
    assert.match(out.result, decision === 'allow' ? /undid/ : /did not allow/)
    assert.equal(await w.read('a.txt'), decision === 'allow' ? 'one\n' : 'ONE\n')
  })
}

test('undo tool: lists without permission; a failed check cannot write', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  w.permission = new Error('permission service failed')
  assert.match((await w.toolUndo('list')).result, /a.txt/)
  assert.equal(w.checks.length, 0)
  await assert.rejects(w.toolUndo('1'), /permission service failed/)
  assert.equal(await w.read('a.txt'), 'ONE\n')
})

test('indices: two real processes on one checkout own different indices and clean only their own', async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  const realIndex = await fs.readFile(join(w.root, '.git/index'))
  const [a, b] = await Promise.all([worker(t, w.root), worker(t, w.root)])
  const [ar, br] = await Promise.all([a.rpc('repo'), b.rpc('repo')])
  assert.notEqual(ar.value, br.value)
  await fs.stat(ar.value)
  await fs.stat(br.value)
  await a.rpc('bash', { command: "printf 'ONE\\n' > a.txt" })
  await b.rpc('bash', { command: "printf 'TWO\\n' > b.txt" })
  assert.match((await a.rpc('undo', { ref: '1' })).value, /undid/)
  assert.match((await b.rpc('undo', { ref: '1' })).value, /undid/)
  await a.rpc('end')
  await a.rpc('end')
  await assert.rejects(fs.stat(ar.value), { code: 'ENOENT' })
  await fs.stat(br.value)
  await b.rpc('end')
  await assert.rejects(fs.stat(br.value), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(join(w.root, '.git/index')), realIndex)
  assert.equal(await w.read('a.txt'), 'one\n')
  assert.equal(await w.read('b.txt'), 'two\n')
})

test('indices: find removes an old killed process index, keeps a fresh one and leaves the real index alone', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  const index = join(w.root, '.git/index')
  const before = await fs.readFile(index)
  const old = join(w.root, '.git/agent-undo.index.deadbeef')
  const fresh = join(w.root, '.git/agent-undo.index.fresh123')
  const outside = join(scratch, `outside-${session}`)
  await fs.writeFile(old, 'stale')
  await fs.writeFile(fresh, 'live')
  await fs.writeFile(outside, 'keep')
  const link = join(w.root, '.git/agent-undo.index.old-link')
  await fs.symlink(outside, link)
  const then = new Date(Date.now() - 9 * 86400000)
  await fs.utimes(old, then, then)
  await fs.lutimes(link, then, then)
  const p = await worker(t, w.root)
  await p.rpc('repo')
  await assert.rejects(fs.lstat(old), { code: 'ENOENT' })
  await assert.rejects(fs.lstat(link), { code: 'ENOENT' })
  assert.equal(await fs.readFile(fresh, 'utf8'), 'live')
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep')
  assert.deepEqual(await fs.readFile(index), before)
})

test('indices: a linked git worktree snapshots, restores and removes its own index', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  const other = join(scratch, `worktree-${session}`)
  w.git('worktree', 'add', '-q', '-b', 'audit-linked', other)
  const p = await worker(t, other)
  const { value: index } = await p.rpc('repo')
  assert.match(index, /\/worktrees\/[^/]+\/agent-undo.index\./)
  const real = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { cwd: other, encoding: 'utf8' }).trim()
  const before = await fs.readFile(real)
  await p.rpc('bash', { command: "printf 'ONE\\n' > a.txt" })
  assert.match((await p.rpc('undo', { ref: '1' })).value, /undid/)
  assert.equal(await fs.readFile(join(other, 'a.txt'), 'utf8'), 'one\n')
  await p.rpc('end')
  await assert.rejects(fs.stat(index), { code: 'ENOENT' })
  assert.deepEqual(await fs.readFile(real), before)
})

test('crash: killing the hook process before rename leaves the file whole and a removable temp', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  const p = await worker(t, w.root)
  await p.rpc('edit')
  const { value: index } = await p.rpc('repo')
  const died = new Promise(resolve => p.child.once('exit', (code, signal) => resolve({ code, signal })))
  p.child.send({ id: 999, op: 'kill-before-rename' })
  assert.deepEqual(await died, { code: null, signal: 'SIGKILL' })
  assert.equal(await w.read('a.txt'), 'ONE\n')
  const temps = (await fs.readdir(w.root)).filter(n => n.startsWith('.agent-undo-'))
  assert.equal(temps.length, 1)
  assert.equal(await w.read(temps[0]), 'one\n')
  await fs.stat(index)
  await fs.unlink(join(w.root, temps[0]))
})

// A stated limit (README): nothing tells one process that another's command ran inside its own window.
test('concurrent processes: an overlapping command must not take the other process write', { todo: 'a README limit: undo the one file' }, async t => {
  const w = await world(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' })
  const [a, b] = await Promise.all([worker(t, w.root), worker(t, w.root)])
  const ready = join(scratch, `ready-${session}`)
  const release = join(scratch, `release-${session}`)
  const running = a.rpc('bash', { command: `printf 'ONE\\n' > a.txt; touch '${ready}'; while [ ! -e '${release}' ]; do sleep 0.01; done` })
  try {
    await untilFile(ready)
    await b.rpc('bash', { command: "printf 'TWO\\n' > b.txt" })
  } finally { await fs.writeFile(release, '') }
  await running
  const list = (await a.rpc('list')).value
  t.diagnostic(list)
  const undo = (await a.rpc('undo', { ref: '1' })).value
  assert.equal(await w.read('b.txt'), 'TWO\n', `process A must not undo process B's write: ${undo}`)
})

test('repeat and concurrent tool undo in one process: exactly one write', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  const answers = await Promise.all([w.toolUndo('1'), w.toolUndo('1')])
  assert.match(answers[0].result, /undid/)
  assert.match(answers[1].result, /already undone/)
  assert.equal(await w.read('a.txt'), 'one\n')
  assert.equal(w.commands.filter(c => c.argv[0] === 'mv').length, 1)
})

for (const refreshOnRead of [1, 2]) {
  // Read 2 is a stated limit (README): no store lock; the session's next save writes its copy again, no file is touched.
  test(`A8: refresh during timestamp read ${refreshOnRead} must survive eviction`, { todo: refreshOnRead === 2 && 'a README limit' }, async t => {
    const w = await world(t, { 'a.txt': 'one\n' })
    for (let n = 1; n <= 5; n++) {
      w.disk.set(`at:old${n}`, n * 1000)
      w.disk.set(`changes:old${n}`, { shape: 'changes-3', list: [] })
    }
    let reads = 0
    w.afterStoreGet = key => {
      if (key !== 'at:old1' || ++reads !== refreshOnRead) return
      w.disk.set('at:old1', Date.now())
      w.disk.set('changes:old1', { shape: 'changes-3', list: [{
        n: 1, at: new Date().toISOString(), tool: 'Edit', file: 'fresh.txt', hunks: [],
      }] })
    }
    await w.edit('a.txt', 'one', 'ONE')
    assert.equal(w.disk.get('changes:old1')?.list[0]?.file, 'fresh.txt')
  })
}


// ---- A shell undo keeps the file's permissions (git recreates the file at the umask mode).
const mode = async (w, n) => (await fs.stat(join(w.root, n))).mode & 0o7777
const wrapRun = (w, f) => { const run = w.engine.process.run; w.engine.process.run = (argv, init) => f(argv, init, run) }
const octal = n => n.toString(8)
for (const start of [0o600, 0o640, 0o644, 0o664, 0o1750]) {
  test(`permissions: a ${octal(start)} file keeps them through a shell undo`, async t => {
    const w = await world(t, { 'secret.env': 'token=old\n' })
    await fs.chmod(join(w.root, 'secret.env'), start)
    await w.bash('echo token=new >> secret.env')
    assert.equal(await mode(w, 'secret.env'), start)
    assert.match(await w.undo('1'), /undid/)
    assert.equal(await w.read('secret.env'), 'token=old\n')
    assert.equal(octal(await mode(w, 'secret.env')), octal(start))
  })
}
test('permissions: bits narrowed after the command stay narrow', async t => {
  const w = await world(t, { 'secret.env': 'token=old\n' })
  await w.bash('echo token=new >> secret.env')
  await fs.chmod(join(w.root, 'secret.env'), 0o600)
  assert.match(await w.undo('1'), /undid/)
  assert.equal(octal(await mode(w, 'secret.env')), '600')
})
test('permissions comparison: an executable bit set after the command is refused', async t => {
  const w = await world(t, { 'run.sh': 'old\n' })
  await w.bash('echo new >> run.sh')
  await fs.chmod(join(w.root, 'run.sh'), 0o755)
  assert.match(await w.undo('1'), /permissions.*changed/)
  assert.equal(octal(await mode(w, 'run.sh')), '755')
})
test('permissions: an owner-only script stays owner-only', async t => {
  const w = await world(t, { 'run.sh': 'old\n' })
  await fs.chmod(join(w.root, 'run.sh'), 0o700)
  w.git('add', '-A'); w.git('commit', '-qm', 'x')
  await w.bash('echo new >> run.sh')
  assert.match(await w.undo('1'), /undid/)
  assert.equal(octal(await mode(w, 'run.sh')), '700')
})
test('permissions: a command that added the bit loses it, everywhere, and the rest stays', async t => {
  const w = await world(t, { 'run.sh': 'old\n' })
  await fs.chmod(join(w.root, 'run.sh'), 0o600)
  await w.bash('echo new >> run.sh; chmod 711 run.sh')
  assert.match(await w.undo('1'), /undid/)
  assert.equal(octal(await mode(w, 'run.sh')), '600')
})
test('permissions: a command that took the bit away gives it back only where r is', async t => {
  const w = await world(t, { 'run.sh': 'old\n' })
  await fs.chmod(join(w.root, 'run.sh'), 0o755)
  w.git('add', '-A'); w.git('commit', '-qm', 'x')
  await w.bash('echo new >> run.sh; chmod 640 run.sh')
  assert.match(await w.undo('1'), /undid/)
  assert.equal(octal(await mode(w, 'run.sh')), '750')
})
test('permissions: with core.filemode false the old bits win whole', async t => {
  const w = await world(t, { 'run.sh': 'old\n' })
  w.git('config', 'core.filemode', 'false')
  await fs.chmod(join(w.root, 'run.sh'), 0o750)
  await w.bash('echo new >> run.sh')
  assert.match(await w.undo('1'), /undid/)
  assert.equal(octal(await mode(w, 'run.sh')), '750')
})
test('permissions: BSD stat answers where GNU stat does not (macOS)', async t => {
  const w = await world(t, { 'secret.env': 'old\n' })
  await fs.chmod(join(w.root, 'secret.env'), 0o600)
  await w.bash('echo new >> secret.env')
  wrapRun(w, (argv, init, run) => argv[0] !== 'stat' ? run(argv, init)
    : argv[1] === '-c' ? Promise.resolve({ exitCode: 1, stdout: '', stderr: "stat: illegal option -- c" })
    : run(['stat', '-c', '%a', ...argv.slice(3)], init))
  assert.match(await w.undo('1'), /undid/)
  assert.equal(octal(await mode(w, 'secret.env')), '600')
})
for (const way of ['exits non-zero', 'cannot start']) {
  test(`permissions: no stat answers (${way}): as before, the file is back at git's mode with no chmod`, async t => {
    const w = await world(t, { 'a.sh': 'old\n' })
    await w.bash('echo new >> a.sh')
    wrapRun(w, (argv, init, run) => argv[0] !== 'stat' ? run(argv, init)
      : way === 'exits non-zero' ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'no' }) : Promise.reject(new Error('spawn stat ENOENT')))
    assert.match(await w.undo('1'), /undid/)
    assert.equal(w.commands.filter(c => c.argv[0] === 'chmod').length, 0)
    assert.equal(await w.read('a.sh'), 'old\n')
  })
}
test('permissions: an ordinary file runs no chmod', async t => {
  const w = await world(t, { 'a.txt': 'old\n' })
  await fs.chmod(join(w.root, 'a.txt'), 0o644)
  await w.bash('echo new >> a.txt')
  await w.undo('1')
  assert.equal(w.commands.filter(c => c.argv[0] === 'chmod').length, 0)
})
for (const way of ['exits non-zero', 'cannot start']) {
  test(`permissions: a chmod that ${way} gets a note naming the file, and the undo stands`, async t => {
    const w = await world(t, { 'secret.env': 'old\n' })
    await fs.chmod(join(w.root, 'secret.env'), 0o600)
    await w.bash('echo new >> secret.env')
    wrapRun(w, (argv, init, run) => argv[0] !== 'chmod' ? run(argv, init)
      : way === 'exits non-zero' ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'chmod: not permitted' }) : Promise.reject(new Error('spawn chmod EAGAIN')))
    const out = await w.undo('1')
    assert.match(out, /undid 1\.1/)
    assert.match(out, /1\.1: secret\.env .*600/)
    assert.doesNotMatch(out, /part way|left as is/)
    assert.equal(await w.read('secret.env'), 'old\n')
  })
}


// ---- A command that cannot start, at every step: $.process.run rejects, and the outcome line still comes.
const rejectAt = (w, k, why) => { let n = 0; wrapRun(w, (argv, init, run) => (n++ === k ? Promise.reject(new Error(why)) : run(argv, init))) }
const steps = async (make, act) => {
  const w = await make()
  const from = w.commands.length
  await act(w)
  return w.commands.slice(from).map(c => c.argv.slice(0, 2).join(' '))
}
const editMade = t => async () => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  return w
}
const shellMade = t => async () => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.bash("printf 'ONE\\n' > a.txt")
  return w
}
for (const [kind, made, whole] of [['Edit', editMade, ['one\n', 'ONE\n']], ['shell', shellMade, ['one\n', 'ONE\n']]]) {
  test(`every step of a ${kind} undo that cannot start answers a line and leaves the file whole`, kind === 'Edit' ? { todo: 'a rejected mv, the next commit' } : {}, async t => {
    const all = await steps(made(t), w => w.undo('1'))
    assert.ok(all.length >= 3, all.join(', '))
    const bad = []
    for (let k = 0; k < all.length; k++) {
      const w = await made(t)()
      rejectAt(w, k, `spawn ${all[k]} EAGAIN`)
      let out
      try { out = await w.undo('1') } catch (e) { bad.push(`${all[k]}: threw ${e.message}`); continue }
      if (!/^agent-undo: /.test(out)) bad.push(`${all[k]}: no line: ${out}`)
      if (!whole.includes(await w.read('a.txt').catch(() => 'missing'))) bad.push(`${all[k]}: the file is not whole: ${out}`)
      if ((await fs.readdir(w.root)).some(n => n.startsWith('.agent-undo-')) && all[k] !== 'rm -f') bad.push(`${all[k]}: a temporary copy stayed`)
    }
    assert.deepEqual(bad, [])
  })
}


// ---- A rejected mktemp is not a machine with no mktemp: the real $.process.run rejects for both, and neither writes in place.
const refuseRun = (w, name, why) => wrapRun(w, (argv, init, run) => (argv[0] === name ? Promise.reject(new Error(why)) : run(argv, init)))
for (const why of ['spawn mktemp EAGAIN', 'spawn mktemp ENOENT', 'mktemp still running at the timeout']) {
  test(`a rejected mktemp (${why}) writes nothing to the file`, async t => {
    const w = await world(t, { 'a.txt': 'one\n' })
    await w.edit('a.txt', 'one', 'ONE')
    refuseRun(w, 'mktemp', why)
    const wrote = []
    w.beforeWrite = p => { wrote.push(p) }
    assert.match(await w.undo('1'), /a\.txt could not get a temporary copy beside it \(.*mktemp.*\); nothing changed/)
    assert.deepEqual(wrote, [])
    assert.equal(await w.read('a.txt'), 'ONE\n')
  })
}
test('killed during a rejected mktemp, the file keeps its text', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  refuseRun(w, 'mktemp', 'still running at the timeout')
  w.beforeWrite = path => execFileSync(process.execPath, ['-e',
    "require('node:fs').openSync(process.argv[1], 'w'); process.kill(process.pid, 'SIGKILL')", path], { stdio: 'ignore' })
  await w.undo('1').catch(() => {})
  assert.equal(await w.read('a.txt'), 'ONE\n')
})
test('comparison: a mktemp that fails with an exit code refuses and leaves the file', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  wrapRun(w, (argv, init, run) => (argv[0] === 'mktemp' ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'mktemp: failed' }) : run(argv, init)))
  assert.match(await w.undo('1'), /temporary copy.*nothing changed/)
  assert.equal(await w.read('a.txt'), 'ONE\n')
})
test('a machine with no cp refuses, leaving the file and no copy', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  refuseRun(w, 'cp', 'spawn cp ENOENT')
  assert.match(await w.undo('1'), /could not be copied \(spawn cp ENOENT\); nothing changed/)
  assert.equal(await w.read('a.txt'), 'ONE\n')
  assert.equal((await fs.readdir(w.root)).filter(n => n.startsWith('.agent-undo-')).length, 0)
})

}
