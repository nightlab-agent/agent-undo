// Run with node --test tests/release-audit17.test.mjs. No packages or network needed.
// An undo on real files: permissions, and a copy that cannot be made.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { world, wrapRun } from './audit-harness.mjs'

// ---- A shell undo keeps the file's permissions (git recreates the file at the umask mode).
const mode = async (w, n) => (await fs.stat(join(w.root, n))).mode & 0o7777
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
  test(`every step of a ${kind} undo that cannot start answers a line and leaves the file whole`, async t => {
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


// ---- The outcome line comes, whatever goes wrong inside the copy.
test('comparison: a cp that fails answers a line', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  wrapRun(w, (argv, init, run) => (argv[0] === 'cp' ? Promise.resolve({ exitCode: 1, stdout: '', stderr: 'cp: no' }) : run(argv, init)))
  assert.match(await w.undo('1'), /could not be copied.*nothing changed/)
})
for (const [way, answer] of [['fails', () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'mv: cannot move: Device or resource busy' })],
  ['cannot start', () => Promise.reject(new Error('spawn mv EAGAIN'))]]) {
  test(`a mv that ${way} answers a line, and neither the file nor a copy changes`, async t => {
    const w = await world(t, { 'a.txt': 'one\n' })
    await w.edit('a.txt', 'one', 'ONE')
    wrapRun(w, (argv, init, run) => (argv[0] === 'mv' ? answer() : run(argv, init)))
    assert.match(await w.undo('1'), /a\.txt could not be put in place \(.*\); nothing changed/)
    assert.equal(await w.read('a.txt'), 'ONE\n')
    assert.equal((await fs.readdir(w.root)).filter(n => n.startsWith('.agent-undo-')).length, 0)
  })
}
test('a file deleted during the undo says changed', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  w.beforeWrite = async p => { if (p.includes('.agent-undo-')) await fs.unlink(join(w.root, 'a.txt')) }
  assert.match(await w.undo('1'), /changed during this undo; nothing changed/)
  assert.equal((await fs.readdir(w.root)).filter(n => n.startsWith('.agent-undo-')).length, 0)
})
test('a read-only file answers a line', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  await fs.chmod(join(w.root, 'a.txt'), 0o444)
  assert.match(await w.undo('1'), /a\.txt could not be written \(.*\); nothing changed/)
  assert.equal(await w.read('a.txt'), 'ONE\n')
  assert.equal((await fs.readdir(w.root)).filter(n => n.startsWith('.agent-undo-')).length, 0)
})
test('the backstop: a failure no step expected still answers a line', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  w.engine.fs.exists = async () => { throw new Error('EIO: i/o error') }
  assert.match(await w.undo('1'), /^agent-undo: this undo stopped: EIO: i\/o error\. /)
})
test('a list that cannot be updated after the write: the line does not say nothing changed', async t => {
  const w = await world(t, { 'a.txt': 'one\n' })
  await w.edit('a.txt', 'one', 'ONE')
  w.engine._atoms.set = () => { throw new Error('state refused') }
  const out = await w.undo('1')
  assert.match(out, /^agent-undo: this undo stopped: state refused\. .*already be changed/)
  assert.equal(await w.read('a.txt'), 'one\n')
})


