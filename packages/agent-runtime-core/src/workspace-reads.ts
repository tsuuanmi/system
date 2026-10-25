/**
 * The workspace reads server (docs/design/agent-runtimes.md#the-workspace-reads-server, T200b): a
 * minimal MCP server of System's own over stdio, with three read-only tools bound to one run's
 * workspace, so an agent reads its workspace without a shell:
 * - `read_file`: one file, optionally a line range, its lines numbered, bounded in bytes;
 * - `list_dir`: one directory's entries, bounded in number;
 * - `search`: a fixed string or a regular expression over the files under a path, bounded in
 *   matches, files, bytes, and time, in a worker thread of this process (no shell, no program).
 * Every path is resolved with `realpath` and must stay inside the workspace: a `..` segment, an
 * absolute path outside it, and a symlink whose target is outside it are refused; git's own data
 * (`.git` anywhere in the path) and files named as secrets ({@link SECRET_NAMES}) are unreadable,
 * and every file or directory is opened without following a link at its end and checked again by
 * the path its descriptor names (`/proc/self/fd`), so a path swapped after the check is refused.
 * Its root is fixed at start (`--root`): it asks the client for no MCP Roots and ignores their
 * notifications. Every bound is a validated argument ({@link WORKSPACE_READ_BOUNDS}, INV-9). A
 * runtime starts it under the run's read confinement with the workspace bound read-only, so these
 * checks are a second layer. Standalone: Node built-ins only, so it is bound alone into that
 * confinement, as the Codex gate hook is.
 * @module @tsuuanmi/system-agent-runtime-core/workspace-reads
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

/** The server's own file: what a runtime runs with `node` and binds into the confinement. */
export const WORKSPACE_READS_SCRIPT: string = fileURLToPath(import.meta.url)

/** The name a runtime registers the server under, and its three tools. */
export const WORKSPACE_READS_SERVER = 'workspace'
export const WORKSPACE_READ_TOOLS: readonly string[] = ['read_file', 'list_dir', 'search']

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
 * `.env.local`, … but not `.env.example`, `.env.sample`, `.env.template`, `.env.dist`), keys and
 * keystores, SSH private keys, and credential files. Such a file, or anything under a directory so
 * named, is unreadable whether or not the repository ignores it.
 */
export const SECRET_NAMES: readonly RegExp[] = [
  /^\.env$/i, /^\.env\.(?!(example|sample|template|dist)$).+$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i, /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.(netrc|npmrc|pypirc|git-credentials|htpasswd)$/i, /^(credentials|secrets)(\.(json|ya?ml|toml))?$/i,
]

/** Why a path relative to the workspace is unreadable by name (git's data, a secret), or undefined. */
function hiddenName(rel: string): string | undefined {
  for (const segment of rel.split(/[\\/]/)) {
    if (segment.toLowerCase() === '.git') return 'git\'s own data (.git) is not read'
    if (SECRET_NAMES.some((pattern) => pattern.test(segment))) return `${segment} is named as a secret file, which is not read`
  }
  return undefined
}

/** A refusal the agent is told (the call's result), never a crash. */
class Refused extends Error {}

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
const MAX_PATH = 4096
/** How much of a file's start tells a binary file (a NUL byte). */
const SNIFF = 8000
const CHUNK = 64 * 1024

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
   * resolved.
   */
  locate(given: unknown): { real: string; rel: string } {
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
    let real: string
    try {
      real = realpathSync.native(join(this.real, rel))
    } catch (error) {
      throw new Refused(errno(error) === 'ENOENT' ? `${written} does not exist` : `${written} cannot be resolved (${errno(error) ?? 'error'})`)
    }
    // Where it leads outside is not said: the refusal names only what the agent wrote.
    if (!inside(this.real, real)) throw new Refused(`${written} resolves outside the workspace (through a symlink), which is never read`)
    const relReal = relative(this.real, real) || '.'
    const resolvedName = hiddenName(relReal)
    if (resolvedName) throw new Refused(resolvedName)
    return { real, rel: relReal }
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
   * left out, and counted.
   */
  listDir(input: Record<string, unknown>): string {
    expectFields(input, { path: 'string' }, [])
    const dir = this.open(this.locate(input.path), 'dir')
    try {
      const entries = readdirSync(`/proc/self/fd/${dir.fd}`, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const shown: string[] = []
      let hidden = 0
      for (const entry of entries) {
        if (hiddenName(entry.name)) {
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
        ...(listed > shown.length ? [`showing the first ${shown.length} of ${listed} (maxEntries)`] : []),
        ...(hidden ? [`${hidden} not shown: git's data or secret files`] : []),
      ]
      return `${dir.rel === '.' ? '.' : dir.rel}/: ${listed} entr${listed === 1 ? 'y' : 'ies'}${notes.length ? ` (${notes.join('; ')})` : ''}\n${shown.join('\n')}`
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
   * directories below the start, files over `maxScanBytes`, binary files. Stops at `maxMatches`,
   * `maxSearchFiles`, or `deadline`, and says so.
   */
  searchSync(plan: SearchPlan, deadline: number): string {
    const flags = plan.ignoreCase ? 'i' : ''
    const expression = plan.regex ? new RegExp(plan.pattern, flags) : undefined
    const needle = plan.ignoreCase ? plan.pattern.toLowerCase() : plan.pattern
    const matches = (text: string): boolean => (expression ? expression.test(text) : (plan.ignoreCase ? text.toLowerCase() : text).includes(needle))
    const { maxMatches, maxSearchFiles, maxScanBytes, maxLineChars } = this.bounds
    const found: string[] = []
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
        const lines = buffer.subarray(0, read).toString('utf8').split('\n')
        for (const [i, text] of lines.entries()) {
          if (i % 256 === 0 && Date.now() > deadline) {
            stop = `stopped at the search's deadline (searchTimeoutMs ${this.bounds.searchTimeoutMs})`
            return
          }
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
        entries = readdirSync(`/proc/self/fd/${dir.fd}`, { withFileTypes: true })
          .map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
        if (hiddenName(entry.name) || (entry.dir && entry.name === 'node_modules')) continue
        // A symlink, a socket, a device: none is followed or read.
        const child = { real: join(located.real, entry.name), rel }
        if (entry.dir) walk(child)
        else if (entry.file) searchFile(child)
      }
    }
    const start = this.locate(plan.start === '.' ? undefined : plan.start)
    let isDir: boolean
    try {
      isDir = statSync(start.real).isDirectory()
    } catch (error) {
      throw new Refused(`${start.rel} cannot be read (${errno(error) ?? 'error'})`)
    }
    if (isDir) walk(start)
    else searchFile(start)
    const notes = [...(stop ? [stop] : []), `${files} file${files === 1 ? '' : 's'} searched`, ...(skipped ? [`${skipped} not read (over maxScanBytes, binary, or not openable)`] : [])]
    return `${found.length} match${found.length === 1 ? '' : 'es'} of ${JSON.stringify(plan.pattern)}${plan.regex ? ' (regular expression)' : ''} under ${start.rel} [${notes.join('; ')}]${found.length ? `\n${found.join('\n')}` : ''}`
  }

  /**
   * `search`, in a worker thread of its own, stopped at the deadline whatever its pattern does (a
   * regular expression that backtracks without end included): the thread is terminated then.
   */
  search(input: Record<string, unknown>): Promise<string> {
    const plan = this.searchPlan(input)
    const deadline = Date.now() + this.bounds.searchTimeoutMs
    return new Promise((resolvePromise, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { kind: SEARCH_WORKER, plan, deadline } })
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
      worker.once('message', (message: { text?: string; refused?: string; error?: string }) => settle(() => {
        if (typeof message.text === 'string') resolvePromise(message.text)
        else reject(message.refused !== undefined ? new Refused(message.refused) : new Error(message.error ?? 'the search failed'))
      }))
      worker.once('error', (error) => settle(() => reject(error)))
      worker.once('exit', () => settle(() => reject(new Error('the search thread ended without an answer'))))
    })
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
      throw new Refused(`${String(name).slice(0, 100)} is not a tool of this server (read_file, list_dir, search)`)
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

/** Cuts `text` to at most `bytes` bytes of UTF-8, never inside a character. */
function cut(text: string, bytes: number): string {
  const buffer = Buffer.from(text)
  if (buffer.length <= bytes) return text
  let end = bytes
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/** Refuses a field not listed, one of another type, or a required one missing. */
function expectFields(input: Record<string, unknown>, fields: Record<string, 'string' | 'integer' | 'boolean'>, required: string[]): void {
  for (const [key, value] of Object.entries(input)) {
    const type = Object.hasOwn(fields, key) ? fields[key] : undefined
    if (!type) throw new Refused(`${JSON.stringify(key.slice(0, 64))} is not an argument of this tool (${Object.keys(fields).join(', ')})`)
    const ok = type === 'integer' ? Number.isSafeInteger(value) : typeof value === type
    if (!ok) throw new Refused(`${key} is not ${type === 'integer' ? 'an integer' : `a ${type}`}`)
  }
  for (const key of required) if (input[key] === undefined) throw new Refused(`${key} is required`)
}

const PATH_DESCRIPTION = 'A path relative to the workspace, or absolute inside it; no ".." segment. Git\'s data (.git) and secret files (.env, keys, credentials) are never read.'

/** The three tools as `tools/list` gives them: read-only, closed-world. */
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
  ]
}

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
          instructions: `Read-only tools over this run's workspace ${reads.root}: read_file, list_dir, search. Read the workspace with them, never with a shell.`,
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
 * order, writing each answer with `write`. A line over 1 MiB, or not JSON, is answered with an
 * error and dropped; past 32 requests waiting, a request is refused.
 */
export function serveWorkspaceReads(reads: WorkspaceReads, input: NodeJS.ReadableStream, write: (line: string) => void): Promise<void> {
  return new Promise((done, failed) => {
    let buffered: Buffer[] = []
    let size = 0
    let dropping = false
    let pending = 0
    let chain = Promise.resolve()
    const send = (reply: Reply): void => write(JSON.stringify(reply))
    const handle = (line: string): void => {
      if (line.trim() === '') return
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        // Answered in its turn, after the requests before it.
        chain = chain.then(() => send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'not JSON' } }))
        return
      }
      if (pending >= MAX_PENDING) {
        const id = (message as { id?: unknown } | null)?.id
        if (typeof id === 'string' || typeof id === 'number') send({ jsonrpc: '2.0', id, error: { code: -32000, message: `more than ${MAX_PENDING} requests wait; this one is refused` } })
        return
      }
      pending += 1
      chain = chain.then(async () => {
        try {
          const reply = await answerMessage(reads, message)
          if (reply) send(reply)
        } catch (error) {
          const id = (message as { id?: unknown } | null)?.id
          if (typeof id === 'string' || typeof id === 'number') send({ jsonrpc: '2.0', id, error: { code: -32603, message: (error as Error)?.message?.slice(0, 500) ?? 'failed' } })
        } finally {
          pending -= 1
        }
      })
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
        handle(Buffer.concat([...buffered, head]).toString('utf8'))
        buffered = []
        size = 0
      }
      if (dropping || data.length === 0) return
      size += data.length
      if (size > MAX_MESSAGE) {
        chain = chain.then(() => send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `a message is longer than ${MAX_MESSAGE} bytes` } }))
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
  try {
    const reads = new WorkspaceReads(plan.root, plan.bounds)
    parentPort!.postMessage({ text: reads.searchSync(plan, deadline) })
  } catch (error) {
    parentPort!.postMessage(error instanceof Refused ? { refused: error.message } : { error: (error as Error)?.message ?? String(error) })
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
