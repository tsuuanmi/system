/**
 * The `system` CLI: creates the `system` DSH profile (only `@tsuuanmi/system-bundle`, no
 * dsh-base) and boots it through the `dsh` launcher, the supported pattern (ADR-0018/0019).
 * @module @tsuuanmi/system-cli
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, constants as osConstants } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CHROME_LOCK, type ChromeChoice, discoverChrome, installManagedChrome } from '@tsuuanmi/system-browser-patchright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { type DrawFigure, drawFigureText, dshHome, issueLeadToken, leadId, leadTokenFile, listLeads, revokeLeadToken, sqliteRuntimeProblem } from '@tsuuanmi/system-libs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { TEST_OFF_ROWS, testProfilePatch, testProfilePatchOf } from './test-profile.ts'

export { stagePatch, TEST_OFF_ROWS, TEST_PORT, testProfilePatch, testProfilePatchOf, testRows } from './test-profile.ts'

const require = createRequire(import.meta.url)
/** The live profile, and the test profile that every live update runs on first (T323). */
export const LIVE_PROFILE = 'system'
export const TEST_PROFILE = 'system-test'
/** The profile the CLI acts on: `system` unless `--profile <name>` named another (see {@link useProfile}). */
let PROFILE = LIVE_PROFILE

/** Act on the other profile of this home: its profile directory, its data directory, its daemon. */
export function useProfile(name: string): void {
  if (name !== LIVE_PROFILE && name !== TEST_PROFILE) throw new Error(`no such profile '${name}': the profiles are ${LIVE_PROFILE} and ${TEST_PROFILE}`)
  PROFILE = name
}

/**
 * The data directory of the profile the CLI acts on: its store, vault, tokens, and discovery file.
 * `<home>/system` for the live profile; `<home>/<name>` for another, so two profiles never share one.
 */
export function stateDir(home: string = dshHome()): string {
  return join(home, PROFILE)
}

/** The `dsh` launcher entry of the pinned DSH installation. */
function dshBin(): string {
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> }
  return join(dirname(manifest), bin['dsh'] ?? 'lib/bin.js')
}

/** Environment for every DSH invocation: telemetry off as defense in depth (ADR-0019). */
function dshEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, DSH_TELEMETRY_DISABLED: '1' }
}

export function profileDir(home: string = dshHome()): string {
  return join(home, 'profiles', PROFILE)
}

/**
 * Create or refresh the profile: its bundle list is exactly the system bundle, linked from
 * this installation; the operator's own `cordis.patch.yml` is created empty and never overwritten.
 */
export interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh: { profile: { bundles: string[] } }
  [key: string]: unknown
}

/**
 * Presets (ADR-0025): a named bundle layer shipped in the system bundle's `presets/<name>`,
 * composed right after it. `default` is the system bundle alone.
 */
export const PRESETS = { 'api-first': '@tsuuanmi/system-preset-api-first' } as const
export type Preset = 'default' | keyof typeof PRESETS
const PRESET_BUNDLES: readonly string[] = Object.values(PRESETS)

/** The preset a profile manifest composes now. */
export function presetOf(current: Partial<ProfileManifest> | undefined): Preset {
  const bundle = current?.dsh?.profile?.bundles?.find((name) => PRESET_BUNDLES.includes(name))
  return (Object.entries(PRESETS).find(([, name]) => name === bundle)?.[0] as Preset | undefined) ?? 'default'
}

/**
 * Merge the system bundle into a profile manifest without dropping anything the operator
 * added with `dsh plugin --profile system add …`; the system bundle stays first, then the
 * preset's layer. Without `preset`, the profile keeps the preset it has.
 */
export function mergeProfileManifest(current: Partial<ProfileManifest> | undefined, bundleDir: string, preset: Preset = presetOf(current)): ProfileManifest {
  const bundles = (current?.dsh?.profile?.bundles ?? []).filter((name) => name !== '@tsuuanmi/system-bundle' && name !== '@deepseek-ai/dsh-base' && !PRESET_BUNDLES.includes(name))
  const dependencies = Object.fromEntries(Object.entries(current?.dependencies ?? {}).filter(([name]) => !PRESET_BUNDLES.includes(name)))
  const layer = preset === 'default' ? undefined : PRESETS[preset]
  return {
    ...current,
    name: current?.name ?? `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: { ...dependencies, '@tsuuanmi/system-bundle': `link:${bundleDir}`, ...(layer ? { [layer]: `link:${join(bundleDir, 'presets', preset)}` } : {}) },
    dsh: { ...current?.dsh, profile: { ...current?.dsh?.profile, bundles: ['@tsuuanmi/system-bundle', ...(layer ? [layer] : []), ...bundles] } },
  }
}

/**
 * The `system-test` profile's manifest (T323): the live profile's own, so the same bundles compose
 * (its preset layer and every bundle the operator added), linked from this installation as `init`
 * links any profile, under the test profile's name. `preset` overrides the live one's, as for `init`.
 */
export function testProfileManifest(live: Partial<ProfileManifest>, bundleDir: string, preset?: Preset): ProfileManifest {
  return { ...mergeProfileManifest(live, bundleDir, preset ?? presetOf(live)), name: `dsh-profile-${TEST_PROFILE}` }
}

/** The packages of the rows the test profile turns off, as this installation's bundle names them: an inserted row of one of them signs in too. */
export function testOffPackages(bundleDir: string = dirname(require.resolve('@tsuuanmi/system-bundle/package.json'))): Set<string> {
  const off: readonly string[] = TEST_OFF_ROWS
  const rows = (parseYaml(readFileSync(join(bundleDir, 'cordis.patch.yml'), 'utf8')) as Array<{ insert?: Array<{ id: string; name?: string }> }>).flatMap((p) => p.insert ?? [])
  return new Set(rows.filter((r) => off.includes(r.id) && r.name).map((r) => r.name!))
}

/** The stage's patch of the test profile (scripts/canary.ts patch): the live patch's text as {@link testProfilePatchOf} takes it, with this bundle's off packages. */
export function stagedTestPatch(state: string, liveText: string): string {
  return testProfilePatchOf(state, liveText, testOffPackages())
}

/** Exit status for a child that exited normally or died from a signal (128 + signal number). */
export function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  return 128 + (signal ? (osConstants.signals[signal] ?? 0) : 1)
}

/**
 * Refuse to initialize or start a profile on a runtime the store would refuse (REQ-HOST-2,
 * CON-2): before anything is written or spawned, with the precise reason. Without it the host
 * would boot with every store-backed plugin waiting, a live process doing nothing.
 */
export function assertRuntime(problem: string | undefined = sqliteRuntimeProblem()): void {
  if (problem) throw new Error(problem)
}

/** A file's text, or undefined when there is none: one read, so nothing can change between a check and it. */
function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Create or refresh the profile, with `preset` when given (otherwise the profile keeps its
 * preset). The operator's own `cordis.patch.yml` is never rewritten: a preset is a bundle layer.
 */
export function init(home: string = dshHome(), preset?: Preset): string {
  const dir = profileDir(home)
  const bundleDir = dirname(require.resolve('@tsuuanmi/system-bundle/package.json'))
  const path = join(dir, 'package.json')
  let manifest: ProfileManifest
  if (PROFILE === TEST_PROFILE) {
    // The test profile composes what the live one does, refreshed from it at every init (T323).
    const live = readIfPresent(join(home, 'profiles', LIVE_PROFILE, 'package.json'))
    if (live === undefined) throw new Error(`no ${LIVE_PROFILE} profile under ${home}/profiles to stage: the ${TEST_PROFILE} profile composes the live one's bundles, so run \`system init\` first`)
    manifest = testProfileManifest(JSON.parse(live) as Partial<ProfileManifest>, bundleDir, preset)
  } else {
    const current = readIfPresent(path)
    manifest = mergeProfileManifest(current === undefined ? undefined : JSON.parse(current) as Partial<ProfileManifest>, bundleDir, preset)
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  // Created only when absent (`wx`, one atomic step): an operator's file is never overwritten.
  try {
    writeFileSync(join(dir, 'cordis.patch.yml'), PROFILE === TEST_PROFILE ? testProfilePatch(stateDir(home)) : '# Operator overrides for the system profile.\n[]\n', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const install = spawnSync(process.execPath, [dshBin(), 'plugin', '--profile', PROFILE, 'install'], {
    env: dshEnv({ ...process.env, DSH_HOME: home }), stdio: 'inherit',
  })
  if (install.error) throw install.error
  if (install.status !== 0) throw new Error(`dsh plugin install failed (${install.signal ?? `status ${install.status}`})`)
  return dir
}

/**
 * Why a client helper for `row` cannot work in this composition, or `undefined` when the row is
 * mounted. The model gateways and agent Workers are off by default (PROP-0004).
 */
export function rowOffProblem(row: string, rows: readonly ComposedRow[]): string | undefined {
  if (rows.some((r) => r.id === row && r.mounted)) return undefined
  return `the ${row} row is off in this composition; turn it on in your profile patch (- id: ${row}, disabled: false), then restart`
}

/** A composed row: its id and whether it is mounted. */
export interface ComposedRow { id: string; mounted: boolean }

/** Parse `dsh --dump-config`: every top-level row in order, and whether a patch disabled it. */
export function parseComposedRows(dump: string): ComposedRow[] {
  const rows: ComposedRow[] = []
  for (const line of dump.split('\n')) {
    const row = /^- id: (\S+)/.exec(line)
    if (row) rows.push({ id: row[1]!, mounted: true })
    else if (/^ {2}disabled: true\b/.test(line) && rows.length) rows.at(-1)!.mounted = false
  }
  return rows
}

/**
 * Check the operator's profile against this code before a host starts on it (the update's
 * preflight): every mounted row's config must pass its plugin's `Config` schema, and a plugin that
 * exports `checkConfig` (workflow: its configured templates; approvals: its policies; agent-workers:
 * its Workers and roles) must find nothing to refuse. The rows
 * and their config come from the profile as composed now; the plugins from this install's bundle.
 */
export async function checkProfile(home: string = dshHome(), envFile?: string): Promise<{ rows: number; problems: string[]; notes: string[] }> {
  const dump = spawnSync(process.execPath, [dshBin(), '--profile', PROFILE, '--dump-config'], { env: dshEnv({ ...process.env, DSH_HOME: home }), encoding: 'utf8' })
  if (dump.error) throw dump.error
  if (dump.status !== 0) return { rows: 0, problems: [`the profile does not compose: ${dump.stderr.trim().slice(0, 500)}`], notes: [] }
  const rows = (parseYaml(dump.stdout) ?? []) as ProfileRow[]
  const checked = await checkRows(rows, createRequire(require.resolve('@tsuuanmi/system-bundle/package.json')))
  if (envFile === undefined) return { ...checked, notes: [] }
  const env = checkEnvFile(envFile, rows)
  return { rows: checked.rows, problems: [...checked.problems, ...env.problems], notes: env.notes }
}

export interface ProfileRow { id: string; name?: string; config?: unknown; disabled?: boolean }

/**
 * The preflight's check of composed rows against the plugins `fromBundle` resolves. Only a row whose
 * package the bundle does not ship (DSH's own, or a third party's) is passed over: a plugin the bundle
 * ships that cannot be resolved or loaded (an entry file missing, a module that throws) is a problem,
 * never a row with nothing to check.
 */
export async function checkRows(rows: readonly ProfileRow[], fromBundle: Pick<NodeJS.Require, 'resolve'>): Promise<{ rows: number; problems: string[] }> {
  const problems: string[] = []
  let checked = 0
  for (const row of rows) {
    if (row.disabled || !row.name) continue
    const named = `row ${row.id} (${row.name})`
    let resolved: string
    try {
      resolved = fromBundle.resolve(row.name)
    } catch (error) {
      // Node's answer that no package of this name is reachable from the bundle: not ours to check.
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND' && (error as Error).message.startsWith(`Cannot find module '${row.name}'`)) continue
      problems.push(`${named}: its plugin cannot be resolved: ${(error as Error).message.split('\n')[0]!.slice(0, 300)}`)
      continue
    }
    let mod: Record<string, unknown>
    try {
      mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>
    } catch (error) {
      problems.push(`${named}: its plugin does not load: ${(error as Error).message.split('\n')[0]!.slice(0, 300)}`)
      continue
    }
    checked++
    const plugin = (mod.default ?? mod) as Record<string, unknown>
    const schema = (plugin.Config ?? mod.Config) as ((value: unknown) => unknown) | undefined
    try {
      if (typeof schema === 'function') schema(row.config ?? {})
    } catch (error) {
      problems.push(`${named}: ${(error as Error).message}`)
      continue
    }
    const check = (mod.checkConfig ?? plugin.checkConfig) as ((config: unknown) => string[]) | undefined
    if (typeof check === 'function') for (const problem of check(row.config ?? {})) problems.push(`${named}: ${problem}`)
  }
  return { rows: checked, problems }
}

/**
 * Every name the daemon reads from its launch environment, by role: the `EnvironmentFile=` of its
 * unit declares them (docs/reference/cli.md#the-daemons-environment). Beside these, a file may
 * set only the names the profile's rows name: a credential reference (`apiKeyEnv`) and a name an
 * agent runtime forwards to its Workers (`forwardEnv`).
 */
export const DAEMON_ENV: { readonly required: Readonly<Record<string, string>>; readonly optional: Readonly<Record<string, string>>; readonly refused: Readonly<Record<string, string>> } = {
  required: {
    PATH: 'where the daemon finds git, Xvfb, bwrap, the VNC server and websockify, and an agent runtime named without a path',
    DSH_HOME: 'the harness home, named so the unit never falls back to a default',
  },
  optional: {
    DSH_AGENTS_HOME: "DSH's agents directory (default ~/.agents)",
    CHROME_PATH: 'a Chrome to use instead of the discovered or managed one',
    NODE_OPTIONS: "options for the daemon's Node",
    NODE_EXTRA_CA_CERTS: 'an extra CA bundle, for a TLS-inspecting proxy',
    HTTP_PROXY: 'an egress proxy', HTTPS_PROXY: 'an egress proxy', NO_PROXY: 'hosts reached without the proxy',
    http_proxy: 'an egress proxy', https_proxy: 'an egress proxy', no_proxy: 'hosts reached without the proxy',
    LANG: 'the locale', LC_ALL: 'the locale', TZ: 'the time zone', TMPDIR: 'the temporary directory',
  },
  refused: {
    HOME: 'systemd sets it for the unit', USER: 'systemd sets it for the unit', LOGNAME: 'systemd sets it for the unit',
    XDG_RUNTIME_DIR: 'systemd sets it for the unit', CREDENTIALS_DIRECTORY: 'systemd sets it for a LoadCredential= of the unit',
    DISPLAY: "a desktop session's: a service shows nothing, and an invisible display is the daemon's own Xvfb",
    WAYLAND_DISPLAY: "a desktop session's", XAUTHORITY: "a desktop session's",
    DBUS_SESSION_BUS_ADDRESS: "a login session's message bus", SSH_AUTH_SOCK: "a login session's key agent", GPG_AGENT_INFO: "a login session's key agent",
    SYSTEM_CODEX_GATE_SOCKET: 'the Codex runtime sets it for its own tool gate', SYSTEM_CODEX_GATE_KEY: 'the Codex runtime sets it for its own tool gate',
    DSH_TELEMETRY_DISABLED: '`system start` sets it',
  },
}

/** Names whose value is a path, or for PATH a list of them: systemd expands no variable or `~` in an EnvironmentFile. */
const PATH_VALUED = new Set(['PATH', 'DSH_HOME', 'DSH_AGENTS_HOME', 'CHROME_PATH', 'NODE_EXTRA_CA_CERTS', 'TMPDIR'])

export interface EnvFileEntry { name: string; line: number; value: string }

/** An EnvironmentFile as systemd reads it, strictly: `NAME=VALUE` lines, comments (`#`, `;`), and blank lines. */
export function parseEnvFile(text: string): { entries: EnvFileEntry[]; problems: string[] } {
  const entries: EnvFileEntry[] = []
  const problems: string[] = []
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '').trimStart()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) {
      problems.push(`line ${index + 1} is not NAME=VALUE`)
      return
    }
    let value = match[2]!.trimEnd()
    if (value.endsWith('\\')) problems.push(`${match[1]} (line ${index + 1}) continues on the next line: write each value on one line`)
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    entries.push({ name: match[1]!, line: index + 1, value })
  })
  return { entries, problems }
}

/** The environment names the profile's rows name: credential references (`apiKeyEnv`) and forwarded names (`forwardEnv`), each with its rows. */
export function configEnvNames(rows: readonly ProfileRow[]): { credentials: Map<string, string[]>; forwarded: Map<string, string[]> } {
  const credentials = new Map<string, string[]>()
  const forwarded = new Map<string, string[]>()
  const add = (to: Map<string, string[]>, name: string, row: string): void => {
    const seen = to.get(name) ?? []
    if (!seen.includes(row)) to.set(name, [...seen, row])
  }
  const walk = (value: unknown, row: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, row)
      return
    }
    if (typeof value !== 'object' || value === null) return
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'apiKeyEnv' && typeof inner === 'string') {
        add(credentials, inner, row)
      } else if (key === 'forwardEnv' && Array.isArray(inner)) {
        for (const name of inner) if (typeof name === 'string') add(forwarded, name, row)
      } else {
        walk(inner, row)
      }
    }
  }
  for (const row of rows) if (!row.disabled) walk(row.config, row.id)
  return { credentials, forwarded }
}

/**
 * Check the daemon unit's EnvironmentFile against what the daemon reads and what the profile's rows
 * name: owner-only, systemd's syntax, every required name, no name the daemon does not read, and
 * absolute paths. Problems and notes name variables, never a value.
 */
export function checkEnvFile(path: string, rows: readonly ProfileRow[], uid: number | undefined = process.getuid?.()): { problems: string[]; notes: string[] } {
  // The owner, mode and content are read through one descriptor, so they are of one file even if
  // the path is replaced meanwhile. It is opened non-blocking, so a FIFO is refused, not waited on.
  let fd: number
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY)
  } catch (error) {
    return { problems: [`the environment file ${path} cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`], notes: [] }
  }
  let stat
  let text: string
  try {
    stat = fstatSync(fd)
    if (!stat.isFile()) return { problems: [`the environment file ${path} is not a regular file`], notes: [] }
    text = readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
  const problems: string[] = []
  const notes: string[] = []
  if (uid !== undefined && stat.uid !== uid) problems.push(`${path} is owned by uid ${stat.uid}, not by you (uid ${uid})`)
  if (stat.mode & 0o077) problems.push(`${path} is readable by others (mode ${(stat.mode & 0o777).toString(8)}): chmod 600 ${path}`)
  const parsed = parseEnvFile(text)
  problems.push(...parsed.problems)
  const { credentials, forwarded } = configEnvNames(rows)
  const seen = new Set<string>()
  for (const { name, line, value } of parsed.entries) {
    if (seen.has(name)) problems.push(`${name} is set twice (again on line ${line})`)
    seen.add(name)
    const refused = Object.hasOwn(DAEMON_ENV.refused, name) ? DAEMON_ENV.refused[name] : undefined
    if (refused) {
      problems.push(`${name} must not be set here: ${refused}`)
    } else if (credentials.has(name)) {
      notes.push(`${name} is the credential reference of ${credentials.get(name)!.join(', ')}: set here, it shadows the vault, and \`system model key ${name}\` refuses it`)
    } else if (!Object.hasOwn(DAEMON_ENV.required, name) && !Object.hasOwn(DAEMON_ENV.optional, name) && !forwarded.has(name)) {
      problems.push(`${name} is not read by the daemon, nor named by a row (apiKeyEnv, forwardEnv): remove it`)
    }
    const parts = name === 'PATH' ? value.split(':') : [value]
    if (PATH_VALUED.has(name) && parts.some((part) => !isAbsolute(part))) {
      problems.push(`${name} is not ${name === 'PATH' ? 'a list of absolute directories' : 'an absolute path'}: systemd expands no variable or ~ in an environment file`)
    }
  }
  for (const name of Object.keys(DAEMON_ENV.required)) if (!seen.has(name)) problems.push(`${name} is required: ${DAEMON_ENV.required[name]}`)
  for (const [name, by] of forwarded) if (!seen.has(name)) notes.push(`${by.join(', ')} forward${by.length === 1 ? 's' : ''} ${name}, which the file does not set: its Workers start without it`)
  return { problems, notes }
}

/** The profile's composed rows, as the launcher would mount them now. */
export function composedRows(home: string = dshHome()): ComposedRow[] {
  const dump = spawnSync(process.execPath, [dshBin(), '--profile', PROFILE, '--dump-config'], { env: dshEnv({ ...process.env, DSH_HOME: home }), encoding: 'utf8' })
  if (dump.error) throw dump.error
  if (dump.status !== 0) throw new Error(`dsh --dump-config failed: ${dump.stderr.trim().slice(0, 500)}`)
  return parseComposedRows(dump.stdout)
}

export interface BrowserDeps {
  discover: () => ChromeChoice | undefined
  install: () => Promise<{ path: string; installed: boolean }>
  hasXvfb: () => boolean
  /** The VNC server for remote login, if installed. */
  vnc: () => string | undefined
}

const defaultBrowserDeps = (home: string): BrowserDeps => ({
  discover: () => discoverChrome(undefined),
  install: () => installManagedChrome({ dir: join(stateDir(home), 'browsers') }),
  hasXvfb: () => spawnSync('sh', ['-c', 'command -v Xvfb'], { stdio: 'ignore' }).status === 0,
  vnc: () => {
    const found = spawnSync('sh', ['-c', 'command -v x0vncserver || command -v x11vnc'], { encoding: 'utf8' })
    return found.status === 0 ? found.stdout.trim().split('\n')[0] : undefined
  },
})

/**
 * Provider turns need a recent Chrome and Xvfb (docs/design/browser-runtime.md). Keeps a
 * usable Chrome; otherwise installs the build pinned in `chrome.lock.json`. Xvfb is a
 * system package, so a missing one is reported, not installed.
 */
export async function ensureBrowser(deps: BrowserDeps = defaultBrowserDeps(dshHome())): Promise<string[]> {
  const found = deps.discover()
  let chrome: string
  if (found) {
    chrome = `chrome: ${found.path} (${found.source})`
  } else {
    const { path } = await deps.install()
    chrome = `chrome: installed managed Chrome ${CHROME_LOCK.buildId} at ${path}`
  }
  const vnc = deps.vnc()
  return [
    chrome,
    deps.hasXvfb() ? 'xvfb: ok' : 'xvfb: missing (provider turns need it; Ubuntu/Debian: sudo apt install xvfb)',
    vnc ? `vnc (remote login): ${vnc}` : 'vnc (remote login): missing (system account login needs it; Ubuntu/Debian: sudo apt install tigervnc-scraping-server, or x11vnc)',
  ]
}

export function browserDeps(home: string = dshHome()): BrowserDeps {
  return defaultBrowserDeps(home)
}

/**
 * Boot the profile in the foreground, forwarding extra launcher arguments (e.g. `--patch`).
 * A terminal Ctrl-C already reaches the child through the foreground process group, so
 * SIGINT is not forwarded again (dsh force-exits on a second interrupt and would skip its
 * disposers); SIGTERM and SIGHUP, which target this process only, are forwarded once.
 */
export function start(args: readonly string[] = [], home: string = dshHome()): Promise<number> {
  const child = spawn(process.execPath, [dshBin(), '--profile', PROFILE, ...args], { env: dshEnv({ ...process.env, DSH_HOME: home }), stdio: 'inherit' })
  process.on('SIGINT', () => {})
  for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.once(signal, () => child.kill(signal))
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve(exitCode(code, signal))))
}

/** Control scopes (ADR-0023): the CLI acts as the operator; clients get `client`; model clients get `model`. */
export type Scope = 'operator' | 'client' | 'model'

interface Discovery { url: string; tokenFiles: Record<Scope, string>; pid?: number }

/** The running profile's discovery file. */
function discovery(home: string): Discovery {
  const path = join(stateDir(home), 'mcp.json')
  const text = readIfPresent(path)
  if (text === undefined) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const found = JSON.parse(text) as Partial<Discovery>
  if (typeof found.tokenFiles !== 'object' || found.tokenFiles === null) {
    throw new Error(`the running profile predates scoped tokens (${path}); run \`system shutdown\`, then \`system start\` with this version`)
  }
  return found as Discovery
}

/** Where the scope token files are: beside the running profile's operator token, else the default `<home>/system`. */
function tokenDirOf(home: string): string {
  try {
    return dirname(discovery(home).tokenFiles.operator)
  } catch {
    return stateDir(home)
  }
}

/**
 * `system lead-token issue|revoke|list [<project>]` (ADR-0076): the operator's command for a project's
 * lead principal. The token file `lead-<project>.token` sits beside `operator.token` with the same
 * permissions; the host reads it on each request, so a revoked token is refused at once. The token
 * itself is never printed. Returns the lines to print; refuses (throws) what cannot be done.
 */
export function leadToken(action: string | undefined, project: string | undefined, home: string = dshHome()): string[] {
  const dir = tokenDirOf(home)
  if (action === 'list' && project === undefined) {
    const leads = listLeads(dir)
    return leads.length ? leads.map((p) => `${p}  ${leadTokenFile(dir, p)}  decider ${leadId(p)}`) : ['no lead token is issued']
  }
  if ((action === 'issue' || action === 'revoke') && project !== undefined) {
    if (action === 'revoke') {
      if (!revokeLeadToken(dir, project)) throw new Error(`no lead token is issued for project ${project}`)
      return [`revoked the lead token of project ${project}: requests with it are refused from now on`]
    }
    const { file, replaced } = issueLeadToken(dir, project)
    return [
      `issued the lead token of project ${project}: ${file} (owner-only, like the operator's)${replaced ? '; the one issued before no longer works' : ''}`,
      `what it decides is recorded as ${leadId(project)}; its rights are a closed list System enforces, and everything else stays the operator's`,
    ]
  }
  throw new Error('usage: system lead-token issue <project> | revoke <project> | list')
}

/** A runtime's own sign-in command for one home, as `account_enroll` gives it (ADR-0051). */
export interface SignIn {
  command: string
  args: string[]
  env: Record<string, string>
}

/**
 * The environment the operator's sign-in command runs in (ADR-0051): theirs, then the runtime's
 * variables for the home, and never a session bus, so the sign-in lands in the home's own files,
 * where a run, which starts without D-Bus, reads it.
 */
export function signInEnvironment(base: NodeJS.ProcessEnv, login: SignIn): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) if (value !== undefined) env[name] = value
  Object.assign(env, login.env)
  delete env.DBUS_SESSION_BUS_ADDRESS
  return env
}

/** The sign-in command as one line the operator can run themselves: `env -u DBUS_SESSION_BUS_ADDRESS K=V command args`. */
export function signInLine(login: SignIn): string {
  const quote = (value: string): string => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`)
  return ['env', '-u', 'DBUS_SESSION_BUS_ADDRESS', ...Object.entries(login.env).map(([k, v]) => `${k}=${quote(v)}`), quote(login.command), ...login.args.map(quote)].join(' ')
}

/** What `system account login`, `verify`, and `remove` name: an agent account by its id, a slot of an agent runtime, or a website account. */
export type AccountTarget = { kind: 'agent'; accountId: string } | { kind: 'agent'; provider: string; slot?: number } | { kind: 'website'; id: string }

/**
 * Tell an agent account from a website account (ADR-0051): an id with a `:` is an agent account (a
 * catalog id has none); a name of an agent runtime the daemon lists is that runtime's slot (with
 * `--slot <n>`, that slot); anything else is a website account. A `--slot` on a website account is
 * refused.
 */
export function accountTarget(args: readonly string[], agentProviders: readonly string[]): AccountTarget {
  const [name, ...flags] = args
  if (!name) throw new Error('name an account')
  let slot: number | undefined
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--slot' && /^[1-9]\d?$/.test(flags[i + 1] ?? '')) slot = Number(flags[++i])
    else if (flags[i] !== '--accept') throw new Error(`unknown option ${flags[i]}`)
  }
  if (name.includes(':')) {
    if (slot !== undefined) throw new Error('an account id names its slot already; --slot is for a runtime')
    return { kind: 'agent', accountId: name }
  }
  if (agentProviders.includes(name)) return { kind: 'agent', provider: name, ...(slot !== undefined ? { slot } : {}) }
  if (slot !== undefined) throw new Error(`${name} is not an agent runtime this host lists, so --slot does not apply`)
  return { kind: 'website', id: name }
}

/**
 * One agent account as `system account list` shows it, beside the website accounts: never its hash,
 * and the hint only masked; the operator's label when its assignment gives one, and a quarantine's
 * detail, what its reading found.
 */
export function agentAccountLine(entry: { account: Record<string, unknown>; workers: string[]; label?: string }): Record<string, unknown> {
  const a = entry.account as { accountId?: string; provider: string; slot: number; home: string; status: string; quarantine?: { reason: string; since: string; detail?: string }; hint?: string; identity?: { reader: string; runtimeVersion: string; verifiedAt: string } }
  return {
    kind: 'agent', ...(a.accountId ? { id: a.accountId } : {}), ...(entry.label ? { label: entry.label } : {}), provider: a.provider, slot: a.slot, status: a.status,
    ...(a.quarantine ? { reason: a.quarantine.reason, ...(a.quarantine.detail ? { detail: a.quarantine.detail } : {}), since: a.quarantine.since } : {}), ...(a.hint ? { hint: a.hint } : {}), home: a.home,
    ...(a.identity ? { reader: a.identity.reader, runtimeVersion: a.identity.runtimeVersion, verifiedAt: a.identity.verifiedAt } : {}), workers: entry.workers,
  }
}

/** `system account migrate` arguments: `--apply` or `--rollback`, and `--stop <runtime>`, repeatable; anything else is refused. */
export function parseMigrate(args: readonly string[]): { apply: boolean; rollback: boolean; stop: string[] } {
  const out = { apply: false, rollback: false, stop: [] as string[] }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') out.apply = true
    else if (args[i] === '--rollback') out.rollback = true
    else if (args[i] === '--stop' && /^[a-z][a-z0-9-]{0,63}$/.test(args[i + 1] ?? '')) out.stop.push(args[++i]!)
    else throw new Error(`unknown option ${args[i]}${args[i] === '--stop' ? ' (name the runtime whose Workers stop)' : ''}`)
  }
  if (out.apply && out.rollback) throw new Error('--apply or --rollback, not both')
  if (out.rollback && out.stop.length) throw new Error('--stop is for a plan or --apply')
  return out
}

/**
 * What `system account migrate` prints (PROP-0012 phase F): what each hand-named Worker becomes,
 * what stops the move, and, once there is nothing to stop it, the `agent-workers` row to put in the
 * profile patch (and the templates for the `resources` row) as YAML; with the exit code, 0 unless a
 * plan has blockers.
 */
export function formatMigration(out: Record<string, unknown>): { text: string; exit: number } {
  const plan = out.plan as { workers: Array<{ from: string; to?: string; why: string }>; templates: unknown[]; blockers: string[] }
  const outcome = out.outcome as string
  const moved = out.moved as { sessions: number; runs: number } | undefined
  const cutover = out.cutover as { decision: string; appliedAt: string } | undefined
  const head = {
    planned: cutover ? `the move was applied on ${cutover.appliedAt} (decision ${cutover.decision}); the hand-named rows are refused at load` : 'the move, planned (nothing changed; --apply applies it):',
    applied: `applied (decision ${cutover?.decision}): ${moved?.sessions ?? 0} session(s) and ${moved?.runs ?? 0} run(s) moved to their new Workers. The hand-named rows are refused from now on: put the row below in the profile patch, then restart (system shutdown, system start)`,
    'already-applied': `applied already, on ${cutover?.appliedAt} (decision ${cutover?.decision}); nothing changed`,
    'rolled-back': `rolled back: ${moved?.sessions ?? 0} session(s) and ${moved?.runs ?? 0} run(s) moved back; the hand-named rows load again (put them back in the profile patch, then restart)`,
    'not-applied': 'no move is applied; nothing changed',
  }[outcome] ?? outcome
  const lines = [head, ...plan.workers.map((w) => `  ${w.from} -> ${w.to ?? 'stops'}: ${w.why}`)]
  if (plan.blockers.length) lines.push('', 'what stops the move:', ...plan.blockers.map((b) => `  - ${b}`))
  if (outcome !== 'rolled-back' && outcome !== 'not-applied' && (!plan.blockers.length || cutover)) {
    lines.push('', '# the agent-workers row of the profile patch (it replaces the row\'s whole config):', stringifyYaml([{ id: 'agent-workers', config: out.row }]).trimEnd())
    if (plan.templates.length) lines.push('', '# add to the resources row\'s config:', stringifyYaml({ templates: plan.templates }).trimEnd())
  }
  return { text: lines.join('\n'), exit: outcome === 'planned' && plan.blockers.length && !cutover ? 1 : 0 }
}

/** Client configuration snippets for Claude Code and Codex, from the running profile's discovery file. */
export function mcpConfig(client: 'claude' | 'codex', home: string = dshHome()): string {
  const { url } = discovery(home)
  // The token is never printed here (shell history); clients read it from the environment.
  if (client === 'claude') {
    // Claude Code runs headersHelper on each connection, so the token never sits in its config.
    const helper = `${process.execPath} ${fileURLToPath(new URL('./bin.js', import.meta.url))} mcp-headers`
    return `claude mcp add-json --scope user system '${JSON.stringify({ type: 'http', url, headersHelper: helper })}'`
  }
  // Codex runs the stdio shim, which authenticates from the token file: no token in its config or environment.
  const bin = fileURLToPath(new URL('./bin.js', import.meta.url))
  return ['# ~/.codex/config.toml', '[mcp_servers.system]', `command = ${JSON.stringify(process.execPath)}`, `args = [${JSON.stringify(bin)}, "mcp-stdio"]`, `# endpoint: ${url}`].join('\n')
}

/**
 * A command that runs Claude Code on the Messages gateway: website Workers become its model
 * (ADR-0022). Its apiKeyHelper runs `system mcp-token --scope model` per connection, so the token is never
 * printed, exported, or written to Claude Code's settings.
 */
export function claudeGatewayCommand(home: string = dshHome()): string {
  const { url } = discovery(home)
  const helper = `${process.execPath} ${fileURLToPath(new URL('./bin.js', import.meta.url))} mcp-token --scope model`
  return `ANTHROPIC_BASE_URL=${new URL(url).origin}/anthropic claude --settings '${JSON.stringify({ apiKeyHelper: helper })}'`
}

/**
 * A command that runs Codex on the Responses gateway with a `system` model provider (ADR-0022).
 * The model token reaches Codex only through its env_key variable, set from `system mcp-token --scope model` in a
 * subshell, so it is never printed. Codex's own retries are off: a retried request would send a
 * website turn again.
 */
export function codexGatewayCommand(home: string = dshHome()): string {
  const { url } = discovery(home)
  const helper = `${process.execPath} ${fileURLToPath(new URL('./bin.js', import.meta.url))} mcp-token --scope model`
  const provider = `{name="system",base_url="${new URL(url).origin}/openai/v1",env_key="SYSTEM_MCP_TOKEN",wire_api="responses",request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=900000}`
  return `SYSTEM_MCP_TOKEN="$(${helper})" codex -c model_provider=system -c 'model_providers.system=${provider}' -m system-standard`
}

/** `{"Authorization": "Bearer <client token>"}` for a client's headersHelper (Claude Code). */
export function mcpHeaders(home: string = dshHome()): string {
  return JSON.stringify({ Authorization: `Bearer ${mcpToken('client', home)}` })
}

/** A scope's bearer token alone; the CLI prints only the model scope's (`system mcp-token --scope model`). */
export function mcpToken(scope: Scope, home: string = dshHome()): string {
  return readFileSync(discovery(home).tokenFiles[scope]).toString('base64url')
}

/**
 * The web UI's address for the running profile. The operator token rides in the fragment, which a
 * browser never sends to a server; the page moves it to session storage and drops it.
 */
export function uiUrl(home: string = dshHome()): string {
  return `${new URL(discovery(home).url).origin}/ui/#token=${mcpToken('operator', home)}`
}

export interface ToolOutcome {
  isError: boolean
  text: string
  structured: Record<string, unknown> | undefined
}

/** Call a tool on the running profile's MCP endpoint as the operator (the CLI acts for the operator). */
export async function callTool(name: string, args: Record<string, unknown>, home: string = dshHome()): Promise<ToolOutcome> {
  const { url } = discovery(home)
  const token = mcpToken('operator', home)
  const client = new Client({ name: 'system-cli', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Transport)
  try {
    const result = await client.callTool({ name, arguments: args })
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>
    return {
      isError: result.isError === true,
      text: content.map((c) => c.text ?? '').join('\n'),
      structured: result.structuredContent as Record<string, unknown> | undefined,
    }
  } finally {
    await client.close()
  }
}

export interface EventLine { seq: number; at: string; type: string; runId?: string; nodeId?: string; sessionId?: string; data?: Record<string, unknown> }

/** `system events` flags to the `events` tool's filter. */
export function parseEvents(args: readonly string[]): Record<string, string | number> | undefined {
  const filter: Record<string, string | number> = {}
  const names: Record<string, string> = { '--run': 'runId', '--node': 'nodeId', '--session': 'sessionId', '--turn': 'turnId', '--type': 'type', '--since': 'since', '--after': 'afterSeq', '--limit': 'limit' }
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]!]
    const value = args[i + 1]
    if (!name || value === undefined) return undefined
    filter[name] = name === 'afterSeq' || name === 'limit' ? Number(value) : value
  }
  return filter
}

/** `system report` flags to the `report` tool's input, each at most once; undefined for an unknown flag or a missing value. */
export function parseReport(args: readonly string[]): Record<string, string | number> | undefined {
  const input: Record<string, string | number> = {}
  const names: Record<string, string> = { '--project': 'projectId', '--since': 'since', '--until': 'until', '--days': 'days' }
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]!]
    const value = args[i + 1]
    if (!name || value === undefined || name in input) return undefined
    input[name] = name === 'days' ? Number(value) : value
  }
  return input
}

/**
 * `system metrics` flags to the `metrics` tool's input (PROP-0016 I4): `--days <n>` (a whole number
 * from 1 to 366), `--project <id>`, `--until <time>`, each at most once; undefined for an unknown
 * flag, a missing value, or days that are not such a number.
 */
export function parseMetrics(args: readonly string[]): Record<string, string | number> | undefined {
  const input: Record<string, string | number> = {}
  const names: Record<string, string> = { '--project': 'projectId', '--days': 'days', '--until': 'until' }
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]!]
    const value = args[i + 1]
    if (!name || value === undefined || name in input) return undefined
    if (name === 'days' && !/^[1-9]\d{0,2}$/.test(value)) return undefined
    input[name] = name === 'days' ? Number(value) : value
  }
  if (typeof input['days'] === 'number' && input['days'] > 366) return undefined
  return input
}

/** A notice of a project's lead inbox, as much of it as the CLI prints (`lead-notice@1.0`). */
export interface LeadNoticeView { id: string; project: string; kind: string; title: string; text: string; act: string[] }

/**
 * `system lead wait [--project <id>] [--timeout <s>]`, `system lead inbox [--project <id>]`, and
 * `system lead ack [--project <id>] <id>...` (D107), each with `--json`; undefined for an unknown
 * word, flag, or value. A timeout is a whole number of seconds from 1 to 86400.
 */
export function parseLead(rest: readonly string[]): { action: 'wait' | 'inbox' | 'ack'; json: boolean; project?: string; timeoutSeconds?: number; ids: string[] } | undefined {
  const [action, ...words] = rest
  if (action !== 'wait' && action !== 'inbox' && action !== 'ack') return undefined
  const out: { action: 'wait' | 'inbox' | 'ack'; json: boolean; project?: string; timeoutSeconds?: number; ids: string[] } = { action, json: false, ids: [] }
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!
    if (word === '--json') out.json = true
    else if (word === '--project' && out.project === undefined && words[i + 1] && !words[i + 1]!.startsWith('--')) out.project = words[++i]!
    else if (word === '--timeout' && action === 'wait' && out.timeoutSeconds === undefined && /^[1-9]\d{0,5}$/.test(words[i + 1] ?? '') && Number(words[i + 1]) <= 86_400) out.timeoutSeconds = Number(words[++i])
    else if (action === 'ack' && !word.startsWith('--')) out.ids.push(word)
    else return undefined
  }
  return action === 'ack' && !out.ids.length ? undefined : out
}

/** One notice as lines: its kind and title, what happened, and the command to act. */
export const formatLeadNotice = (n: LeadNoticeView): string[] => [`[${n.kind}] ${n.title}  (${n.id})`, `  ${n.text}`, ...n.act.map((line) => `  → ${line}`)]

/**
 * The lead's loop instead of polling: `wait` asks the inbox (`lead_inbox`, up to 55 s at a time) until a
 * notice is unread or the timeout passes, and prints it; `inbox` prints what is unread; `ack` marks ids
 * handled. Exit 0 when notices were printed or acked, 1 when the timeout passed with none.
 */
export async function leadInbox(parsed: NonNullable<ReturnType<typeof parseLead>>, call: typeof callTool = callTool, print: (line: string) => void = console.log, now: () => number = Date.now): Promise<number> {
  const base = parsed.project !== undefined ? { projectId: parsed.project } : {}
  const deadline = parsed.timeoutSeconds !== undefined ? now() + parsed.timeoutSeconds * 1000 : Infinity
  for (;;) {
    const left = Math.max(0, Math.ceil((deadline - now()) / 1000))
    const wait = parsed.action === 'wait' ? { waitSeconds: Math.min(55, left) } : {}
    const outcome = await call('lead_inbox', { ...base, ...(parsed.action === 'ack' ? { ack: parsed.ids } : {}), ...wait })
    if (outcome.isError) throw new Error(outcome.text)
    const result = outcome.structured as unknown as { notices: LeadNoticeView[]; acked?: string[]; unknown?: string[] }
    if (parsed.action === 'ack') {
      print(parsed.json ? JSON.stringify(result) : `acked ${result.acked?.length ?? 0}${result.unknown?.length ? `; unknown or handled already: ${result.unknown.join(', ')}` : ''}`)
      return 0
    }
    if (result.notices.length) {
      for (const notice of result.notices) for (const line of parsed.json ? [JSON.stringify(notice)] : formatLeadNotice(notice)) print(line)
      return 0
    }
    if (parsed.action === 'inbox') {
      if (!parsed.json) print('no unread notice')
      return 0
    }
    if (now() >= deadline) return 1
  }
}

/** One line per event: sequence, time, type, where, and its data. */
export function formatEvents(events: readonly EventLine[]): string[] {
  return events.map((e) => [e.seq, e.at, e.type, e.runId ? `run=${e.runId}${e.nodeId ? `/${e.nodeId}` : ''}` : '', e.sessionId ? `session=${e.sessionId}` : '', e.data ? JSON.stringify(e.data) : '']
    .filter((part) => part !== '').join(' '))
}

export interface HealthView { state: 'ok' | 'degraded' | 'down'; checks: Array<{ name: string; state: 'ok' | 'degraded' | 'down'; detail?: string }> }

/** The exit code `system health` ends with: 0 healthy, 1 degraded, 2 down. */
export const healthExit = (state: string): number => ({ ok: 0, degraded: 1, down: 2 } as Record<string, number>)[state] ?? 2

/** The running host's health, every check of it, or `down` when it does not answer. */
export async function hostHealth(call: typeof callTool = callTool): Promise<HealthView> {
  try {
    const outcome = await call('status', { checks: true })
    const health = outcome.structured?.health as HealthView | undefined
    if (outcome.isError || !health) return { state: 'down', checks: [{ name: 'host', state: 'down', detail: outcome.text || 'no health report' }] }
    return health
  } catch (error) {
    return { state: 'down', checks: [{ name: 'host', state: 'down', detail: `the host does not answer: ${(error as Error).message.split('\n')[0]} (system start)` }] }
  }
}

/** One line per check: the healthy ones short, the others with what to do. */
export function formatHealth(health: HealthView): string[] {
  return [`health: ${health.state}`, ...health.checks.map((c) => `  ${c.state.padEnd(8)} ${c.name.padEnd(10)} ${c.detail ?? ''}`.trimEnd())]
}

/**
 * The running profile's capacity now (MCP `roster`'s `now`, docs/design/roster.md#capacity-now): the
 * server's rendering of it for a terminal (the roster text's last block, from "Right now"), or with
 * `json` the record itself (`mcp-roster@1.7` `#/$defs/capacity`). Nothing is computed here. A refused
 * call, a host that does not answer, or a host whose roster has no `now` throws.
 */
export async function hostCapacity(json: boolean, call: typeof callTool = callTool): Promise<string> {
  const outcome = await call('roster', {})
  if (outcome.isError) throw new Error(outcome.text || 'the roster could not be read')
  if (json) {
    const now = outcome.structured?.now
    if (!now) throw new Error('the running profile gave no capacity record (a roster below mcp-roster@1.7 has no now)')
    return JSON.stringify(now, null, 2)
  }
  const at = outcome.text.lastIndexOf('\nRight now (as of ')
  if (at < 0) throw new Error('the running profile gave no capacity (a roster below mcp-roster@1.7 has no now)')
  return outcome.text.slice(at + 1)
}

/**
 * The running profile's roster (REQ-HOST-8, MCP `roster`): its rendering for a terminal, or with
 * `json` the record itself (`mcp-roster@1.7`, with `now`). A refused call, or a host that does not answer, throws.
 */
export async function hostRoster(json: boolean, call: typeof callTool = callTool): Promise<string> {
  const outcome = await call('roster', {})
  if (outcome.isError) throw new Error(outcome.text || 'the roster could not be read')
  if (json) {
    if (!outcome.structured) throw new Error('the running profile gave no roster record')
    return JSON.stringify(outcome.structured, null, 2)
  }
  return outcome.text
}

/** Dispatch as MCP `dispatch_status`, `dispatch_pause`, and `dispatch_resume` give it (ADR-0064), as much as `system dispatch` prints. */
export interface DispatchView {
  enabled: boolean
  paused?: { since: string; reason?: string; decision: string }
  /** PROP-0014 D2: each project's own pause. */
  pausedProjects?: Array<{ projectId?: string; since: string; reason?: string; decision: string }>
  lastPass?: { at: string; state: string; reason?: string; took: Array<{ taskId: string; worker: string; how: string }>; tasks: Array<{ taskId: string; title: string; reason: string }>; more: number }
  bounds: { running: { used: number; max: number }; openAsks: { used: number; max: number }; engine: { active: number; max: number }; hour?: { used: number; max: number } }
  asks: Array<{ taskId: string; title: string; attempt: number; state: string; worker: string; requestId?: string; why: string }>
  /** PROP-0014 D2: what dispatch started in the last 24 h, newest first. */
  started?: Array<{ taskId: string; title: string; attempt: number; worker: string; runId: string; runStatus: string; mode: string; startedAt: string }>
}

/**
 * `system dispatch [status|pause [--project <id>] [reason…]|resume [--project <id>]] [--json]`: the
 * tool to call and its arguments, or undefined when the words are not one of these.
 */
export function parseDispatch(rest: readonly string[]): { action: 'status' | 'pause' | 'resume'; json: boolean; args: Record<string, string> } | undefined {
  const [action = 'status', ...more] = rest[0] === '--json' ? ['status', ...rest] : rest
  if (action !== 'status' && action !== 'pause' && action !== 'resume') return undefined
  const json = more.includes('--json')
  const words = more.filter((a) => a !== '--json')
  const args: Record<string, string> = {}
  const at = words.indexOf('--project')
  if (at >= 0) {
    const projectId = words[at + 1]
    if (action === 'status' || !projectId || projectId.startsWith('--')) return undefined
    args['projectId'] = projectId
    words.splice(at, 2)
  }
  if (action !== 'pause' && words.length) return undefined
  if (words.length) args['reason'] = words.join(' ')
  return { action, json, args }
}

/**
 * `system dispatch` for a terminal: on, off, or paused (since when, why, how to resume), each project
 * paused, the bounds in use, the starts waiting for the operator's go or for their Worker, what it
 * started by itself, and the last pass with its reason for each ready task it looked at.
 */
export function formatDispatch(view: DispatchView): string[] {
  const state = !view.enabled ? 'off (dispatch.enabled is false): nothing is asked or started by itself'
    : view.paused ? `paused since ${view.paused.since}${view.paused.reason ? `: ${view.paused.reason}` : ''} (system dispatch resume; decision ${view.paused.decision})` : 'on'
  const b = view.bounds
  const lines = [`dispatch: ${state}`, `  bounds: ${b.running.used} of ${b.running.max} dispatched runs and asks, ${b.openAsks.used} of ${b.openAsks.max} asks open, ${b.engine.active} of ${b.engine.max} active runs it may fill${b.hour ? `, ${b.hour.used} of ${b.hour.max} starts this hour` : ''}`]
  for (const p of view.pausedProjects ?? []) {
    lines.push(`  project ${p.projectId} paused since ${p.since}${p.reason ? `: ${p.reason}` : ''} (system dispatch resume --project ${p.projectId}; decision ${p.decision})`)
  }
  for (const s of view.started ?? []) {
    lines.push(`  started by itself (${s.mode}) ${s.startedAt}: "${s.title}" (task ${s.taskId}, attempt ${s.attempt}) on ${s.worker}, run ${s.runId} ${s.runStatus}`)
  }
  for (const ask of view.asks) {
    lines.push(ask.state === 'asked'
      ? `  waiting for your go: "${ask.title}" (task ${ask.taskId}, attempt ${ask.attempt}) on ${ask.worker}, request ${ask.requestId}: decide it in the queue (system ui, or MCP approvals_decide)`
      : `  ${ask.state}: "${ask.title}" (task ${ask.taskId}, attempt ${ask.attempt}) on ${ask.worker}`)
    lines.push(`    why ${ask.worker}: ${ask.why}`)
  }
  const last = view.lastPass
  if (last) {
    lines.push(`  last pass ${last.at}: ${last.state}${last.reason ? `: ${last.reason}` : ''}${last.took.length ? `; took ${last.took.map((t) => `${t.taskId} on ${t.worker} (${t.how})`).join(', ')}` : ''}`)
    for (const task of last.tasks) lines.push(`    ${task.taskId} "${task.title}": ${task.reason}`)
    if (last.more) lines.push(`    and ${last.more} more ready task(s)`)
  }
  return lines
}

/** A plugin of the composition as the running profile's `status` lists it to the operator (REQ-HOST-7). */
export interface PluginView {
  name: string
  rows: string[]
  mounted: boolean
  manifest: 'valid' | 'absent' | 'refused'
  reason?: string
  version?: string
  class?: { kind: 'core'; component: string } | { kind: 'family'; family: string }
  lifecycle?: { state: string; since: string; decision: string }
  /** What the manifest check found in a plugin a row mounts, and the decision that recorded it (ADR-0048). */
  findings?: Array<{ kind: string; reason: string }>
  checked?: { since: string; decision: string }
}

/** The plugins of the running profile, from `status` as the operator; refused when its plugin host lists none. */
export async function hostPlugins(call: typeof callTool = callTool): Promise<PluginView[]> {
  const outcome = await call('status', { plugins: true })
  if (outcome.isError) throw new Error(outcome.text)
  const plugins = outcome.structured?.plugins as PluginView[] | undefined
  if (!plugins) throw new Error('the running profile lists no plugins: its plugin-host row is off or not running (system health)')
  return plugins
}

/**
 * One line per plugin: its recorded lifecycle state, whether a row runs it, name and version, class,
 * rows; why its manifest is absent or refused; and each finding of the manifest check, with the
 * decision that recorded it.
 */
export function formatPlugins(plugins: readonly PluginView[]): string[] {
  const width = Math.max(0, ...plugins.map((p) => p.name.length + (p.version ? p.version.length + 1 : 0)))
  const indent = ' '.repeat(14)
  return plugins.flatMap((p) => {
    const cls = !p.class ? '' : p.class.kind === 'core' ? `core: ${p.class.component}` : `family: ${p.class.family}`
    const line = [(p.lifecycle?.state ?? '—').padEnd(9), (p.mounted ? 'on' : 'off').padEnd(3), `${p.name}${p.version ? `@${p.version}` : ''}`.padEnd(width), cls.padEnd(24), p.rows.length ? `row ${p.rows.join(', ')}` : 'no row'].join(' ')
    return [
      line,
      ...(p.manifest === 'valid' ? [] : [`${indent}manifest ${p.manifest}: ${p.reason ?? ''}`.trimEnd()]),
      ...(p.findings ?? []).map((f) => `${indent}finding: ${f.reason}`),
      ...(p.findings?.length && p.checked ? [`${indent}recorded by ${p.checked.decision} (system artifact)`] : []),
    ]
  })
}

/**
 * Drain the host (REQ-HOST-1): no new run is admitted, then poll until nothing is executing or
 * the deadline passes. Gateway requests end with their runs.
 */
export async function drainHost(deadlineMs: number, options: { call?: typeof callTool; pollMs?: number; onActive?: (active: string[]) => void } = {}): Promise<{ drained: boolean; active: string[] }> {
  const call = options.call ?? callTool
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const outcome = await call('drain', {})
    if (outcome.isError) throw new Error(outcome.text)
    const active = (outcome.structured?.active as string[] | undefined) ?? []
    if (!active.length) return { drained: true, active }
    if (Date.now() >= deadline) return { drained: false, active }
    options.onActive?.(active)
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollMs ?? 2000, Math.max(0, deadline - Date.now()))))
  }
}

/**
 * Why `pid` is not this home's running host, or undefined when it is: its command line must run the
 * DSH binary with a profile, and its DSH_HOME must be `home` (or unset, for the default home). Read
 * from `/proc` (Linux); elsewhere nothing is proven, so nothing is stopped.
 */
export function hostProcessProblem(pid: number, home: string, proc = '/proc'): string | undefined {
  let argv: string[]
  let env: string[]
  try {
    argv = readFileSync(join(proc, String(pid), 'cmdline'), 'utf8').split('\0').filter(Boolean)
    env = readFileSync(join(proc, String(pid), 'environ'), 'utf8').split('\0')
  } catch {
    return `it is not running, or not readable under ${proc}`
  }
  if (!argv.some((a) => a.endsWith('/@deepseek-ai/dsh/lib/bin.js')) || !argv.includes('--profile')) return 'it does not run a DSH profile'
  if (argv[argv.indexOf('--profile') + 1] !== PROFILE) return `it runs the ${argv[argv.indexOf('--profile') + 1]} profile, not ${PROFILE}`
  const own = env.find((v) => v.startsWith('DSH_HOME='))?.slice('DSH_HOME='.length)
  const resolved = (p: string): string => resolve(p).replace(/\/$/, '')
  if (own ? resolved(own) !== resolved(home) : resolved(home) !== resolved(join(homedir(), '.dsh'))) return `its DSH_HOME is ${own ?? 'the default'}, not ${home}`
  return undefined
}

/**
 * Stop the running profile: drain first (REQ-HOST-1), then SIGTERM its process and wait for it to
 * exit. Runs still executing at the deadline are not lost: they resume on the next start.
 */
export async function shutdownHost(deadlineMs: number, options: { home?: string; call?: typeof callTool; pollMs?: number; onActive?: (active: string[]) => void; proc?: string } = {}): Promise<{ drained: boolean; active: string[]; pid: number; undrained?: string }> {
  const home = options.home ?? dshHome()
  const path = join(stateDir(home), 'mcp.json')
  const text = readIfPresent(path)
  if (text === undefined) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const { pid } = JSON.parse(text) as Discovery
  if (!pid) throw new Error(`${path} names no process`)
  let drained: { drained: boolean; active: string[]; undrained?: string }
  try {
    drained = await drainHost(deadlineMs, options)
  } catch (error) {
    // The engine that drains is not running (a plugin failed): nothing of it can be running either,
    // so the host is stopped without a drain, once its process is proven to be this home's host.
    if (!/not found|not installed/i.test((error as Error).message)) throw error
    const problem = hostProcessProblem(pid, home, options.proc)
    if (problem) throw new Error(`drain is not available (${(error as Error).message}), and process ${pid} is not stopped: ${problem}`)
    drained = { drained: false, active: [], undrained: (error as Error).message }
  }
  process.kill(pid, 'SIGTERM')
  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  for (const until = Date.now() + 60_000; alive() && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 250))
  if (alive()) throw new Error(`process ${pid} did not exit within 60 s of SIGTERM`)
  return { ...drained, pid }
}

const BACKUP_MANIFEST = 'system-backup.json'
/** The only files a backup holds; a manifest naming any other path is refused. */
const BACKUP_FILES: readonly string[] = ['system.db', 'vault.enc', 'vault.key']

interface BackupManifest {
  schema: 'system-backup@1'
  createdAt: string
  /** Relative path → sha256 hex, for every file in the backup but the manifest. */
  files: Record<string, string>
  includesKey: boolean
}

const fileHash = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

function listFiles(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
    : entry.isFile() ? [`${prefix}${entry.name}`] : [])
}

/**
 * Back up the harness state (docs/operations/runbooks.md#backup-and-restore): a consistent
 * snapshot of the store (`VACUUM INTO`, safe while the profile runs) and the encrypted vault,
 * with a manifest of hashes. The vault key is left out unless
 * `includeKey`: a backup with its key is as sensitive as the host. Login profiles and the
 * managed browser are not state: a new login recreates them.
 */
export function backupHost(target: string, options: { home?: string; includeKey?: boolean } = {}): BackupManifest {
  const state = stateDir(options.home)
  if (!existsSync(join(state, 'system.db'))) throw new Error(`no store at ${join(state, 'system.db')}`)
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} is not empty`)
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(state, 'system.db'))
  try {
    db.prepare('VACUUM INTO ?').run(join(target, 'system.db'))
  } finally {
    db.close()
  }
  if (options.includeKey && existsSync(join(state, 'vault.enc')) && !existsSync(join(state, 'vault.key'))) {
    // The vault's keyFile points elsewhere (a systemd credential, another volume): never report
    // a backup "with its key" that has none.
    throw new Error(`there is no vault key in ${state}: it is kept outside the state directory (the credentials row's keyFile); back it up where it lives, without --include-key`)
  }
  for (const file of ['vault.enc', ...(options.includeKey ? ['vault.key'] : [])]) {
    if (existsSync(join(state, file))) copyFileSync(join(state, file), join(target, file))
  }
  const files = Object.fromEntries(listFiles(target).map((f) => [f, fileHash(join(target, f))]))
  for (const f of Object.keys(files)) chmodSync(join(target, f), 0o600)
  const manifest: BackupManifest = { schema: 'system-backup@1', createdAt: new Date().toISOString(), files, includesKey: !!options.includeKey && 'vault.key' in files }
  writeFileSync(join(target, BACKUP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return manifest
}

/** Whether the profile that owns this state is running (its discovery file names a live process). */
function profileRunning(state: string): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(join(state, 'mcp.json'), 'utf8')) as Discovery
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Restore a backup into the harness state: refused while the profile runs, and only after every
 * file matches the manifest. Without `yes` it only reports what it would do. The replaced store
 * is kept beside it (`system.db.before-restore-<time>`).
 */
/**
 * Restore a verified backup into the state directory. Without its key in the backup, the vault
 * needs one on this host: `<state>/vault.key`, or `keyFile`, where the credentials row's
 * `keyFile` keeps it outside the state directory.
 */
export function restoreHost(source: string, options: { home?: string; yes?: boolean; keyFile?: string } = {}): { manifest: BackupManifest; applied: boolean; keptAside?: string } {
  const state = stateDir(options.home)
  // The manifest is written last, so a backup a crash interrupted has none and is refused.
  if (!existsSync(join(source, BACKUP_MANIFEST))) throw new Error(`${source} has no ${BACKUP_MANIFEST}: it is not a complete system backup`)
  const manifest = JSON.parse(readFileSync(join(source, BACKUP_MANIFEST), 'utf8')) as BackupManifest
  if (manifest.schema !== 'system-backup@1') throw new Error(`${source} is not a system backup`)
  for (const file of Object.keys(manifest.files)) {
    if (!BACKUP_FILES.includes(file)) throw new Error(`${JSON.stringify(file)} is not a file a backup holds; refusing the backup`)
  }
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (!existsSync(join(source, file)) || fileHash(join(source, file)) !== hash) throw new Error(`${file} does not match the backup manifest`)
  }
  const key = options.keyFile ?? join(state, 'vault.key')
  if (!manifest.includesKey && existsSync(join(source, 'vault.enc')) && !existsSync(key)) {
    throw new Error(`the backup has no vault key and this host has none at ${key}: restore the key from where you keep it first (or name it with --key <path>)`)
  }
  if (!options.yes) return { manifest, applied: false }
  if (profileRunning(state)) throw new Error('the profile is running: run `system shutdown` first')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  const keptAside = existsSync(join(state, 'system.db')) ? join(state, `system.db.before-restore-${Date.now()}`) : undefined
  if (keptAside) renameSync(join(state, 'system.db'), keptAside)
  for (const sidecar of ['system.db-wal', 'system.db-shm']) rmSync(join(state, sidecar), { force: true })
  for (const file of Object.keys(manifest.files)) {
    mkdirSync(dirname(join(state, file)), { recursive: true, mode: 0o700 })
    copyFileSync(join(source, file), join(state, file))
    chmodSync(join(state, file), 0o600)
  }
  return { manifest, applied: true, ...(keptAside ? { keptAside } : {}) }
}

export interface ToolContract {
  name: string
  description?: string
  /** `system/scope`: `operator` on a tool only the operator token may call; absent, a client token may call it too (ADR-0023). */
  _meta?: Record<string, unknown>
  inputSchema: { properties?: Record<string, { type?: string | string[]; description?: string; enum?: unknown[]; maximum?: number; maxLength?: number }>; required?: string[] }
}

/** Every tool the running profile serves over MCP, as the operator sees them (`tools/list`), each with its scope. */
export async function listTools(home: string = dshHome()): Promise<ToolContract[]> {
  const { url } = discovery(home)
  const token = mcpToken('operator', home)
  const client = new Client({ name: 'system-cli', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Transport)
  try {
    return ((await client.listTools()).tools as ToolContract[]).sort((a, b) => a.name.localeCompare(b.name))
  } finally {
    await client.close()
  }
}

/** Tool contracts as the reference page (docs/reference/mcp-tools.md). */
export function formatTools(tools: readonly ToolContract[]): string {
  // A backslash is escaped too, or one before a `|` would leave the pipe a cell break.
  const cell = (text: string): string => text.replace(/[\\|]/g, '\\$&').replace(/\n/g, ' ')
  return [
    '# MCP tool contracts',
    '',
    '> Generated by `system tools --markdown` from a running profile (`tools/list`), so it shows',
    '> exactly what clients see; regenerate after changing a tool. A tool answers with structured',
    '> content, and a text block that only summarizes it (a completed run\'s text is its answer); an',
    '> error is text alone ([token budget](../../packages/plugins/mcp-server/README.md#token-budget)).',
    '',
    ...tools.flatMap((tool) => {
      const props = Object.entries(tool.inputSchema.properties ?? {})
      return [
        `## \`${tool.name}\``, '', cell(tool.description ?? ''), '',
        `Scope: \`${String(tool._meta?.['system/scope'] ?? 'client')}\``, '',
        ...(props.length
          ? ['| Argument | Type | Required | Description |', '|---|---|---|---|',
            ...props.map(([name, p]) => `| \`${name}\` | ${cell(p.enum ? p.enum.map((v) => JSON.stringify(v)).join(' | ') : Array.isArray(p.type) ? p.type.join(' | ') : p.type ?? 'any')} | ${tool.inputSchema.required?.includes(name) ? 'yes' : ''} | ${cell(p.description ?? '')} |`), '']
          : ['No arguments.', '']),
      ]
    }),
  ].join('\n')
}

export interface AskRequest {
  prompt: string
  persist?: true
  sessionId?: string
  tier?: string
  classification?: string
  /** `research --deep`: the research procedure's deep variant. */
  deep?: true
  /** `run --variant <v>`: a variant the template defines. */
  variant?: string
  /**
   * `run --task <taskId> [--holder <h> --generation <n>]`: the board task the run serves, one
   * attempt of it, as the MCP `run` tool's `task` takes it; a lead's claim handed over by its holder
   * and generation, both or neither.
   */
  task?: { taskId: string; holder?: string; generation?: number }
}

/**
 * `system ask [--persist] [--session <id>] [--tier <tier>] (<prompt...> | -)`; `-` reads stdin. `run` also
 * takes `--variant` and `--task` (with `--holder` and `--generation`). Each command refuses the flags it does not take.
 */
export async function parseAsk(args: readonly string[], readStdin: () => Promise<string>): Promise<AskRequest | undefined> {
  const rest = [...args]
  const request: Partial<AskRequest> = {}
  const claim: { taskId?: string; holder?: string; generation?: number } = {}
  while (rest[0]?.startsWith('--')) {
    const flag = rest.shift()
    if (flag === '--persist') request.persist = true
    else if (flag === '--session' && rest[0]) request.sessionId = rest.shift()!
    else if (flag === '--tier' && rest[0]) request.tier = rest.shift()!
    else if (flag === '--classification' && rest[0]) request.classification = rest.shift()!
    else if (flag === '--deep') request.deep = true
    else if (flag === '--variant' && rest[0]) request.variant = rest.shift()!
    else if (flag === '--task' && rest[0] && claim.taskId === undefined) claim.taskId = rest.shift()!
    else if (flag === '--holder' && rest[0] && claim.holder === undefined) claim.holder = rest.shift()!
    else if (flag === '--generation' && /^[1-9]\d{0,8}$/.test(rest[0] ?? '') && claim.generation === undefined) claim.generation = Number(rest.shift())
    else return undefined
  }
  // A claim is handed over whole, with its task: its holder and generation, both or neither.
  if ((claim.holder !== undefined || claim.generation !== undefined) && claim.taskId === undefined) return undefined
  if ((claim.holder === undefined) !== (claim.generation === undefined)) return undefined
  if (claim.taskId !== undefined) request.task = { taskId: claim.taskId, ...(claim.holder !== undefined ? { holder: claim.holder, generation: claim.generation! } : {}) }
  const prompt = (rest.length === 1 && rest[0] === '-' ? await readStdin() : rest.join(' ')).trim()
  return prompt ? { prompt, ...request } : undefined
}

interface UsageNode { nodeId: string; state: string; minTier: string; tier?: string; model?: string; worker?: string; quotaClass?: string; usage?: { inputTokens: number; outputTokens: number }; usageUnknown?: string }
interface UsageRun { runId: string; template: string; status: string; createdAt: string; nodes: UsageNode[] }

/**
 * `system usage`: per request and step, the Worker, tier, and quota class that served it, the tokens a
 * model Worker spent, and a step whose usage the resource ledger could not count, with why.
 */
export function formatUsage(usage: { runs: UsageRun[]; draws?: UsageDraws }): string[] {
  return [
    ...usage.runs.flatMap((run) => [
      `${run.runId}  ${run.template}  ${run.status}  ${run.createdAt}`,
      ...run.nodes.map((n) => `  ${n.nodeId}  ${n.state}  ${n.tier ?? '-'}${n.model ? ` (${n.model})` : ''}  ${n.quotaClass ?? '-'}  ${n.worker ?? '-'}${n.usage ? `  ${n.usage.inputTokens} in / ${n.usage.outputTokens} out tokens` : ''}${n.usageUnknown ? `  usage unknown (${n.usageUnknown})` : ''}`),
    ]),
    ...formatDraws(usage.draws),
  ]
}

/** What agent runs drew, as `system usage` gives it (`quota.draw`, PROP-0015 E2): figures per kind and window, then per template step. */
interface UsageDraws {
  byKind: DrawFigure[]
  byStep: DrawFigure[]
  records: number
  unreadable: number
  unread: boolean
}

/**
 * The quota draws section of `system usage`: per kind and window, then per kind, template step, and
 * window, the clean draws counted, their median and p90 in percentage points, and the entries left
 * out by why; none when no draw is recorded.
 */
function formatDraws(draws: UsageDraws | undefined): string[] {
  if (!draws) return []
  const over = `${draws.records} record${draws.records === 1 ? '' : 's'}${draws.unread ? ', the latest only' : ''}${draws.unreadable ? `; ${draws.unreadable} not valid, not counted` : ''}`
  return [
    `quota drawn per run, in percentage points of each window (${over}):`,
    ...draws.byKind.map((f) => `  ${drawFigureText(f)}`),
    ...(draws.byStep.some((f) => f.step !== undefined) ? ['by template step:', ...draws.byStep.filter((f) => f.step !== undefined).map((f) => `  ${drawFigureText(f)}`)] : []),
  ]
}

/** An execution whose liveness needs a look, as `explain` gives it (`ctx.workers.liveness`, PROP-0013). */
export interface ExplainedLiveness {
  source: string
  execution: string
  worker: string
  state: 'stalled' | 'looking' | 'unknown'
  since: string
  verdict?: string
  looks?: { taken: number; max: number }
  reasons: string[]
  decision?: string
  holds: string[]
  action: string
}

type ExplainedDecision = { id: string; type: string; outcome: string; reasons: string[]; result?: string }

/** A review step's latest assessment (ADR-0075): its summary, then its findings by severity with their votes. */
type ExplainedReview = {
  assessment: string
  verdict: string
  summary: string
  findings: Array<{ id?: string; severity: string; title: string; place?: string; class?: string; blocks: boolean; vote?: string; reason?: string; repeated?: string }>
}

/** A review's lines under its step: the summary, then each finding, a blocking one marked, its vote and why. */
export function formatReview(review: ExplainedReview): string[] {
  return [
    `    review  ${review.verdict}  ${review.summary}  (${review.assessment})`,
    ...review.findings.map((f) => `      ${f.blocks ? '!' : '-'} ${f.id ? `${f.id} ` : ''}${f.severity}  ${f.title}${f.place ? `  ${f.place}` : ''}${f.class ? `  [class ${f.class}]` : ''}${f.vote ? `  ${f.vote === 'confirm' ? 'confirmed' : f.vote === 'reject' ? 'rejected' : 'unverified'}${f.reason ? `: ${f.reason}` : ''}` : ''}${f.repeated ? `  repeats ${f.repeated}, not counted` : ''}`),
  ]
}

/** The handbook slice a step's brief recorded (docs/design/handbook.md#what-a-brief-records). */
interface ExplainedHandbook {
  bound: { tokens: number; mode: string }
  tokens: number
  selection: { role: string; class?: string; tier: string; tierFrom: string; paths: string }
  layers: Array<{ layer: number; version: string; renderedBy: string; parts: string[]; tokens: number; atMost?: boolean }>
  /** What the Worker source recorded it rendered of its half for the execution: each part's version and size. */
  source?: Array<{ layer: number; part: string; version: string; tokens: number; lessons?: number }>
}

/** A step's handbook slice: its size against the bound and the mode, what selected it, each layer's size, version, and parts, then what its Worker source rendered. */
export function formatHandbook(h: ExplainedHandbook): string[] {
  const s = h.selection
  return [
    `    handbook  ${h.tokens} of ${h.bound.tokens} tokens (${h.bound.mode} mode)  role ${s.role}${s.class ? `, class ${s.class}` : ''}, tier ${s.tier} (from ${s.tierFrom}), paths ${s.paths}`,
    ...h.layers.map((l) => `      layer ${l.layer}  ${l.atMost ? 'at most ' : ''}${l.tokens} tokens  by ${l.renderedBy}  ${l.version}${l.parts.length ? `  parts ${l.parts.join(', ')}` : ''}`),
    ...(h.source ?? []).map((r) => `      rendered ${r.part}  ${r.tokens} tokens  ${r.version}${r.lessons !== undefined ? `  ${r.lessons} lesson(s)` : ''}`),
  ]
}

interface Explained {
  runId: string
  template: string
  status: string
  specHash: string
  /** The engine's decisions on the run as a whole (a board task's admission, subject, acceptance, report), which no step holds. */
  decisions?: ExplainedDecision[]
  /** The run's risk tier and why (ADR-0071), when its project's policy has a path map. */
  risk?: { tier: string; reasons: string[]; decision: string; at?: string }
  nodes: Array<{ nodeId: string; state: string; worker?: string; quotaClass?: string; turnId?: string; tier?: string; model?: string; decisions: ExplainedDecision[]; review?: ExplainedReview; handbook?: ExplainedHandbook }>
  liveness?: ExplainedLiveness[]
  livenessUnread?: Array<{ source: string; detail: string }>
  /** The run's checks stalled now: no output for their bound, still running to their deadline (T235). */
  stalledChecks?: Array<{ check: string; command: string; since: string; quietSince: string; stallSeconds: number }>
  /** A research role's web calls (T262): how many, unasked, asked, and denied in their session, and each query or URL with its verdict and egress outcome. */
  webCalls?: { count: number; auto: number; asked: number; denied?: number; calls: Array<{ at: string; nodeId?: string; tool: string; target: string; verdict: string; egress: string; reason?: string; decision: string }> }
  /** Where the run's accepted result stands in its target's landing queue (PROP-0016 I3). */
  landing?: { key: string; state: string; position?: number; length: number; holder?: { runId: string; taskId: string }; batch?: { size: number; limit: number; index: number } }
}

/** A run's place in its target's landing queue as `system explain` prints it. */
export function formatLandingQueue(q: NonNullable<Explained['landing']>): string[] {
  const place = q.position ? `position ${q.position} of ${q.length}` : `${q.length} in it`
  return [
    `landing queue  ${q.key}  ${q.state}  ${place}${q.holder ? `  behind task ${q.holder.taskId} (run ${q.holder.runId}), which holds the target` : q.state === 'queued' ? '' : '  holds the target'}`,
    ...(q.batch ? [`  stack  result ${q.batch.index} of ${q.batch.size}  (batch size ${q.batch.limit})`] : []),
  ]
}

/** A run's web calls as `system explain` prints them (T262): the counts, then one line per call. */
export function formatWebCalls(web: NonNullable<Explained['webCalls']>): string[] {
  return [
    `web calls  ${web.count}: ${web.auto} unasked, ${web.asked} asked${web.denied ? `, ${web.denied} denied in their session` : ''}`,
    ...web.calls.map((c) => `  ${c.at}  ${c.nodeId ?? '-'}  ${c.tool}  ${c.verdict}  egress ${c.egress}${c.reason ? `  (${c.reason})` : ''}  ${JSON.stringify(c.target)}  (${c.decision})`),
    ...(web.calls.length < web.count ? [`  and ${web.count - web.calls.length} more`] : []),
  ]
}

/** The words of each liveness state, as an operator reads them. */
const LIVENESS_WORDS = { stalled: 'stalled', looking: 'not known to be gone, being looked at', unknown: 'ended without being known to be gone' } as const

/** One execution's liveness: its state and verdict, its looks, why, what it holds, and what to do. */
export function formatLiveness(runs: readonly ExplainedLiveness[], unread: ReadonlyArray<{ source: string; detail: string }> = []): string[] {
  return [
    ...runs.flatMap((r) => [
      `  ${r.execution}  ${r.worker}  ${LIVENESS_WORDS[r.state]} since ${r.since}${r.verdict ? `  verdict ${r.verdict}` : ''}${r.looks ? `  looks ${r.looks.taken} of ${r.looks.max}` : ''}${r.decision ? `  (${r.decision})` : ''}`,
      ...r.reasons.map((reason) => `    why   ${reason}`),
      ...(r.holds.length ? [`    holds ${r.holds.join('; ')}`] : []),
      `    do    ${r.action}`,
    ]),
    ...unread.map((u) => `  source ${u.source} cannot tell: ${u.detail}`),
  ]
}

/**
 * `system explain <runId>`: the run's risk tier and why (ADR-0071), when it has one; the run's own
 * decisions (a board task's admission, subject, acceptance, report), then each step's handbook slice
 * (its size, the bound's mode, each layer's version) and decisions (egress, tier, route, acceptance)
 * with their reasons, a review step's findings by severity with their votes (ADR-0075), then its
 * executions whose liveness needs a look, and its checks stalled now, and its research Workers' web
 * calls (T262).
 */
export function formatExplanation(explained: Explained): string[] {
  const liveness = explained.liveness?.length || explained.livenessUnread?.length ? ['liveness', ...formatLiveness(explained.liveness ?? [], explained.livenessUnread)] : []
  const stalled = explained.stalledChecks?.length
    ? ['checks', ...explained.stalledChecks.map((c) => `  ${c.check}  stalled since ${c.since}: no output since ${c.quietSince} (bound ${c.stallSeconds} s)  ${c.command}`)]
    : []
  const line = (d: ExplainedDecision): string => `    ${d.type}  ${d.outcome}  ${d.reasons.join('; ')}  (${d.id})${d.result ? `  result ${d.result}` : ''}`
  return [
    `${explained.runId}  ${explained.template}  ${explained.status}  spec ${explained.specHash}`,
    ...(explained.risk ? [`  risk tier ${explained.risk.tier}${explained.risk.at ? ` (at ${explained.risk.at})` : ''}  (${explained.risk.decision})`, ...explained.risk.reasons.map((r) => `    why   ${r}`)] : []),
    ...(explained.decisions?.length ? ['  run (decisions no step holds)', ...explained.decisions.map(line)] : []),
    ...explained.nodes.flatMap((n) => [
      `  ${n.nodeId}  ${n.state}  ${n.worker ?? '-'}  ${n.quotaClass ?? '-'}  ${n.turnId ?? '-'}${n.tier && n.model ? `  tier ${n.tier}, model ${n.model}` : ''}`,
      ...(n.handbook ? formatHandbook(n.handbook) : []),
      ...n.decisions.map(line),
      ...(n.review ? formatReview(n.review) : []),
    ]),
    ...liveness,
    ...stalled,
    ...(explained.webCalls?.count ? formatWebCalls(explained.webCalls) : []),
    ...(explained.landing ? formatLandingQueue(explained.landing) : []),
  ]
}

/** What `agent_run_free` answers (`mcp-agent-runs@1.0`). */
export interface Freed {
  agentRun: string
  decision: string
  again: boolean
  freed: string[]
  worktrees: Array<{ path: string; branch: string; outcome: 'removed' | 'kept'; why: string; commit?: string }>
}

/**
 * `system free <agentRun> --agent-gone [--commit-worktree] [note...]`: the operator's word that a run's
 * agent is gone, so what it held is freed (PROP-0013). Without `--agent-gone` nothing is asked.
 */
export function parseFree(args: readonly string[]): { agentRun: string; agentGone: true; commitWorktree?: true; note?: string } {
  const known = new Set(['--agent-gone', '--commit-worktree'])
  const flags = args.filter((a) => a.startsWith('--'))
  const unknownFlag = flags.find((f) => !known.has(f))
  if (unknownFlag) throw new Error(`system free: unknown option ${unknownFlag}`)
  const [agentRun, ...note] = args.filter((a) => !a.startsWith('--'))
  if (!agentRun) throw new Error('system free: name the agent run (arun_…) that system health or explain lists as unknown')
  if (!flags.includes('--agent-gone')) throw new Error(`system free: freeing ${agentRun} is your word that its agent is gone: check that no process of it runs (docs/operations/runbooks.md#a-runs-liveness-is-unknown), then add --agent-gone`)
  return { agentRun, agentGone: true, ...(flags.includes('--commit-worktree') ? { commitWorktree: true as const } : {}), ...(note.length ? { note: note.join(' ') } : {}) }
}

/** What `system free` prints: the decision, what is free now, and each worktree removed or kept, and why. */
export function formatFreed(freed: Freed): string[] {
  return [
    `${freed.again ? 'freed again' : 'freed'} ${freed.agentRun} (decision ${freed.decision})${freed.freed.length ? `: ${freed.freed.join('; ')}` : ''}`,
    ...freed.worktrees.map((w) => `  worktree ${w.path}: ${w.outcome}${w.commit ? `, its changes committed on ${w.branch} as ${w.commit}` : ''} (${w.why})`),
  ]
}

/** What `agent_worktrees` answers (`mcp-agent-runs@1.1`). */
export interface Worktrees {
  retentionHours: number
  total: number
  worktrees: Array<{ runId: string; path: string; branch: string; state: 'in-use' | 'held' | 'finished'; changes: 'clean' | 'uncommitted' | 'gone' | 'not-intact'; lastActivityAt: string; retiresAt?: string; failure?: string }>
}

/** What `agent_worktrees_remove` answers (`mcp-agent-runs@1.1`). */
export interface WorktreesRemoved {
  decision?: string
  more: number
  worktrees: Array<{ runId: string; path: string; branch: string; outcome: 'removed' | 'kept'; why: string; commit?: string }>
}

/** What `system worktrees` prints: the retention, then each worktree with its state, what it holds, and when it retires. */
export function formatWorktrees(listing: Worktrees): string[] {
  const retention = listing.retentionHours ? `the retention removes a finished one ${listing.retentionHours} h after its last agent run` : 'the retention removes none (worktreeRetentionHours 0)'
  return [
    `${listing.total} run worktree(s); ${retention}${listing.total > listing.worktrees.length ? `; the oldest ${listing.worktrees.length} shown` : ''}`,
    ...listing.worktrees.flatMap((w) => [
      `  ${w.runId}  ${w.state}, ${w.changes}  last activity ${w.lastActivityAt}${w.retiresAt ? `, retires ${w.retiresAt}` : ''}`,
      `    ${w.path}  (${w.branch})`,
      ...(w.failure ? [`    last retirement failed: ${w.failure}`] : []),
    ]),
  ]
}

/**
 * `system worktrees remove [--run <runId>] [--commit-changes] [note...]`: the operator removes the
 * finished run worktrees now (D12); nothing is discarded.
 */
export function parseWorktreesRemove(args: readonly string[]): { runId?: string; commitChanges?: true; note?: string } {
  const out: { runId?: string; commitChanges?: true; note?: string } = {}
  const note: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--run') {
      const runId = args[++i]
      if (!runId || runId.startsWith('--')) throw new Error('system worktrees remove: --run names a workflow run (run_…)')
      out.runId = runId
    } else if (arg === '--commit-changes') out.commitChanges = true
    else if (arg.startsWith('--')) throw new Error(`system worktrees remove: unknown option ${arg}`)
    else note.push(arg)
  }
  return { ...out, ...(note.length ? { note: note.join(' ') } : {}) }
}

/** What `system worktrees remove` prints: the decision, then each worktree removed or kept, and why. */
export function formatWorktreesRemoved(removed: WorktreesRemoved): string[] {
  return [
    removed.decision ? `removed finished run worktrees (decision ${removed.decision})` : 'no finished run worktree could be removed; nothing was decided',
    ...removed.worktrees.map((w) => `  ${w.runId}  ${w.path}: ${w.outcome}${w.commit ? `, its changes committed on ${w.branch} as ${w.commit}` : ''} (${w.why})`),
    ...(removed.more ? [`  ${removed.more} more not looked at: run it again`] : []),
  ]
}

/** What the `artifact` tool returns (the artifacts service's read). */
export type ArtifactRead =
  | { id: string; state: 'stored'; kind: string; bodySchema: string; classification: string; runId?: string; nodeId?: string; createdAt: string; inputs: string[]
    content: 'text' | 'json' | 'blob'; chars: number; offset: number; truncated: boolean; text: string }
  | { id: string; state: 'expired' | 'unknown'; note: string }

/** `system artifact <id>`: a header, which says the classification, then the window of the body. */
export function formatArtifact(read: ArtifactRead): string[] {
  if (read.state !== 'stored') return [`${read.id}  ${read.note}`]
  const end = read.offset + [...read.text].length
  const where = read.runId ? `  run ${read.runId}${read.nodeId ? ` / ${read.nodeId}` : ''}` : ''
  return [
    `${read.id}  ${read.kind} (${read.bodySchema})  ${read.classification}${where}  ${read.createdAt}`,
    ...(read.inputs.length ? [`inputs: ${read.inputs.join(', ')}`] : []),
    read.content === 'blob'
      ? 'body: in a blob store, not read here'
      : `${read.content}: ${read.chars} characters; ${read.offset}..${end}${read.truncated ? ` (more: --offset ${end})` : ''}`,
    '---',
    read.text,
  ]
}

export async function readAllStdin(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += String(chunk)
  return text
}

/**
 * `system mcp-stdio`: an MCP server on stdio that forwards tool listing and calls to the
 * running profile's HTTP endpoint, authenticating from the 0600 discovery and token files.
 * For MCP clients that cannot run a header helper (e.g. Codex): no token in their config or
 * environment. Tools and results pass through unchanged (INV-7).
 */
export async function serveStdio(home: string = dshHome()): Promise<void> {
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
  const { CallToolRequestSchema, ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js')
  const remote = async <T>(use: (client: Client) => Promise<T>): Promise<T> => {
    // The shim serves MCP clients, so it holds the client scope (ADR-0023).
    const { url } = discovery(home)
    const client = new Client({ name: 'system-mcp-stdio', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${mcpToken('client', home)}` } } }) as unknown as Transport)
    try {
      return await use(client)
    } finally {
      await client.close()
    }
  }
  const server = new Server({ name: 'system', version: '0.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => remote((client) => client.listTools()))
  server.setRequestHandler(CallToolRequestSchema, async (request) => remote((client) => client.callTool(request.params) as never))
  await server.connect(new StdioServerTransport() as unknown as Transport)
}
