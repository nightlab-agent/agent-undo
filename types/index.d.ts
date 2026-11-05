/** One hunk of one edit: the lines as they stood before the edit and after it, context included. */
export type Hunk = {
  before: string[]
  after: string[]
  /** Where the after-lines stand, 1-based, followed through later edits and undos; 0 once a later change has no diff. */
  line: number
  /** The file's lines when this was last known, kept in step with later edits and undos. A count that differs at an
   * undo means someone else changed the file's length. */
  total?: number
  /** Set when these after-lines stood once in the file, as far as this mod has seen. */
  alone?: boolean
  beforeNoEol?: boolean
  afterNoEol?: boolean
  undone?: boolean
}

/** One file a shell command changed, from git's diff of the work tree before and after it. */
export type ShellFile = {
  path: string
  status: 'M' | 'D' | 'A' | 'T'
  /** The file's blob before the command and after it (absent where it did not exist). */
  before?: string
  after?: string
  /** Why this file cannot be put back here (a submodule, a symbolic link). */
  fixed?: string
  undone?: boolean
}

/** One Edit, Write, Bash or MCP tool call that Claude Code (or one of its subagents) made, numbered in this session.
 * An MCP call is recorded as a Bash command is (files, tree); its `file` is the server and tool, readably. */
export type Change = {
  n: number
  at: string
  tool: 'Edit' | 'Write' | 'Bash' | 'MCP'
  file: string
  agent?: string
  created?: boolean
  tooLarge?: boolean
  hunks: Hunk[]
  /** Bash and MCP only: the repo's top folder, the tree before the command, and the files it changed. */
  top?: string
  /** Bash and MCP only: the session's folder as it spells it, and its place under the repo's top. */
  root?: string
  prefix?: string
  tree?: string
  files?: ShellFile[]
}

declare global {
  // The form `$.fs.read`'s `{ as: 'bytes' }` documents; TypeScript's own libraries leave it out.
  interface Uint8ArrayConstructor { fromBase64(base64: string): Uint8Array }
}

declare module 'claude-code' {
  interface PluginState {
    'agent-undo': { changes: Shaped<Change[]>; listed: Shaped<string> }
  }
}
