import { expect, test } from 'claude-code/testing'
import { undo } from './world'
import { bash2, world2 } from './review2-world'

// ---- R4 (kind 3): the top is taken as "root minus prefix" whenever the root's last segments
// read like the prefix. A root that is a symlink to a subfolder OF the repo, named as that
// subfolder (~/work/app -> /srv/mono/app), matches by name only: the "top" is ~/work, which is
// no repo. Real git: from ~/work/app it answers /srv/mono and app/;
// from ~/work, "fatal: not a git repository".

const start = ($: any, root: string) => $.session.start({ cwd: root, surface: 'terminal', isInteractive: true })

test('review2 R4: a root symlinked to the repo\'s subfolder of the same name: a command is still recorded', async ($, on) => {
  const root = '/home/u/work/app'
  const w = world2(on, { root, gitTop: '/srv/mono', prefix: 'app/', tops: ['/srv/mono'] }, { 'a.txt': 'a\n' })
  await start($, root)
  await bash2($, w, 'make', f => { f.set(`${root}/a.txt`, 'a2\n') })
  expect(await undo($, '')).toContain('Bash make (1 file)')
})

test('review2 R4 comparison: a root that is a plain subfolder of the repo (no symlink): recorded', async ($, on) => {
  const root = '/srv/mono/app'
  const w = world2(on, { root, gitTop: '/srv/mono', prefix: 'app/', tops: ['/srv/mono'] }, { 'a.txt': 'a\n' })
  await start($, root)
  await bash2($, w, 'make', f => { f.set(`${root}/a.txt`, 'a2\n') })
  expect(await undo($, '')).toContain('Bash make (1 file)')
})

// ---- R5 (kind 3, F5 not closed for this layout): the same symlink under another name
// (~/work/frontend -> /srv/mono/app). The suffix does not match, so the top falls back to git's
// /srv/mono; an Edit during the command is keyed /home/u/work/frontend/b.txt, the command's file
// /srv/mono/app/b.txt: the exclusion misses and the Edit's file is booked to the command.

test('review2 R5: root symlinked to a repo subfolder under another name: an Edit during the command stays with the Edit', async ($, on) => {
  const root = '/home/u/work/frontend'
  const w = world2(on, { root, gitTop: '/srv/mono', prefix: 'app/', tops: ['/srv/mono'] }, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($, root)
  await bash2($, w, 'make', async f => {
    f.set(`${root}/a.txt`, 'a2\n')
    await $.tool.call({ tool: 'Edit', file_path: `${root}/b.txt`, old_string: 'b', new_string: 'B' } as never)
  })
  const text = await undo($, '')
  expect(text).not.toMatch(/\d\.\d changed .*b\.txt/)
})

test('review2 R5 comparison: the same Edit during a command, root a plain subfolder of the repo', async ($, on) => {
  const root = '/srv/mono/app'
  const w = world2(on, { root, gitTop: '/srv/mono', prefix: 'app/', tops: ['/srv/mono'] }, { 'a.txt': 'a\n', 'b.txt': 'b\n' })
  await start($, root)
  await bash2($, w, 'make', async f => {
    f.set(`${root}/a.txt`, 'a2\n')
    await $.tool.call({ tool: 'Edit', file_path: `${root}/b.txt`, old_string: 'b', new_string: 'B' } as never)
  })
  const text = await undo($, '')
  expect(text).toContain('changed a.txt')
  expect(text).not.toMatch(/\d\.\d changed .*b\.txt/)
})
