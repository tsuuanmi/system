/**
 * Public repository snapshots (PROP-0004 Phase 4): the files a team reviews, read at one pinned
 * commit by `system` itself, so no member browses the repository and every quote can be checked
 * against the bytes the members saw. A confined, read-only probe like `subjects.ts`:
 * - the URL is rebuilt from checked parts, and git gets only that canonical URL;
 * - git runs with fixed arguments, no shell, no hooks, no credentials, no user or system config,
 *   https only, pinned to the addresses that were checked;
 * - a blob larger than the per-file bound is never downloaded;
 * - every git call has a bound, the whole snapshot has a deadline, and a stopped call stops its
 *   whole process group (INV-9).
 */
import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SnapshotRequest {
  /** An `https://<host>/<owner>/<repo>` URL of a public repository (no credentials, query, or fragment). */
  url: string
  /** A branch, a tag, or a full commit SHA (default: the remote's HEAD). */
  ref?: string
  /** Paths or globs to review first; otherwise words matched against paths. */
  focus?: string[]
  /** Words from the review request, matched against paths when no `focus` is given. */
  terms?: string[]
}

/** What an operator may configure (`workflow.repositories`). */
export interface SnapshotBounds {
  /** Files read (default 40). */
  maxFiles?: number
  /** Bytes of text read in all (default 300 KB). */
  maxBytes?: number
  /** A larger file is never downloaded, and is listed as unread (default 48 KB). */
  maxFileBytes?: number
  /** Hosts a repository may be read from (default `github.com`): known forges only. */
  hosts?: string[]
}

/**
 * Test seams, for this package's own tests only: not exported from the package, and no other
 * source file may name them (scripts/architecture.spec.ts). Production reads go through
 * {@link snapshotRepository}, which has no way to pass them.
 */
export interface SnapshotTesting {
  /** Accept a `file://` repository, with no host checks. */
  allowLocal?: boolean
  /** How a host resolves (default DNS). */
  resolve?: (host: string) => Promise<string[]>
  /** The whole snapshot's deadline (default 120 s). */
  deadlineMs?: number
}

export interface SnapshotFile {
  path: string
  /** The blob's git id at the commit. */
  sha: string
  bytes: number
  text: string
}

export type UnreadReason = 'bounds' | 'too-large' | 'binary' | 'lockfile' | 'not-selected' | 'path-too-long'

export interface RepositorySnapshot {
  url: string
  commit: string
  /** How the commit was chosen: a full SHA the caller named (on GitHub it may come from a fork of the repository), or a ref resolved to it. */
  pinnedBy: 'sha' | 'ref'
  files: SnapshotFile[]
  /** Every file of the tree that was not read, with why. */
  unread: Array<{ path: string; why: UnreadReason }>
}

/** A refused or failed snapshot: what the caller can tell its caller. */
export class SnapshotError extends Error {
  /** Only `unavailable` (the network, the host) may pass by retrying. */
  constructor(readonly kind: 'invalid_input' | 'overloaded' | 'unavailable' | 'config_error', message: string) {
    super(message)
    this.name = 'SnapshotError'
  }
}

/** git 2.37 added `http.curloptResolve`, which pins a connection to the addresses that were checked. */
export const GIT_FLOOR = [2, 37] as const
const CALL_MS = 20_000
/** The fetch brings every blob within the per-file bound in one call: it may take longer. */
const FETCH_MS = 60_000
/** A call with less than this left before the deadline is not started. */
const MIN_CALL_MS = 1_000
const DEADLINE_MS = 120_000
/** What one git call may print (a listing larger than this is too large to review). */
const MAX_OUTPUT = 64 * 1024 * 1024
const MAX_ENTRIES = 50_000
const MAX_PATH = 1000
const MAX_TERMS = 50
const MAX_FOCUS = 20
const MAX_WILDCARDS = 8
const MAX_SEGMENTS = 16
/**
 * Steps the focus globs may take over the whole tree, so a pathological pattern cannot stall the
 * daemon: 20 patterns such as `**\/*auth*` over 50,000 ordinary paths take well under it.
 */
export const GLOB_BUDGET = 200_000_000

/**
 * The git options that pin every connection to `host` to the addresses checked before it, so git
 * cannot resolve the host again to another (DNS rebinding).
 */
export function pinnedTo(host: string, addresses: readonly string[]): string[] {
  return ['-c', `http.curloptResolve=${host}:443:${addresses.map((a) => (isIP(a) === 6 ? `[${a}]` : a)).join(',')}`]
}

interface Git {
  run(args: string[], options?: { input?: string; noLazyFetch?: boolean; callMs?: number }): Promise<Buffer>
}

/** A git failure that carries its exit code and the start of what it said. */
class GitFailed extends Error {
  constructor(readonly code: number | null, readonly stderr: string) {
    super(`git exited ${code}: ${stderr.slice(0, 300)}`)
  }
}

/**
 * A git confined to `dir` (an empty bare repository): no user, system, or ambient repository
 * config; https only (and file, for tests); no hooks, credentials, prompts, redirects, or ssh.
 * Each call is bounded by `CALL_MS` and by the deadline; a stopped call kills its process group,
 * so a lazy fetch it started stops too.
 */
function confinedGit(dir: string, pin: string[], allowFile: boolean, deadline: number, signal: AbortSignal | undefined): Git {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_SSH_COMMAND: '/bin/false',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: join(dir, '..'),
  }
  const safe = [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.sshCommand=/bin/false', '-c', 'credential.helper=',
    '-c', 'http.followRedirects=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', ...(allowFile ? ['-c', 'protocol.file.allow=always'] : []),
  ]
  return {
    run: (args, options = {}) => new Promise((resolve, reject) => {
      const left = deadline - Date.now()
      if (left < MIN_CALL_MS) return reject(new SnapshotError('unavailable', 'the repository read ran past its deadline'))
      const limit = Math.min(options.callMs ?? CALL_MS, left)
      if (signal?.aborted) return reject(new SnapshotError('unavailable', 'the repository read was stopped'))
      const child = spawn('git', [...safe, ...pin, ...args], { cwd: dir, env: { ...env, ...(options.noLazyFetch ? { GIT_NO_LAZY_FETCH: '1' } : {}) }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const out: Buffer[] = []
      let size = 0
      let err = ''
      const stop = (): void => {
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          // already gone
        }
      }
      const timer = setTimeout(() => {
        stop()
        reject(new SnapshotError('unavailable', `git ${args[0]} took longer than ${Math.round(limit / 1000)} s`))
      }, limit)
      const onAbort = (): void => {
        stop()
        reject(new SnapshotError('unavailable', 'the repository read was stopped'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_OUTPUT) {
          stop()
          reject(new SnapshotError('overloaded', `git ${args[0]} printed more than ${MAX_OUTPUT / 1024 / 1024} MB: the repository is too large to review`))
          return
        }
        out.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        if (err.length < 4000) err += chunk.toString('utf8')
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        done()
        reject(error.code === 'ENOENT' ? new SnapshotError('config_error', 'git is not installed: a repository review needs it') : error)
      })
      child.on('close', (code) => {
        done()
        if (code === 0) resolve(Buffer.concat(out))
        else reject(new GitFailed(code, err))
      })
      // A stopped git closes its input while it is still written: the close above has rejected already.
      child.stdin.on('error', () => undefined)
      child.stdin.end(options.input ?? '')
    }),
  }
}

/** An IPv4 address as a number, or undefined. */
function v4(address: string): number | undefined {
  const parts = address.split('.')
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return undefined
  return parts.reduce((n, p) => n * 256 + Number(p), 0)
}

/** Non-public IPv4 ranges: this network, private, CGNAT, loopback, link-local, protocol, documentation, benchmarking, multicast, reserved. */
const V4_RANGES = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const

/** An IPv6 address as eight 16-bit groups, or undefined. */
function v6(address: string): number[] | undefined {
  let text = address.toLowerCase().split('%')[0]!
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (tail) {
    const n = v4(tail[1]!)
    if (n === undefined) return undefined
    text = `${text.slice(0, -tail[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, rest] = text.split('::') as [string, string | undefined]
  const groups = (s: string): number[] => (s ? s.split(':').map((g) => parseInt(g, 16)) : [])
  const a = groups(head)
  const b = rest === undefined ? [] : groups(rest)
  const all = rest === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill(0), ...b]
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : undefined
}

/** Whether an address is not on the public internet (refused before git connects). */
export function isPrivateAddress(address: string): boolean {
  const n = v4(address)
  if (n !== undefined) return V4_RANGES.some(([base, bits]) => (n >>> (32 - bits)) === (v4(base)! >>> (32 - bits)))
  const g = v6(address)
  if (!g) return true
  if (g.slice(0, 6).every((x) => x === 0)) return true // ::, ::1, and the deprecated IPv4-compatible block (::/96)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPrivateAddress(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`) // mapped v4
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true // SIIT translated v4 (::ffff:0:0/96)
  if ((g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xffc0) === 0xfec0 || (g[0]! & 0xff00) === 0xff00) return true // unique local, link-local, site-local, multicast
  if (g[0] === 0x2001 && g[1] === 0) return true // Teredo: it embeds any v4
  if (g[0] === 0x64 && g[1] === 0xff9b) return true // NAT64: it embeds any v4
  if (g[0] === 0x2002) return true // 6to4: it embeds any v4
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true // documentation
  return false
}

/** True when the text holds a control character, whitespace, or a backslash: never in a repository URL. */
const unsafe = (text: string): boolean => [...text].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === '\\')

/**
 * The canonical URL git is given, rebuilt from checked parts: https on an allowed host (port
 * 443), no credentials, query, or fragment, and a path `/<owner>/<repo>[.git]`. The URL must be
 * exactly its own parse, so a form one parser reads one way and git another is refused. Returns
 * the URL and the git options that pin git to the addresses checked.
 */
async function canonicalUrl(url: string, bounds: SnapshotBounds, testing: SnapshotTesting): Promise<{ href: string; pin: string[] }> {
  if (testing.allowLocal && url.startsWith('file:///')) return { href: url, pin: [] }
  if (url.length > 500 || unsafe(url)) throw new SnapshotError('invalid_input', 'a repository URL has no spaces, control characters, or backslashes')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SnapshotError('invalid_input', `${url} is not a URL`)
  }
  if (parsed.protocol !== 'https:') throw new SnapshotError('invalid_input', 'a repository is read over https only')
  if (parsed.username || parsed.password) throw new SnapshotError('invalid_input', 'a repository URL carries no credentials: only public repositories are read')
  if (parsed.port) throw new SnapshotError('invalid_input', 'a repository is read on the https port only')
  if (parsed.search || parsed.hash || url.includes('?') || url.includes('#')) throw new SnapshotError('invalid_input', 'a repository URL has no query or fragment')
  if (!/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?(\.git)?\/?$/.test(parsed.pathname) || /(^|\/)\.\.?(\/|$)/.test(parsed.pathname)) {
    throw new SnapshotError('invalid_input', 'a repository URL is https://<host>/<owner>/<repo>')
  }
  // Only the scheme's and host's case and the default port may differ from the parse.
  const plain = /^https:\/\/([A-Za-z0-9.-]+)(?::443)?(\/.*)$/i.exec(url)
  if (!plain || `https://${plain[1]!.toLowerCase()}${plain[2]}` !== parsed.href) throw new SnapshotError('invalid_input', `${url} is not in its canonical form (${parsed.href})`)
  const host = parsed.hostname.toLowerCase()
  const hosts = (bounds.hosts ?? ['github.com']).map((h) => h.toLowerCase())
  if (!hosts.includes(host)) throw new SnapshotError('invalid_input', `${host} is not an allowed repository host (allowed: ${hosts.join(', ')})`)
  if (isIP(host)) throw new SnapshotError('invalid_input', 'a repository host is named, not an address')
  const resolve = testing.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address))
  const addresses = await resolve(host).catch(() => [])
  if (!addresses.length) throw new SnapshotError('unavailable', `${host} does not resolve`)
  if (addresses.some(isPrivateAddress)) throw new SnapshotError('invalid_input', `${host} resolves to a non-public address`)
  return { href: `https://${host}${parsed.pathname}`, pin: pinnedTo(host, addresses) }
}

const SKIPPED_DIRS = /(^|\/)(node_modules|vendor|dist|build|out|target|coverage|\.next|\.git|third_party)\//
const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock)$/
const MANIFESTS = /^(package\.json|pyproject\.toml|setup\.py|setup\.cfg|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|CMakeLists\.txt|Makefile|deno\.json)$/
const ENTRY = /^(src\/)?(index|main|lib|app|__main__|cli)\.[a-z]+$|^cmd\/[^/]+\/main\.go$/
const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$/
const stem = (path: string): string => path.split('/').pop()!.replace(/\.(test|spec)(?=\.)/, '').replace(/^test_/, '').replace(/_test(?=\.go$)/, '').replace(/\.[^.]+$/, '').toLowerCase()

/** Steps a glob match may still take; past them the focus is too costly for the tree. */
export interface GlobBudget {
  left: number
}

const spend = (budget: GlobBudget | undefined, steps: number): void => {
  if (budget && (budget.left -= steps) < 0) throw new SnapshotError('overloaded', 'the focus patterns are too costly to match against this tree: narrow them')
}

/** One path segment against one pattern segment: `*` is any run of characters (no exponential backtracking). */
function segmentMatches(pattern: string, text: string, budget?: GlobBudget): boolean {
  let p = 0
  let t = 0
  let star = -1
  let mark = 0
  while (t < text.length) {
    spend(budget, 1)
    if (p < pattern.length && pattern[p] === text[t]) {
      p++
      t++
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++
      mark = t
    } else if (star >= 0) {
      p = star + 1
      t = ++mark
    } else return false
  }
  while (p < pattern.length && pattern[p] === '*') p++
  return p === pattern.length
}

/**
 * Whether `path` is under `pattern`: `*` within a segment, `**` across any segments, a path or a
 * directory prefix otherwise. Segment by segment, so it is O(pattern × path) and never backtracks;
 * a `budget` bounds the steps over many calls.
 */
export function globMatches(pattern: string, path: string, budget?: GlobBudget): boolean {
  const parts = pattern.replace(/^\.?\//, '').split('/').filter((s, i, all) => s !== '' || i === all.length - 1)
    .map((s) => (/^\*{2,}$/.test(s) ? '**' : s.replace(/\*+/g, '*')))
    .filter((s, i, all) => !(s === '**' && all[i - 1] === '**'))
  // A pattern names a path or everything under it.
  if (parts.at(-1) === '') parts.pop()
  if (parts.at(-1) !== '**') parts.push('**')
  const segs = path.split('/')
  const memo = new Map<number, boolean>()
  const at = (i: number, j: number): boolean => {
    const key = i * (segs.length + 1) + j
    const known = memo.get(key)
    if (known !== undefined) return known
    spend(budget, 1)
    let ok: boolean
    if (i === parts.length) ok = j === segs.length
    else if (parts[i] === '**') ok = at(i + 1, j) || (j < segs.length && at(i, j + 1))
    else ok = j < segs.length && segmentMatches(parts[i]!, segs[j]!, budget) && at(i + 1, j + 1)
    memo.set(key, ok)
    return ok
  }
  return at(0, 0)
}

/** A focus pattern within its bounds: at most 500 characters, 8 wildcards, and 16 segments. */
function checkFocus(focus: readonly string[]): void {
  if (focus.length > MAX_FOCUS) throw new SnapshotError('invalid_input', `at most ${MAX_FOCUS} focus patterns`)
  for (const f of focus) {
    if (f.length > 500 || (f.match(/\*/g)?.length ?? 0) > MAX_WILDCARDS || f.split('/').length > MAX_SEGMENTS) {
      throw new SnapshotError('invalid_input', `a focus pattern has at most 500 characters, ${MAX_WILDCARDS} wildcards, and ${MAX_SEGMENTS} segments`)
    }
  }
}

interface Entry {
  path: string
  sha: string
  /** Undefined when the blob was not downloaded: larger than the per-file bound. */
  bytes: number | undefined
}

/**
 * The order files are read in, until the bounds: the root README, manifests, entry points, the
 * focus (paths or globs, else the request's words in a path), then tests beside what was chosen.
 * Within a class, shorter paths first, then smaller files. Terms are deduplicated and capped.
 */
export function selectFiles(entries: Entry[], request: Pick<SnapshotRequest, 'focus' | 'terms'>, entryPoints: string[] = [], globBudget = GLOB_BUDGET): Entry[] {
  const candidates = entries.filter((e) => !SKIPPED_DIRS.test(e.path) && !LOCKFILES.test(e.path))
  const lower = new Map(candidates.map((e) => [e, e.path.toLowerCase()]))
  const order = (list: Entry[]): Entry[] => [...list].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.length - b.path.length
    || (a.bytes ?? Infinity) - (b.bytes ?? Infinity) || (a.path < b.path ? -1 : 1))
  const focus = request.focus ?? []
  const terms = [...new Set((request.terms ?? []).map((t) => t.toLowerCase()).filter((t) => t.length >= 4))].slice(0, MAX_TERMS)
  const named = new Set(entryPoints.map((p) => p.replace(/^\.\//, '')))
  const budget: GlobBudget = { left: globBudget }
  const classes = [
    candidates.filter((e) => /^readme(\.[a-z]+)?$/i.test(e.path)),
    candidates.filter((e) => MANIFESTS.test(e.path) || (e.path.split('/').length === 2 && /\/(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(e.path))),
    candidates.filter((e) => named.has(e.path) || ENTRY.test(e.path)),
    candidates.filter((e) => !TEST.test(e.path) && (focus.length ? focus.some((f) => globMatches(f, e.path, budget)) : terms.some((t) => lower.get(e)!.includes(t)))),
  ]
  const chosen = new Set<Entry>()
  for (const list of classes) for (const e of order(list)) chosen.add(e)
  const stems = new Set([...chosen].map((e) => stem(e.path)))
  for (const e of order(candidates.filter((c) => TEST.test(c.path) && stems.has(stem(c.path))))) chosen.add(e)
  return [...chosen]
}

/** The commit a ref names, by git's own precedence: a tag (its peeled commit when annotated), then a branch. */
function commitOf(listed: string[], ref: string | undefined): string | undefined {
  const line = (name: string): string | undefined => listed.find((l) => l.endsWith(`\t${name}`))
  const found = ref ? line(`refs/tags/${ref}^{}`) ?? line(`refs/tags/${ref}`) ?? line(`refs/heads/${ref}`) : line('HEAD')
  return found?.split('\t')[0]
}

/**
 * Snapshot a public repository at one commit: resolve the ref, fetch the commit with only blobs
 * within the per-file bound, choose the files in a fixed order, and read only those, within the
 * bounds. Every file not read is listed with why. Throws {@link SnapshotError}. It takes no test
 * seam: a `file://` repository or a fake resolver cannot reach it, even as an extra argument.
 */
export function snapshotRepository(request: SnapshotRequest, bounds: SnapshotBounds = {}, signal?: AbortSignal): Promise<RepositorySnapshot> {
  return snapshotWithTestSeams(request, bounds, signal, {})
}

/** {@link snapshotRepository} with this package's test seams: for its own tests only (see {@link SnapshotTesting}). */
export async function snapshotWithTestSeams(request: SnapshotRequest, bounds: SnapshotBounds, signal: AbortSignal | undefined, testing: SnapshotTesting): Promise<RepositorySnapshot> {
  const limits = { maxFiles: bounds.maxFiles ?? 40, maxBytes: bounds.maxBytes ?? 300_000, maxFileBytes: bounds.maxFileBytes ?? 48_000 }
  if (request.ref !== undefined && (!/^[A-Za-z0-9._/-]{1,200}$/.test(request.ref) || request.ref.startsWith('-') || request.ref.includes('..'))) {
    throw new SnapshotError('invalid_input', 'a ref is a branch, a tag, or a commit SHA')
  }
  checkFocus(request.focus ?? [])
  const { href, pin } = await canonicalUrl(request.url, bounds, testing)
  const deadline = Date.now() + (testing.deadlineMs ?? DEADLINE_MS)
  const base = await mkdtemp(join(tmpdir(), 'system-repo-'))
  const dir = join(base, 'repo.git')
  let failure: unknown
  try {
    // Every call runs in an empty bare repository of its own, so no ambient config is read.
    await confinedGit(base, [], false, deadline, signal).run(['init', '-q', '--bare', dir])
    const git = confinedGit(dir, pin, !!testing.allowLocal, deadline, signal)
    const version = /(\d+)\.(\d+)/.exec((await git.run(['--version'])).toString('utf8'))
    const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0]
    if (major < GIT_FLOOR[0] || (major === GIT_FLOOR[0] && minor < GIT_FLOOR[1])) {
      throw new SnapshotError('config_error', `git ${major}.${minor} cannot pin a connection to a checked address; ${GIT_FLOOR.join('.')} or later is needed`)
    }
    const pinnedBy = request.ref && /^[0-9a-f]{40}$/.test(request.ref) ? 'sha' : 'ref'
    let commit = pinnedBy === 'sha' ? request.ref! : undefined
    if (!commit) {
      const patterns = request.ref ? [`refs/tags/${request.ref}`, `refs/tags/${request.ref}^{}`, `refs/heads/${request.ref}`] : ['HEAD']
      const listed = (await git.run(['ls-remote', href, ...patterns]).catch((error: unknown) => {
        if (error instanceof GitFailed && /not found|does not exist|not appear to be a git repository|could not read Username/i.test(error.stderr)) {
          throw new SnapshotError('invalid_input', `${href} is not a public git repository`)
        }
        throw error instanceof SnapshotError ? error : new SnapshotError('unavailable', `${href} cannot be read now`)
      })).toString('utf8').trim().split('\n').filter(Boolean)
      commit = commitOf(listed, request.ref)
      if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new SnapshotError('invalid_input', `${href} has no ref ${request.ref ?? 'HEAD'}`)
    }
    await git.run(['remote', 'add', 'origin', href])
    // Only blobs within the per-file bound come down; a larger one is never downloaded.
    // `blob:limit=n` leaves out blobs of n bytes or more: a file of exactly the bound is still read.
    await git.run(['fetch', '-q', '--no-tags', '--depth', '1', `--filter=blob:limit=${limits.maxFileBytes + 1}`, 'origin', commit], { callMs: FETCH_MS }).catch((error: unknown) => {
      throw error instanceof SnapshotError ? error : new SnapshotError('unavailable', `commit ${commit} of ${href} cannot be fetched`)
    })
    const listing = (await git.run(['ls-tree', '-r', '-z', '--full-tree', commit], { noLazyFetch: true })).toString('utf8').split('\0').filter(Boolean)
    if (listing.length > MAX_ENTRIES) throw new SnapshotError('overloaded', `${href} has ${listing.length} files; at most ${MAX_ENTRIES} are listed`)
    const blobs = listing.flatMap((line) => {
      const tab = line.indexOf('\t')
      const [, type, sha] = line.slice(0, tab).split(' ') as [string, string, string]
      return type === 'blob' ? [{ path: line.slice(tab + 1), sha }] : []
    })
    // What came down, and its size, without fetching what did not (a missing blob is too large).
    const missing = new Set((await git.run(['rev-list', '--objects', '--missing=print', commit], { noLazyFetch: true })).toString('utf8')
      .split('\n').filter((l) => l.startsWith('?')).map((l) => l.slice(1).trim()))
    const present = [...new Set(blobs.map((b) => b.sha).filter((sha) => !missing.has(sha)))]
    const sizes = new Map((present.length ? (await git.run(['cat-file', '--batch-check=%(objectname) %(objectsize)'], { input: `${present.join('\n')}\n`, noLazyFetch: true })).toString('utf8') : '')
      .split('\n').filter(Boolean).map((l) => l.split(' ') as [string, string]).map(([sha, size]) => [sha, Number(size)] as const))
    const why = new Map<string, UnreadReason>()
    const entries: Entry[] = blobs.flatMap((b) => {
      if (b.path.length > MAX_PATH) {
        why.set(b.path, 'path-too-long')
        return []
      }
      return [{ path: b.path, sha: b.sha, bytes: sizes.get(b.sha) }]
    })
    const read = async (shas: string[]): Promise<Map<string, Buffer>> => {
      if (!shas.length) return new Map()
      const raw = await git.run(['cat-file', '--batch'], { input: `${shas.join('\n')}\n`, noLazyFetch: true })
      const bodies = new Map<string, Buffer>()
      for (let at = 0; at < raw.length;) {
        const eol = raw.indexOf(10, at)
        const [sha, , size] = raw.subarray(at, eol).toString('utf8').split(' ') as [string, string, string]
        const n = Number(size)
        bodies.set(sha, raw.subarray(eol + 1, eol + 1 + n))
        at = eol + 1 + n + 1
      }
      return bodies
    }
    // A package manifest at the root names its entry points.
    const manifest = entries.find((e) => e.path === 'package.json' && e.bytes !== undefined)
    const entryPoints = manifest ? packageEntries((await read([manifest.sha])).get(manifest.sha)?.toString('utf8') ?? '') : []
    const chosen: Entry[] = []
    let total = 0
    for (const e of selectFiles(entries, request, entryPoints)) {
      if (chosen.length >= limits.maxFiles) why.set(e.path, 'bounds')
      else if (e.bytes === undefined || e.bytes > limits.maxFileBytes) why.set(e.path, 'too-large')
      else if (total + e.bytes > limits.maxBytes) why.set(e.path, 'bounds')
      else {
        chosen.push(e)
        total += e.bytes
      }
    }
    const bodies = await read([...new Set(chosen.map((e) => e.sha))])
    const files: SnapshotFile[] = []
    for (const e of chosen) {
      const body = bodies.get(e.sha)
      if (!body || body.includes(0)) {
        why.set(e.path, 'binary')
        continue
      }
      files.push({ path: e.path, sha: e.sha, bytes: body.length, text: body.toString('utf8') })
    }
    const readPaths = new Set(files.map((f) => f.path))
    const unread = blobs.filter((b) => !readPaths.has(b.path)).map((b) => ({
      path: b.path.length > MAX_PATH ? `${b.path.slice(0, MAX_PATH - 1)}…` : b.path,
      why: why.get(b.path) ?? (LOCKFILES.test(b.path) ? 'lockfile' as const : 'not-selected' as const),
    }))
    return { url: href, commit, pinnedBy, files, unread }
  } catch (error) {
    failure = error
    throw error instanceof SnapshotError ? error : new SnapshotError('unavailable', `the repository could not be read: ${(error as Error).message.slice(0, 200)}`)
  } finally {
    // A stopped git's children may still be writing: retry the removal, and never mask the failure.
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error: unknown) => {
      if (!failure) throw error
    })
  }
}

/** The files a package.json names as its entry points (`main`, `module`, `bin`, `exports`), relative to the root. */
function packageEntries(text: string): string[] {
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>
    const out = new Set<string>()
    const add = (v: unknown): void => {
      if (typeof v === 'string') out.add(v.replace(/^\.\//, ''))
      else if (v && typeof v === 'object') for (const x of Object.values(v)) add(x)
    }
    add(pkg.main)
    add(pkg.module)
    add(pkg.bin)
    add(pkg.exports)
    return [...out]
  } catch {
    return []
  }
}
