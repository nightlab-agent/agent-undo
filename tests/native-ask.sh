#!/bin/sh
# The engine's real answer to a permission query, plan mode and default, with no model turn. register.tsx tells the two
# apart by these words, since a verdict has no field for it: a changed wording fails here first.
set -eu
cd "$(dirname "$0")/.."
probe=$(mktemp -d .native-ask-XXXXXX)
trap 'rm -rf "$probe"' EXIT
printf '%s\n' '*' > "$probe/.gitignore"
mkdir -p "$probe/.claude-plugin" "$probe/hooks"
cat > "$probe/.claude-plugin/plugin.json" <<'JSON'
{ "name": "ask-probe", "version": "0.0.0", "description": "Local permission probe" }
JSON
printf '%s\n' '{ "modules": ["./probe.tsx"] }' > "$probe/hooks/hooks.json"
cat > "$probe/hooks/probe.tsx" <<'TS'
import type { Register } from 'claude-code'
export const register: Register = on => {
  on('prompt.submit', async ($) => {
    const verdict = await $.tool.check({ tool: 'mcp__agent-undo__undo', input: { ref: '1' } })
    await $.fs.write((await $.env.get('NATIVE_ASK_OUTPUT'))!, JSON.stringify(verdict))
    return { drop: 'Local probe complete; no model turn' }
  })
}
TS
asked() {
  NATIVE_ASK_OUTPUT="$PWD/$probe/$1.json" claude --setting-sources '' --strict-mcp-config \
    --mcp-config '{"mcpServers":{}}' --permission-mode "$1" --plugin-dir . --plugin-dir "$probe" -p 'Local probe' >/dev/null
  grep -q "$2" "$probe/$1.json" || { echo "native ask: $1 changed: $(cat "$probe/$1.json")"; exit 1; }
}
asked plan '"decision":"ask".*plan mode'
asked default '"decision":"ask".*requested permissions'
echo "native ask: plan and default read as the mod expects"
