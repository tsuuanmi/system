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
import { isAbsolute, join, normalize } from 'node:path'
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

/** The files a verification's scan reads (at any depth the dependency files name them, and at the root always). */
const SCANNED: readonly string[] = ['.npmrc', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']
/**
 * The `.npmrc` settings a result may set and still be verified online, by the name pnpm reads (its
 * `npm-conf` takes `_` and `-` alike, and this scan reads names case-blind): each changes how the
 * install lays packages out, never where it fetches from, how it trusts what it fetches, or what it
 * runs. `registry` is allowed only when it names the verification's registry. Every other setting,
 * spelled any way, refuses the verification (an allowlist, never a denylist: INV-2, INV-12).
 */
const NPMRC_ALLOWED = new Set(['registry', 'save-exact', 'save-prefix', 'auto-install-peers', 'strict-peer-dependencies', 'shamefully-hoist', 'node-linker', 'engine-strict', 'link-workspace-packages', 'prefer-workspace-packages', 'resolution-mode', 'dedupe-peer-dependents', 'hoist-pattern', 'public-hoist-pattern', 'prefer-frozen-lockfile', 'lockfile', 'package-lock'])
/**
 * The top-level `pnpm-workspace.yaml` keys a result may set (the workspace's packages, its version
 * pins, its build rules, and layout settings), by exact name; any other top-level key, a key no plain
 * name spells, a flow mapping, a document marker, an anchor, a tag, or a complex key refuses it.
 */
const WORKSPACE_ALLOWED = new Set(['packages', 'catalog', 'catalogs', 'overrides', 'packageExtensions', 'patchedDependencies', 'allowBuilds', 'onlyBuiltDependencies', 'neverBuiltDependencies', 'ignoredBuiltDependencies', 'ignoredOptionalDependencies', 'peerDependencyRules', 'allowedDeprecatedVersions', 'supportedArchitectures', 'nodeLinker', 'shamefullyHoist', 'hoistPattern', 'publicHoistPattern', 'autoInstallPeers', 'strictPeerDependencies', 'linkWorkspacePackages', 'preferWorkspacePackages', 'saveExact', 'savePrefix', 'dedupePeerDependents', 'resolutionMode'])
/** The keys a lockfile resolution may hold: a registry package's integrity, a tarball under the registry, or a local directory. */
const RESOLUTION_ALLOWED = new Set(['integrity', 'tarball', 'directory', 'type'])
/** Specifier shorthands for a host other than the registry (a git host's), which pnpm fetches over the network. */
const HOST_SHORTHAND = /(?:^|[\s'"@:{,])(?:github|gitlab|bitbucket|git\+[a-z]+|git):|(?<![\w-])git@[a-z][\w-]*(?:\.[\w-]+)+:/i
/** A file read whole for the scan at most: a larger one is refused, never read in part. */
const SCANNED_BYTES = 64 * 1024 * 1024

/** A worktree file's text, read as itself (never through a link); null when there is none; undefined when it is a link, not a plain file, past {@link SCANNED_BYTES}, or unreadable. */
function textOf(path: string): string | null | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : undefined
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > SCANNED_BYTES) return undefined
    const buffer = Buffer.alloc(stat.size)
    let read = 0
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, null)
      if (!n) break
      read += n
    }
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

const sameRegistry = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * The options a setup's install may carry and still be the verification's command, by name (a value
 * after `=` only where named): none of them names a file the result wrote, a registry, a config, a
 * directory to run in, or a hook.
 */
const INSTALL_OPTIONS: Readonly<Record<string, 'flag' | 'path' | 'word'>> = {
  'frozen-lockfile': 'flag', offline: 'flag', 'prefer-offline': 'flag', 'ignore-scripts': 'flag', 'ignore-pnpmfile': 'flag', silent: 'flag',
  'store-dir': 'path', 'package-import-method': 'word', reporter: 'word',
}

/**
 * The argv of a lockfile's online verification made from the setup's command `argv`, or undefined
 * when that command is not one (T333, INV-12): only pnpm's own frozen install qualifies, run as the
 * host's `pnpm` or `corepack pnpm` (a program name, never a path, so never a file the result wrote),
 * `install` with `--frozen-lockfile` and no other word but the options of {@link INSTALL_OPTIONS}.
 * Any other command (a script, another program, another pnpm command, an unknown option) is never run
 * online, whatever flags it carries. The verification is that install without `--offline`, with
 * `--ignore-scripts` and `--ignore-pnpmfile`, so none of the result's code runs while the network is open.
 */
export function verificationArgv(argv: readonly string[]): string[] | undefined {
  const at = argv[0] === 'pnpm' ? 1 : argv[0] === 'corepack' && argv[1] === 'pnpm' ? 2 : -1
  if (at < 0 || (argv[at] !== 'install' && argv[at] !== 'i')) return undefined
  const options = argv.slice(at + 1)
  for (const word of options) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(word)
    const kind = match ? INSTALL_OPTIONS[match[1]!] : undefined
    if (!match || !kind) return undefined
    const value = match[2]
    if (kind === 'flag' ? value !== undefined : kind === 'path' ? !value || !isAbsolute(value) || normalize(value) !== value : !value || !/^[a-z][a-z-]*$/.test(value)) return undefined
  }
  if (!options.includes('--frozen-lockfile')) return undefined
  return [...argv.filter((word) => word !== '--offline'), ...['--ignore-scripts', '--ignore-pnpmfile'].filter((flag) => !argv.includes(flag))]
}

const unquote = (text: string): string => text.trim().replace(/^(['"])(.*)\1$/, '$2').trim()

/** An `.npmrc`'s findings: every setting not on {@link NPMRC_ALLOWED}, and any section, read as pnpm's ini reader reads lines (a bare CR is refused before, in {@link verificationProblems}). */
function npmrcProblems(file: string, text: string, registry: string): string[] {
  const problems: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      problems.push(`${file} opens a section (${line.slice(0, 60)})`)
      continue
    }
    const at = line.indexOf('=')
    const written = unquote(at < 0 ? line : line.slice(0, at))
    const value = at < 0 ? '' : unquote(line.slice(at + 1))
    // pnpm's config reader takes `_` for `-`; read case-blind, so no spelling of a name slips past.
    const key = written.toLowerCase().replaceAll('_', '-').replace(/\[\]$/, '')
    if (!/^[a-z0-9-]+$/.test(key) || !NPMRC_ALLOWED.has(key)) problems.push(`${file} sets ${written.slice(0, 80)}`)
    else if (key === 'registry' && (!sameRegistry(value, registry) || value.includes('${'))) problems.push(`${file} sets registry to ${value.slice(0, 120)}`)
  }
  return problems
}

/**
 * A `pnpm-workspace.yaml`'s findings, read line by line and failing closed: every top-level line is
 * blank, a comment, or a plain key on {@link WORKSPACE_ALLOWED} (quotes and spaces before its colon
 * read through); a top-level line of any other shape (a flow mapping, a sequence, a document marker,
 * a directive, an anchor, a tag, a complex key) is a finding, never read past. An indented line
 * belongs to the top-level key above it; one before any top-level key is a finding, since YAML lets
 * the root mapping itself be indented, and then every key of it would go unread.
 */
function workspaceProblems(file: string, text: string): string[] {
  const problems: string[] = []
  let keyed = false
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    if (raw.startsWith(' ')) {
      if (!keyed) {
        problems.push(`${file} indents its first key, so its root mapping is not read as top-level keys (${raw.trim().slice(0, 60)})`)
        break
      }
      continue
    }
    keyed = true
    if (raw.startsWith('\t')) {
      problems.push(`${file} indents a line with a tab, which YAML does not read as indentation`)
      continue
    }
    const match = /^("[^"\\]*"|'[^']*'|[A-Za-z][A-Za-z0-9]*)[ ]*:(?:[ ].*|)$/.exec(raw)
    const key = match ? unquote(match[1]!) : undefined
    if (key === undefined) problems.push(`${file} has a top-level line this scan does not read as a plain key (${raw.slice(0, 60)})`)
    else if (!WORKSPACE_ALLOWED.has(key)) problems.push(`${file} sets ${key.slice(0, 80)}`)
  }
  return problems
}

/**
 * A lockfile's findings: any URL not under the registry, any git host shorthand, any shape pnpm never
 * writes (an anchor, an alias, a tag, an escape in a quoted string, a complex key but its own for a
 * long package id), and any resolution that is not a registry package's (its integrity, or a tarball
 * under the registry) or a local directory's, read from pnpm's one-line `resolution: {…}` form; a
 * resolution in any other form is a finding too.
 */
function lockfileProblems(file: string, text: string, registry: string): string[] {
  const problems: string[] = []
  const base = registry.replace(/\/*$/, '/')
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s,'"}]*/gi)) {
    if (!match[0].startsWith(base)) problems.push(`${file} names a URL off the registry (${match[0].slice(0, 200)})`)
  }
  if (HOST_SHORTHAND.test(text)) problems.push(`${file} names a git host's source`)
  // pnpm writes a complex key only for a package id too long for a plain one, two spaces in under `packages:` or `snapshots:`;
  // anywhere else, and never an escape in a quoted string, an anchor, an alias, or a tag: any of them could spell a key this scan would not see.
  for (const match of text.matchAll(/^([ \t]*)\?(?:[ \t]+(.*))?$/gm)) {
    if (match[1] !== '  ' || !match[2]?.includes('@')) problems.push(`${file} holds a complex key`)
  }
  if (/"[^"\n]*\\/.test(text)) problems.push(`${file} holds an escape in a quoted string`)
  if (/(?:^|[\s:,[{])[&*!][^\s'"]/m.test(text)) problems.push(`${file} holds an anchor, an alias, or a tag`)
  for (const raw of text.split(/\r?\n/)) {
    const at = raw.search(/\bresolution['"]?\s*:/)
    if (at < 0) continue
    const value = raw.slice(raw.indexOf(':', at) + 1).trim()
    const inner = /^\{(.*)\}$/.exec(value)?.[1]
    if (inner === undefined || inner.includes('{') || inner.includes('}') || inner.includes('[')) {
      problems.push(`${file} holds a resolution this scan does not read (${raw.trim().slice(0, 120)})`)
      continue
    }
    const fields = new Map(inner.split(',').map((pair) => {
      const colon = pair.indexOf(':')
      return [unquote(colon < 0 ? pair : pair.slice(0, colon)), colon < 0 ? '' : unquote(pair.slice(colon + 1))] as const
    }))
    const other = [...fields.keys()].find((key) => !RESOLUTION_ALLOWED.has(key))
    if (other !== undefined) problems.push(`${file} holds a resolution with ${other.slice(0, 40)}, not a registry package's`)
    else if (fields.has('type') && fields.get('type') !== 'directory') problems.push(`${file} holds a resolution of type ${fields.get('type')!.slice(0, 40)}`)
    else if (fields.has('tarball') && !fields.get('tarball')!.startsWith(base)) problems.push(`${file} names a tarball off the registry (${fields.get('tarball')!.slice(0, 200)})`)
  }
  return problems
}

/**
 * Why a lockfile's online verification in the worktree at `path` (its real path) could reach more than
 * `registry` (T333, INV-12): the result's own files, which its agent wrote, are read against
 * allowlists, so a setting spelled in a way this scan does not know refuses the verification rather
 * than passing it. An `.npmrc` may set only layout settings ({@link NPMRC_ALLOWED}) and the
 * verification's own registry; a `pnpm-workspace.yaml` only the top-level keys of
 * {@link WORKSPACE_ALLOWED}, each a plain key on its own line; a lockfile no URL off the registry, no
 * git host, and no resolution but a registry package's or a local directory's. Each finding, by file;
 * empty when none, so the registry is the one host the install is configured to reach. The root's
 * three files are read whatever the setup's `dependencyFiles` name. A file that is there but cannot be
 * read whole, or that ends a line with a bare carriage return (a line break for pnpm's readers, not
 * for this scan), is a finding too (INV-2).
 */
export function verificationProblems(path: string, files: Readonly<Record<string, string>>, registry: string): string[] {
  const problems: string[] = []
  for (const file of [...new Set([...SCANNED, ...Object.keys(files)])].sort()) {
    const name = file.split('/').at(-1)!
    if (!SCANNED.includes(name)) continue
    const text = textOf(join(path, file))
    if (text === null) continue
    if (text === undefined) problems.push(`${file} cannot be read whole as a plain file`)
    // A bare CR ends a line for pnpm's ini reader and for YAML, but not for this scan's line split: refused, never read past.
    else if (/\r(?!\n)/.test(text)) problems.push(`${file} ends a line with a bare carriage return, which this scan does not read as pnpm does`)
    else if (name === '.npmrc') problems.push(...npmrcProblems(file, text, registry))
    else if (name === 'pnpm-workspace.yaml') problems.push(...workspaceProblems(file, text))
    else problems.push(...lockfileProblems(file, text, registry))
  }
  return [...new Set(problems)].slice(0, 20)
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
 * Whether an offline install lacked only registry metadata (`ERR_PNPM_NO_OFFLINE_META`, what pnpm's
 * supply-chain verification of a new lockfile reads, T333) and no package's tarball, and could reach no
 * registry for anything else: the one failure a lockfile's online verification cures.
 */
export function lockfileVerificationOnly(output: string): boolean {
  return [...output.matchAll(OFFLINE_META)].length > 0 && ![OFFLINE_TARBALL, META_FETCH, TARBALL_FETCH].some((pattern) => output.match(pattern))
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
