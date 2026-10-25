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
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCall, ToolGate, ToolVerdict } from '@tsuuanmi/system-agent-runtime-core'
import { type ActionClass, type ApprovalRequest, type Approvals, type ArtifactRef, type AutonomyVerdict, type Check, SHELL_METACHARACTER } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-event-log'
import { contentId } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'

/** A tool call as an action the policy judges: its class, a command's argv, and what the operator is shown. */
export interface ToolAction {
  class: ActionClass
  /** For `command`: the argv, the command split on single spaces (never parsed by a shell). */
  command?: string[]
  summary: string
  consequences: string
}

/**
 * The table is keyed by the tool names the runtimes report (INV-11: a name, never a runtime): Claude
 * Code's built-in tools; Codex's as its PreToolUse hook reports them (`exec_command` as `Bash`
 * with `command` only, `apply_patch` with the patch as `command`, `view_image`); and the Antigravity
 * CLI's file tools as its PreToolUse hook reports them (`read_file`, `write_file`, `edit_file`,
 * each naming its file in `Path`). Its `run_command` is not classified, so it is denied: no
 * confinement of its commands is proven.
 */
/** Tools that only read, and the input field that names where; a field that may be absent reads the workspace. */
const READS: Record<string, { field: string; required: boolean }> = {
  Read: { field: 'file_path', required: true },
  NotebookRead: { field: 'notebook_path', required: true },
  LS: { field: 'path', required: true },
  Glob: { field: 'path', required: false },
  Grep: { field: 'path', required: false },
  view_image: { field: 'path', required: true },
  read_file: { field: 'Path', required: true },
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
 * Antigravity CLI's reports (agy 1.4.6 with `gemini-3.8-flash`, recorded in a supervised live check:
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
}
const EDIT_FIELDS: Record<string, FieldType> = { old_string: 'string', new_string: 'string', replace_all: 'boolean' }

const SUMMARY_MAX = 500
const clamp = (text: string): string => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text)
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether `value` has type `type`. */
function typed(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'strings': return Array.isArray(value) && value.every((v) => typeof v === 'string')
    case 'edits': return Array.isArray(value) && value.every((edit) => isObject(edit) && unknownField(edit, EDIT_FIELDS) === undefined)
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
/**
 * Each read-only program and the rule its words must pass. `git` is not one: it finds its
 * repository, and the configuration it runs (`core.fsmonitor`, a diff driver), from the working
 * directory, which the gate does not see; it stays a `command`.
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

/** Whether `argv` is a read-only inspection command inside the workspace (`READ_COMMANDS`). */
function readCommand(argv: string[], workspace: string): boolean {
  const [program, ...args] = argv
  const rule = program !== undefined && Object.hasOwn(READ_COMMANDS, program) ? READ_COMMANDS[program] : undefined
  return rule !== undefined && rule(args, workspace)
}

const ANSWER = 'Approved: the next run of this session makes exactly this call. Rejected, or unanswered when the request expires: the call is denied.'

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
 * Classify one tool call, conservatively; `{ refused }` for a call the gate does not classify,
 * which is denied without asking anyone. Every classified tool's input may carry only the fields
 * its SDK type declares, each of its type (an unknown field, or a wrong type, is refused), and a
 * path is inside the workspace only where it really is, every symlink followed:
 * - `Read`, `NotebookRead`, `LS`, `Glob`, `Grep`, `view_image`, `read_file`: `read`, when the path
 *   they name is inside the workspace (absent for `Glob` and `Grep`: the workspace); a `Glob`
 *   pattern whose literal leading directory is outside it, or that climbs with `..`, is refused;
 * - `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `write_file`, `edit_file`: `workspace-write`, for
 *   a file inside the workspace; outside it is refused (the runtime refuses it too), and so is a
 *   file in git's own data (a `.git` entry in its path, as written or on disk);
 * - `apply_patch`: `workspace-write`, when its patch reads strictly in the patch grammar and every
 *   file a header names (added, deleted, updated, or moved to) is inside the workspace and not in
 *   git's own data;
 * - `Bash`: an empty word (a doubled, leading, or trailing space) or a word with a shell
 *   metacharacter is refused here first, before the policy is asked (which forbids the latter
 *   too). Then a probe that can do nothing is `read` (summary the command, no argv): `echo` with
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
 *   as the policy's exact-argv rule matches it;
 * - `WebFetch`, `WebSearch`: `external-send`;
 * - any other tool (`run_command` among them), or an input that is not an object: refused.
 * A path may be a `file:` URI, which is checked as the path it names.
 */
export function classify(call: ToolCall, workspace: string): ToolAction | { refused: string } {
  const { tool } = call
  const input = call.input
  if (!isObject(input)) return { refused: `the input of ${tool} is not an object` }
  const fields = Object.hasOwn(FIELDS, tool) ? FIELDS[tool] : undefined
  if (!fields) return { refused: `${tool} is not a tool the gate classifies` }
  const unknown = unknownField(input, fields)
  if (unknown) return { refused: `${tool} ${unknown}` }
  const read = Object.hasOwn(READS, tool) ? READS[tool] : undefined
  if (read) {
    if (tool === 'Glob') {
      const pattern = input.pattern
      const base = typeof input.path === 'string' ? input.path : undefined
      const literal = typeof pattern === 'string' ? pattern.split(/[*?[{]/)[0]! : ''
      const dir = pattern === undefined || isAbsolute(literal) ? literal : base === undefined ? literal || '.' : `${base}${sep}${literal}`
      if (typeof pattern !== 'string' || pattern.split(/[\\/]/).includes('..') || !within(workspace, dir)) {
        return { refused: `the Glob pattern ${JSON.stringify(pattern)} reaches outside the workspace` }
      }
    }
    const where = input[read.field]
    if (where === undefined && !read.required) return { class: 'read', summary: clamp(`${tool} in the workspace`), consequences: `Reads inside the run's workspace. ${ANSWER}` }
    if (typeof where !== 'string' || !within(workspace, where)) return { refused: `${tool} reads ${typeof where === 'string' ? where : 'no path'}, which is not inside the workspace` }
    return { class: 'read', summary: clamp(`${tool} ${where}`), consequences: `Reads ${where} inside the run's workspace. ${ANSWER}` }
  }
  const patchField = Object.hasOwn(PATCHES, tool) ? PATCHES[tool] : undefined
  if (patchField) {
    const patch = input[patchField]
    if (typeof patch !== 'string') return { refused: `${tool} carries no patch` }
    const files = patchFiles(patch)
    if ('refused' in files) return { refused: `${tool}: ${files.refused}` }
    const outside = files.find((f) => !within(workspace, f.path))
    if (outside) return { refused: `${tool} changes ${outside.path}, which is not inside the workspace` }
    const git = files.find((f) => gitData(workspace, f.path))
    if (git) return { refused: `${tool} changes ${git.path}, which is git's own data (.git): only an asked command or the operator changes it` }
    const touched = clamp(files.map((f) => `${f.op} ${f.path}`).join(', '))
    return { class: 'workspace-write', summary: clamp(`${tool}: ${touched}`), consequences: `Changes ${files.length === 1 ? 'one file' : `${files.length} files`} inside the run's workspace: ${touched}. ${ANSWER}` }
  }
  const write = Object.hasOwn(WRITES, tool) ? WRITES[tool] : undefined
  if (write) {
    const file = input[write]
    if (typeof file !== 'string' || !within(workspace, file)) return { refused: `${tool} changes ${typeof file === 'string' ? file : 'no file'}, which is not inside the workspace` }
    if (gitData(workspace, file)) return { refused: `${tool} changes ${file}, which is git's own data (.git): only an asked command or the operator changes it` }
    return { class: 'workspace-write', summary: clamp(`${tool} ${file}`), consequences: `Changes ${file} inside the run's workspace. ${ANSWER}` }
  }
  if (tool === COMMAND) {
    const command = input.command
    if (typeof command !== 'string' || command === '') return { refused: `${tool} names no command` }
    const argv = command.split(' ')
    // Defence in depth: the policy forbids a metacharacter word too, but the gate never asks it about one.
    const empty = argv.indexOf('')
    if (empty >= 0) return { refused: `${tool}: argv word ${empty + 1} is empty (a doubled, leading, or trailing space); a command is words split on single spaces` }
    const unsafe = argv.findIndex((word) => SHELL_METACHARACTER.test(word))
    if (unsafe >= 0) return { refused: `${tool}: argv word ${unsafe + 1} holds a shell metacharacter; a command is never parsed by a shell` }
    if (noopCommand(argv)) return { class: 'read', summary: clamp(command), consequences: `Prints its words or the working directory, or nothing, and reads and changes nothing: ${clamp(command)}. ${ANSWER}` }
    if (readCommand(argv, workspace)) return { class: 'read', summary: clamp(command), consequences: `Reads inside the run's workspace: ${clamp(command)}. ${ANSWER}` }
    return { class: 'command', command: argv, summary: clamp(`${tool}: ${command}`), consequences: `Runs this exact command in the run's workspace. ${ANSWER}` }
  }
  const send = Object.hasOwn(SENDS, tool) ? SENDS[tool] : undefined
  if (send) {
    const what = input[send]
    if (typeof what !== 'string' || what === '') return { refused: `${tool} names no ${send}` }
    return { class: 'external-send', summary: clamp(`${tool}: ${what}`), consequences: `Sends this request out of this machine. ${ANSWER}` }
  }
  return { refused: `${tool} is not a tool the gate classifies` }
}

/** The run a gate is for: where it works, who asked, and the classification of what it shows. */
export interface GateRun {
  /** The agent run (`arun_…`). */
  runId: string
  worker: string
  workspace: string
  /** The run's session: an approved call runs in a later run of it. */
  sessionId?: string | undefined
  /** The workflow run the agent run belongs to, for the decisions' and events' lineage. */
  workflowRunId?: string | undefined
  classification: 'public' | 'operator-shared' | 'local-private'
  /**
   * The run's step is a review team member's, under the review-member profile (ADR-0049): its
   * material is its prompt alone, so the gate denies every tool call, each a recorded decision.
   */
  profile?: 'review-member' | undefined
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

const RULE = { type: 'rule', id: 'agent-workers.tool-gate', version: '1' } as const
/** The checks a policy rule can require (`autonomy-policy@1.0`): the only ones a verdict may leave pending. */
export const CHECKS: readonly Check[] = ['tests', 'typecheck', 'lint', 'schema', 'quote-check', 'review']

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

  const event = (kind: 'notified' | 'checks-pending' | 'denied' | 'deferred', call: ToolCall, decision: ArtifactRef | undefined, data: Record<string, unknown> = {}): void => {
    try {
      ctx.get('eventLog')?.append({
        type: `agent-workers.tool.${kind}`, ...(run.workflowRunId ? { runId: run.workflowRunId } : {}), ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(decision ? { decision } : {}), data: { agentRun: run.runId, worker: run.worker, tool: call.tool.slice(0, 100), ...data },
      })
    } catch (error) {
      ctx.logger.warn(`agent Workers: the ${kind} event of a ${call.tool} call in ${run.runId} was not appended: ${(error as Error).message}`)
    }
  }

  /** Deny by the gate's own rule, recorded as a `gate` decision (INV-13). */
  const refuse = (call: ToolCall, why: string, inputs: ArtifactRef[] = []): ToolVerdict => {
    const decision = ctx.artifacts.recordDecision({
      decisionType: 'gate', question: `May ${run.worker} make the ${call.tool} call it asked for in run ${run.runId}?`, inputs,
      candidates: [
        { option: 'allow', selected: false, reasons: [`not allow: ${why}`] },
        { option: 'deny', selected: true, reasons: [why] },
        { option: 'defer', selected: false, reasons: ['not defer: nothing an operator answers would let this call run'] },
      ],
      decider: RULE, outcome: { option: 'deny', detail: { agentRun: run.runId, tool: call.tool.slice(0, 100) } }, deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, ...(run.workflowRunId ? { runId: run.workflowRunId } : {}), classification: run.classification })
    event('denied', call, decision.id as ArtifactRef)
    return { decision: 'deny', reason: `${why} (decision ${decision.id})` }
  }

  /** Deny on the policy's own decision: it is the record. */
  const denied = (call: ToolCall, action: ToolAction, verdict: AutonomyVerdict, why: string): ToolVerdict => {
    event('denied', call, verdict.decision, { actionClass: action.class })
    return { decision: 'deny', reason: `${why} (decision ${verdict.decision})` }
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

  /** An `ask`: the request already opened for this exact call in this session, or a new one. */
  const ask = async (approvals: Approvals, call: ToolCall, action: ToolAction, verdict: AutonomyVerdict): Promise<ToolVerdict> => {
    if (!run.sessionId) return refuse(call, `the policy asks the operator about this ${action.class} call, and run ${run.runId} has no session a later run could continue once approved, so it cannot wait`, [verdict.decision])
    const scope = `session:${run.sessionId}`
    const inputHash = contentId(call.input)
    const db = ctx.store.db
    const prior = db.prepare('SELECT request_id, run_id, used_at FROM agent_tool_requests WHERE scope = ? AND tool = ? AND input_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(scope, call.tool, inputHash) as RequestRow | undefined
    if (prior) {
      const request: ApprovalRequest | undefined = await approvals.get(prior.request_id)
      if (!request) return refuse(call, `approval request ${prior.request_id} for this call cannot be read`, [verdict.decision])
      // INV-5: the request is for exactly this call, asked by this session's Worker, as the row records it.
      const other = mismatch(request, { ref: `agent-tool-call:${prior.run_id}:${call.tool}`, version: inputHash, actionClass: action.class, runId: prior.run_id, sessionId: run.sessionId })
      if (other) return refuse(call, `approval request ${request.requestId} is for another call than this one (its ${other} differs), so its verdict is not used`, [verdict.decision])
      if (request.state === 'rejected') {
        const how = request.resolution?.cause === 'verdict' ? 'rejected by the operator' : request.resolution?.cause === 'expired' ? 'unanswered when it expired' : 'withdrawn'
        event('denied', call, request.resolution?.decision, { actionClass: action.class, requestId: request.requestId })
        return { decision: 'deny', reason: `approval request ${request.requestId} for exactly this call was ${how}, so it does not run` }
      }
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

  const judge = async (call: ToolCall): Promise<ToolVerdict> => {
    if (run.profile === 'review-member') return refuse(call, 'a review member answers from the material in its prompt alone: the review-member profile allows no tool call (ADR-0049)')
    if (deferred) return refuse(call, `the run stopped at its ${deferred.tool} call, which waits for approval request ${deferred.requestId}; no further call runs`)
    const approvals = ctx.get('approvals')
    if (!approvals) return refuse(call, 'no approval queue (ctx.approvals) is loaded, and no tool call runs without its autonomy decision')
    const action = classify(call, run.workspace)
    if ('refused' in action) return refuse(call, action.refused)
    const verdict = await approvals.check({ class: action.class, ...(action.command ? { command: action.command } : {}) })
    switch (verdict.mode) {
      case 'forbid':
        return denied(call, action, verdict, forbidden(action, verdict))
      case 'auto':
      case 'notify':
      {
        // A rule's required checks are checks the result must pass before it is accepted, never
        // preconditions of one tool call, which cannot carry them: they stay pending, named in the
        // autonomy decision (`failedChecks`) and the run's events, and bind at acceptance
        // (docs/design/approvals.md#a-verdict-is-not-yet-a-permission). Only a check a rule can
        // require may be pending; anything else is not a verdict this gate knows.
        const pending = verdict.failedChecks ?? []
        if (pending.some((c) => !CHECKS.includes(c))) return refuse(call, `the autonomy policy left checks pending that no rule can require (${pending.join(', ')})`, [verdict.decision])
        const shown = pending.length ? { pendingChecks: pending } : {}
        if (verdict.mode === 'notify') event('notified', call, verdict.decision, { actionClass: action.class, ...shown })
        else if (pending.length && !pendingShown.has(action.class)) event('checks-pending', call, verdict.decision, { actionClass: action.class, ...shown })
        if (pending.length) pendingShown.add(action.class)
        return { decision: 'allow' }
      }
      case 'ask':
        return ask(approvals, call, action, verdict)
      default:
        return refuse(call, `the autonomy policy gave a mode the gate does not know (${String(verdict.mode)})`, [verdict.decision])
    }
  }

  return {
    gate: async (call) => {
      try {
        return await judge(call)
      } catch (error) {
        ctx.logger.warn(`agent Workers: the gate of ${run.runId} failed on a ${call.tool} call, which is denied: ${(error as Error).message}`)
        try {
          return refuse(call, `the gate could not judge this call: ${(error as Error).message.slice(0, 200)}`)
        } catch {
          return { decision: 'deny', reason: 'the gate could not judge this call, nor record why' }
        }
      }
    },
    deferral: () => deferred,
  }
}
