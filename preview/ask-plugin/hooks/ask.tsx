import type { Register } from 'claude-code'

// Preview only: the window runs with permissions bypassed, so this stands in for the question default mode would raise.
export const register: Register = on => {
  on('tool.check', { tool: 'mcp__agent-undo__undo' }, () => ({ decision: 'ask', reason: 'preview' }) as never)
}
