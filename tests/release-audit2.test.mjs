// Run with node --test tests/release-audit2.test.mjs. No packages or network needed.
// An undo on real files: renames, links, temporary copies.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { world, worker, untilFile, scratch, session } from './audit-harness.mjs'

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
      assert.match(await w.undo('1'), /nothing changed/)
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
  assert.match(await w.undo('1'), /nothing changed/)
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
  assert.match((await w.toolUndo('1')).result, /did not allow/)
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


