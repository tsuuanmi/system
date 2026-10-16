/**
 * Public repository snapshots (PROP-0004 Phase 4): the files a team reviews, read at one pinned
 * commit by `system` itself, so no member browses the repository and every quote can be checked
 * against the bytes the members saw. A confined, read-only probe like `subjects.ts`: fixed `git`
 * argument lists, no shell, no hooks, no credentials, bounded time, files, and bytes (INV-9).
 */
import { execFile } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SnapshotRequest {
  /** An `https://` URL of a public repository (no credentials in it). */
  url: string
  /** A branch, a tag, or a full commit SHA (default: the remote's HEAD). */
  ref?: string
  /** Paths or globs to review first; otherwise words matched against paths. */
  focus?: string[]
  /** Words from the review request, matched against paths when no `focus` is given. */
  terms?: string[]
}

export interface SnapshotBounds {
  /** Files read (default 40). */
  maxFiles?: number
  /** Bytes of text read in all (default 300 KB). */
  maxBytes?: number
  /** A larger file is listed as unread (default 48 KB). */
  maxFileBytes?: number
  /** A tree with more entries is refused (default 50 000). */
  maxEntries?: number
  /** Each git call (default 20 s). */
  timeoutMs?: number
  /** Hosts a repository may be read from (default `github.com`): known forges only. */
  hosts?: string[]
  /** Tests only: accept a `file://` URL and local hosts. */
  allowLocal?: boolean
  /** Tests only: how a host resolves (default DNS). */
  resolve?: (host: string) => Promise<string[]>
}

export interface SnapshotFile {
  path: string
  /** The blob's git id at the commit. */
  sha: string
  bytes: number
  text: string
}

export type UnreadReason = 'bounds' | 'too-large' | 'binary' | 'lockfile' | 'not-selected'

export interface RepositorySnapshot {
  url: string
  commit: string
  files: SnapshotFile[]
  /** Every file of the tree that was not read, with why. */
  unread: Array<{ path: string; why: UnreadReason }>
}

/** A refused or failed snapshot: what the caller can tell its caller. */
export class SnapshotError extends Error {
  /** `invalid_input` and `config_error` cannot pass by retrying; `unavailable` (the network, the host) may. */
  constructor(readonly kind: 'invalid_input' | 'overloaded' | 'unavailable' | 'config_error', message: string) {
    super(message)
    this.name = 'SnapshotError'
  }
}

/** git 2.37 added `http.curloptResolve`, which pins a connection to the address that was checked. */
export const GIT_FLOOR = [2, 37] as const

const ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '/bin/false', LC_ALL: 'C', HOME: '/nonexistent' }
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=user', '-c', 'credential.helper=', '-c', 'http.followRedirects=false']

/**
 * The git options that pin every connection to `host` to the address checked before it, so git
 * cannot resolve the host again to another (DNS rebinding).
 */
export function pinnedTo(host: string, address: string): string[] {
  return ['-c', `http.curloptResolve=${host}:443:${isIP(address) === 6 ? `[${address}]` : address}`]
}

function git(args: string[], timeoutMs: number, cwd?: string, pin: string[] = []): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE, ...pin, ...(cwd ? ['-C', cwd] : []), ...args], { env: ENV, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./]
const isPrivate = (address: string): boolean => (isIP(address) === 6
  ? /^(::1|::|fc|fd|fe80)/i.test(address) || /^::ffff:/i.test(address) && isPrivate(address.replace(/^::ffff:/i, ''))
  : PRIVATE_V4.some((range) => range.test(address)))

/**
 * The URL is https on an allowed host, with no credentials, and the host resolves to public
 * addresses only. Returns the git options that pin git to the address checked.
 */
async function checkUrl(url: string, bounds: SnapshotBounds): Promise<string[]> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SnapshotError('invalid_input', `${url} is not a URL`)
  }
  if (bounds.allowLocal && parsed.protocol === 'file:') return []
  if (parsed.protocol !== 'https:') throw new SnapshotError('invalid_input', 'a repository is read over https only')
  if (parsed.username || parsed.password) throw new SnapshotError('invalid_input', 'a repository URL carries no credentials: only public repositories are read')
  if (parsed.port && parsed.port !== '443') throw new SnapshotError('invalid_input', 'a repository is read on the https port only')
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const hosts = bounds.hosts ?? ['github.com']
  if (!hosts.includes(host)) throw new SnapshotError('invalid_input', `${host} is not an allowed repository host (allowed: ${hosts.join(', ')})`)
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new SnapshotError('invalid_input', `${host} is not a public host`)
  const resolve = bounds.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((a) => a.address))
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [])
  if (!addresses.length) throw new SnapshotError('unavailable', `${host} does not resolve`)
  if (addresses.some(isPrivate)) throw new SnapshotError('invalid_input', `${host} resolves to a private address`)
  return isIP(host) ? [] : pinnedTo(host, addresses[0]!)
}

/** Fail closed on a git older than the floor: it could not be pinned to the checked address. */
async function checkGit(timeoutMs: number): Promise<void> {
  const version = /(\d+)\.(\d+)/.exec((await git(['--version'], timeoutMs)).toString('utf8'))
  const [major, minor] = version ? [Number(version[1]), Number(version[2])] : [0, 0]
  if (major < GIT_FLOOR[0] || (major === GIT_FLOOR[0] && minor < GIT_FLOOR[1])) {
    throw new SnapshotError('config_error', `git ${major}.${minor} cannot pin a connection to a checked address; ${GIT_FLOOR.join('.')} or later is needed`)
  }
}

const SKIPPED_DIRS = /(^|\/)(node_modules|vendor|dist|build|out|target|coverage|\.next|\.git|third_party)\//
const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock)$/
const MANIFESTS = /^(package\.json|pyproject\.toml|setup\.py|setup\.cfg|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|Gemfile|composer\.json|CMakeLists\.txt|Makefile|deno\.json)$/
const ENTRY = /^(src\/)?(index|main|lib|app|__main__|cli)\.[a-z]+$|^cmd\/[^/]+\/main\.go$/
const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$/
const stem = (path: string): string => path.split('/').pop()!.replace(/\.(test|spec)(?=\.)/, '').replace(/^test_/, '').replace(/_test(?=\.go$)/, '').replace(/\.[^.]+$/, '').toLowerCase()

/** `*` within a segment, `**` across segments; anything else literal. */
function glob(pattern: string): RegExp {
  const body = pattern.replace(/^\.?\//, '').split(/(\*\*\/?|\*)/).map((part) => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(`^${body}${pattern.endsWith('/') ? '.*' : '(?:/.*)?'}$`)
}

interface Entry {
  path: string
  sha: string
  bytes: number
}

/**
 * The order files are read in, until the bounds: the root README, manifests, entry points, the
 * focus (paths or globs, else the request's words in a path), then tests beside what was chosen.
 * Within a class, shorter paths first, then smaller files.
 */
export function selectFiles(entries: Entry[], request: Pick<SnapshotRequest, 'focus' | 'terms'>, entryPoints: string[] = []): Entry[] {
  const candidates = entries.filter((e) => !SKIPPED_DIRS.test(e.path) && !LOCKFILES.test(e.path))
  const order = (list: Entry[]): Entry[] => [...list].sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.length - b.path.length || a.bytes - b.bytes || (a.path < b.path ? -1 : 1))
  const focus = (request.focus ?? []).map(glob)
  const terms = (request.terms ?? []).map((t) => t.toLowerCase()).filter((t) => t.length >= 4)
  const named = new Set(entryPoints.map((p) => p.replace(/^\.\//, '')))
  const classes = [
    candidates.filter((e) => /^readme(\.[a-z]+)?$/i.test(e.path)),
    candidates.filter((e) => MANIFESTS.test(e.path) || (e.path.split('/').length === 2 && /\/(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(e.path))),
    candidates.filter((e) => named.has(e.path) || ENTRY.test(e.path)),
    candidates.filter((e) => !TEST.test(e.path) && (focus.length ? focus.some((f) => f.test(e.path)) : terms.some((t) => e.path.toLowerCase().includes(t)))),
  ]
  const chosen: Entry[] = []
  for (const list of classes) for (const e of order(list)) if (!chosen.includes(e)) chosen.push(e)
  const stems = new Set(chosen.map((e) => stem(e.path)))
  for (const e of order(candidates.filter((c) => TEST.test(c.path) && stems.has(stem(c.path))))) if (!chosen.includes(e)) chosen.push(e)
  return chosen
}

/**
 * Snapshot a public repository at one commit: resolve the ref, fetch the commit's tree without
 * its blobs, choose the files in a fixed order, and read only those, within the bounds. Every file
 * not read is listed with why. Throws {@link SnapshotError}.
 */
export async function snapshotRepository(request: SnapshotRequest, bounds: SnapshotBounds = {}): Promise<RepositorySnapshot> {
  const limits = { maxFiles: 40, maxBytes: 300_000, maxFileBytes: 48_000, maxEntries: 50_000, timeoutMs: 20_000, ...bounds }
  await checkGit(limits.timeoutMs)
  const pin = await checkUrl(request.url, bounds)
  if (request.ref !== undefined && !/^[A-Za-z0-9._/-]{1,200}$/.test(request.ref)) throw new SnapshotError('invalid_input', 'a ref is a branch, a tag, or a commit SHA')
  const dir = await mkdtemp(join(tmpdir(), 'system-repo-'))
  try {
    let commit = request.ref && /^[0-9a-f]{40}$/.test(request.ref) ? request.ref : undefined
    if (!commit) {
      const patterns = request.ref ? [request.ref, `${request.ref}^{}`] : ['HEAD']
      const listed = (await git(['ls-remote', request.url, ...patterns], limits.timeoutMs, undefined, pin).catch(() => {
        throw new SnapshotError('unavailable', `${request.url} cannot be read: it is not a public git repository, or it is unreachable`)
      })).toString('utf8').trim().split('\n').filter(Boolean)
      // An annotated tag is listed twice; its peeled line (`^{}`) names the commit.
      const named = (suffix: string): string | undefined => listed.find((line) => line.endsWith(`\trefs/tags/${request.ref}${suffix}`) || line.endsWith(`\trefs/heads/${request.ref}${suffix}`))
      const exact = request.ref ? named('^{}') ?? named('') : listed.find((line) => line.endsWith('\tHEAD'))
      commit = exact?.split('\t')[0]
      if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new SnapshotError('invalid_input', `${request.url} has no ref ${request.ref ?? 'HEAD'}`)
    }
    await git(['init', '-q', '--bare', dir], limits.timeoutMs)
    await git(['remote', 'add', 'origin', request.url], limits.timeoutMs, dir)
    await git(['fetch', '-q', '--no-tags', '--depth', '1', '--filter=blob:none', 'origin', commit], limits.timeoutMs * 3, dir, pin).catch(() => {
      throw new SnapshotError('unavailable', `commit ${commit} of ${request.url} cannot be fetched`)
    })
    const tree = (await git(['ls-tree', '-r', '-l', '--full-tree', commit], limits.timeoutMs, dir)).toString('utf8').split('\n').filter(Boolean)
    if (tree.length > limits.maxEntries) throw new SnapshotError('overloaded', `${request.url} has ${tree.length} files; at most ${limits.maxEntries} are listed`)
    const entries: Entry[] = tree.flatMap((line) => {
      const [meta, path] = line.split('\t') as [string, string]
      const [, type, sha, size] = meta.split(/\s+/) as [string, string, string, string]
      return type === 'blob' ? [{ path, sha, bytes: Number(size) }] : []
    })
    // A blob is fetched on demand from the same remote: pinned too.
    const read = async (sha: string): Promise<Buffer> => git(['cat-file', 'blob', sha], limits.timeoutMs, dir, pin)
    // A package manifest at the root names its entry points.
    const manifest = entries.find((e) => e.path === 'package.json' && e.bytes <= limits.maxFileBytes)
    const entryPoints = manifest ? packageEntries((await read(manifest.sha)).toString('utf8')) : []
    const files: SnapshotFile[] = []
    const why = new Map<string, UnreadReason>()
    let total = 0
    for (const e of selectFiles(entries, request, entryPoints)) {
      if (files.length >= limits.maxFiles) {
        why.set(e.path, 'bounds')
        continue
      }
      if (e.bytes > limits.maxFileBytes) {
        why.set(e.path, 'too-large')
        continue
      }
      if (total + e.bytes > limits.maxBytes) {
        why.set(e.path, 'bounds')
        continue
      }
      const body = await read(e.sha)
      if (body.includes(0)) {
        why.set(e.path, 'binary')
        continue
      }
      files.push({ path: e.path, sha: e.sha, bytes: body.length, text: body.toString('utf8') })
      total += body.length
    }
    const readPaths = new Set(files.map((f) => f.path))
    const unread = entries.filter((e) => !readPaths.has(e.path)).map((e) => ({ path: e.path, why: why.get(e.path) ?? (LOCKFILES.test(e.path) ? 'lockfile' as const : 'not-selected' as const) }))
    return { url: request.url, commit, files, unread }
  } finally {
    await rm(dir, { recursive: true, force: true })
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
