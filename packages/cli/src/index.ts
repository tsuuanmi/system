/**
 * The `system` CLI: creates the `system` DSH profile (only `@tsuuanmi/system-bundle`, no
 * dsh-base) and boots it through the `dsh` launcher, the supported pattern (ADR-0018/0019).
 * @module @tsuuanmi/system-cli
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, constants as osConstants } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CHROME_LOCK, type ChromeChoice, discoverChrome, installManagedChrome } from '@tsuuanmi/system-browser-patchright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { dshHome, sqliteRuntimeProblem } from '@tsuuanmi/system-libs'
import { parse as parseYaml } from 'yaml'

const require = createRequire(import.meta.url)
const PROFILE = 'system'

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
interface ProfileManifest {
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
    name: current?.name ?? 'dsh-profile-system',
    private: true,
    dependencies: { ...dependencies, '@tsuuanmi/system-bundle': `link:${bundleDir}`, ...(layer ? { [layer]: `link:${join(bundleDir, 'presets', preset)}` } : {}) },
    dsh: { ...current?.dsh, profile: { ...current?.dsh?.profile, bundles: ['@tsuuanmi/system-bundle', ...(layer ? [layer] : []), ...bundles] } },
  }
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
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const bundleDir = dirname(require.resolve('@tsuuanmi/system-bundle/package.json'))
  const path = join(dir, 'package.json')
  const current = readIfPresent(path)
  writeFileSync(path, `${JSON.stringify(mergeProfileManifest(current === undefined ? undefined : JSON.parse(current) as Partial<ProfileManifest>, bundleDir, preset), null, 2)}\n`)
  // Created only when absent (`wx`, one atomic step): an operator's file is never overwritten.
  try {
    writeFileSync(join(dir, 'cordis.patch.yml'), '# Operator overrides for the system profile.\n[]\n', { flag: 'wx' })
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
 * exports `checkConfig` (workflow: its configured templates) must find nothing to refuse. The rows
 * and their config come from the profile as composed now; the plugins from this install's bundle.
 */
export async function checkProfile(home: string = dshHome()): Promise<{ rows: number; problems: string[] }> {
  const dump = spawnSync(process.execPath, [dshBin(), '--profile', PROFILE, '--dump-config'], { env: dshEnv({ ...process.env, DSH_HOME: home }), encoding: 'utf8' })
  if (dump.error) throw dump.error
  if (dump.status !== 0) return { rows: 0, problems: [`the profile does not compose: ${dump.stderr.trim().slice(0, 500)}`] }
  const rows = (parseYaml(dump.stdout) ?? []) as Array<{ id: string; name?: string; config?: unknown; disabled?: boolean }>
  const fromBundle = createRequire(require.resolve('@tsuuanmi/system-bundle/package.json'))
  const problems: string[] = []
  let checked = 0
  for (const row of rows) {
    if (row.disabled || !row.name) continue
    let mod: Record<string, unknown>
    try {
      mod = (await import(pathToFileURL(fromBundle.resolve(row.name)).href)) as Record<string, unknown>
    } catch {
      continue // a plugin this install does not ship (DSH's own, or a third party's): not ours to check
    }
    checked++
    const plugin = (mod.default ?? mod) as Record<string, unknown>
    const schema = (plugin.Config ?? mod.Config) as ((value: unknown) => unknown) | undefined
    try {
      if (typeof schema === 'function') schema(row.config ?? {})
    } catch (error) {
      problems.push(`row ${row.id} (${row.name}): ${(error as Error).message}`)
      continue
    }
    const check = (mod.checkConfig ?? plugin.checkConfig) as ((config: unknown) => string[]) | undefined
    if (typeof check === 'function') for (const problem of check(row.config ?? {})) problems.push(`row ${row.id} (${row.name}): ${problem}`)
  }
  return { rows: checked, problems }
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
  install: () => installManagedChrome({ dir: join(home, 'system', 'browsers') }),
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
  const path = join(home, 'system', 'mcp.json')
  const text = readIfPresent(path)
  if (text === undefined) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const found = JSON.parse(text) as Partial<Discovery>
  if (typeof found.tokenFiles !== 'object' || found.tokenFiles === null) {
    throw new Error(`the running profile predates scoped tokens (${path}); run \`system shutdown\`, then \`system start\` with this version`)
  }
  return found as Discovery
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

/** One line per event: sequence, time, type, where, and its data. */
export function formatEvents(events: readonly EventLine[]): string[] {
  return events.map((e) => [e.seq, e.at, e.type, e.runId ? `run=${e.runId}${e.nodeId ? `/${e.nodeId}` : ''}` : '', e.sessionId ? `session=${e.sessionId}` : '', e.data ? JSON.stringify(e.data) : '']
    .filter((part) => part !== '').join(' '))
}

export interface HealthView { state: 'ok' | 'degraded' | 'down'; checks: Array<{ name: string; state: 'ok' | 'degraded' | 'down'; detail?: string }> }

/** The exit code `system health` ends with: 0 healthy, 1 degraded, 2 down. */
export const healthExit = (state: string): number => ({ ok: 0, degraded: 1, down: 2 } as Record<string, number>)[state] ?? 2

/** The running host's health, or `down` when it does not answer. */
export async function hostHealth(call: typeof callTool = callTool): Promise<HealthView> {
  try {
    const outcome = await call('status', {})
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
  /** What the manifest check found in a plugin a row mounts, and the decision that recorded it (ADR-0045). */
  findings?: Array<{ kind: string; reason: string }>
  checked?: { since: string; decision: string }
}

/** The plugins of the running profile, from `status` as the operator; refused when its plugin host lists none. */
export async function hostPlugins(call: typeof callTool = callTool): Promise<PluginView[]> {
  const outcome = await call('status', {})
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
  const path = join(home, 'system', 'mcp.json')
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
  const state = join(options.home ?? dshHome(), 'system')
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
  const state = join(options.home ?? dshHome(), 'system')
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
  /** `system/scope`: who may call the tool (ADR-0023). */
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
    '> exactly what clients see; regenerate after changing a tool.',
    '',
    ...tools.flatMap((tool) => {
      const props = Object.entries(tool.inputSchema.properties ?? {})
      return [
        `## \`${tool.name}\``, '', cell(tool.description ?? ''), '',
        ...(tool._meta?.['system/scope'] ? [`Scope: \`${String(tool._meta['system/scope'])}\``, ''] : []),
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

interface UsageNode { nodeId: string; state: string; minTier: string; tier?: string; worker?: string; quotaClass?: string; usage?: { inputTokens: number; outputTokens: number } }
interface UsageRun { runId: string; template: string; status: string; createdAt: string; nodes: UsageNode[] }

/** `system usage`: per request and step, the Worker, tier, and quota class that served it, and the tokens a model Worker spent. */
export function formatUsage(usage: { runs: UsageRun[] }): string[] {
  return usage.runs.flatMap((run) => [
    `${run.runId}  ${run.template}  ${run.status}  ${run.createdAt}`,
    ...run.nodes.map((n) => `  ${n.nodeId}  ${n.state}  ${n.tier ?? '-'}  ${n.quotaClass ?? '-'}  ${n.worker ?? '-'}${n.usage ? `  ${n.usage.inputTokens} in / ${n.usage.outputTokens} out tokens` : ''}`),
  ])
}

interface Explained {
  runId: string
  template: string
  status: string
  specHash: string
  nodes: Array<{ nodeId: string; state: string; worker?: string; quotaClass?: string; turnId?: string; decisions: Array<{ id: string; type: string; outcome: string; reasons: string[]; result?: string }> }>
}

/** `system explain <runId>`: each step's decisions (egress, tier, route, acceptance) with their reasons. */
export function formatExplanation(explained: Explained): string[] {
  return [
    `${explained.runId}  ${explained.template}  ${explained.status}  spec ${explained.specHash}`,
    ...explained.nodes.flatMap((n) => [
      `  ${n.nodeId}  ${n.state}  ${n.worker ?? '-'}  ${n.quotaClass ?? '-'}  ${n.turnId ?? '-'}`,
      ...n.decisions.map((d) => `    ${d.type}  ${d.outcome}  ${d.reasons.join('; ')}  (${d.id})${d.result ? `  result ${d.result}` : ''}`),
    ]),
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
