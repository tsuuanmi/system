/**
 * The tool gate of an agent run (docs/design/approvals.md#a-workers-tool-calls): before each tool
 * call runs, it is classified into an action and judged by the autonomy policy (`ctx.approvals`).
 * Code decides, never a model: a call is classified by its tool's name and input only, and a call
 * it cannot classify is denied (INV-2). `forbid` denies; `auto` and `notify` allow, their rule's
 * required checks still pending (they bind when the result is accepted, not per call); `ask` opens
 * one approval request on the exact call (INV-5) and defers it, and the same exact call in a later
 * run of the same session runs once the operator approved it. A review member's run (the
 * review-member profile, ADR-0049) has every call denied: its material is its prompt alone.
 * @module @tsuuanmi/system-agent-workers/gate
 */
import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { COMMIT_ID, HOST_TOOLS_SERVER, type ToolCall, type ToolGate, type ToolVerdict, WORKSPACE_GIT_TOOLS, WORKSPACE_READS_SERVER, WORKSPACE_READ_TOOLS } from '@tsuuanmi/system-agent-runtime-core'
import {
  type ActionClass, type ApprovalRequest, type Approvals, type ArtifactRef, type AutonomyVerdict, type Check, type CommandPathScope, commandRulesOf, SHELL_METACHARACTER, webAccessOf, type WebTool, withinClassification,
} from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-ledger-core'
import { contentId, isRecord } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-workers-core'
import { matchCommandRule, REF_NAME } from './command-rules.ts'
import { namesLocalPath, WEB_PROBE_QUERY, webTarget } from './research.ts'

/**
 * Why the gate denied a call (T207): a stable code, and the plain explanation of it each
 * `agent-workers.tool.denied` event carries (at most {@link EXPLANATION_MAX} characters). The
 * explanation is fixed per code, so an event never carries the call's input (a path, a command):
 * the agent's own reason and the decision name those. A code is never renamed or reused; a new
 * cause gets a new code (additive, ADR-0036).
 */
export const DENIAL_REASONS = {
  'metacharacter': 'A Bash command word holds a shell metacharacter (; & | $ < > ( ) quotes * ? ~ and the like). A command is words split on single spaces and never parsed by a shell, so such a word is denied before the policy is asked.',
  'empty-word': 'A Bash command has an empty word: a doubled, leading, or trailing space. A command is words split on single spaces, so it is denied before the policy is asked.',
  'outside-workspace': 'The call names a path that is not inside the run\'s workspace, as written or on disk (every symlink followed), or a Glob pattern that reaches outside it.',
  'git-data': 'The call writes git\'s own data (a .git entry in its path), or reads it through the workspace reads server: only a command the operator approved, or the operator, changes it, and that server never reads it.',
  'unclassified-tool': 'The tool is not one the gate classifies, so no autonomy rule can judge it, and it is denied (INV-2).',
  'unsupported-field': 'The tool input carries a field the gate does not classify, or a known field of another type, so it is denied.',
  'invalid-input': 'The tool input is not an object, or names no path, file, command, patch, URL, or query where the tool needs one.',
  'invalid-patch': 'The apply_patch patch does not read strictly in the patch grammar, so the files it touches are not known and it is denied.',
  'policy-forbid': 'The autonomy policy forbids this action class.',
  'not-listed': 'The command is not on the autonomy policy\'s commands list, and the policy forbids every other command.',
  'request-rejected': 'The operator rejected the approval request for exactly this call, so it stays denied in this session.',
  'request-expired': 'The approval request for exactly this call expired unanswered, so it stays denied in this session.',
  'request-withdrawn': 'The approval request for exactly this call was withdrawn before a verdict (unanswered in time, its work ended, or the policy changed), so it stays denied in this session.',
  'workflow-denied': 'The workflow engine denied exactly this call in this session (no verdict in time), so it stays denied.',
  'request-mismatch': 'The approval request recorded for this call is for another call, so its verdict is not used.',
  'request-unreadable': 'The approval request recorded for this call cannot be read from the queue.',
  'no-session': 'The policy asks the operator about this call, and the run has no session a later run could continue once it is approved, so it cannot wait.',
  'run-stopped': 'The run already stopped at a call that waits for the operator\'s approval: no further call runs in it.',
  'review-member': 'A review member answers from the material in its prompt alone: its profile allows no tool call (ADR-0049).',
  'no-approvals': 'No approval queue is loaded, and no tool call runs without its autonomy decision.',
  'unknown-checks': 'The autonomy policy left checks pending that no rule can require, so the verdict is not one the gate knows.',
  'unknown-mode': 'The autonomy policy gave a mode the gate does not know.',
  'gate-error': 'The gate failed while it judged the call, so the call is denied.',
  'use-read-tool': 'A Bash inspection command is denied at once, never asked, where the run\'s agent has a reading tool for it: Read or read_file for cat, head, tail, sed -n, and wc (its numbered lines count them); Grep or search for grep and rg; Glob or list_dir for ls and find.',
  'research-role': 'A research role\'s run reads its workspace and searches and fetches the web, and nothing else (ADR-0074): a call that writes a file or runs a command is denied, and so is, in its web probe, any call but the probe\'s own search.',
} as const satisfies Record<string, string>
/** A stable code of why the gate denied a call. */
export type DenialReason = keyof typeof DENIAL_REASONS
/** The characters an event's explanation holds at most. */
export const EXPLANATION_MAX = 300

/** A call {@link classify} does not classify: why, in words for the agent, and the stable code. */
export interface Refusal { refused: string; reason: DenialReason }

/** A tool call as an action the policy judges: its class, a command's argv, and what the operator is shown. */
export interface ToolAction {
  class: ActionClass
  /** For `command`: the argv, the command split on single spaces (never parsed by a shell). */
  command?: string[]
  /**
   * For `command`: a git history read ({@link gitHistory}, T276) in a shell that is not proven clean.
   * The policy judges it as a command; where that asks, it is judged as a workspace write, as the
   * policy judges a command on its commands list, so a forbidden command class still binds.
   */
  historyRead?: true
  summary: string
  consequences: string
}

/**
 * The table is keyed by the tool names the runtimes report (INV-11: a name, never a runtime): Claude
 * Code's built-in tools; Codex's as its PreToolUse hook reports them (`exec_command` as `Bash`
 * with `command` only, `apply_patch` with the patch as `command`, `view_image`); and the Antigravity
 * CLI's file tools as its PreToolUse hook reports them (`read_file`, `write_file`, `edit_file`,
 * each naming its file in `Path`). Its `run_command` is not classified, so it is denied: no
 * confinement of its commands is proven. And the tools of System's own workspace reads server, as
 * an MCP client names them (`mcp__workspace__read_file`, …, T200b; its git views, T223).
 */
/** What a classification knows of the run's runtime. */
export interface ClassifyOptions {
  /**
   * The runtime enforces that every shell a call runs in reads no startup code
   * (`RuntimeEvidence.cleanShells`, T198): only then is a `Bash` probe or inspection command a
   * `read`. Absent: it is not.
   */
  shellReads?: boolean | undefined
  /**
   * The runtime gives the run's agent System's own workspace reads server
   * (`RuntimeEvidence.workspaceReads`, T200b): only then are its tools
   * (`mcp__workspace__read_file`, `…list_dir`, `…search`, and the git views `…git_log`,
   * `…git_show`, `…git_diff`, `…git_status`, T223) a `read`. Absent: every tool of that name is
   * refused, since no server of System's started under it.
   */
  workspaceReads?: boolean | undefined
  /**
   * The reading tools the run's agent has, by name (T222): its runtime's own (`Read`, `Grep`,
   * `Glob`; `RuntimeEvidence.readTools`, as the Worker's tools list keeps them) and the workspace
   * reads server's (`read_file`, `list_dir`, `search`, and its git views, with `workspaceReads`). A shell inspection
   * command one of them serves is refused at once, naming it ({@link inspectionRefusal}). Absent or
   * empty: none, and such a command stays a `command`.
   */
  readTools?: readonly string[] | undefined
  /**
   * The host tools its source gave the run's agent, by name (ADR-0070: `dossier_read`,
   * `dossier_append`), which the runtime offers as `mcp__system__<name>`: only these are classified
   * ({@link HOST_TOOL_FIELDS}); any other tool of that server, or one the run was not given, is refused.
   */
  hostTools?: readonly string[] | undefined
}

/** The host tools' server as an MCP client names its tools (`mcp__system__<name>`, ADR-0070). */
const HOST_PREFIX = `mcp__${HOST_TOOLS_SERVER}__`

/**
 * The host tools the gate classifies, each with its input fields (agent-workers `dossierTools`, whose
 * schemas the runtime checks too) and its class: reading the task's dossier is a `read`; appending
 * to it changes System's own record of the work (no file, no command, nothing sent out), judged as
 * a `workspace-write`, the class of the Worker writing its own work.
 */
const HOST_TOOL_FIELDS: Record<string, { fields: Record<string, FieldType>; class: 'read' | 'workspace-write'; summary: string }> = {
  dossier_read: { fields: { from: 'number', limit: 'number' }, class: 'read', summary: 'Reads its board task\'s dossier (System\'s own record of the work)' },
  dossier_append: {
    fields: { kind: 'string', text: 'string', commits: 'strings', refs: 'strings', finding: 'string', inReplyTo: 'string' }, class: 'workspace-write',
    summary: 'Appends an entry to its board task\'s dossier (System\'s own append-only record of the work; no file, no command)',
  },
}

/**
 * The tools of the workspace reads server (agent-runtime-core, T200b) as an MCP client names them
 * (`mcp__<server>__<tool>`, as Codex's hook reports an MCP tool): System's own read-only server,
 * started under the run's confinement with its root fixed to the run's workspace. They run no
 * program but git, which the server runs itself with an argv it builds and every setting that
 * could run a program pinned off (T223), so they are reads. No other tool of that server is classified.
 */
const SERVER_PREFIX = `mcp__${WORKSPACE_READS_SERVER}__`
const SERVER_TOOLS: readonly string[] = WORKSPACE_READ_TOOLS.map((tool) => `${SERVER_PREFIX}${tool}`)
/** The server's git views (T223): their paths (`paths`, a list) and their commits (hex ids only). */
const GIT_VIEWS: readonly string[] = WORKSPACE_GIT_TOOLS.map((tool) => `${SERVER_PREFIX}${tool}`)
const GIT_COMMIT_FIELDS = ['commit', 'from', 'to'] as const

/** Tools that only read, and the input field that names where; a field that may be absent reads the workspace. */
const READS: Record<string, { field: string; required: boolean }> = {
  Read: { field: 'file_path', required: true },
  NotebookRead: { field: 'notebook_path', required: true },
  LS: { field: 'path', required: true },
  Glob: { field: 'path', required: false },
  Grep: { field: 'path', required: false },
  view_image: { field: 'path', required: true },
  read_file: { field: 'Path', required: true },
  [`${SERVER_PREFIX}read_file`]: { field: 'path', required: true },
  [`${SERVER_PREFIX}list_dir`]: { field: 'path', required: false },
  [`${SERVER_PREFIX}search`]: { field: 'path', required: false },
}
/** Tools that change one file, and the input field that names it. */
const WRITES: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path', write_file: 'Path', edit_file: 'Path' }
/** Tools that change files by a patch, and the input field that holds it: the patch names every file it touches. */
const PATCHES: Record<string, string> = { apply_patch: 'command' }
/** Tools that send data out of this machine, and the input field the operator is shown. */
const SENDS: Record<string, string> = { WebFetch: 'url', WebSearch: 'query' }
/** The tool that runs a command. */
const COMMAND = 'Bash'

/** The type an input field must have: `edits` is `MultiEdit`'s list of `{ old_string, new_string, replace_all? }`. */
type FieldType = 'string' | 'number' | 'boolean' | 'strings' | 'edits'
/**
 * Every input field each classified tool may carry, and its type, from the Claude Agent SDK's tool
 * input types (`sdk-tools.d.ts`; `MultiEdit`, `NotebookRead`, and `LS`, which it no longer
 * declares, from their last published shapes) and from what Codex's PreToolUse hook reports
 * (Codex 0.164: `apply_patch` and `view_image`; its `Bash` is a subset of Claude Code's) and the
 * Antigravity CLI's reports (agy 1.4.6 with its economy model, recorded in a supervised live check:
 * `runtime-antigravity-cli/tests/fixtures/agy-1.4.6-hook-inputs.json`; `ArtifactMetadata`, which
 * writes an agy artifact, is left out). A field not listed (Bash's `dangerouslyDisableSandbox`,
 * say, which would run it outside its sandbox), or a listed one of another type, refuses the call:
 * the gate classifies only an input it knows whole.
 */
const FIELDS: Record<string, Record<string, FieldType>> = {
  Read: { file_path: 'string', offset: 'number', limit: 'number', pages: 'string', allow_large: 'boolean' },
  NotebookRead: { notebook_path: 'string', cell_id: 'string' },
  LS: { path: 'string', ignore: 'strings' },
  Glob: { pattern: 'string', path: 'string' },
  Grep: {
    'pattern': 'string', 'path': 'string', 'glob': 'string', 'output_mode': 'string', '-B': 'number', '-A': 'number', '-C': 'number', 'context': 'number',
    '-n': 'boolean', '-i': 'boolean', '-o': 'boolean', 'type': 'string', 'head_limit': 'number', 'offset': 'number', 'multiline': 'boolean',
  },
  Write: { file_path: 'string', content: 'string' },
  Edit: { file_path: 'string', old_string: 'string', new_string: 'string', replace_all: 'boolean' },
  MultiEdit: { file_path: 'string', edits: 'edits' },
  NotebookEdit: { notebook_path: 'string', cell_id: 'string', new_source: 'string', cell_type: 'string', edit_mode: 'string' },
  Bash: { command: 'string', description: 'string', timeout: 'number', run_in_background: 'boolean' },
  WebFetch: { url: 'string', prompt: 'string', offset: 'number' },
  WebSearch: { query: 'string', allowed_domains: 'strings', blocked_domains: 'strings' },
  apply_patch: { command: 'string' },
  view_image: { path: 'string', detail: 'string' },
  read_file: { Path: 'string', StartLine: 'number', EndLine: 'number', ByteOffset: 'number' },
  write_file: { Path: 'string', Content: 'string', Append: 'boolean', Overwrite: 'boolean' },
  edit_file: { Path: 'string', Target: 'string', Replacement: 'string' },
  // The workspace reads server's own input schemas (agent-runtime-core `workspaceReadTools`).
  [`${SERVER_PREFIX}read_file`]: { path: 'string', startLine: 'number', endLine: 'number' },
  [`${SERVER_PREFIX}list_dir`]: { path: 'string' },
  [`${SERVER_PREFIX}search`]: { pattern: 'string', regex: 'boolean', ignoreCase: 'boolean', path: 'string' },
  [`${SERVER_PREFIX}git_log`]: { count: 'number', skip: 'number', commit: 'string', paths: 'strings', fields: 'strings' },
  [`${SERVER_PREFIX}git_show`]: { commit: 'string', stat: 'boolean', patch: 'boolean', paths: 'strings' },
  [`${SERVER_PREFIX}git_diff`]: { from: 'string', to: 'string', cached: 'boolean', stat: 'boolean', paths: 'strings' },
  [`${SERVER_PREFIX}git_status`]: { paths: 'strings' },
}
const EDIT_FIELDS: Record<string, FieldType> = { old_string: 'string', new_string: 'string', replace_all: 'boolean' }

const SUMMARY_MAX = 500
/**
 * The characters of a Bash command the gate accepts (T295): a request carries it whole in its
 * `consequences` (approval-request@1's bound is 2000 characters, the rest of the text fits in the
 * remaining 500), beside a short summary; a longer command is refused, never cut.
 */
export const COMMAND_MAX = 1500
const clamp = (text: string): string => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text)

/** Whether `value` has type `type`. */
function typed(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'strings': return Array.isArray(value) && value.every((v) => typeof v === 'string')
    case 'edits': return Array.isArray(value) && value.every((edit) => isRecord(edit) && unknownField(edit, EDIT_FIELDS) === undefined)
  }
}

/** The first field of `input` that `fields` does not list, or lists with another type, and why; undefined when there is none. */
function unknownField(input: Record<string, unknown>, fields: Record<string, FieldType>): string | undefined {
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(fields, key)) return `carries ${JSON.stringify(key.slice(0, 100))}, a field the gate does not classify`
    if (!typed(value, fields[key]!)) return `carries ${JSON.stringify(key)} that is not a ${fields[key] === 'strings' ? 'list of strings' : fields[key] === 'edits' ? 'list of edits' : fields[key]}`
  }
  return undefined
}

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const code = (error: unknown): unknown => (error as NodeJS.ErrnoException | undefined)?.code

/**
 * Where `path` (absolute) is on disk, every symlink followed, `..` resolved physically: an existing
 * path's real path; for one that does not exist yet (a write target), its deepest existing
 * ancestor's real path and the rest appended, which must hold no `..`. Undefined when it cannot be
 * resolved (a dangling symlink, a loop, a permission error, a `..` in the rest): such a path is
 * outside every workspace.
 */
function realLocation(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (code(error) !== 'ENOENT') return undefined
  }
  const segments = path.split(sep).filter((s) => s !== '' && s !== '.')
  for (let i = segments.length; i >= 0; i -= 1) {
    const ancestor = sep + segments.slice(0, i).join(sep)
    try {
      lstatSync(ancestor)
    } catch (error) {
      if (code(error) === 'ENOENT') continue
      return undefined
    }
    const rest = segments.slice(i)
    if (rest.includes('..')) return undefined
    try {
      // The deepest entry that exists: a symlink there that does not resolve (dangling) refuses.
      return join(realpathSync.native(ancestor), ...rest)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Whether `written` (a path relative to the workspace, an absolute one, or a `file:` URI) names the
 * workspace or a path inside it, both as written (lexically) and on disk: its real location (every
 * symlink followed) is inside the workspace's real path. A `file:` URI is the path it names, checked
 * the same way; one that names no local path (another host, an encoded slash) is not inside, and
 * neither is a path that cannot be resolved. A symlink created after this check is bounded by the
 * runtime's own confinement, which the gate does not replace.
 */
function within(workspace: string, written: string): boolean {
  let path = written
  if (/^file:/i.test(written)) {
    try {
      path = fileURLToPath(written)
    } catch {
      return false
    }
  }
  if (path === '' || path.startsWith('~') || path.includes('\0')) return false
  const root = resolve(workspace)
  if (!inside(root, resolve(root, path))) return false
  let realRoot: string
  try {
    realRoot = realpathSync.native(root)
  } catch {
    return false
  }
  const real = realLocation(isAbsolute(path) ? path : `${root}${sep}${path}`)
  return real !== undefined && inside(realRoot, real)
}

/**
 * Whether `written` (a path `within` the workspace) is git's own data: a `.git` entry anywhere in
 * it, as written or on disk (any letter case). Git reads its configuration there, and a read-only
 * git command runs what that configuration names (`core.fsmonitor`, a diff or filter driver): so a
 * tool that writes a file never changes it, and it changes only by an asked command or the operator.
 */
function gitData(workspace: string, written: string): boolean {
  let path = written
  if (/^file:/i.test(written)) {
    try {
      path = fileURLToPath(written)
    } catch {
      return true
    }
  }
  const named = (rest: string): boolean => rest.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')
  const root = resolve(workspace)
  if (named(relative(root, resolve(root, path)))) return true
  try {
    const real = realLocation(isAbsolute(path) ? path : `${root}${sep}${path}`)
    return real === undefined || named(relative(realpathSync.native(root), real))
  } catch {
    return true
  }
}

/**
 * Read-only inspection commands (a `Bash` call's argv, after the empty-word and metacharacter
 * refusals): a fixed list of programs, each with the rule every word after it must pass. Nothing is
 * guessed: a word that is not an option the rule allows (exactly, never abbreviated or clustered
 * otherwise) nor a path inside the workspace fails the rule, and the call stays a `command`.
 *
 * The gate does not see the directory a command runs in: Codex's `exec_command` takes its own
 * `workdir`, which its hook does not report, and Claude Code's shell keeps the directory a previous
 * command changed to. So every path is absolute, and a form that names no path (and would read its
 * working directory) or that depends on it (`git`, which finds its repository there) is no read.
 */
const NUMBER = /^\d+$/
/** An option's value that cannot be read as an option. */
const VALUE = /^[^-]/
/**
 * A word that names a path inside the workspace: absolute (so it names the same file from any
 * working directory), with no `..` segment, and `within` the workspace on disk, every symlink
 * followed. An option (`-`), a comment (`#`), find's negation (`!`), a URI (`file:`, which the
 * shell reads as a relative name) or a relative path is none.
 */
const pathWord = (workspace: string, word: string): boolean => word.startsWith('/') && !word.split('/').includes('..') && within(workspace, word)

/**
 * Options from `flags` (exact words), options from `valued` each followed by a value its pattern
 * allows, and at least `paths` path words inside the workspace.
 */
function optionsAndPaths(args: string[], workspace: string, flags: (word: string) => boolean, valued: Record<string, RegExp>, paths: number): boolean {
  let named = 0
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i]!
    if (flags(word)) continue
    const value = Object.hasOwn(valued, word) ? valued[word] : undefined
    if (value) {
      const next = args[i + 1]
      if (next === undefined || !value.test(next)) return false
      i += 1
      continue
    }
    if (!pathWord(workspace, word)) return false
    named += 1
  }
  return named >= paths
}

const among = (...words: string[]) => (word: string): boolean => words.includes(word)

/**
 * A search (`rg`, `grep`): options from `flags` and `valued`, then one pattern word (free text, not
 * an option), then at least one path word inside the workspace (none would search the working
 * directory, which the gate does not see).
 */
function search(args: string[], workspace: string, flags: (word: string) => boolean, valued: Record<string, RegExp>): boolean {
  let pattern = false
  let paths = 0
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i]!
    if (flags(word)) continue
    const value = Object.hasOwn(valued, word) ? valued[word] : undefined
    if (value) {
      const next = args[i + 1]
      if (next === undefined || !value.test(next)) return false
      i += 1
      continue
    }
    if (/^[-#]/.test(word)) return false
    if (!pattern) pattern = true
    else if (!pathWord(workspace, word)) return false
    else paths += 1
  }
  return pattern && paths > 0
}

/** find's tests it may carry, each with its value: never an action (`-exec`, `-delete`, `-fprint`, …) nor `-L`/`-follow`. */
const FIND_TESTS: Record<string, RegExp> = { '-name': VALUE, '-iname': VALUE, '-path': VALUE, '-type': /^[bcdpfls]$/, '-maxdepth': NUMBER, '-mindepth': NUMBER }

/** `find <paths> [<test> <value>]...`: at least one path inside the workspace first, then only the tests above. */
function findRule(args: string[], workspace: string): boolean {
  let i = 0
  for (; i < args.length && !args[i]!.startsWith('-'); i += 1) if (!pathWord(workspace, args[i]!)) return false
  if (i === 0) return false
  for (; i < args.length; i += 2) {
    const value = Object.hasOwn(FIND_TESTS, args[i]!) ? FIND_TESTS[args[i]!] : undefined
    const next = args[i + 1]
    if (!value || next === undefined || !value.test(next)) return false
  }
  return true
}

const HEAD_TAIL: Record<string, RegExp> = { '-n': /^\+?\d+$/, '-c': /^\+?\d+$/ }
const LS_FLAGS = among('-l', '-a', '-A', '-la', '-al', '-lA', '-1', '-R', '-h', '-lh', '-lah', '-alh', '-F')
/** A revision word: a {@link REF_NAME}, or a range of two (`a..b`, `a...b`): never an option, never a path that leaves the directory. */
const REVISION = new RegExp(`^${REF_NAME}(?:\\.\\.\\.?${REF_NAME})?$`)
/** `show`'s `<rev>:<path>`: one {@link REF_NAME}, the path relative to the repository root (its `..` and `.git` segments refused). */
const REVISION_PATH = new RegExp(`^(${REF_NAME}):([A-Za-z0-9_.][A-Za-z0-9_./-]*)$`)
/** A run's branch (agent-workers worktrees, `system/run/<runId>`): the only names `git branch --list` looks up. */
const RUN_BRANCH = /^system\/run\/[A-Za-z0-9_-]+$/
/** `log`'s `--format=`: placeholders and plain characters, no space (a command is split on spaces), so one word. */
const LOG_FORMAT = /^--format=[A-Za-z0-9%:,._-]+$/

/**
 * The git history reads a Worker needs (T276), and no other form:
 * - `git log`: at most one revision (a ref or a range), `--oneline`, `-n <k>`, `--format=<placeholders>`,
 *   and paths, each absolute and inside the workspace, bare or after `--`;
 * - `git show <rev>[:<path>]`: exactly one, its path relative to the root, with no `..` and no `.git` segment;
 * - `git diff <a> <b>`: exactly two revisions, `--stat` the only option;
 * - `git branch --list system/run/<runId>`: one run branch, by name (no wildcard passes the shell check).
 * Any other word fails it (`-c`, `-C`, `--git-dir`, `--output`, `--ext-diff`, `-p`, …), and so does
 * every other subcommand: a write (`commit`, `push`, `checkout`, `branch <name>`) stays a `command`.
 * `git` finds its repository from the working directory, which the gate does not see: the runtime
 * starts a Worker's shell in the run's worktree, and the configuration git reads there (`.git`, which
 * no file tool writes, {@link gitData}) is the operator's, as for a listed `git` command.
 */
function gitHistory(argv: readonly string[], workspace: string): boolean {
  const [program, sub, ...rest] = argv
  if (program !== 'git') return false
  if (sub === 'branch') return rest.length === 2 && rest[0] === '--list' && RUN_BRANCH.test(rest[1]!)
  const forms: Record<string, { flags: (word: string) => boolean; valued: Record<string, RegExp>; revisions: [number, number]; shows: boolean; paths: boolean }> = {
    log: { flags: (w) => w === '--oneline' || LOG_FORMAT.test(w), valued: { '-n': NUMBER }, revisions: [0, 1], shows: false, paths: true },
    show: { flags: () => false, valued: {}, revisions: [1, 1], shows: true, paths: false },
    diff: { flags: (w) => w === '--stat', valued: {}, revisions: [2, 2], shows: false, paths: false },
  }
  const form = sub !== undefined && Object.hasOwn(forms, sub) ? forms[sub] : undefined
  if (!form) return false
  let revisions = 0
  let paths = false
  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!
    if (paths) {
      if (!pathWord(workspace, word)) return false
      continue
    }
    if (word === '--' && form.paths) {
      paths = true
      continue
    }
    if (form.flags(word)) continue
    const value = Object.hasOwn(form.valued, word) ? form.valued[word] : undefined
    if (value) {
      const next = rest[i + 1]
      if (next === undefined || !value.test(next)) return false
      i += 1
      continue
    }
    if (form.paths && pathWord(workspace, word)) continue
    const shown = form.shows ? REVISION_PATH.exec(word) : null
    if (shown) {
      if (shown[2]!.split('/').some((segment) => segment === '..' || segment.toLowerCase() === '.git')) return false
    } else if (!REVISION.test(word)) return false
    revisions += 1
  }
  return revisions >= form.revisions[0] && revisions <= form.revisions[1]
}

/**
 * Each read-only program and the rule its words must pass. `git` is not one: only its history
 * reads are ({@link gitHistory}), judged on their own.
 */
const READ_COMMANDS: Record<string, (args: string[], workspace: string) => boolean> = {
  cat: (args, ws) => optionsAndPaths(args, ws, among('-n'), {}, 1),
  head: (args, ws) => optionsAndPaths(args, ws, (w) => /^-\d+$/.test(w), HEAD_TAIL, 1),
  tail: (args, ws) => optionsAndPaths(args, ws, (w) => /^-\d+$/.test(w), HEAD_TAIL, 1),
  wc: (args, ws) => optionsAndPaths(args, ws, among('-l', '-c', '-w', '-m'), {}, 1),
  ls: (args, ws) => optionsAndPaths(args, ws, LS_FLAGS, {}, 1),
  stat: (args, ws) => optionsAndPaths(args, ws, () => false, {}, 1),
  file: (args, ws) => optionsAndPaths(args, ws, among('-b', '-i'), {}, 1),
  sed: (args, ws) => args.length === 3 && args[0] === '-n' && /^\d+(,\d+)?p$/.test(args[1]!) && pathWord(ws, args[2]!),
  rg: (args, ws) => search(args, ws, among('-n', '-i', '-l', '-F', '-w', '-c', '--line-number'), { '-A': NUMBER, '-B': NUMBER, '-C': NUMBER, '--glob': VALUE, '-g': VALUE, '-t': /^[A-Za-z0-9_]+$/ }),
  grep: (args, ws) => search(args, ws, among('-n', '-i', '-l', '-r', '-F', '-w', '-c', '--line-number'), { '-A': NUMBER, '-B': NUMBER, '-C': NUMBER }),
  find: findRule,
}

/**
 * Probes that can do nothing but print (T187): `echo` with any words (none holds a metacharacter,
 * so the shell expands nothing, and with no backslash `-e` or `-n` changes only how the words are
 * printed), `pwd` with no argument, and `true` and `false` with none. Each is a shell builtin that
 * reads no file and changes nothing; `pwd` shows only the name of the directory the command runs in.
 */
function noopCommand(argv: string[]): boolean {
  const [program, ...args] = argv
  return program === 'echo' || ((program === 'pwd' || program === 'true' || program === 'false') && args.length === 0)
}

/** The words that run one test file (T270), before its path: `corepack pnpm vitest run <path>`. */
const ONE_TEST_RUN: readonly string[] = ['corepack', 'pnpm', 'vitest', 'run']
/** A test file's name, as the repository's test runner takes one (`*.spec.ts`, `*.test.mjs`, …). */
const TEST_FILE = /\.(spec|test|e2e)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/**
 * Whether `argv` is exactly `corepack pnpm vitest run <path>`, its path a test file's name (T270):
 * one test file run with its output readable, where the policy's whole-suite command cuts it. Where
 * the path is is the caller's to judge: inside the workspace, or refused.
 */
function isOneTestRun(argv: readonly string[]): boolean {
  return argv.length === ONE_TEST_RUN.length + 1 && ONE_TEST_RUN.every((word, i) => argv[i] === word) && TEST_FILE.test(argv[ONE_TEST_RUN.length]!)
}

/** The words that run the tests related to some files (T299), before their paths: `corepack pnpm test:related <path>…`. */
const RELATED_TEST_RUN: readonly string[] = ['corepack', 'pnpm', 'test:related']
/** How many files one related-tests run names at most (INV-9). */
const RELATED_FILES_MAX = 64

/**
 * Whether `argv` is exactly `corepack pnpm test:related <path>…`: one to {@link RELATED_FILES_MAX}
 * words, none an option (T299). It runs only the tests of the worktree that relate to those files;
 * where each path is is the caller's to judge: inside the workspace, or refused.
 */
function isRelatedTestRun(argv: readonly string[]): boolean {
  const files = argv.slice(RELATED_TEST_RUN.length)
  return RELATED_TEST_RUN.every((word, i) => argv[i] === word) && files.length >= 1 && files.length <= RELATED_FILES_MAX && files.every((word) => !word.startsWith('-'))
}

/** Whether `argv` is a read-only inspection command inside the workspace (`READ_COMMANDS`). */
function readCommand(argv: string[], workspace: string): boolean {
  const [program, ...args] = argv
  const rule = program !== undefined && Object.hasOwn(READ_COMMANDS, program) ? READ_COMMANDS[program] : undefined
  return rule !== undefined && rule(args, workspace)
}

/**
 * The shell inspection commands a reading tool serves (T222), by group: the programs (the argv's
 * first word, as the gate split it; T147's programs), the reading tools that serve them in the
 * order they are named (the runtime's own first, then the workspace reads server's), and how.
 */
const INSPECTIONS = [
  { programs: ['cat', 'head', 'tail', 'sed'], forms: 'cat, head, tail, sed -n', tools: ['Read', 'read_file'], how: 'it reads a file, a range of its lines too' },
  { programs: ['wc'], forms: 'wc', tools: ['Read', 'read_file'], how: 'it numbers a file\'s lines, so its last line number is the line count' },
  { programs: ['grep', 'rg'], forms: 'grep, rg', tools: ['Grep', 'search'], how: 'it searches files for a pattern' },
  { programs: ['ls', 'find'], forms: 'ls, find', tools: ['Glob', 'LS', 'list_dir'], how: 'it lists a directory or finds files by name' },
] as const

/** find's actions: a `find` that carries one is no inspection, and stays a `command`. */
const FIND_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])

/**
 * Whether `args` is `sed`'s read-only printing form, `-n <a>[,<b>]p <path>…`, its paths relative or
 * absolute (the `sed` rule of {@link READ_COMMANDS}, which wants one absolute path): no other
 * option, so no `-i` and no `-e` or `-f` script, and no script but a line range printed, so none
 * that writes a file (`w`) or runs a command (`e`).
 */
function sedPrints(args: readonly string[]): boolean {
  return args.length >= 3 && args[0] === '-n' && /^\d+(,\d+)?p$/.test(args[1]!) && args.slice(2).every((word) => !word.startsWith('-'))
}

/**
 * The inspection group `argv` is, by its first word, or undefined: `sed` only in its read-only
 * printing form ({@link sedPrints}), `find` only with no action (`-exec`, `-delete`, …), since a
 * form that writes or runs a command is no inspection a reading tool serves.
 */
function inspectionOf(argv: readonly string[]): (typeof INSPECTIONS)[number] | undefined {
  const [program, ...args] = argv
  if (program === undefined) return undefined
  if (program === 'sed' && !sedPrints(args)) return undefined
  if (program === 'find' && args.some((word) => FIND_ACTIONS.has(word))) return undefined
  return INSPECTIONS.find((group) => (group.programs as readonly string[]).includes(program))
}

/**
 * The reading tools a run's agent has (T222), from its runtime's evidence and the Worker's tools
 * list: the workspace reads server's (its git views among them, T223) where the runtime gives it (`workspaceReads`), and the
 * runtime's own (`readTools`) that the tools list keeps (an absent or empty list keeps every one,
 * as the runtime then gives its default set). No evidence: none.
 */
export function readToolsOf(evidence: { workspaceReads?: boolean | undefined; readTools?: readonly string[] | undefined } | undefined, tools: readonly string[] | undefined): string[] {
  const own = (evidence?.readTools ?? []).filter((tool) => !tools?.length || tools.includes(tool))
  return [...own, ...(evidence?.workspaceReads === true ? WORKSPACE_READ_TOOLS : [])]
}

/**
 * The refusal of a shell inspection command whose reading tool the run's agent has (T222): the
 * tools of `readTools` that serve it, named. Undefined when it is no inspection command, or none
 * of its tools is the agent's: it stays a `command`, judged as one.
 */
function inspectionRefusal(argv: readonly string[], readTools: readonly string[] | undefined): Refusal | undefined {
  const group = inspectionOf(argv)
  if (!group || !readTools?.length) return undefined
  const tools = group.tools.filter((tool) => readTools.includes(tool))
  if (!tools.length) return undefined
  const named = tools.join(' or ')
  return {
    refused: `Bash: ${argv[0]} is a shell inspection command, and you have ${named} for it (${group.how}): use ${named} instead. A shell inspection command is denied at once, never asked`,
    reason: 'use-read-tool',
  }
}

const ANSWER = 'Approved: the next run of this session makes exactly this call. Rejected, or unanswered when the request expires: the call is denied.'

/** At most this many of the policy's commands-list lines are shown to the agent (INV-9). */
const NOTE_LINES = 50
const NOTE_LINE_CHARS = 200
/** The UTF-8 bytes of a Worker's Tools section at most, whatever the policy lists (INV-9): 1,000 estimated tokens, the handbook's count of it. */
export const TOOLS_NOTE_MAX = 4000
/** The characters of the workspace path the section names at most. */
const NOTE_PATH_CHARS = 300

/** What the Tools section knows of the run beyond the policy. */
export interface ToolsNoteOptions {
  /** The runtime enforces clean shells (T198): only then is a Bash inspection command a read. Absent: it is not. */
  shellReads?: boolean | undefined
  /** The run has a session a later run continues once a deferred call is approved. Absent: it has one. */
  resumes?: boolean | undefined
  /**
   * The Worker's sandbox. `read-only`: no tool call it makes writes a file, so the section names
   * no writing tool and no commands list, and says writing is unavailable. Absent: `workspace-write`.
   */
  sandbox?: 'read-only' | 'workspace-write' | undefined
  /**
   * The runtime gives the agent the workspace reads server (T200b): its reading tools are the
   * server's read_file, list_dir, and search, and its git views (T223), and it is told to read
   * with them, never with a shell. Absent: it gives none.
   */
  workspaceReads?: boolean | undefined
  /**
   * The reading tools the agent has, by name, as its gate reads them ({@link ClassifyOptions.readTools},
   * T222): the section says a shell inspection command one of them serves is denied at once, and
   * names the tool for each. Absent: none.
   */
  readTools?: readonly string[] | undefined
  /** The run holds its board task's dossier tools (ADR-0070): the section says what to write with them. Absent: it does not. */
  dossier?: boolean | undefined
  /**
   * A research role's run (T262, ADR-0074): the web tools it has, and the web access grant in force
   * for it (`null`: none, so every web call asks the operator). Absent: it is no research run.
   */
  research?: { tools: readonly string[]; grant: { tools: readonly string[]; maxWebCallsPerRun: number; maxClassification: string } | null } | undefined
}

/**
 * The Tools section a Worker is told before its work, fit to its sandbox (a read-only one is told
 * it writes nothing, and given no writing tool or commands list)
 * (docs/design/approvals.md#a-deferred-call; T199, extended by T207): its workspace, the tool calls
 * its gate lets run without asking the operator under the autonomy policy as it stands
 * (`ctx.approvals.policy()`, the studio policy the gate judges by), the gate's own refusals (a
 * shell metacharacter, an empty word, a path outside the workspace; a relative path in a Bash
 * command is never a read), and whether an approval resumes the step. Pure: read from the policy's
 * effective modes and its commands list, the exact lines, never a guess. A call it does not name
 * may still run (the gate decides each call); one it names as unasked is never one the policy asks
 * about now. A Bash inspection command is named as a read only where the runtime enforces clean
 * shells, as the gate judges it; where the runtime gives the agent the workspace reads server
 * (T200b), its tools are the reading tools named, and the agent is told to read with them, never
 * with a shell. Where the agent has reading tools (`options.readTools`, T222), it says a shell
 * inspection command one of them serves is denied at once, never asked, and names the tool to use
 * for each. At most {@link TOOLS_NOTE_MAX} UTF-8 bytes: the commands list is
 * cut first, its rest counted.
 */
export function unaskedNote(policy: { policies: readonly AutonomyPolicyLike[]; effective: ReadonlyArray<{ actionClass: ActionClass; mode: string }> }, workspace: string, options: ToolsNoteOptions = {}): string {
  const mode = (c: ActionClass): string => policy.effective.find((e) => e.actionClass === c)?.mode ?? 'ask'
  const unasked = (c: ActionClass): boolean => mode(c) === 'auto' || mode(c) === 'notify'
  const ws = workspace.length > NOTE_PATH_CHARS ? `${workspace.slice(0, NOTE_PATH_CHARS - 1)}…` : workspace
  const resumes = options.resumes !== false
  const readOnly = options.sandbox === 'read-only'
  const workspaceReads = options.workspaceReads === true
  const lines: string[] = []
  if (unasked('read')) {
    lines.push(`- Reading tools (${workspaceReads ? 'the workspace server\'s read_file, list_dir, search, git_log, git_show, git_diff, and git_status' : 'Read, Glob, Grep, LS'}) on paths inside your workspace ${ws}.`)
    if (options.shellReads === true) {
      lines.push(`- Bash read-only inspection, every path absolute and inside ${ws} (a relative path, or a form that names none, asks): cat, head, tail, wc, ls, stat, file, sed -n <a>,<b>p, rg, grep, and find without actions; and echo, pwd, true, false with no argument but echo's.`)
    }
  }
  if (unasked('workspace-write') && !readOnly) lines.push(`- Writing tools (Write, Edit) on files inside ${ws}, outside its .git.`)
  // The git history reads (T276): a read in a clean shell, else judged as a listed command is (a workspace write unless commands are forbidden).
  const history = (options.shellReads === true && unasked('read')) || unasked('command') || (mode('command') !== 'forbid' && unasked('workspace-write'))
  if (history && !options.research) lines.push(`- Bash git history, read-only, every path absolute and inside ${ws}: git log [<ref>|<a>..<b>] [--oneline] [-n <k>] [--format=<placeholders>] [-- <path>], git show <sha>[:<path>], git diff <a> <b> [--stat], git branch --list system/run/<runId>.`)
  // A research run's web calls under the web access grant (T262): never a call the policy forbids.
  const research = options.research
  const webTools = research ? research.tools.filter((t) => research.grant?.tools.includes(t)) : []
  if (research?.grant && webTools.length && mode('external-send') !== 'forbid') {
    lines.push(`- Web calls (${webTools.join(', ')}), at most ${research.grant.maxWebCallsPerRun} in this run, each whose query or URL passes the egress check: it names no path of this machine and no credential, and your work is classified at most ${research.grant.maxClassification}. Past the bound, or refused by the egress check, a web call waits for the operator. Put nothing from your workspace or brief in a query or URL but the words you search for.`)
  }
  // The policy's rule (approvals policy.ts `judge`, T209): a command on the commands list is judged
  // as a workspace write, not as a command, unless the command class is forbidden. So a listed
  // command follows the workspace-write mode, any other command the command mode. The gate runs a
  // listed command unasked whatever the sandbox (a read-only one makes a writing command fail).
  const command = mode('command')
  const writes = unasked('workspace-write')
  const listed = command === 'forbid' ? [] : (policy.policies[0]?.commands ?? []).filter((line) => line.length <= NOTE_LINE_CHARS)
  const listing: string[] = []
  let exception = false
  if (unasked('command')) {
    // Every other command runs; a listed one is the exception unless writes run too.
    if (listed.length && !writes) {
      exception = true
      listing.push(...listed)
    } else lines.push(readOnly ? '- Any other Bash command, under your read-only sandbox (it changes no file).' : '- Any other Bash command.')
  } else if (listed.length && writes) listing.push(...listed)
  // The inspection commands the gate denies at once, each with the reading tool to use (T222).
  const served = INSPECTIONS.map((group) => ({ group, tools: group.tools.filter((tool) => options.readTools?.includes(tool)) })).filter((s) => s.tools.length)
  const inspections = !served.length ? ''
    : ` A Bash inspection command you have a reading tool for is denied at once, never asked${options.shellReads === true ? ' (unless it is one of the reads above)' : ''}: ${served.map(({ group, tools }) => `${group.forms}: use ${tools.join(' or ')} (${group.how})`).join('; ')}.`
  const bashReads = (options.shellReads === true
    ? ''
    : served.length
      ? ` Under this runtime no Bash command is a read: read with the ${workspaceReads ? 'workspace server\'s tools, never with a shell' : 'reading tools'}.`
      : ` Under this runtime no Bash command is a read (cat, ls, rg, and the like are commands, judged as one): read with the ${workspaceReads ? 'workspace server\'s tools, never with a shell' : 'reading tools'}.`) + inspections
  // Whether an approval resumes the step is said whatever the command mode: a read or a write the
  // policy asks about defers (and resumes) or is denied at once just as a command does.
  const commandsForbidden = command === 'forbid'
  const asking = commandsForbidden || unasked('command') ? 'A call the policy asks the operator about' : 'Any other command'
  const rule = !listed.length ? ''
    : `A command on the autonomy policy's commands list is judged as a workspace write, not as a command: ${writes ? 'workspace writes run unasked, so it runs unasked too'
      : mode('workspace-write') === 'forbid' ? 'workspace writes are denied, so it is denied too, even where other commands run unasked'
      : 'workspace writes wait for the operator, so it waits too, even where other commands run unasked'}. `
  const otherwise = rule + (commandsForbidden ? 'Any other command is denied. ' : '') + (!resumes
    ? `${asking} is denied at once: this run has no session an approval could resume.`
    : `${asking} waits for the operator; unanswered in time, or rejected, it is denied and you go on without it, so prefer the calls above. An approval resumes this step: the run stops at that call, and once it is approved a later run of this session makes exactly that call.`)
  const head = [
    'Tools (your tool gate and the autonomy policy now):',
    `- Workspace: ${ws}. A tool's path outside it is denied, and so is a write in its .git.`,
    ...(workspaceReads
      ? ['- Read your workspace with the workspace server\'s tools, never with a shell: read_file (path; startLine and endLine for a range), its lines numbered; list_dir (path; default the workspace); search, the lines that hold a fixed string (pattern) or match a regular expression (regex: true), under a path (default the workspace). Read its git history the same way: git_log (count, skip, commit, paths), git_show (commit; stat, patch), git_diff (the worktree, or cached: the index, against HEAD; or from and to), git_status; a commit is always its hex id (from git_log), never a branch name. Each path is relative to the workspace, or absolute inside it, with no "..".']
      : []),
    ...(readOnly ? ['- Your sandbox is read-only: no tool call writes a file (Write, Edit, and any command that changes one fail), so read, and answer with what you found.'] : []),
    ...(research ? [`- You are a research role: you read your workspace and search and fetch the web (${research.tools.length ? research.tools.join(', ') : 'no web tool'}), and nothing else; a call that writes a file or runs a command is denied.${research.grant ? '' : ' No web access is granted now, so each web call waits for the operator.'}`] : []),
    ...(options.dossier === true
      ? ['- Your board task\'s dossier, through which its Workers work (none reads your conversation): dossier_read pages through it; dossier_append adds your entry as this step\'s Worker: a plan at the start, progress after each step (what you did, its commits, what remains, small decisions and why), a response per review finding (fixed in which commit, or not and why); a reviewer, its review.']
      : []),
    'Tool calls that run without asking the operator:',
  ]
  const tail = [
    ...(lines.length || listing.length ? [] : ['- none now: every call asks the operator or is denied.']),
    `Refused by the gate, never asked: a Bash command is words split on single spaces, never parsed by a shell, so a word with a shell metacharacter (; & | $ < > ( ) quotes * ? ~ and the like) or an empty word (a doubled, leading, or trailing space) is denied. Name every path in a Bash command absolute: the gate does not see the directory a command runs in, so a relative path makes no command a read.${bashReads}${readOnly ? '' : ` Tests: one test file runs as corepack pnpm vitest run <its absolute path inside the workspace>, judged as a write of the workspace (a relative path is refused there). Several test files in one command are a command the operator is asked about: name them with paths relative to your worktree (corepack pnpm vitest run packages/plugins/x/tests/a.spec.ts packages/plugins/x/tests/b.spec.ts), so the operator reads it short and whole; a command past ${COMMAND_MAX} characters is refused.`}`,
    otherwise,
  ]
  if (listing.length) {
    // The commands list fills what the rest leaves of the bound, line by line, its rest counted.
    const intro = exception
      ? `- Any other Bash command${readOnly ? ', under your read-only sandbox (it changes no file),' : ','} except one on the autonomy policy's commands list:`
      : '- Bash, exactly these commands, word for word (the autonomy policy\'s commands list; no other word, option, or argument):'
    let budget = TOOLS_NOTE_MAX - utf8([...head, ...lines, intro, ...tail].join('\n')) - 40
    const shown: string[] = []
    for (const line of listing.slice(0, NOTE_LINES)) {
      if (utf8(line) + 5 > budget) break
      shown.push(`  - ${line}`)
      budget -= utf8(line) + 5
    }
    if (shown.length) {
      lines.push(intro, ...shown)
      if (listing.length > shown.length) lines.push(`  - and ${listing.length - shown.length} more`)
    } else {
      lines.push(`- Bash, ${listing.length} exact command(s) of the autonomy policy's commands list (not shown here).`)
    }
  }
  const note = [...head, ...lines, ...tail].join('\n')
  if (utf8(note) <= TOOLS_NOTE_MAX) return note
  // Cut by UTF-8 bytes, whole code points, the ellipsis (3 bytes) included.
  let cut = ''
  let used = 0
  for (const char of note) {
    if (used + utf8(char) > TOOLS_NOTE_MAX - 3) break
    cut += char
    used += utf8(char)
  }
  return `${cut}…`
}

/** UTF-8 bytes of a text: the Tools section is bounded in bytes, so the handbook's estimate (`ceil(bytes / 4)`) of it never passes 1,000 tokens. */
function utf8(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** The part of a policy {@link unaskedNote} reads. */
interface AutonomyPolicyLike { commands?: string[] | undefined }

/** The file headers of a patch, and what each does to the file it names. */
const PATCH_HEADERS = [['*** Add File: ', 'add'], ['*** Delete File: ', 'delete'], ['*** Update File: ', 'update'], ['*** Move to: ', 'move to']] as const

/**
 * The files a patch touches, as its headers name them, read strictly in the patch format's own
 * grammar (`*** Begin Patch`, then `Add File` with `+` lines, `Delete File`, or `Update File` with an
 * optional `Move to` and `@@`, ` `, `+`, `-` lines and `*** End of File`, then `*** End Patch`). The
 * tool acts only on files its headers name, so every one is returned; anything the grammar does
 * not allow (a line starting `***` that is not a header where one may stand, a carriage return, a
 * name with surrounding spaces) refuses the whole patch: the gate never guesses at a lenient reading.
 */
function patchFiles(patch: string): Array<{ op: string; path: string }> | { refused: string } {
  const lines = patch.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (patch.includes('\r') || patch.includes('\0')) return { refused: 'the patch holds a carriage return or a NUL' }
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch' || lines.length < 3) return { refused: 'the patch does not start with *** Begin Patch and end with *** End Patch' }
  const files: Array<{ op: string; path: string }> = []
  let state: 'add' | 'delete' | 'update' | 'moved' | 'eof' | undefined
  for (const [i, line] of lines.slice(1, -1).entries()) {
    const header = PATCH_HEADERS.find(([prefix]) => line.startsWith(prefix))
    if (header) {
      const [prefix, op] = header
      const path = line.slice(prefix.length)
      if (path === '' || path !== path.trim()) return { refused: `patch line ${i + 2} names no file, or one with surrounding spaces` }
      if (op === 'move to' && state !== 'update') return { refused: `patch line ${i + 2}: Move to stands only right after Update File` }
      files.push({ op, path })
      state = op === 'move to' ? 'moved' : op
      continue
    }
    if (line.trimStart().startsWith('***')) {
      if (line === '*** End of File' && (state === 'update' || state === 'moved')) {
        state = 'eof'
        continue
      }
      return { refused: `patch line ${i + 2} is a *** line the patch format does not define here` }
    }
    // An empty line in an update hunk is an empty context line, as the tool itself reads it.
    const ok = state === 'add' ? line.startsWith('+') : state === 'update' || state === 'moved' ? /^[ +-]/.test(line) || line === '' || line === '@@' || line.startsWith('@@ ') : false
    if (!ok) return { refused: `patch line ${i + 2} is not a line its hunk may hold` }
  }
  if (!files.length) return { refused: 'the patch names no file' }
  return files
}

/**
 * One of the workspace reads server's git views (T223), its fields already known whole: `read` when
 * every commit it names (`commit`, `from`, `to`) is a hex id and every path of `paths` is inside the
 * workspace (as written and on disk; a path only history has is where it would be), holds no `..`
 * segment, and is not git's own data; the server refuses the rest itself, and so does the gate.
 */
function classifyGitView(tool: string, input: Record<string, unknown>, workspace: string): ToolAction | Refusal {
  for (const field of GIT_COMMIT_FIELDS) {
    const value = input[field]
    if (value !== undefined && (typeof value !== 'string' || !COMMIT_ID.test(value))) {
      return { refused: `${tool} names ${field} ${JSON.stringify(String(value).slice(0, 100))}, which is not a commit's hex id: the workspace reads server takes no other`, reason: 'invalid-input' }
    }
  }
  const paths = (input.paths as string[] | undefined) ?? []
  for (const path of paths) {
    if (path === '' || !within(workspace, path)) return { refused: `${tool} names ${path === '' ? 'an empty path' : path}, which is not inside the workspace`, reason: path === '' ? 'invalid-input' : 'outside-workspace' }
    if (path.split(/[\\/]/).includes('..')) return { refused: `${tool} names ${path}, which climbs with "..": the workspace reads server never reads such a path`, reason: 'outside-workspace' }
    if (gitData(workspace, path)) return { refused: `${tool} names ${path}, which is git's own data (.git): the workspace reads server never reads it`, reason: 'git-data' }
  }
  const where = paths.length ? paths.join(' ') : 'the workspace'
  return { class: 'read', summary: clamp(`${tool} ${where}`), consequences: `Reads the git history and status of the run's workspace (${clamp(where)}), without a shell. ${ANSWER}` }
}

/**
 * Classify one tool call, conservatively; `{ refused }` for a call the gate does not classify,
 * which is denied without asking anyone. Every classified tool's input may carry only the fields
 * its SDK type declares, each of its type (an unknown field, or a wrong type, is refused), and a
 * path is inside the workspace only where it really is, every symlink followed:
 * - `Read`, `NotebookRead`, `LS`, `Glob`, `Grep`, `view_image`, `read_file`: `read`, when the path
 *   they name is inside the workspace (absent for `Glob` and `Grep`: the workspace); a `Glob`
 *   pattern whose literal leading directory is outside it, or that climbs with `..`, is refused;
 * - the workspace reads server's `mcp__workspace__read_file`, `mcp__workspace__list_dir`, and
 *   `mcp__workspace__search` (T200b): `read`, when the `path` they name is inside the workspace
 *   (absent or empty for `list_dir` and `search`: the workspace), holds no `..` segment, and is not
 *   git's own data; they run no program. Its git views `mcp__workspace__git_log`, `…git_show`,
 *   `…git_diff`, `…git_status` (T223): `read`, when every commit they name is a hex id and every
 *   path of their `paths` passes the same checks ({@link classifyGitView}). Only for a run whose
 *   runtime gives its agent that server (`options.workspaceReads`, its evidence); otherwise, and for
 *   any other tool of that server (`mcp__workspace__…`), refused;
 * - `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `write_file`, `edit_file`: `workspace-write`, for
 *   a file inside the workspace; outside it is refused (the runtime refuses it too), and so is a
 *   file in git's own data (a `.git` entry in its path, as written or on disk);
 * - `apply_patch`: `workspace-write`, when its patch reads strictly in the patch grammar and every
 *   file a header names (added, deleted, updated, or moved to) is inside the workspace and not in
 *   git's own data;
 * - `Bash`: an empty word (a doubled, leading, or trailing space) or a word with a shell
 *   metacharacter is refused here first, before the policy is asked (which forbids the latter
 *   too). Then, only where the runtime enforces clean shells (`options.shellReads`, below), a
 *   probe that can do nothing is `read` (summary the command, no argv): `echo` with
 *   zero or more words (any word, `-e` and `-n` included: with no metacharacter it only prints
 *   them), `pwd` with no argument, and `true` and `false` with none; they read no file and change
 *   nothing, so a Worker's probe never waits on the operator. A read-only inspection command inside
 *   the workspace is `read` too (summary the command, no argv): `cat`, `head`, `tail`, `wc`, `ls`, `stat`, `file` with a few options each and every
 *   other word a path inside the workspace; `sed -n <a>[,<b>]p <path>` exactly; `rg` and `grep`
 *   with allowed options only (never `--pre`, `-f`, `-z`, `-L`, …), a free-text pattern, and paths
 *   inside the workspace; `find <paths>` with only `-name`, `-iname`, `-path`, `-type`,
 *   `-maxdepth`, `-mindepth` (never an action such as `-exec` or `-delete`, nor `-L`). Every path
 *   is absolute, with no `..`, and at least one is named: the gate does not see the directory the
 *   command runs in (Codex's `exec_command` takes a `workdir` its hook does not report), so a
 *   relative path, a form that reads its working directory, and `git` (which finds its repository
 *   and configuration there) stay a `command`. The shell that runs it sees the same words (no
 *   metacharacter, so no expansion), under the run's read confinement and its runtime's own
 *   sandbox. Any word the rule does not match exactly, or that could be read as either an option
 *   or a path, leaves the call a `command`: its argv the command split on single spaces, exactly
 *   as the policy's exact-argv rule matches it. But where the run's agent has the reading tool for
 *   a shell inspection command (`options.readTools`, T222; {@link INSPECTIONS}: `Read` or
 *   `read_file` for `cat`, `head`, `tail`, `sed -n`, `wc`; `Grep` or `search` for `grep`, `rg`;
 *   `Glob` or `list_dir` for `ls`, `find`), recognised by its first word whatever its other words,
 *   it is refused (`use-read-tool`), naming the tool, and opens no request; a `sed` other than
 *   `sed -n <a>[,<b>]p <path>…` (an in-place edit, a `-e` or `-f` script, a script that writes
 *   or runs a command) or a `find` with an action is no inspection, and stays a `command`.
 *   Exactly `corepack pnpm vitest run <path>`, its path a test file's name (`*.spec.ts`,
 *   `*.test.mjs`, …), is one test file run with readable output (T270): a `workspace-write`, under
 *   any runtime, when the path is absolute, with no `..`, and inside the workspace on disk (so it
 *   runs wherever the policy lets a write of the workspace run); refused (`outside-workspace`) when it
 *   is not. Any other word, option, or a second path leaves it a `command`;
 *   likewise `corepack pnpm test:related <path>…` (T299), one to 64 paths, none an option, each
 *   absolute and inside the workspace, else refused (`outside-workspace`): the tests related to
 *   those files, run in the worktree;
 * - `WebFetch`, `WebSearch`: `external-send`;
 * - the host tools its source gave the run (`options.hostTools`, ADR-0070), as `mcp__system__<name>`:
 *   `dossier_read`, a `read`; `dossier_append`, a `workspace-write` (System's own record of the work,
 *   no file); each with only its own fields. Any other `mcp__system__…` tool, or one the run was not
 *   given, is refused;
 * - any other tool (`run_command` among them), or an input that is not an object: refused.
 * A path may be a `file:` URI, which is checked as the path it names.
 *
 * A `Bash` probe or inspection command is `read` only with `options.shellReads` (T198): the run's
 * runtime itself starts every shell a call's command runs in, non-login and non-interactive, with no
 * startup file or startup variable, in a shell the agent cannot choose (`RuntimeEvidence.cleanShells`),
 * so the program a word names is the one that runs. Without it, absent included, such a command
 * stays a `command`, judged by its exact argv like any other (INV-2: what cannot be enforced is not
 * assumed). Neither Codex (each call picks its shell and login mode) nor Claude Code (each command
 * sources its shell snapshot) reports it, so under either no shell command is a read.
 */
export function classify(call: ToolCall, workspace: string, options: ClassifyOptions = {}): ToolAction | Refusal {
  const { tool } = call
  const input = call.input
  if (tool.startsWith(SERVER_PREFIX)) {
    // The read class rests on the runtime's evidence that this server is System's own (T200b): a
    // server of that name a runtime did not start is no read.
    if (options.workspaceReads !== true) return { refused: `${tool.slice(0, 100)} is not a tool the gate classifies: this run's runtime gives its agent no workspace reads server`, reason: 'unclassified-tool' }
    if (!SERVER_TOOLS.includes(tool)) return { refused: `${tool.slice(0, 100)} is not one of the workspace reads server's tools (${WORKSPACE_READ_TOOLS.join(', ')}); no other tool of it runs`, reason: 'unclassified-tool' }
  }
  if (tool.startsWith(HOST_PREFIX)) {
    // Only a host tool the run's source gave it (ADR-0070): a server of that name it was not given is no tool of System's.
    const name = tool.slice(HOST_PREFIX.length)
    const host = Object.hasOwn(HOST_TOOL_FIELDS, name) ? HOST_TOOL_FIELDS[name] : undefined
    if (!host || !options.hostTools?.includes(name)) return { refused: `${tool.slice(0, 100)} is not a tool the gate classifies: this run was given no such host tool`, reason: 'unclassified-tool' }
    if (!isRecord(input)) return { refused: `the input of ${tool} is not an object`, reason: 'invalid-input' }
    const unknown = unknownField(input, host.fields)
    if (unknown) return { refused: `${tool} ${unknown}`, reason: 'unsupported-field' }
    return { class: host.class, summary: clamp(`${tool}${typeof input.kind === 'string' ? ` ${input.kind}` : ''}`), consequences: `${host.summary}. ${ANSWER}` }
  }
  if (!isRecord(input)) return { refused: `the input of ${tool} is not an object`, reason: 'invalid-input' }
  const fields = Object.hasOwn(FIELDS, tool) ? FIELDS[tool] : undefined
  if (!fields) return { refused: `${tool} is not a tool the gate classifies`, reason: 'unclassified-tool' }
  const unknown = unknownField(input, fields)
  if (unknown) return { refused: `${tool} ${unknown}`, reason: 'unsupported-field' }
  if (GIT_VIEWS.includes(tool)) return classifyGitView(tool, input, workspace)
  const read = Object.hasOwn(READS, tool) ? READS[tool] : undefined
  if (read) {
    if (tool === 'Glob') {
      const pattern = input.pattern
      const base = typeof input.path === 'string' ? input.path : undefined
      const literal = typeof pattern === 'string' ? pattern.split(/[*?[{]/)[0]! : ''
      const dir = pattern === undefined || isAbsolute(literal) ? literal : base === undefined ? literal || '.' : `${base}${sep}${literal}`
      if (typeof pattern !== 'string' || pattern.split(/[\\/]/).includes('..') || !within(workspace, dir)) {
        return { refused: `the Glob pattern ${JSON.stringify(pattern)} reaches outside the workspace`, reason: typeof pattern === 'string' ? 'outside-workspace' : 'invalid-input' }
      }
    }
    // The workspace reads server reads an empty path as its root, the workspace.
    const where = SERVER_TOOLS.includes(tool) && input[read.field] === '' ? '.' : input[read.field]
    if (where === undefined && !read.required) return { class: 'read', summary: clamp(`${tool} in the workspace`), consequences: `Reads inside the run's workspace. ${ANSWER}` }
    if (typeof where !== 'string' || !within(workspace, where)) return { refused: `${tool} reads ${typeof where === 'string' ? where : 'no path'}, which is not inside the workspace`, reason: typeof where === 'string' ? 'outside-workspace' : 'invalid-input' }
    // The server refuses these itself; the gate does not ask the policy about a call it would refuse.
    if (SERVER_TOOLS.includes(tool)) {
      if (where.split(/[\\/]/).includes('..')) return { refused: `${tool} names ${where}, which climbs with "..": the workspace reads server never reads such a path`, reason: 'outside-workspace' }
      if (gitData(workspace, where)) return { refused: `${tool} names ${where}, which is git's own data (.git): the workspace reads server never reads it`, reason: 'git-data' }
    }
    return { class: 'read', summary: clamp(`${tool} ${where}`), consequences: `Reads ${where} inside the run's workspace. ${ANSWER}` }
  }
  const patchField = Object.hasOwn(PATCHES, tool) ? PATCHES[tool] : undefined
  if (patchField) {
    const patch = input[patchField]
    if (typeof patch !== 'string') return { refused: `${tool} carries no patch`, reason: 'invalid-input' }
    const files = patchFiles(patch)
    if ('refused' in files) return { refused: `${tool}: ${files.refused}`, reason: 'invalid-patch' }
    const outside = files.find((f) => !within(workspace, f.path))
    if (outside) return { refused: `${tool} changes ${outside.path}, which is not inside the workspace`, reason: 'outside-workspace' }
    const git = files.find((f) => gitData(workspace, f.path))
    if (git) return { refused: `${tool} changes ${git.path}, which is git's own data (.git): only an asked command or the operator changes it`, reason: 'git-data' }
    const touched = clamp(files.map((f) => `${f.op} ${f.path}`).join(', '))
    return { class: 'workspace-write', summary: clamp(`${tool}: ${touched}`), consequences: `Changes ${files.length === 1 ? 'one file' : `${files.length} files`} inside the run's workspace: ${touched}. ${ANSWER}` }
  }
  const write = Object.hasOwn(WRITES, tool) ? WRITES[tool] : undefined
  if (write) {
    const file = input[write]
    if (typeof file !== 'string' || !within(workspace, file)) return { refused: `${tool} changes ${typeof file === 'string' ? file : 'no file'}, which is not inside the workspace`, reason: typeof file === 'string' ? 'outside-workspace' : 'invalid-input' }
    if (gitData(workspace, file)) return { refused: `${tool} changes ${file}, which is git's own data (.git): only an asked command or the operator changes it`, reason: 'git-data' }
    return { class: 'workspace-write', summary: clamp(`${tool} ${file}`), consequences: `Changes ${file} inside the run's workspace. ${ANSWER}` }
  }
  if (tool === COMMAND) {
    const command = input.command
    if (typeof command !== 'string' || command === '') return { refused: `${tool} names no command`, reason: 'invalid-input' }
    // A request carries the whole command, so a longer one is refused, never cut (T295).
    if (command.length > COMMAND_MAX) return { refused: `${tool}: the command is ${command.length} characters, past the ${COMMAND_MAX} an approval request shows whole; run a shorter command: give paths relative to your worktree, and fewer files per command`, reason: 'invalid-input' }
    const argv = command.split(' ')
    // Defence in depth: the policy forbids a metacharacter word too, but the gate never asks it about one.
    const empty = argv.indexOf('')
    if (empty >= 0) return { refused: `${tool}: argv word ${empty + 1} is empty (a doubled, leading, or trailing space); a command is words split on single spaces`, reason: 'empty-word' }
    const unsafe = argv.findIndex((word) => SHELL_METACHARACTER.test(word))
    if (unsafe >= 0) return { refused: `${tool}: argv word ${unsafe + 1} holds a shell metacharacter; a command is never parsed by a shell`, reason: 'metacharacter' }
    // A program is what its name says only in a shell enforced to read no startup code (T198): elsewhere a
    // function or an alias a startup file defined could run instead, so nothing is taken for a read.
    if (options.shellReads === true && noopCommand(argv)) return { class: 'read', summary: clamp(command), consequences: `Prints its words or the working directory, or nothing, and reads and changes nothing: ${clamp(command)}. ${ANSWER}` }
    if (options.shellReads === true && readCommand(argv, workspace)) return { class: 'read', summary: clamp(command), consequences: `Reads inside the run's workspace: ${clamp(command)}. ${ANSWER}` }
    // A git history read (T276): a read in a clean shell; elsewhere a command the gate judges as a listed one is judged.
    if (gitHistory(argv, workspace)) {
      if (options.shellReads === true) return { class: 'read', summary: clamp(command), consequences: `Reads the git history of the run's workspace: ${clamp(command)}. ${ANSWER}` }
      return { class: 'command', command: argv, historyRead: true, summary: clamp(`${tool}: ${command}`), consequences: `Runs this read-only git command in the run's workspace: it reads its history and changes nothing. ${ANSWER}` }
    }
    // One test file, run with its output readable (T270): a write of the workspace (the runner's caches
    // there), only for a test file inside it; outside it, refused before the policy is asked.
    if (isOneTestRun(argv)) {
      const file = argv[ONE_TEST_RUN.length]!
      // A relative path is the policy's command rules' to judge (the shell starts in the worktree); it stays a command.
      if (!file.startsWith('/')) return { class: 'command', command: argv, summary: clamp(`${tool}: ${command}`), consequences: `Runs this exact command in the run's workspace: ${command}\n${ANSWER}` }
      if (!pathWord(workspace, file)) return { refused: `${tool}: ${clamp(file)} is not a test file inside the workspace (an absolute path, with no "..", that stays inside it on disk): one test file runs only inside the run's worktree`, reason: 'outside-workspace' }
      return { class: 'workspace-write', summary: clamp(command), consequences: `Runs the one test file ${file} inside the run's workspace, its output readable; it writes only the test runner's caches there. ${ANSWER}` }
    }
    // The tests related to the files a Worker changed (T299): a write of the workspace (the runner's caches), only for files inside it.
    if (isRelatedTestRun(argv)) {
      const files = argv.slice(RELATED_TEST_RUN.length)
      const outside = files.find((file) => file.startsWith('/') && !pathWord(workspace, file))
      // A relative path is the policy's command rules' to judge (the shell starts in the worktree); it stays a command.
      if (outside === undefined && files.some((file) => !file.startsWith('/'))) return { class: 'command', command: argv, summary: clamp(`${tool}: ${command}`), consequences: `Runs this exact command in the run's workspace: ${command}\n${ANSWER}` }
      if (outside !== undefined) return { refused: `${tool}: ${clamp(outside)} is not a file inside the workspace (an absolute path, with no "..", that stays inside it on disk): the related tests run only on the run's worktree`, reason: 'outside-workspace' }
      return { class: 'workspace-write', summary: clamp(command), consequences: `Runs the tests of the run's workspace that relate to the files named, inside it; it writes only the test runner's caches there. ${ANSWER}` }
    }
    // An inspection command the agent has a reading tool for is denied at once, naming it, never asked (T222).
    const inspection = inspectionRefusal(argv, options.readTools)
    if (inspection) return inspection
    return { class: 'command', command: argv, summary: clamp(`${tool}: ${command}`), consequences: `Runs this exact command in the run's workspace: ${command}\n${ANSWER}` }
  }
  const send = Object.hasOwn(SENDS, tool) ? SENDS[tool] : undefined
  if (send) {
    const what = input[send]
    if (typeof what !== 'string' || what === '') return { refused: `${tool} names no ${send}`, reason: 'invalid-input' }
    return { class: 'external-send', summary: clamp(`${tool}: ${what}`), consequences: `Sends this request out of this machine. ${ANSWER}` }
  }
  return { refused: `${tool} is not a tool the gate classifies`, reason: 'unclassified-tool' }
}

/** The run a gate is for: where it works, who asked, and the classification of what it shows. */
export interface GateRun {
  /** The agent run (`arun_…`). */
  runId: string
  worker: string
  /** The Worker's kind, its runtime (`claude-agent-sdk`, `codex-sdk`, …): its denials are counted by it (T207). */
  workerKind?: string | undefined
  workspace: string
  /**
   * The repository the run's worktree is cut from (a real path), when the run works in one: a
   * command rule's `repository-read` paths may be under it, read-only. Absent: the worktree only.
   */
  repository?: string | undefined
  /** The run's session: an approved call runs in a later run of it. */
  sessionId?: string | undefined
  /** The workflow run the agent run belongs to, for the decisions' and events' lineage. */
  workflowRunId?: string | undefined
  classification: 'public' | 'operator-shared' | 'local-private'
  /**
   * The run's step is a review team member's, under the review-member profile (ADR-0049): its
   * material is its prompt alone, so the gate denies every tool call, each a recorded decision.
   * `research` (T262, ADR-0074): the run is a research role's, which reads and searches the web only:
   * a call that writes or runs a command is denied (`research-role`), and a web call is judged under
   * the autonomy policy's web access grant ({@link runGate}).
   */
  profile?: 'review-member' | 'research' | undefined
  /**
   * The board task's project the run serves (its brief's, from the engine's own record): a research
   * run's calls are judged under that project's policy as well as the studio's, so a project's
   * prohibition binds and its grant narrows the studio's.
   */
  projectId?: string | undefined
  /**
   * The board task the run serves (its brief's, from the engine's own record): a request it asks names
   * it, so the task's project's lead may give its verdict (ADR-0076). It never changes how a call is judged.
   */
  taskId?: string | undefined
  /** The workflow step (node id) the run serves, from the engine's own start: its web calls' decisions name it. */
  nodeId?: string | undefined
  /**
   * The research role's web probe (./web-probe.ts): the only call that runs is `WebSearch` with exactly
   * {@link WEB_PROBE_QUERY}; every other is denied (`research-role`). Only with profile `research`.
   */
  webProbe?: boolean | undefined
  /**
   * The run's runtime enforces that its shells read no startup code (`RuntimeEvidence.cleanShells`,
   * T198): only then does the gate take a `Bash` probe or inspection command for a read ({@link classify}).
   */
  shellReads?: boolean | undefined
  /**
   * The run's runtime gives its agent System's own workspace reads server
   * (`RuntimeEvidence.workspaceReads`, T200b): only then does the gate take that server's three
   * tools for reads ({@link classify}); otherwise every `mcp__workspace__…` call is denied.
   */
  workspaceReads?: boolean | undefined
  /**
   * The reading tools the run's agent has, by name (T222; {@link ClassifyOptions.readTools}): a
   * shell inspection command one of them serves is denied at once, naming it, and asks no one.
   */
  readTools?: readonly string[] | undefined
  /**
   * The host tools the run's agent was given, by name (ADR-0070; {@link ClassifyOptions.hostTools}):
   * only these of `mcp__system__…` are classified; any other is denied.
   */
  hostTools?: readonly string[] | undefined
}

/** The call a run's gate deferred: the run stops there and does not complete. */
export interface Deferral {
  tool: string
  requestId: string
  reason: string
}

export interface RunGate {
  gate: ToolGate
  /** The call the gate deferred, once it deferred one. */
  deferral(): Deferral | undefined
}

interface RequestRow { request_id: string; run_id: string; used_at: string | null }

/**
 * The table of requests a gate opened, one row per request: the session and exact call it is for
 * (tool and the content id of its input), and when an approved one was used. An approval covers
 * one call: once used, the same call asks again.
 */
export const GATE_MIGRATION = {
  version: 5,
  sql: `CREATE TABLE agent_tool_requests (
    request_id TEXT PRIMARY KEY, scope TEXT NOT NULL, tool TEXT NOT NULL, input_hash TEXT NOT NULL, run_id TEXT NOT NULL,
    created_at TEXT NOT NULL, used_at TEXT, used_by TEXT
  );
  CREATE INDEX agent_tool_requests_call ON agent_tool_requests (scope, tool, input_hash, created_at);`,
}

/**
 * A call's denial by the workflow engine, kept on its request's row (docs/design/approvals.md#a-deferred-call):
 * when, the engine's `recovery` decision `deny`, and its cause. Durable, so the call stays denied in
 * its session across workflows, restarts, and the event log's retention, whatever the queue says
 * of the request later (an approval given after the deadline, a request left open when its
 * withdrawal failed).
 */
export const DENIAL_MIGRATION = {
  version: 18,
  sql: `ALTER TABLE agent_tool_requests ADD COLUMN denied_at TEXT;
  ALTER TABLE agent_tool_requests ADD COLUMN denial_decision TEXT;
  ALTER TABLE agent_tool_requests ADD COLUMN denial_cause TEXT;`,
}

/**
 * Record that the call request `requestId` was for is denied for good in its session: the engine's
 * `recovery` decision `deny` and its cause, on the request's row, in the caller's transaction. The
 * first denial stands (idempotent). False when no gate opened that request, so nothing could hold it.
 */
export function recordDenial(ctx: Context, requestId: string, denial: { decision: string; cause: string }): boolean {
  return ctx.store.transaction((db) => {
    if (!db.prepare('SELECT 1 FROM agent_tool_requests WHERE request_id = ?').get(requestId)) return false
    db.prepare('UPDATE agent_tool_requests SET denied_at = ?, denial_decision = ?, denial_cause = ? WHERE request_id = ? AND denied_at IS NULL')
      .run(new Date().toISOString(), denial.decision, denial.cause.slice(0, 64), requestId)
    return true
  })
}

/**
 * The first part of a stored request that is not the call the gate's row says it is for: its
 * subject (`content`, the ref naming the run that opened it and the tool, the input's content id),
 * its action class, and its requester (`worker`, that run, this session). Undefined when it is.
 */
function mismatch(request: ApprovalRequest, call: { ref: string; version: string; actionClass: ActionClass; runId: string; sessionId: string }): string | undefined {
  if (request.subject.type !== 'content') return 'subject type'
  if (request.subject.ref !== call.ref) return 'subject ref'
  if (request.subject.version !== call.version) return 'subject version'
  if (request.action.class !== call.actionClass) return 'action class'
  if (request.requester.component !== 'worker') return 'requester component'
  if (request.requester.runId !== call.runId) return 'requester run'
  if (request.requester.sessionId !== call.sessionId) return 'requester session'
  return undefined
}

const execFileAsync = promisify(execFile)
const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

/**
 * Whether `word` is a path a command rule allows under `scope` (`autonomy-policy@1.4`): relative to
 * the worktree (the runtime starts a Worker's shell there) or absolute; no `..`, never git's own data
 * (`.git`, as written or on disk), every symlink followed on disk. `run-worktree` is inside the
 * worktree below its top, and never `.system`; `repository-read` is inside the worktree or the run's
 * repository, read-only, `.system` included; `scratch-file` is `run-worktree` that is an untracked
 * regular file (not a link, not a directory), as `git ls-files` says; `test-target` is `run-worktree`
 * that names one test file or one directory as a test runner's filter selects it ({@link testTarget}).
 */
async function commandPath(workspace: string, repository: string | undefined, word: string, scope: CommandPathScope): Promise<boolean> {
  if (word === '' || word.startsWith('-') || word.startsWith('~') || /^file:/i.test(word) || word.includes('\0')) return false
  const segments = word.split('/').map((s) => s.toLowerCase())
  if (segments.includes('..') || segments.includes('.git')) return false
  if (scope !== 'repository-read' && segments.includes('.system')) return false
  const worktree = resolve(workspace)
  const absolute = isAbsolute(word) ? resolve(word) : resolve(worktree, word)
  const roots = scope === 'repository-read' && repository !== undefined ? [worktree, resolve(repository)] : [worktree]
  const root = roots.find((r) => inside(r, absolute) && within(r, absolute) && !gitData(r, absolute))
  if (root === undefined) return false
  if (scope === 'repository-read') return true
  const rel = relative(worktree, absolute)
  if (rel === '' || rel.split(sep).includes('.system')) return false
  if (scope === 'run-worktree') return true
  if (scope === 'test-target') return testTarget(worktree, word, absolute, rel)
  try {
    if (!lstatSync(absolute).isFile()) return false
    await execFileAsync('git', ['--literal-pathspecs', '-C', worktree, '-c', 'core.fsmonitor=false', 'ls-files', '--error-unmatch', '--', rel], { env: GIT_ENV, timeout: 10_000, killSignal: 'SIGKILL' })
    return false
  } catch (error) {
    // Exit 1: git knows no such tracked file, so it is untracked (or ignored). Any other failure refuses.
    return code(error) === 1 && (() => {
      try {
        return lstatSync(absolute).isFile()
      } catch {
        return false
      }
    })()
  }
}

/** The test files a worktree has at most for a `test-target` check (INV-9): past it, no word is one. */
const TEST_TARGET_FILES = 20_000

/**
 * Whether `word` (a `run-worktree` path, `absolute` and `rel` its forms) names one test file or one
 * directory of the worktree as a test runner's filter selects it, and nothing else. vitest takes a
 * path word as a filter, not a path: a test file is selected when its path relative to the root
 * holds the word (or its relative form) as a substring, or, for an absolute word, starts with it.
 * So `tests` or `a.spec.ts` would select test files across the whole repository. The word must exist
 * (a regular file with a test file's name, or a tests directory, `tests`, `test`, or `__tests__`, or
 * a directory inside one; no link), and every test file of the
 * worktree (`git ls-files`, tracked and untracked but not ignored) that the filter selects must be
 * that file or under that directory.
 */
async function testTarget(worktree: string, word: string, absolute: string, rel: string): Promise<boolean> {
  try {
    const stat = lstatSync(absolute)
    // A directory is a tests directory or one inside it: `packages` names what it selects, and that is a suite.
    const testsDirectory = stat.isDirectory() && rel.split(sep).some((segment) => /^(tests?|__tests__)$/.test(segment))
    if (!(testsDirectory || (stat.isFile() && TEST_FILE.test(absolute)))) return false
  } catch {
    return false
  }
  let listed: string
  try {
    listed = (await execFileAsync('git', ['--literal-pathspecs', '-C', worktree, '-c', 'core.fsmonitor=false', 'ls-files', '-z', '-c', '-o', '--exclude-standard'], { env: GIT_ENV, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 })).stdout
  } catch {
    return false
  }
  const tests = listed.split('\0').filter((path) => path !== '' && TEST_FILE.test(path))
  if (tests.length > TEST_TARGET_FILES) return false
  const under = rel.split(sep).join('/')
  // vitest keeps a word's trailing `/` on its relative form too.
  const filters = [word.toLowerCase(), (word.endsWith('/') ? `${under}/` : under).toLowerCase()]
  return tests.every((path) => {
    const selected = filters.some((f) => path.toLowerCase().includes(f)) || (isAbsolute(word) && join(worktree, path).startsWith(word))
    return !selected || path === under || path.startsWith(`${under}/`)
  })
}

const RULE = { type: 'rule', id: 'agent-workers.tool-gate', version: '1' } as const
/** The web access rule's decider (T262, ADR-0074): every web call of a research run it judges is one of its decisions. */
export const WEB_RULE = { type: 'rule', id: 'agent-workers.web-access', version: '1' } as const

/** Whether a `WebSearch` input is exactly the web probe's own search: its fixed query and no other field. */
function isProbeSearch(input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false
  const keys = Object.keys(input)
  return keys.length === 1 && keys[0] === 'query' && (input as { query?: unknown }).query === WEB_PROBE_QUERY
}
/** The checks a policy rule can require (`autonomy-policy@1.0`): the only ones a verdict may leave pending. */
export const CHECKS: readonly Check[] = ['tests', 'typecheck', 'lint', 'schema', 'quote-check', 'review', 'red-on-base']

/**
 * The gate of one run. `ctx.approvals` is read when a call comes (optional: none, and every call is
 * denied, fail-closed rule 5). A call is judged under the studio policy: no trusted envelope names
 * the project of an agent run yet. Every outcome is a recorded decision: the `autonomy` decision
 * `check` records, the queue's own `approval` decision for a request it resolved, or, where the gate
 * decided without the policy (no queue, a call it does not classify, a run that already stopped, an
 * ask with no session to continue), a `gate` decision of rule `agent-workers.tool-gate`.
 */
export function runGate(ctx: Context, run: GateRun): RunGate {
  let deferred: Deferral | undefined
  /** The action classes this run already showed pending checks for: one event per class and run. */
  const pendingShown = new Set<ActionClass>()

  const event = (kind: 'notified' | 'checks-pending' | 'denied' | 'deferred' | 'web', call: ToolCall, decision: ArtifactRef | undefined, data: Record<string, unknown> = {}): void => {
    try {
      ctx.get('eventLog')?.append({
        type: `agent-workers.tool.${kind}`, ...(run.workflowRunId ? { runId: run.workflowRunId } : {}), ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(decision ? { decision } : {}),
        data: { agentRun: run.runId, worker: run.worker, ...(run.workerKind ? { workerKind: run.workerKind.slice(0, 100) } : {}), tool: call.tool.slice(0, 100), ...data },
      })
    } catch (error) {
      ctx.logger.warn(`agent Workers: the ${kind} event of a ${call.tool} call in ${run.runId} was not appended: ${(error as Error).message}`)
    }
  }

  /**
   * The `agent-workers.tool.denied` event of a denial (T207): its stable reason code, the code's
   * plain explanation (never the call's input), the action class when the call was classified, and
   * the decision behind it, on the entry and in its data.
   */
  const deniedEvent = (call: ToolCall, reason: DenialReason, decision: ArtifactRef | undefined, data: { actionClass?: ActionClass; requestId?: string } = {}): void => {
    event('denied', call, decision, { reason, explanation: DENIAL_REASONS[reason].slice(0, EXPLANATION_MAX), ...data, ...(decision ? { decision } : {}) })
  }

  /** Deny by the gate's own rule, recorded as a `gate` decision (INV-13). */
  const refuse = (call: ToolCall, why: string, reason: DenialReason, inputs: ArtifactRef[] = [], actionClass?: ActionClass): ToolVerdict => {
    const decision = ctx.artifacts.recordDecision({
      decisionType: 'gate', question: `May ${run.worker} make the ${call.tool} call it asked for in run ${run.runId}?`, inputs,
      candidates: [
        { option: 'allow', selected: false, reasons: [`not allow: ${why}`] },
        { option: 'deny', selected: true, reasons: [why] },
        { option: 'defer', selected: false, reasons: ['not defer: nothing an operator answers would let this call run'] },
      ],
      decider: RULE, outcome: { option: 'deny', detail: { agentRun: run.runId, tool: call.tool.slice(0, 100), reason } }, deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, ...(run.workflowRunId ? { runId: run.workflowRunId } : {}), classification: run.classification })
    deniedEvent(call, reason, decision.id as ArtifactRef, actionClass ? { actionClass } : {})
    return { decision: 'deny', reason: `${why} (decision ${decision.id})` }
  }

  /** Deny on the policy's own decision: it is the record. */
  const denied = (call: ToolCall, action: ToolAction, verdict: AutonomyVerdict, why: string, reason: DenialReason): ToolVerdict => {
    deniedEvent(call, reason, verdict.decision, { actionClass: action.class })
    return { decision: 'deny', reason: `${why} (decision ${verdict.decision})` }
  }

  /**
   * Why the policy forbids a call: `not-listed` for a command whose argv no line of the studio
   * policy's commands list matches word for word (with the `command` class forbidden, every other
   * command is), else `policy-forbid`. A policy that cannot be read leaves it `policy-forbid`.
   */
  const forbidReason = async (approvals: Approvals, action: ToolAction): Promise<DenialReason> => {
    if (action.class !== 'command' || !action.command) return 'policy-forbid'
    try {
      const commands = (await approvals.policy()).policies[0]?.commands ?? []
      return commands.includes(action.command.join(' ')) ? 'policy-forbid' : 'not-listed'
    } catch {
      return 'policy-forbid'
    }
  }

  /** Why the policy forbids it, from the decision it recorded. */
  const forbidden = (action: ToolAction, verdict: AutonomyVerdict): string => {
    const body = ctx.artifacts.get(verdict.decision)?.body as { candidates?: Array<{ selected?: boolean; reasons?: string[] }> } | undefined
    const reason = body?.candidates?.find((c) => c.selected)?.reasons?.[0]
    return `the autonomy policy forbids this ${action.class} call${reason ? `: ${reason}` : ''}`
  }

  const defer = (call: ToolCall, action: ToolAction, verdict: AutonomyVerdict, requestId: string): ToolVerdict => {
    const reason = `${action.summary}: waits for the operator's approval (request ${requestId}); the run stops here, and a later run of session ${run.sessionId} makes exactly this call once it is approved`
    deferred = { tool: call.tool, requestId, reason }
    event('deferred', call, verdict.decision, { actionClass: action.class, requestId })
    return { decision: 'defer', reason, requestId }
  }

  /**
   * The workflow engine's denial of exactly this call in this session (docs/design/approvals.md#a-deferred-call):
   * one of the session's requests for it whose row carries the denial ({@link recordDenial}),
   * written in the transaction that recorded the engine's `recovery` decision `deny`. Read from the
   * store by session, so it holds in any workflow that continues the session, across restarts
   * (INV-4) and the event log's retention, whatever the queue says of the request later (an
   * approval given after the step's deadline, a request left open when its withdrawal failed).
   * Undefined when none.
   */
  const workflowDenial = (call: ToolCall, inputHash: string): { requestId: string; decision?: ArtifactRef; cause?: string } | undefined => {
    const found = ctx.store.db.prepare('SELECT request_id, denial_decision, denial_cause FROM agent_tool_requests WHERE scope = ? AND tool = ? AND input_hash = ? AND denied_at IS NOT NULL ORDER BY denied_at LIMIT 1')
      .get(`session:${run.sessionId}`, call.tool, inputHash) as { request_id: string; denial_decision: string | null; denial_cause: string | null } | undefined
    if (!found) return undefined
    return { requestId: found.request_id, ...(found.denial_decision ? { decision: found.denial_decision as ArtifactRef } : {}), ...(found.denial_cause ? { cause: found.denial_cause } : {}) }
  }

  /**
   * The request this session last opened for exactly this call, if any, read and checked (INV-5),
   * and whether that call stands denied: its request rejected (a verdict, an expiry, a withdrawal)
   * or denied by the workflow engine ({@link workflowDenial}). A denied call stays denied in its
   * session whatever the policy says now, `auto` included: a policy change never runs it. A
   * `verdict` is returned when the gate decides here (denied, or a request it cannot use).
   */
  const priorOf = async (approvals: Approvals, call: ToolCall, action: ToolAction, inputs: ArtifactRef[]): Promise<{ prior?: RequestRow; request?: ApprovalRequest; verdict?: ToolVerdict }> => {
    if (!run.sessionId) return {}
    const inputHash = contentId(call.input)
    const prior = ctx.store.db.prepare('SELECT request_id, run_id, used_at FROM agent_tool_requests WHERE scope = ? AND tool = ? AND input_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(`session:${run.sessionId}`, call.tool, inputHash) as RequestRow | undefined
    if (!prior) return {}
    const request: ApprovalRequest | undefined = await approvals.get(prior.request_id)
    if (!request) return { verdict: refuse(call, `approval request ${prior.request_id} for this call cannot be read`, 'request-unreadable', inputs, action.class) }
    // INV-5: the request is for exactly this call, asked by this session's Worker, as the row records it.
    const other = mismatch(request, { ref: `agent-tool-call:${prior.run_id}:${call.tool}`, version: inputHash, actionClass: action.class, runId: prior.run_id, sessionId: run.sessionId })
    if (other) return { verdict: refuse(call, `approval request ${request.requestId} is for another call than this one (its ${other} differs), so its verdict is not used`, 'request-mismatch', inputs, action.class) }
    if (request.state === 'rejected') {
      const cause = request.resolution?.cause
      const how = cause === 'verdict' ? 'rejected by the operator' : cause === 'expired' ? 'unanswered when it expired' : 'withdrawn before a verdict (unanswered in time, its work ended, or the policy changed)'
      deniedEvent(call, cause === 'verdict' ? 'request-rejected' : cause === 'expired' ? 'request-expired' : 'request-withdrawn', request.resolution?.decision, { actionClass: action.class, requestId: request.requestId })
      // The operator's own note on the verdict (what to run instead) is the tool result's, so the next try can follow it (T295).
      const approval = request.resolution?.approval
      const said = cause === 'verdict' && approval ? (ctx.artifacts.get(approval)?.body as { note?: unknown } | undefined)?.note : undefined
      const note = typeof said === 'string' && said.trim() ? `. The operator's note: ${said.trim().slice(0, 2000)}` : ''
      return { verdict: { decision: 'deny', reason: `approval request ${request.requestId} for exactly this call was ${how}, so it does not run; go on without it${note}` } }
    }
    const denial = workflowDenial(call, inputHash)
    if (denial) {
      deniedEvent(call, 'workflow-denied', denial.decision, { actionClass: action.class, requestId: denial.requestId })
      return { verdict: { decision: 'deny', reason: `approval request ${denial.requestId} for exactly this call was denied (${denial.cause ?? 'no verdict in time'}${denial.decision ? `, decision ${denial.decision}` : ''}), so it does not run; go on without it` } }
    }
    return { prior, request }
  }

  /** An `ask`: the request already opened for this exact call in this session, or a new one. */
  const ask = async (approvals: Approvals, call: ToolCall, action: ToolAction, verdict: AutonomyVerdict, ruledProject?: string): Promise<ToolVerdict> => {
    if (!run.sessionId) return refuse(call, `the policy asks the operator about this ${action.class} call, and run ${run.runId} has no session a later run could continue once approved, so it cannot wait`, 'no-session', [verdict.decision], action.class)
    const scope = `session:${run.sessionId}`
    const inputHash = contentId(call.input)
    const { prior, request, verdict: decided } = await priorOf(approvals, call, action, [verdict.decision])
    if (decided) return decided
    if (prior && request) {
      if (request.state !== 'approved') return defer(call, action, verdict, request.requestId)
      if (prior.used_at === null) {
        // One approval, one call: taken once, under the store's write lock.
        const taken = ctx.store.transaction((tx) => Number(tx.prepare('UPDATE agent_tool_requests SET used_at = ?, used_by = ? WHERE request_id = ? AND used_at IS NULL')
          .run(new Date().toISOString(), run.runId, request.requestId).changes) === 1)
        if (taken) return { decision: 'allow' }
      }
      // Its approval was used: the same call asks again.
    }
    const created = await approvals.request({
      subject: { type: 'content', ref: `agent-tool-call:${run.runId}:${call.tool}`, version: inputHash },
      action: { class: action.class, summary: action.summary, consequences: action.consequences },
      requester: {
        component: 'worker', runId: run.runId, sessionId: run.sessionId,
        // Judged again under the project its verdict was (a research run's, T262).
        ...((researchProject() ?? ruledProject) !== undefined ? { projectId: (researchProject() ?? ruledProject)! } : {}),
        // The board task it serves, so that task's project's lead may answer it (ADR-0076); never judged on.
        ...(run.taskId ? { taskId: run.taskId } : {}),
        ...(call.callId && call.callId.length <= 128 ? { toolUseId: call.callId } : {}),
      },
      verdict, ...(action.command ? { command: action.command } : {}), classification: run.classification,
    })
    ctx.store.transaction((tx) => {
      tx.prepare('INSERT INTO agent_tool_requests (request_id, scope, tool, input_hash, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(created.requestId, scope, call.tool, inputHash, run.runId, created.createdAt)
    })
    return defer(call, action, verdict, created.requestId)
  }

  /** The project a research run's calls are judged under (T262), as its task's brief names it; none for any other run, judged under the studio policy as before. */
  const researchProject = (): string | undefined => (run.profile === 'research' ? run.projectId : undefined)

  /** The web calls this run made unasked under the web access grant (T262): at most its `maxWebCallsPerRun`. */
  let webCalls = 0
  /** The web calls of this run the web access rule judged, allowed or asked, in order: what each decision numbers. */
  let webJudged = 0
  /**
   * The web access rule's turns (T262): one call is judged at a time, from its bound check to its
   * recorded outcome, so concurrent calls never all pass a bound only one of them may take.
   */
  let webTurn: Promise<unknown> = Promise.resolve()
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const next = webTurn.then(work, work)
    webTurn = next.catch(() => undefined)
    return next
  }

  /**
   * The web access rule (T262, ADR-0074), for a research run's `WebSearch` or `WebFetch` call the
   * policy said `ask` for: it runs unasked only under the grant in force for the research profile
   * (the studio's, narrowed by the run's project's), for a tool the grant names, from a run whose
   * content is classified at most as the grant allows, within the grant's calls per run, with a
   * query or URL that names no path of this machine and passes the egress check (class `agent`: its
   * classification permitted, no credential pattern). Every call it judges is a `gate` decision of
   * rule `agent-workers.web-access` (its query or URL, the call's number, the bound, the egress
   * decision, and why) and, but for a denial, an `agent-workers.tool.web` event (ids only); a call it
   * does not let run asks as before (undefined: the caller asks). A call the grant would let run but
   * that this session was denied stays denied: that is resolved first, recorded as a `deny` of the
   * rule, and it takes no place in the bound. Run one call at a time ({@link serially}).
   */
  const webAccess = async (approvals: Approvals, call: ToolCall, action: ToolAction, verdict: AutonomyVerdict): Promise<ToolVerdict | undefined> => {
    const target = webTarget(call.tool, call.input) ?? ''
    const grant = webAccessOf((await approvals.policy(run.projectId)).policies, 'research')
    let why: { code: string; reason: string } | undefined
    let egress: { allowed: boolean; decision: ArtifactRef; reason: string } | undefined
    if (!grant) why = { code: 'no-grant', reason: `the autonomy policy grants the research role no web access${run.projectId ? ` (for project ${run.projectId})` : ''}` }
    else if (!grant.tools.includes(call.tool as WebTool)) why = { code: 'tool-not-granted', reason: `the web access grant names ${grant.tools.join(', ')}, not ${call.tool}` }
    else if (!withinClassification(run.classification, grant.maxClassification)) why = { code: 'classification', reason: `the run's content is ${run.classification}, above the grant's ${grant.maxClassification}` }
    else if (webCalls >= grant.maxWebCallsPerRun) why = { code: 'bound', reason: `the run already made ${webCalls} web calls unasked, the grant's bound (maxWebCallsPerRun ${grant.maxWebCallsPerRun})` }
    else if (namesLocalPath(target, [resolve(run.workspace), homedir()])) why = { code: 'local-path', reason: `the ${call.tool === 'WebSearch' ? 'query' : 'URL'} names a path of this machine (the workspace or the home directory), which is local-private` }
    else {
      const checked = await ctx.egress.check({ payload: target, classification: run.classification, workerClass: 'agent' })
      egress = { allowed: checked.allowed, decision: checked.decision as ArtifactRef, reason: checked.reason }
      if (!checked.allowed) why = { code: 'egress', reason: `the egress check refused it: ${checked.reason}` }
    }
    const inputs = [verdict.decision, ...(egress ? [egress.decision] : [])]
    // A call this session was denied stays denied, whatever the grant says (as under auto): resolved
    // before anything is recorded as unasked, so it neither counts as one nor takes a place in the bound.
    const prior = why === undefined ? (await priorOf(approvals, call, action, inputs)).verdict : undefined
    const option: 'auto' | 'ask' | 'deny' = prior ? 'deny' : why === undefined ? 'auto' : 'ask'
    if (option === 'auto') webCalls += 1
    webJudged += 1
    const bound = grant ? `${webCalls} of at most ${grant.maxWebCallsPerRun}` : 'no grant'
    const denied = prior ? `this exact call was denied in session ${run.sessionId}, so it stays denied whatever the grant says` : ''
    // Filed under the workflow run, its step named in the detail only: a step's decision chain stays the engine's.
    const decision = ctx.artifacts.recordDecision({
      decisionType: 'gate', question: `May ${run.worker}'s ${call.tool} call in run ${run.runId} go out unasked under the web access grant?`,
      inputs,
      candidates: [
        {
          option: 'auto', selected: option === 'auto',
          reasons: option === 'auto' ? [`the research role's web access grant (${grant!.from.map((p) => `${p.id} version ${p.version}, webAccess ${p.webAccess}`).join('; ')}) names ${call.tool}`, `web call ${bound} this run`, `egress: ${egress!.reason}`]
            : [`not auto: ${why?.reason ?? denied}`],
        },
        { option: 'ask', selected: option === 'ask', reasons: option === 'ask' ? [why!.reason, 'it asks the operator, as every external-send does'] : [option === 'auto' ? 'not ask: the grant holds and the egress check passed' : `not ask: ${denied}`] },
        { option: 'deny', selected: option === 'deny', reasons: option === 'deny' ? [denied] : ['not deny: this session denied no such call'] },
      ],
      decider: WEB_RULE,
      outcome: {
        option,
        detail: {
          agentRun: run.runId, worker: run.worker, tool: call.tool, target: clamp(target), call: webJudged, unasked: webCalls, ...(grant ? { max: grant.maxWebCallsPerRun } : {}),
          egress: egress ? (egress.allowed ? 'allow' : 'deny') : 'not-checked', ...(why ? { reason: why.code } : prior ? { reason: 'session-denied' } : {}), ...(run.nodeId ? { nodeId: run.nodeId } : {}),
        },
      },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, ...(run.workflowRunId ? { runId: run.workflowRunId } : {}), classification: run.classification })
    // A denied call's event is the denial's own (`agent-workers.tool.denied`, from priorOf).
    if (option !== 'deny') {
      event('web', call, decision.id as ArtifactRef, {
        actionClass: 'external-send', verdict: option, egress: egress ? (egress.allowed ? 'allow' : 'deny') : 'not-checked', call: webJudged, unasked: webCalls,
        ...(grant ? { max: grant.maxWebCallsPerRun } : {}), ...(why ? { reason: why.code } : {}), decision: decision.id,
      })
    }
    return prior ?? (option === 'auto' ? { decision: 'allow' } : undefined)
  }

  const judge = async (call: ToolCall): Promise<ToolVerdict> => {
    if (run.profile === 'review-member') return refuse(call, 'a review member answers from the material in its prompt alone: the review-member profile allows no tool call (ADR-0049)', 'review-member')
    if (deferred) return refuse(call, `the run stopped at its ${deferred.tool} call, which waits for approval request ${deferred.requestId}; no further call runs`, 'run-stopped')
    const approvals = ctx.get('approvals')
    if (!approvals) return refuse(call, 'no approval queue (ctx.approvals) is loaded, and no tool call runs without its autonomy decision', 'no-approvals')
    // The web probe makes one call, its own fixed search, and no other (./research.ts).
    if (run.profile === 'research' && run.webProbe && !(call.tool === 'WebSearch' && isProbeSearch(call.input))) {
      return refuse(call, `the web probe makes one call, WebSearch with the query ${JSON.stringify(WEB_PROBE_QUERY)} and nothing else; this ${call.tool.slice(0, 100)} call is not it`, 'research-role')
    }
    const classified = classify(call, run.workspace, { shellReads: run.shellReads === true, workspaceReads: run.workspaceReads === true, readTools: run.readTools, hostTools: run.hostTools })
    if ('refused' in classified) return refuse(call, classified.refused, classified.reason)
    let action: ToolAction = classified
    // A research role reads and searches the web only (ADR-0074): its board task's dossier is System's own record, no file.
    if (run.profile === 'research' && (action.class === 'workspace-write' || action.class === 'command') && !call.tool.startsWith(HOST_PREFIX)) {
      return refuse(call, `a research role's run writes no file and runs no command; this ${call.tool.slice(0, 100)} call is ${action.class}`, 'research-role', [], action.class)
    }
    // A research run's calls are judged under its task's project's policy too (T262): the policy that
    // gives the web grant also binds, so a project's forbid holds whatever the grant says.
    let projectId = researchProject()
    // A command a command rule of the policy allows (autonomy-policy@1.4) is judged as a workspace
    // write, under the run's project's policy set when it has one (the studio's rules, narrowed by the
    // project's): the decision names the rule.
    let ruled: string | undefined
    if (action.class === 'command' && action.historyRead !== true && action.command) {
      const forProject = run.projectId ?? projectId
      const policies = (await approvals.policy(forProject)).policies
      const rule = await matchCommandRule(commandRulesOf(policies), action.command, { path: (word, scope) => commandPath(run.workspace, run.repository, word, scope) })
      if (rule) {
        ruled = rule.id
        projectId = forProject
      }
    }
    let verdict = await approvals.check({ class: action.class, ...(action.command ? { command: action.command } : {}), ...(ruled ? { commandRule: ruled } : {}), ...(projectId !== undefined ? { projectId } : {}) })
    // The rule made it a workspace write unless commands are forbidden (then the verdict is forbid, and the class stays command).
    if (ruled && verdict.mode !== 'forbid') action = { class: 'workspace-write', summary: action.summary, consequences: action.consequences, ...(action.command ? { command: action.command } : {}) }
    // A git history read (T276) the policy asks about as a command is judged as a workspace write, as
    // the policy judges a command on its commands list: it runs where writes run unasked; a forbidden
    // command class, or writes that are not unasked, leave the command's own verdict.
    if (action.historyRead === true && verdict.mode === 'ask') {
      const write = await approvals.check({ class: 'workspace-write', ...(projectId !== undefined ? { projectId } : {}) })
      if (write.mode === 'auto' || write.mode === 'notify') {
        verdict = write
        action = { class: 'workspace-write', summary: action.summary, consequences: action.consequences }
      }
    }
    // A research run's web call the policy asks about goes out unasked only under the web access grant (T262).
    if (run.profile === 'research' && action.class === 'external-send' && verdict.mode === 'ask' && Object.hasOwn(SENDS, call.tool)) {
      const web = await serially(() => webAccess(approvals, call, action, verdict))
      if (web) return web
    }
    switch (verdict.mode) {
      case 'forbid':
        return denied(call, action, verdict, forbidden(action, verdict), await forbidReason(approvals, action))
      case 'auto':
      case 'notify':
      {
        // A rule's required checks are checks the result must pass before it is accepted, never
        // preconditions of one tool call, which cannot carry them: they stay pending, named in the
        // autonomy decision (`failedChecks`) and the run's events, and bind at acceptance
        // (docs/design/approvals.md#a-verdict-is-not-yet-a-permission). Only a check a rule can
        // require may be pending; anything else is not a verdict this gate knows.
        const pending = verdict.failedChecks ?? []
        if (pending.some((c) => !CHECKS.includes(c))) return refuse(call, `the autonomy policy left checks pending that no rule can require (${pending.join(', ')})`, 'unknown-checks', [verdict.decision], action.class)
        // A call this session was denied stays denied, even once a newer policy lets its class or
        // argv run unasked (the denial is persisted: the queue's request, the engine's denial on its row).
        const { verdict: decided } = await priorOf(approvals, call, action, [verdict.decision])
        if (decided) return decided
        const shown = pending.length ? { pendingChecks: pending } : {}
        if (verdict.mode === 'notify') event('notified', call, verdict.decision, { actionClass: action.class, ...shown })
        else if (pending.length && !pendingShown.has(action.class)) event('checks-pending', call, verdict.decision, { actionClass: action.class, ...shown })
        if (pending.length) pendingShown.add(action.class)
        return { decision: 'allow' }
      }
      case 'ask':
        return ask(approvals, call, action, verdict, ruled ? projectId : undefined)
      default:
        return refuse(call, `the autonomy policy gave a mode the gate does not know (${String(verdict.mode)})`, 'unknown-mode', [verdict.decision], action.class)
    }
  }

  return {
    gate: async (call) => {
      try {
        return await judge(call)
      } catch (error) {
        ctx.logger.warn(`agent Workers: the gate of ${run.runId} failed on a ${call.tool} call, which is denied: ${(error as Error).message}`)
        try {
          return refuse(call, `the gate could not judge this call: ${(error as Error).message.slice(0, 200)}`, 'gate-error')
        } catch {
          return { decision: 'deny', reason: 'the gate could not judge this call, nor record why' }
        }
      }
    },
    deferral: () => deferred,
  }
}
