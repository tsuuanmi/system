/**
 * A worktree's dependencies as its setup installed them (T235): the files that say what a setup's
 * install installs (each package's `package.json`, the lockfile, the workspace file), read as the
 * worktree holds them, so a result that changes any of them has its worktree set up again before its
 * checks run (./setup.ts `refresh`). And what an offline install that needed the network said it
 * lacked, so it fails at once as `dependency_unavailable`, naming the packages, never waits.
 * @module @tsuuanmi/system-agent-workers/dependencies
 */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { dependencyPaths } from './worktrees.ts'

/** The dependency files a setup watches when its `dependencyFiles` names none: pnpm's manifests, lockfile, workspace, and settings. */
export const DEFAULT_DEPENDENCY_FILES: readonly string[] = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs']

/** A file read for its hash at most; past it, its size and change time stand for it. */
const HASHED_BYTES = 256 * 1024 * 1024
/** The per-file hashes a setup's decision keeps at most; past it, only the digest. */
export const KEPT_FILES = 500

/** The dependency files of a worktree: each path's hash (`gone`, `link:<target>`, or `other` for what is not a file), and one digest of them all. */
export interface Dependencies {
  digest: string
  files: Record<string, string>
}

/**
 * The dependency files of the worktree at `path` (its real path; git pointed at `gitdir`): every file
 * named one of `names`, tracked or untracked and not ignored, each read as itself, never through a
 * link. Throws when git cannot list them.
 */
export async function dependenciesOf(path: string, gitdir: string, names: readonly string[]): Promise<Dependencies> {
  const files: Record<string, string> = {}
  const all = createHash('sha256')
  for (const file of await dependencyPaths(path, gitdir, names)) {
    const hash = fileHash(join(path, file))
    files[file] = hash
    all.update(`${file}\0${hash}\0`)
  }
  return { digest: `sha256:${all.digest('hex')}`, files }
}

/** One file's hash, never followed through a link. */
function fileHash(path: string): string {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'gone'
    if (code === 'ELOOP') {
      try {
        return `link:${readlinkSync(path)}`
      } catch {
        return 'gone'
      }
    }
    return `unreadable:${code ?? 'unknown'}`
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) return 'other'
    if (stat.size > HASHED_BYTES) return `large:${stat.size}:${stat.mtimeMs}`
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null)
      if (!n) break
      hash.update(buffer.subarray(0, n))
    }
    return `sha256:${hash.digest('hex')}`
  } finally {
    closeSync(fd)
  }
}

/** The paths whose hash differs between `before` and `after` (added, changed, or removed), sorted. */
export function changedFiles(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((p) => before[p] !== after[p]).sort()
}

/** pnpm's errors of an install that needed a package it could not get without the network. */
const OFFLINE_TARBALL = /ERR_PNPM_NO_OFFLINE_TARBALL[^\n]*?downloaded from (\S+?)\.?(?=\s|$)/g
const OFFLINE_META = /ERR_PNPM_NO_OFFLINE_META[^\n]*?Failed to resolve (\S+) in package mirror/g
const META_FETCH = /ERR_PNPM_META_FETCH_FAIL[^\n]*?GET (\S+?):?(?=\s|$)/g
const TARBALL_FETCH = /ERR_PNPM_(?:TARBALL_FETCH|FETCH_\d+)[^\n]*?(https?:\/\/\S+?\.tgz)/g
/** A registry the install could not reach, with no package named. */
const UNREACHABLE = /(?:ERR_PNPM_[A-Z_]*(?:FETCH|OFFLINE)[A-Z_]*|EAI_AGAIN|ENOTFOUND|ENETUNREACH)/

/** The package a registry URL names: `name@version` from a tarball's, `name` from a metadata one's, else the URL. */
function packageOf(url: string): string {
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(url).pathname)
  } catch {
    return url
  }
  const tarball = /^\/((?:@[^/]+\/)?([^/]+))\/-\/(?:@[^/]+\/)?([^/]+)\.tgz$/.exec(pathname)
  if (tarball) {
    const [, name, short, file] = tarball as unknown as [string, string, string, string]
    return file.startsWith(`${short}-`) ? `${name}@${file.slice(short.length + 1)}` : name
  }
  const meta = /^\/((?:@[^/]+\/)?[^/]+)\/?$/.exec(pathname)
  return meta ? meta[1]! : url
}

/**
 * What an install's output says it lacked to run without the network: the packages it names (each
 * `name@version` or the spec it could not resolve), at most 20; an empty list when it says a registry
 * was unreachable without naming one; undefined when it says neither (another failure).
 */
export function missingPackages(output: string): string[] | undefined {
  const found = new Set<string>()
  for (const m of output.matchAll(OFFLINE_TARBALL)) found.add(packageOf(m[1]!))
  for (const m of output.matchAll(OFFLINE_META)) found.add(m[1]!)
  for (const m of output.matchAll(META_FETCH)) found.add(packageOf(m[1]!))
  for (const m of output.matchAll(TARBALL_FETCH)) found.add(packageOf(m[1]!))
  if (found.size) return [...found].slice(0, 20)
  return UNREACHABLE.test(output) ? [] : undefined
}
