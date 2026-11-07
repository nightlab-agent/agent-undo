// How a wrapped call reads in the list: an MCP tool's name, a command's first line.

/** agent-undo's own model tool, exactly the name `$.tool.register` returned (its undo is not a change to
 * record); until it answers, the name its own hook serves. Only that name: a configured server that
 * happens to be named agent-undo is another server and is recorded. */
let own = 'mcp__agent-undo__undo'
export const ownTool = (name: unknown) => { if (typeof name === 'string' && name.startsWith('mcp__')) own = name }
/** An MCP tool's call, by its wire name, that is not this mod's own. */
export const isMcp = (tool: unknown): tool is string => typeof tool === 'string' && tool.startsWith('mcp__') && tool !== own
/** `mcp__filesystem__write_file` as `filesystem write_file`: one line, at most 60 characters. */
export const mcpLabel = (tool: string) => {
  const rest = tool.slice('mcp__'.length)
  const k = rest.indexOf('__')
  const name = (k < 0 ? rest : `${rest.slice(0, k)} ${rest.slice(k + 2)}`).replace(/[\u0000-\u001f\u007f]/g, ' ')
  return name.length > 60 ? `${name.slice(0, 59)}…` : name
}

export const commandLabel = (command: unknown) => {
  const first = String(command ?? '').trim().split('\n')[0] ?? ''
  return first.length > 60 ? `${first.slice(0, 59)}…` : first
}
