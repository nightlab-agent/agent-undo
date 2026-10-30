/** One hunk of one edit: the lines as they stood before the edit and after it, context included. */
export type Hunk = {
  before: string[]
  after: string[]
  line: number
  beforeNoEol?: boolean
  afterNoEol?: boolean
  undone?: boolean
}

/** One Edit or Write that Claude Code (or one of its subagents) made, numbered in this session. */
export type Change = {
  n: number
  at: string
  tool: 'Edit' | 'Write'
  file: string
  agent?: string
  created?: boolean
  tooLarge?: boolean
  hunks: Hunk[]
}

declare module 'claude-code' {
  interface PluginState {
    'agent-undo': { changes: Shaped<Change[]> }
  }
}
