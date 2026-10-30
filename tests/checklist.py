#!/usr/bin/env python3
"""The plugin directory's pre-submission checklist, as far as a file read can check it.

Run from the repo root: python3 -I tests/checklist.py   (exit 1 on any FAIL; WARN does not fail)

Each rule is one a real submission met: the directory's validation flagged it, or a policy
hold named it, on three mods submitted to the directory in October 2026 by this repo's
maintainer (subagent-spend, usage-file, turn-tally).
`claude plugin validate .` covers the manifest's schema; this covers what it does not.
"""
import json, pathlib, re, sys

ROOT = pathlib.Path('.')
# Manifest fields the directory accepted on those mods, plus the documented
# component paths. Any other field drew an "unknown field" warning (it was `types`).
KNOWN = {'name', 'version', 'description', 'author', 'homepage', 'repository', 'license',
         'keywords', 'userConfig', 'commands', 'agents', 'skills', 'hooks', 'mcpServers',
         'outputStyles', 'lspServers'}
# A module that read an environment variable (HOME) was held. Why is a guess, not tested:
# the scan may take any environment read for a credential read.
ENV_READ = re.compile(r'\$\.env\b|process\.env|Deno\.env|Bun\.env|import\.meta\.env')
# A held module had a comment saying it never reads credentials. That the word itself
# caused the hold is a guess, not tested; dropping such words costs nothing.
SCARY_WORD = re.compile(r'\b(credential|password|secret|api[ _-]?key|transcript)s?\b', re.I)
INSTALL_SCRIPTS = {'preinstall', 'install', 'postinstall', 'preuninstall', 'uninstall', 'postuninstall', 'prepare'}

results = []
def check(ok, rule, detail='', warn=False):
    results.append(('PASS' if ok else 'WARN' if warn else 'FAIL', rule, detail))

def comments(text):
    return re.findall(r'//[^\n]*|/\*.*?\*/', text, re.S)

plugin = json.loads((ROOT / '.claude-plugin/plugin.json').read_text())
unknown = sorted(set(plugin) - KNOWN)
check(not unknown, 'plugin.json has no unknown fields', ', '.join(unknown))
for field in ('homepage', 'repository'):
    check(bool(plugin.get(field)), f'plugin.json names {field}', 'the listing links it')

check((ROOT / 'LICENSE').is_file(), 'a LICENSE file')

readme = (ROOT / 'README.md').read_text() if (ROOT / 'README.md').is_file() else ''
words = len(re.findall(r'\w+', readme))
check(words >= 40, 'README has 40+ words', f'{words} words')
check(re.search(r'nothing\s+leaves\s+(the|your)\s+machine|everything\s+stays\s+on\s+(the|your)\s+machine', readme, re.I) is not None,
      'README says plainly that nothing leaves the machine', 'only true if no hook sends data')
check(re.search(r'^#+ .*(writes|files)', readme, re.I | re.M) is not None,
      'README has a heading saying what the mod writes')

hooks = ROOT / 'hooks/hooks.json'
modules = json.loads(hooks.read_text()).get('modules', []) if hooks.is_file() else []
for mod in modules:
    path = ROOT / 'hooks' / mod
    text = path.read_text()
    for event in sorted(set(re.findall(r"""\bon\(\s*['"]([\w.]+)['"]""", text))):
        check(f'`{event}`' in readme, f'README names the hook `{event}` and what it does', str(path))
    hits = sorted({m.group(0) for m in ENV_READ.finditer(text)})
    check(not hits, 'the module reads no environment variable', f'{path}: {", ".join(hits)}; use a userConfig option')
    words_in = sorted({m.group(0).lower() for c in comments(text) for m in SCARY_WORD.finditer(c)})
    check(not words_in, 'no comment names credentials, secrets or transcripts', f'{path}: {", ".join(words_in)}')
    writes = re.findall(r'\$\.fs\.write\(\s*([^,]+),', text)
    loose = [w for w in writes if not re.match(r"""['"`]|`\$\{dir|\$\{""", w.strip()) and 'dir' not in w]
    check(not loose, 'every write path is fixed text or under the option folder', f'{path}: {loose}')

if (ROOT / 'CLAUDE.md').is_file():
    check(False, 'no CLAUDE.md at the plugin root', 'the directory does not load it (warning only)', warn=True)

pkg_path = ROOT / 'package.json'
if pkg_path.is_file():
    pkg = json.loads(pkg_path.read_text())
    scripts = sorted(set(pkg.get('scripts', {})) & INSTALL_SCRIPTS)
    check(not scripts, 'package.json has no install-time scripts', ', '.join(scripts))
    repo = pkg.get('repository', {})
    url = repo.get('url', '') if isinstance(repo, dict) else repo
    norm = lambda u: re.sub(r'^git\+|\.git$', '', (u or '').strip().rstrip('/')).rstrip('/').lower()
    prepo = plugin.get('repository')
    want = norm(prepo.get('url', '') if isinstance(prepo, dict) else prepo)
    check(bool(re.fullmatch(r'https://github\.com/[^/]+/' + re.escape(plugin['name'].lower()), norm(url))) and norm(url) == want,
          'package.json repository is the plugin\'s own GitHub repo', f'{url} (plugin.json: {want})')
    missing = [f for f in pkg.get('files', []) if not (ROOT / f.rstrip('/')).exists()]
    check(not missing, 'every package.json files entry exists', ', '.join(missing))
    check(not pkg.get('private'), 'package.json is not private')
    check('publishConfig' not in pkg, 'package.json has no publishConfig',
          'it can send the package to another registry or access level; pass --access public on the first release instead')
check(not (ROOT / '.npmrc').exists(), 'no .npmrc in the repo')

width = max(len(r[1]) for r in results)
for status, rule, detail in results:
    print(f'{status}  {rule.ljust(width)}  {detail if status != "PASS" else ""}'.rstrip())
fails = sum(r[0] == 'FAIL' for r in results)
print(f'checklist: {len(results)} rules, {fails} FAIL, {sum(r[0] == "WARN" for r in results)} WARN')
sys.exit(1 if fails else 0)
