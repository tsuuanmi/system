/**
 * The workspace reads server (docs/design/agent-runtimes.md#the-workspace-reads-server, T200b): a
 * minimal MCP server of System's own over stdio, with three read-only tools bound to one run's
 * workspace, so an agent reads its workspace without a shell:
 * - `read_file`: one file, optionally a line range, its lines numbered, bounded in bytes;
 * - `list_dir`: one directory's entries, bounded in number, and no more of them read than 10 times that;
 * - `search`: a fixed string or a regular expression over the files under a path, bounded in
 *   matches, files, bytes, and time, in a worker thread of this process with a bounded heap (no
 *   shell, no program);
 * - four read-only git views of the workspace's repository (T223), each git run with an argv the
 *   server builds (never a shell; a commit only as a hex id, a path only after `--`, as a literal
 *   pathspec, after the checks below) and every git setting that could run a program pinned off
 *   ({@link GIT_CONFIG_PINS}, {@link gitEnvironment}), bounded in bytes and time: `git_log` (a
 *   bounded count, a fixed set of fields), `git_show` (one commit, its stat and/or patch), `git_diff`
 *   (the worktree or the index against HEAD, or two commits), `git_status` (porcelain). Files named
 *   as secrets are left out of every stat, patch, and status.
 * Every path is resolved with `realpath` and must stay inside the workspace: a `..` segment, an
 * absolute path outside it, and a symlink whose target is outside it are refused; git's own data
 * (`.git` anywhere in the path, and a bare repository `*.git`), files named as secrets
 * ({@link SECRET_NAMES}, {@link SECRET_PATHS}), files git ignores that are named like secrets
 * ({@link SECRET_LIKE}), and a file with more than one hard link (outside `node_modules`) are
 * unreadable, and every file or directory is opened without following a link at its end and
 * checked again by the path its descriptor names (`/proc/self/fd`), so a path swapped after the
 * check is refused.
 * Its root is fixed at start (`--root`): it asks the client for no MCP Roots and ignores their
 * notifications. Every bound is a validated argument ({@link WORKSPACE_READ_BOUNDS}, INV-9). A
 * runtime starts it under the run's read confinement with the workspace bound read-only, so these
 * checks are a second layer. Standalone: Node built-ins only, so it is bound alone into that
 * confinement, as the Codex gate hook is.
 * @module @tsuuanmi/system-agent-runtime-core/workspace-reads
 */
import { spawn } from 'node:child_process'
import { type Dirent, closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, readSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { getHeapStatistics } from 'node:v8'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

/** The server's own file: what a runtime runs with `node` and binds into the confinement. */
export const WORKSPACE_READS_SCRIPT: string = fileURLToPath(import.meta.url)

/** The name a runtime registers the server under, and its tools: three over files, four git views (T223). */
export const WORKSPACE_READS_SERVER = 'workspace'
export const WORKSPACE_GIT_TOOLS: readonly string[] = ['git_log', 'git_show', 'git_diff', 'git_status']
export const WORKSPACE_READ_TOOLS: readonly string[] = ['read_file', 'list_dir', 'search', ...WORKSPACE_GIT_TOOLS]

/** The bounds of the workspace reads server (INV-9): each an integer within its range. */
export interface WorkspaceReadBounds {
  /** The most bytes `read_file` returns, its line numbers included. */
  maxReadBytes: number
  /** The most bytes of one file read through: for a line range, and per file searched (a larger file is not searched). */
  maxScanBytes: number
  /** The most entries `list_dir` returns. */
  maxEntries: number
  /** The most matching lines `search` returns. */
  maxMatches: number
  /** The most files one `search` opens. */
  maxSearchFiles: number
  /** The most characters of one matching line `search` shows. */
  maxLineChars: number
  /** The longest pattern `search` takes. */
  maxPatternChars: number
  /** How long one `search` may take, in milliseconds; past it, it is stopped. */
  searchTimeoutMs: number
  /** The most commits one `git_log` lists. */
  maxLogCount: number
  /** The most bytes of output one git view (`git_log`, `git_show`, `git_diff`, `git_status`) returns. */
  maxGitBytes: number
  /** How long one git view may take, in milliseconds, every git it runs counted; past it, git is stopped. */
  gitTimeoutMs: number
}

/** Each bound's range, default, command-line flag, and what it bounds. */
export const WORKSPACE_READ_BOUNDS: Readonly<Record<keyof WorkspaceReadBounds, { min: number; max: number; default: number; flag: string; description: string }>> = {
  maxReadBytes: { min: 1024, max: 8 * 1024 * 1024, default: 256 * 1024, flag: '--max-read-bytes', description: 'The most bytes read_file returns, line numbers included' },
  maxScanBytes: { min: 64 * 1024, max: 256 * 1024 * 1024, default: 8 * 1024 * 1024, flag: '--max-scan-bytes', description: 'The most bytes of one file read through: for a line range, and per file searched (a larger file is not searched)' },
  maxEntries: { min: 1, max: 10_000, default: 1000, flag: '--max-entries', description: 'The most entries list_dir returns' },
  maxMatches: { min: 1, max: 5000, default: 200, flag: '--max-matches', description: 'The most matching lines search returns' },
  maxSearchFiles: { min: 1, max: 200_000, default: 20_000, flag: '--max-search-files', description: 'The most files one search opens' },
  maxLineChars: { min: 80, max: 10_000, default: 500, flag: '--max-line-chars', description: 'The most characters of one matching line search shows' },
  maxPatternChars: { min: 1, max: 10_000, default: 1000, flag: '--max-pattern-chars', description: 'The longest pattern search takes' },
  searchTimeoutMs: { min: 100, max: 120_000, default: 10_000, flag: '--search-timeout-ms', description: 'How long one search may take, in milliseconds; past it, it is stopped' },
  maxLogCount: { min: 1, max: 1000, default: 100, flag: '--max-log-count', description: 'The most commits one git_log lists' },
  maxGitBytes: { min: 1024, max: 8 * 1024 * 1024, default: 256 * 1024, flag: '--max-git-bytes', description: 'The most bytes of output one git view (git_log, git_show, git_diff, git_status) returns' },
  gitTimeoutMs: { min: 100, max: 120_000, default: 10_000, flag: '--git-timeout-ms', description: 'How long one git view may take, in milliseconds, every git it runs counted; past it, git is stopped' },
}

const BOUND_NAMES = Object.keys(WORKSPACE_READ_BOUNDS) as Array<keyof WorkspaceReadBounds>

/** Why `bounds` are not bounds of the server (a name it does not know, a value not an integer within its range), or undefined. */
export function workspaceReadBoundsProblem(bounds: unknown): string | undefined {
  if (bounds === undefined) return undefined
  if (typeof bounds !== 'object' || bounds === null || Array.isArray(bounds)) return 'the workspace reads bounds are not an object'
  for (const [name, value] of Object.entries(bounds)) {
    if (!Object.hasOwn(WORKSPACE_READ_BOUNDS, name)) return `${JSON.stringify(name.slice(0, 64))} is not a workspace reads bound`
    if (value === undefined) continue
    const range = WORKSPACE_READ_BOUNDS[name as keyof WorkspaceReadBounds]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < range.min || value > range.max) {
      return `the workspace reads bound ${name} is ${JSON.stringify(value)}, not an integer from ${range.min} to ${range.max}`
    }
  }
  return undefined
}

/** `bounds` with every bound not given at its default; throws when {@link workspaceReadBoundsProblem} finds one. */
export function workspaceReadBounds(bounds?: Partial<WorkspaceReadBounds>): WorkspaceReadBounds {
  const problem = workspaceReadBoundsProblem(bounds)
  if (problem) throw new Error(problem)
  return Object.fromEntries(BOUND_NAMES.map((name) => [name, bounds?.[name] ?? WORKSPACE_READ_BOUNDS[name].default])) as unknown as WorkspaceReadBounds
}

/** The server's arguments for one workspace (absolute) and its bounds. */
export function workspaceReadArgs(root: string, bounds: WorkspaceReadBounds): string[] {
  if (!isAbsolute(root)) throw new Error(`the workspace ${root} is not an absolute path`)
  return ['--root', root, ...BOUND_NAMES.flatMap((name) => [WORKSPACE_READ_BOUNDS[name].flag, String(bounds[name])])]
}

/** The server's arguments read back: every flag once, the root absolute, every bound within its range; throws otherwise. */
export function parseWorkspaceReadArgs(argv: readonly string[]): { root: string; bounds: WorkspaceReadBounds; selfTest?: string } {
  const given: Record<string, number> = {}
  let root: string | undefined
  let selfTest: string | undefined
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`${flag} has no value`)
    if (seen.has(flag)) throw new Error(`${flag} is given twice`)
    seen.add(flag)
    if (flag === '--root') root = value
    else if (flag === '--self-test') selfTest = value
    else {
      const name = BOUND_NAMES.find((n) => WORKSPACE_READ_BOUNDS[n].flag === flag)
      if (!name) throw new Error(`${flag} is not an argument of the workspace reads server`)
      if (!/^\d{1,10}$/.test(value)) throw new Error(`${flag} ${value} is not a whole number`)
      given[name] = Number(value)
    }
  }
  if (root === undefined || !isAbsolute(root)) throw new Error('--root must name the workspace by an absolute path')
  return { root, bounds: workspaceReadBounds(given), ...(selfTest !== undefined ? { selfTest } : {}) }
}

/**
 * File names a repository keeps secrets in, by name (any letter case): environment files (`.env`,
 * `.env.local`, … but not `.env.example`, `.env.sample`, `.env.template`, `.env.dist`; `.envrc`),
 * keys and keystores, SSH private keys, credential files (`.netrc`, `.npmrc`, `.pypirc`,
 * `.git-credentials`, `.htpasswd`, `.pgpass`; `credentials` and `secrets`, `secrets.env` among
 * them), a `.secrets` directory, Terraform variables and state (`*.tfvars`, `*.tfstate`), and
 * `kubeconfig`. Such a file, or anything under a directory so named, is unreadable whether or not
 * the repository ignores it.
 */
export const SECRET_NAMES: readonly RegExp[] = [
  /^\.env$/i, /^\.env\.(?!(example|sample|template|dist)$).+$/i, /^\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i, /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.(netrc|npmrc|pypirc|git-credentials|htpasswd|pgpass)$/i, /^(credentials|secrets)(\.(json|ya?ml|toml|env))?$/i, /^\.secrets$/i,
  /\.tfvars(\.json)?$/i, /\.tfstate(\.backup)?$/i, /^kubeconfig$/i,
]

/** Paths that hold credentials though their last name alone does not (consecutive segments, any letter case, anywhere in a path). */
export const SECRET_PATHS: readonly (readonly [string, string])[] = [['.kube', 'config'], ['.docker', 'config.json'], ['.aws', 'config'], ['.aws', 'credentials']]

/**
 * A name that looks like a secret's (a word of it, any letter case: secret, token, password,
 * credential, private, an API key): not refused by itself (`tokenizer.ts` is no secret), only in a
 * file or directory the workspace's git ignores ({@link GitIgnores}).
 */
export const SECRET_LIKE = /(^|[^a-z])(secrets?|tokens?|passwords?|passwd|credentials?|private|api[-_]?keys?)([^a-z]|$)/i

/** Why a path relative to the workspace is unreadable by name (git's data, a repository, a secret), or undefined. */
function hiddenName(rel: string): string | undefined {
  const segments = rel.split(/[\\/]/)
  for (const [i, segment] of segments.entries()) {
    const lower = segment.toLowerCase()
    if (lower === '.git') return 'git\'s own data (.git) is not read'
    // A bare repository is named so by custom (`project.git`): its config and history are git's data.
    if (lower.endsWith('.git')) return `${segment} is named as a git repository (*.git), which is not read`
    if (SECRET_NAMES.some((pattern) => pattern.test(segment))) return `${segment} is named as a secret file, which is not read`
    const next = segments[i + 1]?.toLowerCase()
    if (SECRET_PATHS.some(([dir, name]) => lower === dir && next === name)) return `${segment}/${segments[i + 1]} is a credentials file, which is not read`
  }
  return undefined
}

/**
 * One step of a gitignore pattern: a character, `?`, a bracket set (each never `/`), `*` (any run
 * without `/`), `**` followed by `/` (`dirs`: nothing, or anything ending in `/`), a trailing `**` (`rest`).
 */
type GlobToken = { kind: 'char'; c: string } | { kind: 'one' } | { kind: 'set'; test: (c: string) => boolean } | { kind: 'star' } | { kind: 'dirs' } | { kind: 'rest' }

/**
 * One line of a `.gitignore`: what it matches, relative to the directory of its file. `unknown`: a
 * negating pattern this matcher cannot read (a POSIX class it does not know), which fails closed:
 * taken to match none. An ignoring one with such a class matches a superset of git's (the class is
 * any character but '/').
 */
interface IgnoreRule { tokens: GlobToken[]; negate: boolean; dirOnly: boolean; unknown?: boolean }

/**
 * Whether `tokens` match all of `path`, by simulating the pattern's automaton one character at a
 * time (never a backtracking regular expression: a pattern like `*a*a*a…*b` costs at most the
 * pattern's length per character). Each step spends the active states from `budget`; undefined once
 * it runs out, which the caller takes as matched (fail closed).
 */
function globMatch(tokens: readonly GlobToken[], path: string, budget: { steps: number }): boolean | undefined {
  const m = tokens.length
  // State i (0..m): before token i. State m + 1 + i: inside a `dirs` token i, at least one character in.
  const seen = new Uint32Array(2 * (m + 1))
  let generation = 1
  const add = (list: number[], start: number): void => {
    if (start > m) {
      if (seen[start] !== generation) {
        seen[start] = generation
        list.push(start)
      }
      return
    }
    for (let i = start; i <= m; i += 1) {
      if (seen[i] === generation) return
      seen[i] = generation
      list.push(i)
      const kind = tokens[i]?.kind
      if (kind !== 'star' && kind !== 'dirs' && kind !== 'rest') return
    }
  }
  let current: number[] = []
  add(current, 0)
  for (let k = 0; k < path.length; k += 1) {
    budget.steps -= current.length
    if (budget.steps < 0) return undefined
    const c = path[k]!
    generation += 1
    const next: number[] = []
    for (const state of current) {
      if (state > m) {
        const i = state - m - 1
        add(next, state)
        if (c === '/') add(next, i + 1)
        continue
      }
      const token = tokens[state]
      if (token === undefined) continue
      switch (token.kind) {
        case 'char': if (c === token.c) add(next, state + 1); break
        case 'one': if (c !== '/') add(next, state + 1); break
        case 'set': if (c !== '/' && token.test(c)) add(next, state + 1); break
        case 'star': if (c !== '/') add(next, state); break
        case 'rest': add(next, state); break
        case 'dirs':
          add(next, state + m + 1)
          if (c === '/') add(next, state + 1)
          break
      }
    }
    if (next.length === 0) return false
    current = next
  }
  return seen[m] === generation
}

/** The POSIX character classes git's patterns know (`[[:digit:]]`), ASCII as git's are. */
const POSIX_CLASSES: Readonly<Record<string, { test: (c: string) => boolean }>> = {
  alnum: /^[A-Za-z0-9]$/,
  alpha: /^[A-Za-z]$/,
  blank: /^[ \t]$/,
  cntrl: { test: (c) => c.length === 1 && (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) },
  digit: /^[0-9]$/,
  graph: /^[\x21-\x7e]$/,
  lower: /^[a-z]$/,
  print: /^[\x20-\x7e]$/,
  punct: /^[!-/:-@[-`{-~]$/,
  space: /^[ \t\n\r\f\v]$/,
  upper: /^[A-Z]$/,
  xdigit: /^[0-9A-Fa-f]$/,
}

/**
 * The bracket expression opening at `text[open]` (`[`), parsed as git's wildmatch does: `!` or `^`
 * negates; a first `]` is a member; `\x` is `x`; `a-z` a range; `[:class:]` a POSIX class; a `[`
 * not opening a class is a member. Its test of one character, and the index of its closing `]`;
 * `unterminated` without one (git's pattern then matches nothing), `unknown` for a class git's
 * patterns do not know.
 */
function bracketSet(text: string, open: number): { test: (c: string) => boolean; end: number; unknown?: true } | 'unterminated' {
  let p = open + 1
  const negated = text[p] === '!' || text[p] === '^'
  if (negated) p += 1
  const members: ((c: string) => boolean)[] = []
  let prev: string | undefined
  let unknown = false
  // The first character is a member even if it is `]`.
  for (let first = true; first || text[p] !== ']'; first = false) {
    let ch = text[p]
    if (ch === undefined) return 'unterminated'
    if (ch === '\\') {
      p += 1
      ch = text[p]
      if (ch === undefined) return 'unterminated'
      const literal = ch
      members.push((c) => c === literal)
    } else if (ch === '-' && prev !== undefined && text[p + 1] !== undefined && text[p + 1] !== ']') {
      p += 1
      let high = text[p]!
      if (high === '\\') {
        p += 1
        if (text[p] === undefined) return 'unterminated'
        high = text[p]!
      }
      const low = prev
      members.push((c) => c >= low && c <= high)
      ch = undefined
    } else if (ch === '[' && text[p + 1] === ':') {
      const close = text.indexOf(']', p + 2)
      if (close < 0) return 'unterminated'
      if (close - (p + 2) < 1 || text[close - 1] !== ':') members.push((c) => c === '[')
      else {
        const pattern = POSIX_CLASSES[text.slice(p + 2, close - 1)]
        // A class git's patterns do not know: any character, so the set matches more than git's, never less.
        if (pattern === undefined) unknown = true
        members.push((c) => pattern === undefined || pattern.test(c))
        p = close
        ch = undefined
      }
    } else {
      const literal = ch
      members.push((c) => c === literal)
    }
    prev = ch
    p += 1
  }
  // With an unknown class the set is taken to match every character but '/' (negated or not): a superset of git's.
  return { test: (c) => (unknown ? c !== '/' : members.some((member) => member(c)) !== negated), end: p, ...(unknown ? { unknown: true as const } : {}) }
}

/** A gitignore pattern as steps over a path relative to its file's directory; undefined for a blank line or a comment. */
function gitIgnoreRule(line: string): IgnoreRule | undefined {
  let text = line.endsWith('\r') ? line.slice(0, -1) : line
  while (text.endsWith(' ') && !text.endsWith('\\ ')) text = text.slice(0, -1)
  if (text === '' || text.startsWith('#')) return undefined
  const negate = text.startsWith('!')
  if (negate) text = text.slice(1)
  const dirOnly = text.endsWith('/')
  if (dirOnly) text = text.slice(0, -1)
  if (text === '') return undefined
  const anchored = text.includes('/')
  if (text.startsWith('/')) text = text.slice(1)
  // Unanchored, the pattern may match below any directory of its file's.
  const tokens: GlobToken[] = anchored ? [] : [{ kind: 'dirs' }]
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    if (c === '*' && text[i + 1] === '*' && (i === 0 || text[i - 1] === '/') && (i + 2 === text.length || text[i + 2] === '/')) {
      // `**/` any directories (or none), a trailing `/**` everything below.
      tokens.push({ kind: i + 2 === text.length ? 'rest' : 'dirs' })
      i += 2
    } else if (c === '*') {
      if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' })
    } else if (c === '?') tokens.push({ kind: 'one' })
    else if (c === '[') {
      const set = bracketSet(text, i)
      // Unterminated, git's pattern matches nothing (no rule). An unknown class fails closed: a pattern
      // that ignores matches a superset (the class is any character); one that negates undoes nothing.
      if (set === 'unterminated') return undefined
      if (set.unknown && negate) return { tokens: [], negate, dirOnly, unknown: true }
      tokens.push({ kind: 'set', test: set.test })
      i = set.end
    } else if (c === '\\' && i + 1 < text.length) {
      i += 1
      tokens.push({ kind: 'char', c: text[i]! })
    } else tokens.push({ kind: 'char', c })
  }
  return { tokens, negate, dirOnly }
}

/** The most bytes of one ignore file read; a longer one is incomplete, and its directory fails closed ({@link GitIgnores}). */
const MAX_IGNORE_FILE = 256 * 1024
/** The most automaton steps one call spends matching ignore patterns ({@link globMatch}); past it, a name like a secret's is refused. */
const MAX_IGNORE_STEPS = 20_000_000

/**
 * What the workspace's git ignores, from its `.gitignore` files and `.git/info/exclude` (read here,
 * never shown; no git runs), each read once per call: a path is ignored when its last matching
 * pattern, the deeper file's last, does not negate, or when a directory above it is ignored.
 * Not read: git's global excludes (`core.excludesFile`), which live outside the workspace.
 *
 * Bounded, and failing closed: an ignore file longer than {@link MAX_IGNORE_FILE} is not complete,
 * so everything at or below its directory counts as ignored; and once a call has spent
 * {@link MAX_IGNORE_STEPS} matching, every path asked about counts as ignored. Only a name like a
 * secret's is asked about ({@link GitIgnores.secret}), so failing closed refuses no other file.
 */
export class GitIgnores {
  private readonly rules = new Map<string, { rules: IgnoreRule[]; incomplete: boolean }>()
  private readonly budget = { steps: MAX_IGNORE_STEPS }
  // A plain field, not a parameter property: the server runs from this file under Node's type stripping, which refuses those.
  private readonly real: string
  constructor(real: string) {
    this.real = real
  }

  /** The text of the ignore file at `path` ('' if there is none), and whether it is longer than is read. */
  private read(path: string): { text: string; incomplete: boolean } {
    let fd: number
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch {
      return { text: '', incomplete: false }
    }
    try {
      if (!fstatSync(fd).isFile()) return { text: '', incomplete: false }
      // One byte more than is used tells a longer file, whatever its size said.
      const buffer = Buffer.alloc(MAX_IGNORE_FILE + 1)
      let read = 0
      while (read < buffer.length) {
        const n = readSync(fd, buffer, read, buffer.length - read, read)
        if (n === 0) break
        read += n
      }
      if (read > MAX_IGNORE_FILE) return { text: '', incomplete: true }
      return { text: buffer.subarray(0, read).toString('utf8'), incomplete: false }
    } finally {
      closeSync(fd)
    }
  }

  /** The rules of the directory `dir` (relative to the workspace; '' for its root), in order, and whether one of its ignore files is incomplete. */
  private rulesOf(dir: string): { rules: IgnoreRule[]; incomplete: boolean } {
    let entry = this.rules.get(dir)
    if (entry === undefined) {
      const files = [...(dir === '' ? [this.read(join(this.real, '.git', 'info', 'exclude'))] : []), this.read(join(this.real, dir, '.gitignore'))]
      entry = {
        rules: files.flatMap((file) => file.text.split('\n').flatMap((line) => gitIgnoreRule(line) ?? [])),
        incomplete: files.some((file) => file.incomplete),
      }
      this.rules.set(dir, entry)
    }
    return entry
  }

  /** Whether the last pattern matching `path` itself ignores it; true when that cannot be told within bounds. */
  private matches(path: string, isDir: boolean): boolean {
    const segments = path.split('/')
    let ignored = false
    for (let depth = 0; depth < segments.length; depth += 1) {
      const sub = segments.slice(depth).join('/')
      const { rules, incomplete } = this.rulesOf(segments.slice(0, depth).join('/'))
      if (incomplete) return true
      for (const rule of rules) {
        // A negating pattern this matcher cannot read undoes nothing (fails closed).
        if (rule.unknown) continue
        if (rule.dirOnly && !isDir) continue
        const matched = globMatch(rule.tokens, sub, this.budget)
        if (matched === undefined) return true
        if (matched) ignored = !rule.negate
      }
    }
    return ignored
  }

  /** Whether git ignores `rel` (relative to the workspace), it or a directory above it. */
  ignored(rel: string, isDir: boolean): boolean {
    const segments = rel.split('/')
    for (let i = 1; i <= segments.length; i += 1) {
      if (this.matches(segments.slice(0, i).join('/'), i < segments.length || isDir)) return true
    }
    return false
  }

  /**
   * Why `rel` is unreadable as an ignored path named like a secret ({@link SECRET_LIKE}), or
   * undefined: some segment of it is named like a secret, and git ignores the whole path (it, or a
   * directory above it; `private/config.txt` ignored is refused though only `private` is so named).
   */
  secret(rel: string, isDir: boolean): string | undefined {
    if (rel === '.' || rel === '') return undefined
    const named = rel.split('/').find((segment) => SECRET_LIKE.test(segment))
    if (named === undefined) return undefined
    return this.ignored(rel, isDir) ? `${rel} is ignored by git and named like a secret (${named}), so it is not read` : undefined
  }
}

/** A refusal the agent is told (the call's result), never a crash. */
class Refused extends Error {}

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
const MAX_PATH = 4096

/**
 * Where `path` (absolute, no `..`), which does not exist, would be: its deepest existing ancestor's
 * real path, the rest appended (nothing of the rest exists, so no link in it is followed).
 * Undefined when that ancestor cannot be resolved (a dangling symlink, a permission error).
 */
function deepestExisting(path: string): string | undefined {
  const rest: string[] = []
  let at = path
  for (;;) {
    try {
      lstatSync(at)
    } catch (error) {
      const parent = dirname(at)
      if (errno(error) !== 'ENOENT' || parent === at) return undefined
      rest.unshift(basename(at))
      at = parent
      continue
    }
    try {
      return join(realpathSync.native(at), ...rest)
    } catch {
      return undefined
    }
  }
}
/** How much of a file's start tells a binary file (a NUL byte). */
const SNIFF = 8000
const CHUNK = 64 * 1024
/** How many of one directory's entries are read, at most, per entry `list_dir` may show. */
const DIRECTORY_READ_FACTOR = 10

/**
 * At most `cap` entries of the directory open at `fd`, sorted by name, read one by one (never the
 * whole directory at once), and whether it holds more, left unread.
 */
function readEntries(fd: number, cap: number): { entries: Dirent[]; more: boolean } {
  const dir = opendirSync(`/proc/self/fd/${fd}`)
  const entries: Dirent[] = []
  let more = false
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      if (entries.length >= cap) {
        more = true
        break
      }
      entries.push(entry)
    }
  } finally {
    dir.closeSync()
  }
  return { entries: entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), more }
}

/** A file or directory opened inside the workspace, by its descriptor, and where it is. */
interface Opened { fd: number; real: string; rel: string }

/**
 * The workspace of one server: its root as given and as it really is, and what the tools may read
 * there. Every read goes through {@link WorkspaceReads.locate} and {@link WorkspaceReads.open}.
 */
export class WorkspaceReads {
  readonly root: string
  readonly real: string
  readonly bounds: WorkspaceReadBounds

  constructor(root: string, bounds: WorkspaceReadBounds) {
    if (!isAbsolute(root)) throw new Error(`the workspace ${root} is not an absolute path`)
    this.root = resolve(root)
    this.real = realpathSync.native(this.root)
    if (!statSync(this.real).isDirectory()) throw new Error(`the workspace ${root} is not a directory`)
    this.bounds = bounds
  }

  /**
   * Where `given` (relative to the workspace, or absolute inside it; absent or empty: the
   * workspace) really is, every symlink followed, and its path relative to the workspace. Refused:
   * not a string, a NUL, a `..` segment, an absolute path outside the workspace, a real location
   * outside the workspace's real path (a symlink out), git's data, or a secret, as written or as
   * resolved; and, as written and as resolved, a path git ignores that is named like a secret ({@link GitIgnores}).
   * With `missing` (a git view's path, which may name a file only history has), a path that does
   * not exist is where its deepest existing ancestor really is, the rest appended.
   */
  locate(given: unknown, ignores: GitIgnores = new GitIgnores(this.real), missing = false): { real: string; rel: string } {
    if (given !== undefined && typeof given !== 'string') throw new Refused('path is not a string')
    const written = given === undefined || given === '' ? '.' : given
    if (written.length > MAX_PATH || written.includes('\0')) throw new Refused('the path is longer than 4096 characters or holds a NUL')
    if (written.split(/[\\/]/).includes('..')) throw new Refused(`${written} climbs with "..", which is never read`)
    let rel = written
    if (isAbsolute(written)) {
      const base = [this.root, this.real].find((r) => inside(r, resolve(written)))
      if (base === undefined) throw new Refused(`${written} is outside the workspace ${this.root}`)
      rel = relative(base, resolve(written))
    }
    const named = hiddenName(rel)
    if (named) throw new Refused(named)
    // As written too: a symlink git ignores, named like a secret, is refused wherever it leads.
    // What it is (a directory or not) is not asked of the link, so both readings are taken.
    const relWritten = relative(this.real, join(this.real, rel)) || '.'
    const ignoredAsWritten = SECRET_LIKE.test(relWritten) ? (ignores.secret(relWritten, false) ?? ignores.secret(relWritten, true)) : undefined
    if (ignoredAsWritten) throw new Refused(ignoredAsWritten)
    let real: string
    try {
      real = realpathSync.native(join(this.real, rel))
    } catch (error) {
      const found = missing && errno(error) === 'ENOENT' ? deepestExisting(join(this.real, rel)) : undefined
      if (found === undefined) throw new Refused(errno(error) === 'ENOENT' ? `${written} does not exist` : `${written} cannot be resolved (${errno(error) ?? 'error'})`)
      real = found
    }
    // Where it leads outside is not said: the refusal names only what the agent wrote.
    if (!inside(this.real, real)) throw new Refused(`${written} resolves outside the workspace (through a symlink), which is never read`)
    const relReal = relative(this.real, real) || '.'
    const resolvedName = hiddenName(relReal)
    if (resolvedName) throw new Refused(resolvedName)
    const ignored = SECRET_LIKE.test(relReal) ? ignores.secret(relReal, statSync(real, { throwIfNoEntry: false })?.isDirectory() ?? false) : undefined
    if (ignored) throw new Refused(ignored)
    return { real, rel: relReal }
  }

  /** Why an entry of a listed or searched directory is left out (its name, or ignored and named like a secret), or undefined. */
  private hidden(rel: string, isDir: boolean, ignores: GitIgnores): string | undefined {
    return hiddenName(rel) ?? (SECRET_LIKE.test(rel) ? ignores.secret(rel, isDir) : undefined)
  }

  /**
   * Opens `real` (from {@link locate}) without following a link at its end and without blocking,
   * then checks what the descriptor names: still inside the workspace, still that path, and a
   * regular file (`file`) or a directory (`dir`). Throws {@link Refused} otherwise, the descriptor closed.
   */
  open(located: { real: string; rel: string }, kind: 'file' | 'dir'): Opened {
    let fd: number
    try {
      fd = openSync(located.real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (kind === 'dir' ? constants.O_DIRECTORY : 0))
    } catch (error) {
      const code = errno(error)
      throw new Refused(code === 'ENOTDIR' ? `${located.rel} is not a directory` : code === 'ELOOP' ? `${located.rel} became a symlink, which is not followed` : `${located.rel} cannot be opened (${code ?? 'error'})`)
    }
    try {
      let at: string
      try {
        at = readlinkSync(`/proc/self/fd/${fd}`)
      } catch {
        throw new Refused(`where ${located.rel} was opened cannot be checked (/proc/self/fd), so it is not read`)
      }
      if (at !== located.real || !inside(this.real, at)) throw new Refused(`${located.rel} moved while it was opened, so it is not read`)
      const stat = fstatSync(fd)
      if (kind === 'file' && stat.isDirectory()) throw new Refused(`${located.rel} is a directory: list it with list_dir`)
      if (kind === 'file' && !stat.isFile()) throw new Refused(`${located.rel} is not a regular file`)
      // A hard link is the file it links, whatever its name: a secret, or a file outside the
      // workspace on its filesystem. No path check sees it, so a file with more than one link is
      // not read, except under node_modules, where pnpm links its store's files.
      if (kind === 'file' && stat.nlink > 1 && !located.rel.split('/').includes('node_modules')) {
        throw new Refused(`${located.rel} has ${stat.nlink} hard links, so it may be another file under another name (a secret, or a file outside the workspace), and is not read`)
      }
      return { fd, real: located.real, rel: located.rel }
    } catch (error) {
      closeSync(fd)
      throw error
    }
  }

  /**
   * `read_file`: the file's lines, each numbered (`<n>\t<line>`), from `startLine` (default 1)
   * through `endLine` (default the end), at most `maxReadBytes` of output, reading through at most
   * `maxScanBytes` of the file. A binary file (a NUL in its first 8000 bytes) is named, not shown.
   */
  readFile(input: Record<string, unknown>): string {
    expectFields(input, { path: 'string', startLine: 'integer', endLine: 'integer' }, ['path'])
    const start = (input.startLine as number | undefined) ?? 1
    const end = (input.endLine as number | undefined) ?? Number.MAX_SAFE_INTEGER
    if (start < 1 || end < start) throw new Refused('startLine must be 1 or more, and endLine at least startLine')
    const file = this.open(this.locate(input.path), 'file')
    try {
      const size = fstatSync(file.fd).size
      const { maxReadBytes, maxScanBytes } = this.bounds
      const decoder = new StringDecoder('utf8')
      const buffer = Buffer.alloc(CHUNK)
      const out: string[] = []
      let outBytes = 0
      let scanned = 0
      let line = 1
      // The current line's text so far, kept only while it is in the range and its bytes fit the
      // output (a longer line is cut there anyway): each chunk is searched once, so a long line
      // costs what its bytes do, never a re-split of all of it per chunk.
      let partial: string[] = []
      let partialBytes = 0
      let partialSeen = false
      const keep = (text: string): void => {
        if (text === '') return
        partialSeen = true
        if (line < start || line > end || partialBytes > maxReadBytes) return
        partial.push(text)
        partialBytes += Buffer.byteLength(text)
      }
      let stop: string | undefined
      let eof = false
      /** Adds one whole line; false once the output is full. */
      const take = (text: string): boolean => {
        if (line >= start && line <= end) {
          const shown = `${line}\t${text}\n`
          const bytes = Buffer.byteLength(shown)
          if (outBytes + bytes > maxReadBytes) {
            const room = maxReadBytes - outBytes
            if (room > 0) out.push(cut(shown, room))
            stop = `output cut at ${maxReadBytes} bytes (maxReadBytes) in line ${line}; read on with startLine ${line}`
            return false
          }
          out.push(shown)
          outBytes += bytes
        }
        line += 1
        return line <= end
      }
      for (;;) {
        const want = Math.min(CHUNK, maxScanBytes - scanned)
        const n = want > 0 ? readSync(file.fd, buffer, 0, want, scanned) : 0
        if (n === 0) {
          // At the scan bound, only a file with no byte left is read to its end.
          if (want > 0 || readSync(file.fd, Buffer.alloc(1), 0, 1, scanned) === 0) eof = true
          else stop = `stopped after reading ${scanned} bytes of the file (maxScanBytes), at line ${line}`
          break
        }
        if (scanned === 0 && buffer.subarray(0, Math.min(n, SNIFF)).includes(0)) return `${file.rel}: a binary file of ${size} bytes, not shown`
        scanned += n
        const text = decoder.write(buffer.subarray(0, n))
        let from = 0
        let full = false
        for (let newline = text.indexOf('\n'); newline >= 0; newline = text.indexOf('\n', from)) {
          keep(text.slice(from, newline))
          from = newline + 1
          const whole = partial.join('')
          partial = []
          partialBytes = 0
          partialSeen = false
          if (!take(whole)) {
            full = true
            break
          }
        }
        if (full) break
        keep(text.slice(from))
      }
      if (eof && stop === undefined) {
        keep(decoder.end())
        if (partialSeen) take(partial.join(''))
      }
      const header = `${file.rel} (${size} bytes)${start > 1 || end !== Number.MAX_SAFE_INTEGER ? `, lines ${start} to ${end === Number.MAX_SAFE_INTEGER ? 'the end' : end}` : ''}`
      const tail = stop ? `\n[${stop}]` : eof && line <= start ? `\n[the file has ${line - 1} line${line - 1 === 1 ? '' : 's'}; none from line ${start}]` : ''
      return `${header}\n${out.join('')}${tail}`
    } finally {
      closeSync(file.fd)
    }
  }

  /**
   * `list_dir`: the directory's entries by name, at most `maxEntries`: a directory with a trailing
   * `/`, a symlink with `@` (not followed), a file with its size. Git's data and secret files are
   * left out, and counted. It reads at most 10 x `maxEntries` of the directory's entries (in the
   * order the directory gives them, then sorted), and says when there are more ("at least").
   */
  listDir(input: Record<string, unknown>): string {
    expectFields(input, { path: 'string' }, [])
    const ignores = new GitIgnores(this.real)
    const dir = this.open(this.locate(input.path, ignores), 'dir')
    try {
      const cap = DIRECTORY_READ_FACTOR * this.bounds.maxEntries
      const { entries, more } = readEntries(dir.fd, cap)
      const shown: string[] = []
      let hidden = 0
      for (const entry of entries) {
        if (this.hidden(dir.rel === '.' ? entry.name : `${dir.rel}/${entry.name}`, entry.isDirectory(), ignores)) {
          hidden += 1
          continue
        }
        if (shown.length >= this.bounds.maxEntries) continue
        if (entry.isDirectory()) shown.push(`${entry.name}/`)
        else if (entry.isSymbolicLink()) shown.push(`${entry.name}@`)
        else if (entry.isFile()) {
          let size = '?'
          try {
            // Never followed: the entry's own size, as listed.
            size = String(lstatSync(join(dir.real, entry.name), { throwIfNoEntry: false })?.size ?? '?')
          } catch {
            // listed without its size
          }
          shown.push(`${entry.name}\t${size} bytes`)
        } else shown.push(`${entry.name}\t(not a regular file)`)
      }
      const listed = entries.length - hidden
      const notes = [
        ...(more ? [`reading stopped at ${cap} entries, ${DIRECTORY_READ_FACTOR} x maxEntries`] : []),
        ...(listed > shown.length ? [more ? `showing ${shown.length} (maxEntries)` : `showing the first ${shown.length} of ${listed} (maxEntries)`] : []),
        ...(hidden ? [`${hidden} not shown: git's data or secret files`] : []),
      ]
      return `${dir.rel === '.' ? '.' : dir.rel}/: ${more ? 'at least ' : ''}${listed} entr${listed === 1 ? 'y' : 'ies'}${notes.length ? ` (${notes.join('; ')})` : ''}\n${shown.join('\n')}`
    } finally {
      closeSync(dir.fd)
    }
  }

  /** `search`'s input checked and its start located: what the worker thread is given. */
  searchPlan(input: Record<string, unknown>): SearchPlan {
    expectFields(input, { pattern: 'string', regex: 'boolean', ignoreCase: 'boolean', path: 'string' }, ['pattern'])
    const pattern = input.pattern as string
    if (pattern === '' || pattern.length > this.bounds.maxPatternChars) throw new Refused(`the pattern must hold 1 to ${this.bounds.maxPatternChars} characters (maxPatternChars)`)
    if (pattern.includes('\n')) throw new Refused('the pattern holds a newline; search matches one line at a time')
    const regex = input.regex === true
    if (regex) {
      try {
        new RegExp(pattern, input.ignoreCase === true ? 'i' : '')
      } catch (error) {
        throw new Refused(`the pattern is not a regular expression: ${(error as Error).message.slice(0, 200)}`)
      }
    }
    const start = this.locate(input.path)
    return { root: this.root, bounds: this.bounds, pattern, regex, ignoreCase: input.ignoreCase === true, start: start.rel }
  }

  /**
   * `search`, in this thread: the lines that hold `pattern` (a fixed string, or a regular expression
   * with `regex`), `<path>:<line>: <text>`, in the files under `start` (or that file), in name
   * order, depth first. Not followed or read: symlinks, git's data, secret files, `node_modules`
   * directories below the start, files over `maxScanBytes`, binary files, files with more than one
   * hard link. Reads at most 10 x `maxEntries` of each directory's entries. Stops at `maxMatches`,
   * `maxSearchFiles`, or `deadline`, and says so.
   */
  searchSync(plan: SearchPlan, deadline: number): string {
    const flags = plan.ignoreCase ? 'i' : ''
    const expression = plan.regex ? new RegExp(plan.pattern, flags) : undefined
    const needle = plan.ignoreCase ? plan.pattern.toLowerCase() : plan.pattern
    const matches = (text: string): boolean => (expression ? expression.test(text) : (plan.ignoreCase ? text.toLowerCase() : text).includes(needle))
    const { maxMatches, maxSearchFiles, maxScanBytes, maxLineChars } = this.bounds
    const found: string[] = []
    const ignores = new GitIgnores(this.real)
    const cap = DIRECTORY_READ_FACTOR * this.bounds.maxEntries
    let partial = 0
    let files = 0
    let skipped = 0
    let stop: string | undefined
    const searchFile = (located: { real: string; rel: string }): void => {
      if (files >= maxSearchFiles) {
        stop = `stopped after ${files} files (maxSearchFiles)`
        return
      }
      files += 1
      let file: Opened
      try {
        file = this.open(located, 'file')
      } catch {
        skipped += 1
        return
      }
      try {
        const size = fstatSync(file.fd).size
        if (size > maxScanBytes) {
          skipped += 1
          return
        }
        const buffer = Buffer.alloc(size)
        let read = 0
        while (read < size) {
          const n = readSync(file.fd, buffer, read, size - read, read)
          if (n === 0) break
          read += n
        }
        if (buffer.subarray(0, Math.min(read, SNIFF)).includes(0)) {
          skipped += 1
          return
        }
        // One line at a time, never an array of them all: a file of short lines would cost many
        // times its bytes in the thread's bounded heap ({@link searchResourceLimits}).
        const whole = buffer.toString('utf8', 0, read)
        for (let i = 0, from = 0; from <= whole.length; i += 1) {
          if (i % 256 === 0 && Date.now() > deadline) {
            stop = `stopped at the search's deadline (searchTimeoutMs ${this.bounds.searchTimeoutMs})`
            return
          }
          const newline = whole.indexOf('\n', from)
          const end = newline < 0 ? whole.length : newline
          const text = whole.slice(from, end)
          from = end + 1
          if (!matches(text)) continue
          if (found.length >= maxMatches) {
            stop = `stopped at ${maxMatches} matches (maxMatches)`
            return
          }
          found.push(`${file.rel}:${i + 1}: ${text.length > maxLineChars ? `${text.slice(0, maxLineChars)}…` : text}`)
        }
      } finally {
        closeSync(file.fd)
      }
    }
    const walk = (located: { real: string; rel: string }): void => {
      let dir: Opened
      try {
        dir = this.open(located, 'dir')
      } catch {
        skipped += 1
        return
      }
      let entries: Array<{ name: string; dir: boolean; file: boolean }>
      try {
        const read = readEntries(dir.fd, cap)
        if (read.more) partial += 1
        entries = read.entries.map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }))
      } finally {
        closeSync(dir.fd)
      }
      for (const entry of entries) {
        if (stop) return
        if (Date.now() > deadline) {
          stop = `stopped at the search's deadline (searchTimeoutMs ${this.bounds.searchTimeoutMs})`
          return
        }
        const rel = located.rel === '.' ? entry.name : `${located.rel}/${entry.name}`
        if ((entry.dir && entry.name === 'node_modules') || this.hidden(rel, entry.dir, ignores)) continue
        // A symlink, a socket, a device: none is followed or read.
        const child = { real: join(located.real, entry.name), rel }
        if (entry.dir) walk(child)
        else if (entry.file) searchFile(child)
      }
    }
    const start = this.locate(plan.start === '.' ? undefined : plan.start, ignores)
    let isDir: boolean
    try {
      isDir = statSync(start.real).isDirectory()
    } catch (error) {
      throw new Refused(`${start.rel} cannot be read (${errno(error) ?? 'error'})`)
    }
    if (isDir) walk(start)
    else searchFile(start)
    const notes = [
      ...(stop ? [stop] : []), `${files} file${files === 1 ? '' : 's'} searched`,
      ...(partial ? [`${partial} director${partial === 1 ? 'y' : 'ies'} read only to ${partial === 1 ? 'its' : 'their'} first ${cap} entries (${DIRECTORY_READ_FACTOR} x maxEntries)`] : []),
      ...(skipped ? [`${skipped} not read (over maxScanBytes, binary, hard links, or not openable)`] : []),
    ]
    return `${found.length} match${found.length === 1 ? '' : 'es'} of ${JSON.stringify(plan.pattern)}${plan.regex ? ' (regular expression)' : ''} under ${start.rel} [${notes.join('; ')}]${found.length ? `\n${found.join('\n')}` : ''}`
  }

  /**
   * `search`, in a worker thread of its own, stopped at the deadline whatever its pattern does (a
   * regular expression that backtracks without end included): the thread is terminated then.
   */
  search(input: Record<string, unknown>): Promise<string> {
    const plan = this.searchPlan(input)
    const deadline = Date.now() + this.bounds.searchTimeoutMs
    const resourceLimits = searchResourceLimits(this.bounds)
    // V8 sizes the whole heap from both (measured: the old generation and 1.5 x the young one);
    // the thread reports what it was given, and an answer from a thread bounded more loosely is not used.
    const heapBudget = (resourceLimits.maxOldGenerationSizeMb + 2 * resourceLimits.maxYoungGenerationSizeMb) * 1024 * 1024
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { kind: SEARCH_WORKER, plan, deadline }, resourceLimits })
      let settled = false
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        fn()
      }
      // Past the deadline the thread checks itself; a second later it is ended from here.
      const timer = setTimeout(() => settle(() => reject(new Refused(`the search did not finish within ${this.bounds.searchTimeoutMs} ms (searchTimeoutMs), and was stopped; narrow its path or its pattern`))), this.bounds.searchTimeoutMs + 1000)
      worker.once('message', (message: { text?: string; refused?: string; error?: string; heapLimit?: number }) => settle(() => {
        if (typeof message.heapLimit !== 'number' || message.heapLimit > heapBudget) reject(new Error('the search thread\'s heap was not bounded (resourceLimits), so its answer is not used'))
        else if (typeof message.text === 'string') resolvePromise(message.text)
        else reject(message.refused !== undefined ? new Refused(message.refused) : new Error(message.error ?? 'the search failed'))
      }))
      worker.once('error', (error) => settle(() => reject(
        errno(error) === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new Refused(`the search ran out of its memory (${resourceLimits.maxOldGenerationSizeMb} MiB, from maxScanBytes), and was stopped; narrow its path or its pattern`)
          : error,
      )))
      worker.once('exit', () => settle(() => reject(new Error('the search thread ended without an answer'))))
    })
  }

  /**
   * Runs git once in the workspace with `args` after the pinned options ({@link gitArgv}), never
   * through a shell, in a process group of its own: its output read up to `maxBytes` (one byte more
   * tells a longer one, and git is stopped there: `cut`), its exit status one of `ok`, by
   * `deadline`, or the whole group is killed and the call refused.
   */
  private runGit(args: readonly string[], deadline: number, maxBytes: number, overrides: readonly string[], ok: readonly number[] = [0]): Promise<{ out: Buffer; cut: boolean }> {
    return new Promise((resolvePromise, reject) => {
      const timedOut = (): Refused => new Refused(`git did not finish within ${this.bounds.gitTimeoutMs} ms (gitTimeoutMs), and was stopped; narrow the view (paths, count)`)
      const wait = deadline - Date.now()
      if (wait <= 0) {
        reject(timedOut())
        return
      }
      const child = spawn('git', gitArgv(args, overrides), { cwd: this.real, env: gitEnvironment(this.real), stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false })
      const chunks: Buffer[] = []
      let size = 0
      let cut = false
      let stderr = ''
      let settled = false
      const kill = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      const settle = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        kill()
        settle(() => reject(timedOut()))
      }, wait)
      child.stdout.on('data', (chunk: Buffer) => {
        if (cut) return
        const room = maxBytes + 1 - size
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room))
          size += room
          cut = true
          kill()
          return
        }
        chunks.push(chunk)
        size += chunk.length
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8')
      })
      child.once('error', (error) => settle(() => reject(new Error(`git cannot be run: ${error.message.slice(0, 300)}`))))
      child.once('close', (code) => settle(() => {
        if (cut) resolvePromise({ out: Buffer.concat(chunks).subarray(0, maxBytes), cut: true })
        else if (code !== null && ok.includes(code)) resolvePromise({ out: Buffer.concat(chunks), cut: false })
        else reject(new Refused(`git failed: ${(stderr.split('\n').find((line) => line.trim() !== '') ?? `exit ${code ?? 'by a signal'}`).slice(0, 300)}`))
      }))
    })
  }

  /**
   * The `-c` overrides that turn off every filter driver the repository's configuration names
   * (`filter.<name>.clean`, `.smudge`, `.process` empty, `.required` false): git runs a clean filter
   * when it reads a file of the worktree to compare or diff it (`git status`, `git diff`), and a
   * `.gitattributes` in the worktree chooses the driver, so no driver is left to run. Names are read
   * with `git config` (which runs nothing); one that `-c` cannot carry (an `=`, a newline), or more
   * than {@link MAX_GIT_FILTERS}, refuses the view.
   */
  private async filterOverrides(deadline: number): Promise<string[]> {
    const { out, cut } = await this.runGit(['config', '-z', '--name-only', '--get-regexp', '^filter\\.'], deadline, 64 * 1024, [], [0, 1])
    if (cut) throw new Refused('the repository\'s configuration names too many filter settings, so no git view runs')
    const names = new Set<string>()
    for (const key of out.toString('utf8').split('\0').flatMap((part) => part.split('\n'))) {
      if (!key.toLowerCase().startsWith('filter.')) continue
      const last = key.lastIndexOf('.')
      if (last <= 'filter.'.length) continue
      names.add(key.slice('filter.'.length, last))
    }
    if (names.size > MAX_GIT_FILTERS) throw new Refused(`the repository's configuration names more than ${MAX_GIT_FILTERS} filter drivers, so no git view runs`)
    return [...names].flatMap((name) => {
      if (/[=\n\r]/.test(name) || name.includes('\0')) throw new Refused('the repository\'s configuration names a filter driver git\'s -c cannot turn off (an "=" or a newline in its name), so no git view runs')
      return [`filter.${name}.clean=`, `filter.${name}.smudge=`, `filter.${name}.process=`, `filter.${name}.required=false`]
    })
  }

  /**
   * A git view's `paths`, each through {@link locate} (a path only history has included) and given
   * to git as a literal pathspec (`:(literal)`, so no `:` magic or glob is read from it); the
   * workspace itself is no pathspec. At most {@link MAX_GIT_PATHS}.
   */
  private gitPathspecs(given: unknown, ignores: GitIgnores): string[] {
    if (given === undefined) return []
    if (!Array.isArray(given) || !given.every((path) => typeof path === 'string')) throw new Refused('paths is not a list of strings')
    if (given.length > MAX_GIT_PATHS) throw new Refused(`paths names more than ${MAX_GIT_PATHS} paths`)
    return given.flatMap((path: string) => {
      if (path === '') throw new Refused('a path in paths is empty')
      const { rel } = this.locate(path, ignores, true)
      return rel === '.' ? [] : [`:(literal)${rel}`]
    })
  }

  /** Why the file `name` (relative to the repository) is left out of a git view, as {@link locate} refuses it, or undefined. */
  private secretInGit(name: string, ignores: GitIgnores): string | undefined {
    const isDir = name.endsWith('/')
    const rel = isDir ? name.slice(0, -1) : name
    return hiddenName(rel) ?? (SECRET_LIKE.test(rel) ? ignores.secret(rel, isDir) : undefined)
  }

  /**
   * The pathspecs that leave out of a diff the files it touches that are named as secrets
   * (`:(exclude,literal)<name>`): git lists them first (`listArgs` with `--name-only -z`), and each
   * so named is excluded. A list longer than {@link MAX_GIT_NAMES} bytes, more than
   * {@link MAX_GIT_EXCLUDES} such files, or one whose name is not UTF-8 refuses the view.
   */
  private async secretExcludes(listArgs: readonly string[], pathspecs: readonly string[], ignores: GitIgnores, deadline: number, overrides: readonly string[]): Promise<string[]> {
    const { out, cut } = await this.runGit([...listArgs, '--name-only', '-z', '--', ...pathspecs], deadline, MAX_GIT_NAMES, overrides)
    if (cut) throw new Refused('the view touches too many files to check them for secrets; narrow it with paths')
    // `show` puts a newline between its (empty) header and the names.
    const secret = [...new Set(out.toString('utf8').replace(/^\n+/, '').split('\0'))].filter((name) => name !== '' && this.secretInGit(name, ignores) !== undefined)
    if (secret.length > MAX_GIT_EXCLUDES) throw new Refused(`the view touches more than ${MAX_GIT_EXCLUDES} files named as secrets; narrow it with paths`)
    if (secret.some((name) => name.includes('�'))) throw new Refused('the view touches a file named as a secret whose name is not UTF-8, so it cannot be left out; narrow it with paths')
    return secret.map((name) => `:(exclude,literal)${name}`)
  }

  /** `text` within `maxGitBytes`, and a note when it, or git's output, was cut there. */
  private gitBounded(header: string, text: string, cutByGit: boolean, hint: string): string {
    const max = this.bounds.maxGitBytes
    const over = cutByGit || Buffer.byteLength(text) > max
    const body = over ? cut(text, max) : text
    return `${header}\n${body}${over ? `\n[output cut at ${max} bytes (maxGitBytes); ${hint}]` : ''}`
  }

  /**
   * `git_log`: at most `count` commits (default 20, at most `maxLogCount`) from HEAD or from a
   * commit named by its hex id, after `skip` of them, touching `paths` if given; each one line of
   * the chosen fields ({@link GIT_LOG_FIELDS}; default hash, date, author, subject), tab-separated,
   * and a requested body below it, indented.
   */
  async gitLog(input: Record<string, unknown>): Promise<string> {
    expectFields(input, { count: 'integer', skip: 'integer', commit: 'string', paths: 'strings', fields: 'strings' }, [])
    const max = this.bounds.maxLogCount
    const count = (input.count as number | undefined) ?? Math.min(20, max)
    if (count < 1 || count > max) throw new Refused(`count must be 1 to ${max} (maxLogCount)`)
    const skip = (input.skip as number | undefined) ?? 0
    if (skip < 0 || skip > 10_000_000) throw new Refused('skip must be 0 to 10000000')
    const commit = input.commit === undefined ? undefined : commitId(input.commit, 'commit')
    const fields = (input.fields as string[] | undefined) ?? DEFAULT_LOG_FIELDS
    if (fields.length === 0 || fields.length > Object.keys(GIT_LOG_FIELDS).length || new Set(fields).size !== fields.length) throw new Refused('fields must name each field at most once, at least one')
    for (const field of fields) if (!Object.hasOwn(GIT_LOG_FIELDS, field)) throw new Refused(`${JSON.stringify(field.slice(0, 64))} is not a field of git_log (${Object.keys(GIT_LOG_FIELDS).join(', ')})`)
    const deadline = Date.now() + this.bounds.gitTimeoutMs
    const pathspecs = this.gitPathspecs(input.paths, new GitIgnores(this.real))
    const overrides = await this.filterOverrides(deadline)
    const format = `--format=format:%x1e${fields.map((field) => GIT_LOG_FIELDS[field]).join('%x1f')}`
    const { out, cut: cutByGit } = await this.runGit(
      ['log', '--no-show-signature', '--no-color', `--max-count=${count}`, `--skip=${skip}`, format, ...(commit ? [`${commit}^{commit}`] : []), '--', ...pathspecs],
      deadline, this.bounds.maxGitBytes, overrides,
    )
    const records = out.toString('utf8').split('\x1e').slice(1)
    // A record git was stopped inside is not shown.
    if (cutByGit) records.pop()
    const lines = records.map((record) => {
      const values = record.split('\x1f')
      const body = fields.includes('body') ? (values[fields.indexOf('body')] ?? '').trim() : ''
      const line = fields.flatMap((field, i) => (field === 'body' ? [] : [(values[i] ?? '').replace(/\n+$/, '')])).join('\t')
      return `${line}${body ? `\n${body.split('\n').map((l) => `    ${l}`).join('\n')}` : ''}`
    })
    const header = `git log: ${records.length} commit${records.length === 1 ? '' : 's'} from ${commit ?? 'HEAD'}${skip ? `, after ${skip}` : ''}${pathspecs.length ? ' touching the paths given' : ''} (${fields.join(', ')})`
    return this.gitBounded(header, lines.join('\n'), cutByGit, `read on with skip ${skip + Math.max(0, records.length - 1)}`)
  }

  /**
   * `git_show`: one commit, named by its hex id: its header (id, parents, author, committer, the
   * whole message), then its `stat` and its `patch` (both by default; neither: the header alone),
   * limited to `paths` if given; files named as secrets are left out. No textconv, no external diff.
   */
  async gitShow(input: Record<string, unknown>): Promise<string> {
    expectFields(input, { commit: 'string', stat: 'boolean', patch: 'boolean', paths: 'strings' }, ['commit'])
    const commit = commitId(input.commit, 'commit')
    const stat = input.stat !== false
    const patch = input.patch !== false
    const deadline = Date.now() + this.bounds.gitTimeoutMs
    const ignores = new GitIgnores(this.real)
    const pathspecs = this.gitPathspecs(input.paths, ignores)
    const overrides = await this.filterOverrides(deadline)
    const rev = `${commit}^{commit}`
    // `-m`: a merge's files against each parent, a superset of what its stat or combined patch shows.
    const excludes = stat || patch ? await this.secretExcludes(['show', '--no-show-signature', '--format=', '-m', ...GIT_DIFF_OPTIONS, rev], pathspecs, ignores, deadline, overrides) : []
    const format = '--format=format:commit %H%nparents %P%nauthor %an <%ae> %aI%ncommitter %cn <%ce> %cI%n%n%w(0,4,4)%B'
    const shown = [...(stat ? [`--stat=${STAT_WIDTH}`] : []), ...(patch ? ['--patch'] : []), ...(!stat && !patch ? ['--no-patch'] : [])]
    const { out, cut: cutByGit } = await this.runGit(['show', '--no-show-signature', format, ...GIT_DIFF_OPTIONS, ...shown, rev, '--', ...pathspecs, ...excludes], deadline, this.bounds.maxGitBytes, overrides)
    const header = `git show ${commit}${pathspecs.length ? ', the paths given' : ''}${excludes.length ? `; ${excludes.length} file${excludes.length === 1 ? '' : 's'} named as secrets left out` : ''}`
    return this.gitBounded(header, out.toString('utf8'), cutByGit, 'narrow it with paths, or ask for the stat alone (patch: false)')
  }

  /**
   * `git_diff`: the worktree against HEAD (default), the index against HEAD (`cached`), or commit
   * `from` against commit `to` (both hex ids); a patch, or its `stat`, limited to `paths` if given;
   * files named as secrets are left out. Submodules are not entered. No textconv, no external diff.
   */
  async gitDiff(input: Record<string, unknown>): Promise<string> {
    expectFields(input, { from: 'string', to: 'string', cached: 'boolean', stat: 'boolean', paths: 'strings' }, [])
    if ((input.from === undefined) !== (input.to === undefined)) throw new Refused('give both from and to (two commits), or neither (the worktree or the index against HEAD)')
    if (input.from !== undefined && input.cached === true) throw new Refused('cached compares the index with HEAD: it takes no from and to')
    const from = input.from === undefined ? undefined : commitId(input.from, 'from')
    const to = input.to === undefined ? undefined : commitId(input.to, 'to')
    const deadline = Date.now() + this.bounds.gitTimeoutMs
    const ignores = new GitIgnores(this.real)
    const pathspecs = this.gitPathspecs(input.paths, ignores)
    const overrides = await this.filterOverrides(deadline)
    const revs = from !== undefined && to !== undefined ? [`${from}^{commit}`, `${to}^{commit}`] : input.cached === true ? ['--cached', 'HEAD'] : ['HEAD']
    const base = ['diff', ...GIT_DIFF_OPTIONS, '--ignore-submodules=all']
    const excludes = await this.secretExcludes([...base, ...revs], pathspecs, ignores, deadline, overrides)
    const { out, cut: cutByGit } = await this.runGit([...base, input.stat === true ? `--stat=${STAT_WIDTH}` : '--patch', ...revs, '--', ...pathspecs, ...excludes], deadline, this.bounds.maxGitBytes, overrides)
    const what = from !== undefined ? `${from} against ${to}` : input.cached === true ? 'the index against HEAD' : 'the worktree against HEAD'
    const header = `git diff: ${what}${input.stat === true ? ', stat' : ''}${pathspecs.length ? ', the paths given' : ''}${excludes.length ? `; ${excludes.length} file${excludes.length === 1 ? '' : 's'} named as secrets left out` : ''}`
    const text = out.toString('utf8')
    return this.gitBounded(header, text === '' ? '(no difference)' : text, cutByGit, 'narrow it with paths, or ask for the stat (stat: true)')
  }

  /**
   * `git_status`: the branch line and one line per changed or untracked path (`XY path`, git's
   * porcelain v1; a path with a control character, a quote, or a backslash JSON-quoted), limited to
   * `paths` if given; files named as secrets are counted, not shown. No renames detected, no
   * submodule entered.
   */
  async gitStatus(input: Record<string, unknown>): Promise<string> {
    expectFields(input, { paths: 'strings' }, [])
    const deadline = Date.now() + this.bounds.gitTimeoutMs
    const ignores = new GitIgnores(this.real)
    const pathspecs = this.gitPathspecs(input.paths, ignores)
    const overrides = await this.filterOverrides(deadline)
    const { out, cut: cutByGit } = await this.runGit(
      ['status', '--porcelain=v1', '-z', '--branch', '--no-renames', '--ignore-submodules=all', '--untracked-files=normal', '--', ...pathspecs],
      deadline, this.bounds.maxGitBytes, overrides,
    )
    const entries = out.toString('utf8').split('\0')
    // The last entry is cut, or the empty one after the last NUL.
    entries.pop()
    const lines: string[] = []
    let hidden = 0
    for (const entry of entries) {
      if (entry.startsWith('## ')) {
        lines.push(entry)
        continue
      }
      const path = entry.slice(3)
      if (this.secretInGit(path, ignores) !== undefined) {
        hidden += 1
        continue
      }
      lines.push(`${entry.slice(0, 3)}${needsQuoting(path) ? JSON.stringify(path) : path}`)
    }
    const changed = lines.filter((line) => !line.startsWith('## ')).length
    const header = `git status: ${changed} path${changed === 1 ? '' : 's'}${pathspecs.length ? ' under the paths given' : ''}${hidden ? `; ${hidden} named as secrets not shown` : ''}`
    return this.gitBounded(header, lines.join('\n'), cutByGit, 'narrow it with paths')
  }

  /** Runs one tool by its name; a refusal or failure is the call's error result, never a crash. */
  async call(name: unknown, input: unknown): Promise<{ text: string; isError: boolean }> {
    try {
      const args = input === undefined ? {} : input
      if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Refused('the arguments are not an object')
      const record = args as Record<string, unknown>
      if (name === 'read_file') return { text: this.readFile(record), isError: false }
      if (name === 'list_dir') return { text: this.listDir(record), isError: false }
      if (name === 'search') return { text: await this.search(record), isError: false }
      if (name === 'git_log') return { text: await this.gitLog(record), isError: false }
      if (name === 'git_show') return { text: await this.gitShow(record), isError: false }
      if (name === 'git_diff') return { text: await this.gitDiff(record), isError: false }
      if (name === 'git_status') return { text: await this.gitStatus(record), isError: false }
      throw new Refused(`${String(name).slice(0, 100)} is not a tool of this server (${WORKSPACE_READ_TOOLS.join(', ')})`)
    } catch (error) {
      return { text: error instanceof Refused ? `refused: ${error.message}` : `failed: ${(error as Error)?.message?.slice(0, 500) ?? String(error)}`, isError: true }
    }
  }
}

/** What a search's worker thread is given. */
interface SearchPlan {
  root: string
  bounds: WorkspaceReadBounds
  pattern: string
  regex: boolean
  ignoreCase: boolean
  /** The start, relative to the workspace. */
  start: string
}

const SEARCH_WORKER = 'system-workspace-reads-search'

/**
 * The heap of a search's worker thread, from `maxScanBytes`: the thread holds one file at a time,
 * decoded (up to 2 bytes a character) and one line of it, its matches (bounded), and its walk, so
 * 64 MiB and 4 x `maxScanBytes` of old generation, and a young generation of `maxScanBytes`
 * between 16 and 64 MiB. Past it the thread is ended and the search refused.
 */
export function searchResourceLimits(bounds: WorkspaceReadBounds): { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number } {
  const scanMb = Math.ceil(bounds.maxScanBytes / (1024 * 1024))
  return { maxOldGenerationSizeMb: 64 + 4 * scanMb, maxYoungGenerationSizeMb: Math.min(64, Math.max(16, scanMb)) }
}

/** Cuts `text` to at most `bytes` bytes of UTF-8, never inside a character. */
function cut(text: string, bytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.length <= bytes) return text
  let end = bytes
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/** Whether a path git shows must be JSON-quoted: a control character, a quote, a backslash, or spaces at either end. */
function needsQuoting(path: string): boolean {
  for (const c of path) {
    const code = c.charCodeAt(0)
    if (code < 0x20 || code === 0x7f || c === '"' || c === '\\') return true
  }
  return path !== path.trim()
}

/**
 * A commit id as the git views take it: 4 to 64 hex digits (a SHA-1 or SHA-256 id, or a prefix of
 * one), never a ref name, an option, or a revision expression.
 */
export const COMMIT_ID = /^[0-9a-fA-F]{4,64}$/

/** `value` as a commit id ({@link COMMIT_ID}); refused otherwise. */
function commitId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !COMMIT_ID.test(value)) throw new Refused(`${field} must be a commit's hex id (4 to 64 hex digits), never a name or an expression`)
  return value.toLowerCase()
}

/** The fields `git_log` shows, each a fixed `--format` placeholder (none runs a program: no signature, no mailmap). */
export const GIT_LOG_FIELDS: Readonly<Record<string, string>> = {
  hash: '%H', parents: '%P', date: '%aI', author: '%an', email: '%ae', committer: '%cn', committed: '%cI', subject: '%s', body: '%b',
}
const DEFAULT_LOG_FIELDS: readonly string[] = ['hash', 'date', 'author', 'subject']
/** The most paths one git view takes. */
const MAX_GIT_PATHS = 64
/** The most bytes of the list of files a diff touches, read to leave out those named as secrets. */
const MAX_GIT_NAMES = 16 * 1024 * 1024
/** The most files named as secrets one git view leaves out; more refuses it. */
const MAX_GIT_EXCLUDES = 512
/** The most filter drivers the repository's configuration may name for a git view to run. */
const MAX_GIT_FILTERS = 64
/** The width of a `--stat` (long names are shortened past it). */
const STAT_WIDTH = 200
/** What every diff a git view shows is: no external diff, no textconv, no rename detection, no colour. */
const GIT_DIFF_OPTIONS: readonly string[] = ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color']

/**
 * The configuration every git a view runs is given (`-c`, which no file of the repository's
 * overrides), each a setting under which a read-only git command could run a program, or reach
 * outside the workspace, turned off (T223; git-config(1), gitattributes(5), githooks(5)):
 * - `core.fsmonitor`: a hook program `git status` and `git diff` run to ask what changed (an empty
 *   value is false);
 * - `core.pager` (and `--no-pager`): the program output is piped through;
 * - `core.hooksPath`: hooks; none of these commands runs one (`post-index-change` only where the
 *   index is written, which `--no-optional-locks` stops), turned off all the same;
 * - `diff.external` (and `--no-ext-diff`, which also turns off every `diff.<driver>.command`): an
 *   external diff program; `diff.<driver>.textconv` is turned off by `--no-textconv`;
 * - `core.attributesFile`: a global attributes file outside the workspace (and `GIT_ATTR_NOSYSTEM`);
 * - `log.showSignature` (and `--no-show-signature`): `gpg.program` run to verify a signature;
 * - `protocol.allow`, `core.sshCommand`, `credential.helper`, `core.askPass`: a transport (a lazy
 *   fetch of a partial clone's missing object) and the programs it would run (and `GIT_NO_LAZY_FETCH`);
 * - `status.submoduleSummary`, `submodule.recurse`, `diff.submodule`: git run again in a submodule
 *   (and `--ignore-submodules=all`);
 * - `log.mailmap`: a mailmap file read from anywhere; `color.ui`; `gc.auto` and
 *   `maintenance.auto`: no command here starts them, turned off all the same.
 * Filter drivers (`filter.<name>.clean`, `.process`) run not only on checkout: a clean filter runs
 * whenever git reads a worktree file to compare or diff it, so every driver the repository's
 * configuration names is turned off too (the view's `filterOverrides`).
 */
export const GIT_CONFIG_PINS: readonly string[] = [
  'core.fsmonitor=', 'core.pager=cat', 'core.hooksPath=/dev/null', 'diff.external=', 'core.attributesFile=/dev/null',
  'log.showSignature=false', 'protocol.allow=never', 'core.sshCommand=', 'credential.helper=', 'core.askPass=',
  'status.submoduleSummary=false', 'submodule.recurse=false', 'diff.submodule=short', 'log.mailmap=false', 'color.ui=false',
  'gc.auto=0', 'maintenance.auto=false',
]

/** The argv of one git a view runs: no pager, no optional lock (the index is never written), the pins and `overrides` as `-c`, then `args`. */
export function gitArgv(args: readonly string[], overrides: readonly string[] = []): string[] {
  return ['--no-pager', '--no-optional-locks', ...[...GIT_CONFIG_PINS, ...overrides].flatMap((pin) => ['-c', pin]), ...args]
}

/**
 * The whole environment of a git a view runs (nothing else of the server's is passed): no system
 * or global configuration (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`), no system
 * attributes, no prompt, no optional lock, no lazy fetch, no pager; the repository found only at the
 * workspace's root (`GIT_CEILING_DIRECTORIES` its parent) and its worktree the workspace
 * (`GIT_WORK_TREE`, over any `core.worktree`); the C locale; only `PATH` from the server's.
 */
export function gitEnvironment(real: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat', PAGER: 'cat', GIT_CEILING_DIRECTORIES: dirname(real), GIT_WORK_TREE: real,
  }
}

/** Refuses a field not listed, one of another type, or a required one missing. */
function expectFields(input: Record<string, unknown>, fields: Record<string, 'string' | 'integer' | 'boolean' | 'strings'>, required: string[]): void {
  for (const [key, value] of Object.entries(input)) {
    const type = Object.hasOwn(fields, key) ? fields[key] : undefined
    if (!type) throw new Refused(`${JSON.stringify(key.slice(0, 64))} is not an argument of this tool (${Object.keys(fields).join(', ')})`)
    const ok = type === 'integer' ? Number.isSafeInteger(value) : type === 'strings' ? Array.isArray(value) && value.every((v) => typeof v === 'string') : typeof value === type
    if (!ok) throw new Refused(`${key} is not ${type === 'integer' ? 'an integer' : type === 'strings' ? 'a list of strings' : `a ${type}`}`)
  }
  for (const key of required) if (input[key] === undefined) throw new Refused(`${key} is required`)
}

const PATH_DESCRIPTION = 'A path relative to the workspace, or absolute inside it; no ".." segment. Git\'s data (.git) and secret files (.env, keys, credentials, ignored files named like secrets) are never read, nor a file with more than one hard link outside node_modules.'

/** The tools as `tools/list` gives them: read-only, closed-world. */
export function workspaceReadTools(bounds: WorkspaceReadBounds): unknown[] {
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  return [
    {
      name: 'read_file', title: 'Read a file',
      description: `Reads one file of the workspace, its lines numbered (<n><TAB><line>), at most ${bounds.maxReadBytes} bytes; give startLine and endLine (1-based, inclusive) to read a range or read on.`,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['path'],
        properties: { path: { type: 'string', description: PATH_DESCRIPTION }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 } },
      },
      annotations,
    },
    {
      name: 'list_dir', title: 'List a directory',
      description: `Lists one directory of the workspace (default: its root), at most ${bounds.maxEntries} entries: a directory ends in /, a symlink in @, a file shows its size.`,
      inputSchema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', description: PATH_DESCRIPTION } } },
      annotations,
    },
    {
      name: 'search', title: 'Search the workspace',
      description: `Finds the lines that hold a fixed string (or, with regex, match a JavaScript regular expression) in the files under a path of the workspace (default: all of it), at most ${bounds.maxMatches} matches as <path>:<line>: <text>; skips symlinks, node_modules directories below the path, binary files, and git's data.`,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['pattern'],
        properties: {
          pattern: { type: 'string', description: 'What a line must hold; one line, no newline.' }, regex: { type: 'boolean', description: 'The pattern is a regular expression (default: a fixed string).' },
          ignoreCase: { type: 'boolean' }, path: { type: 'string', description: PATH_DESCRIPTION },
        },
      },
      annotations,
    },
    {
      name: 'git_log', title: 'Git log',
      description: `Lists commits of the workspace's repository, newest first, from HEAD or from a commit given by its hex id: at most ${bounds.maxLogCount} (count, default ${Math.min(20, bounds.maxLogCount)}), after skip of them, touching paths if given; one line each of the fields asked for, tab-separated (default hash, date, author, subject), a body below it, indented. At most ${bounds.maxGitBytes} bytes.`,
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          count: { type: 'integer', minimum: 1, maximum: bounds.maxLogCount }, skip: { type: 'integer', minimum: 0 }, commit: COMMIT_SCHEMA, paths: PATHS_SCHEMA,
          fields: { type: 'array', items: { type: 'string', enum: Object.keys(GIT_LOG_FIELDS) }, minItems: 1, uniqueItems: true },
        },
      },
      annotations,
    },
    {
      name: 'git_show', title: 'Git show',
      description: `Shows one commit of the workspace's repository, given by its hex id: its header and whole message, then its stat and its patch (each on by default), limited to paths if given. Files named as secrets are left out. At most ${bounds.maxGitBytes} bytes.`,
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['commit'],
        properties: { commit: COMMIT_SCHEMA, stat: { type: 'boolean', description: 'Show the stat (default true).' }, patch: { type: 'boolean', description: 'Show the patch (default true).' }, paths: PATHS_SCHEMA },
      },
      annotations,
    },
    {
      name: 'git_diff', title: 'Git diff',
      description: `Diffs the workspace's worktree against HEAD (default), its index against HEAD (cached), or commit from against commit to (both hex ids): a patch, or with stat its stat, limited to paths if given. Files named as secrets are left out; submodules are not entered. At most ${bounds.maxGitBytes} bytes.`,
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { from: COMMIT_SCHEMA, to: COMMIT_SCHEMA, cached: { type: 'boolean', description: 'The index (staged changes) against HEAD.' }, stat: { type: 'boolean', description: 'The stat, not the patch.' }, paths: PATHS_SCHEMA },
      },
      annotations,
    },
    {
      name: 'git_status', title: 'Git status',
      description: `The workspace's git status, porcelain: its branch line, then XY path for each changed or untracked path, limited to paths if given; files named as secrets are counted, not shown. At most ${bounds.maxGitBytes} bytes.`,
      inputSchema: { type: 'object', additionalProperties: false, properties: { paths: PATHS_SCHEMA } },
      annotations,
    },
  ]
}

const COMMIT_SCHEMA = { type: 'string', pattern: COMMIT_ID.source, description: 'A commit\'s hex id, 4 to 64 hex digits (from git_log); never a branch name or an expression.' }
const PATHS_SCHEMA = { type: 'array', items: { type: 'string' }, maxItems: MAX_GIT_PATHS, description: `${PATH_DESCRIPTION} A path may name a file only history has.` }

/** The MCP protocol versions the server answers in; the first is its own. */
export const WORKSPACE_READS_PROTOCOLS: readonly string[] = ['2025-06-18', '2025-03-26', '2024-11-05']
/** The largest message the server reads; a longer line is refused and dropped. */
const MAX_MESSAGE = 1024 * 1024
/** Requests waiting at once; a further one is refused. */
const MAX_PENDING = 32

type JsonRpcId = string | number
type Reply = { jsonrpc: '2.0'; id: JsonRpcId | null } & ({ result: unknown } | { error: { code: number; message: string } })

/**
 * The answer to one JSON-RPC message, or undefined for a notification (MCP Roots' among them, which
 * change nothing: the root is fixed) or a response. `initialize`, `ping`, `tools/list`, and
 * `tools/call` are answered; every other method is not found. The server never sends a request.
 */
export async function answerMessage(reads: WorkspaceReads, message: unknown): Promise<Reply | undefined> {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'not a JSON-RPC request' } }
  const m = message as Record<string, unknown>
  const id = typeof m.id === 'string' || (typeof m.id === 'number' && Number.isFinite(m.id)) ? m.id : undefined
  if (typeof m.method !== 'string') return undefined
  if (id === undefined) return undefined
  if (m.jsonrpc !== '2.0') return { jsonrpc: '2.0', id, error: { code: -32600, message: 'not a JSON-RPC 2.0 request' } }
  const params = typeof m.params === 'object' && m.params !== null ? m.params as Record<string, unknown> : {}
  switch (m.method) {
    case 'initialize': {
      const asked = params.protocolVersion
      const protocolVersion = typeof asked === 'string' && WORKSPACE_READS_PROTOCOLS.includes(asked) ? asked : WORKSPACE_READS_PROTOCOLS[0]
      return {
        jsonrpc: '2.0', id, result: {
          protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'system-workspace-reads', version: '1.0.0' },
          instructions: `Read-only tools over this run's workspace ${reads.root}: ${WORKSPACE_READ_TOOLS.join(', ')}. Read the workspace and its git history with them, never with a shell.`,
        },
      }
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: workspaceReadTools(reads.bounds) } }
    case 'tools/call': {
      const { text, isError } = await reads.call(params.name, params.arguments)
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `${m.method.slice(0, 100)} is not a method of this server` } }
  }
}

/**
 * Serves MCP over newline-delimited JSON-RPC on `input` until it ends, one request at a time, in
 * order, writing each answer with `write`. A line over 1 MiB (whether it arrives whole or in
 * parts), or not JSON, is answered with an error and dropped; past 32 lines waiting (requests, and
 * lines answered with an error), a request is refused at once, and so is a line that is not JSON.
 * One at a time, a request waits for those before it: Codex's tool timeout (the search deadline
 * and 30 s) counts that wait too.
 */
export function serveWorkspaceReads(reads: WorkspaceReads, input: NodeJS.ReadableStream, write: (line: string) => void): Promise<void> {
  return new Promise((done, failed) => {
    let buffered: Buffer[] = []
    let size = 0
    let dropping = false
    let pending = 0
    let chain = Promise.resolve()
    const send = (reply: Reply): void => write(JSON.stringify(reply))
    const refuse = (id: JsonRpcId | null): void => send({ jsonrpc: '2.0', id, error: { code: -32000, message: `more than ${MAX_PENDING} requests wait; this one is refused` } })
    /** Answers in its turn, after the lines before it, while fewer than MAX_PENDING wait; else false. */
    const enqueue = (answer: () => Promise<void> | void): boolean => {
      if (pending >= MAX_PENDING) return false
      pending += 1
      chain = chain.then(async () => {
        try {
          await answer()
        } finally {
          pending -= 1
        }
      })
      return true
    }
    const tooLong = (): void => {
      const reply: Reply = { jsonrpc: '2.0', id: null, error: { code: -32600, message: `a message is longer than ${MAX_MESSAGE} bytes` } }
      if (!enqueue(() => send(reply))) refuse(null)
    }
    const handle = (line: string): void => {
      if (line.trim() === '') return
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        if (!enqueue(() => send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } }))) refuse(null)
        return
      }
      const raw = (message as { id?: unknown } | null)?.id
      const id = typeof raw === 'string' || typeof raw === 'number' ? raw : undefined
      const queued = enqueue(async () => {
        try {
          const reply = await answerMessage(reads, message)
          if (reply) send(reply)
        } catch (error) {
          if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32603, message: (error as Error)?.message?.slice(0, 500) ?? 'failed' } })
        }
      })
      if (!queued && id !== undefined) refuse(id)
    }
    input.on('data', (chunk: Buffer | string) => {
      let data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      for (let newline = data.indexOf(10); newline >= 0; newline = data.indexOf(10)) {
        const head = data.subarray(0, newline)
        data = data.subarray(newline + 1)
        if (dropping) {
          dropping = false
          continue
        }
        // A whole line in one chunk is measured too, never parsed past the bound.
        if (size + head.length > MAX_MESSAGE) tooLong()
        else handle(Buffer.concat([...buffered, head]).toString('utf8'))
        buffered = []
        size = 0
      }
      if (dropping || data.length === 0) return
      size += data.length
      if (size > MAX_MESSAGE) {
        tooLong()
        buffered = []
        size = 0
        dropping = true
        return
      }
      buffered.push(data)
    })
    input.once('end', () => {
      chain.then(() => done(), failed)
    })
    input.once('error', failed)
  })
}

/** The server's process: its arguments, then MCP on stdin and stdout; `--self-test <path>` reads that file once and prints it. */
async function main(argv: readonly string[]): Promise<void> {
  let reads: WorkspaceReads
  let selfTest: string | undefined
  try {
    const parsed = parseWorkspaceReadArgs(argv)
    reads = new WorkspaceReads(parsed.root, parsed.bounds)
    selfTest = parsed.selfTest
  } catch (error) {
    process.stderr.write(`workspace reads: ${(error as Error).message}\n`)
    process.exit(2)
  }
  if (selfTest !== undefined) {
    const { text, isError } = await reads.call('read_file', { path: selfTest })
    process.stdout.write(`${text}\n`)
    process.exit(isError ? 1 : 0)
  }
  await serveWorkspaceReads(reads, process.stdin, (line) => process.stdout.write(`${line}\n`))
}

if (!isMainThread && (workerData as { kind?: unknown } | null)?.kind === SEARCH_WORKER) {
  const { plan, deadline } = workerData as { plan: SearchPlan; deadline: number }
  // What the thread's heap is bounded by, for the server to check against what it asked.
  const heapLimit = getHeapStatistics().heap_size_limit
  try {
    const reads = new WorkspaceReads(plan.root, plan.bounds)
    parentPort!.postMessage({ text: reads.searchSync(plan, deadline), heapLimit })
  } catch (error) {
    parentPort!.postMessage(error instanceof Refused ? { refused: error.message, heapLimit } : { error: (error as Error)?.message ?? String(error), heapLimit })
  }
} else if (isMainThread && process.argv[1] !== undefined && (() => {
  try {
    return realpathSync(process.argv[1]!) === realpathSync(WORKSPACE_READS_SCRIPT)
  } catch {
    return false
  }
})()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`workspace reads: ${(error as Error)?.message ?? String(error)}\n`)
    process.exit(1)
  })
}
