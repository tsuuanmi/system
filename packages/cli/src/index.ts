/**
 * The `system` CLI: creates the `system` DSH profile (only `@tsuuanmi/system-bundle`, no
 * dsh-base) and boots it through the `dsh` launcher, the supported pattern (ADR-0018/0019).
 * @module @tsuuanmi/system-cli
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { CHROME_LOCK, type ChromeChoice, discoverChrome, installManagedChrome } from '@tsuuanmi/system-browser-patchright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { dshHome, sqliteRuntimeProblem } from '@tsuuanmi/system-libs'

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
 * Merge the system bundle into a profile manifest without dropping anything the operator
 * added with `dsh plugin --profile system add …`; the system bundle stays first.
 */
export function mergeProfileManifest(current: Partial<ProfileManifest> | undefined, bundleDir: string): ProfileManifest {
  const bundles = (current?.dsh?.profile?.bundles ?? []).filter((name) => name !== '@tsuuanmi/system-bundle' && name !== '@deepseek-ai/dsh-base')
  return {
    ...current,
    name: current?.name ?? 'dsh-profile-system',
    private: true,
    dependencies: { ...current?.dependencies, '@tsuuanmi/system-bundle': `link:${bundleDir}` },
    dsh: { ...current?.dsh, profile: { ...current?.dsh?.profile, bundles: ['@tsuuanmi/system-bundle', ...bundles] } },
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

export function init(home: string = dshHome()): string {
  const dir = profileDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const bundleDir = dirname(require.resolve('@tsuuanmi/system-bundle/package.json'))
  const path = join(dir, 'package.json')
  const current = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<ProfileManifest>) : undefined
  writeFileSync(path, `${JSON.stringify(mergeProfileManifest(current, bundleDir), null, 2)}\n`)
  if (!existsSync(join(dir, 'cordis.patch.yml'))) writeFileSync(join(dir, 'cordis.patch.yml'), '# Operator overrides for the system profile.\n[]\n')
  const install = spawnSync(process.execPath, [dshBin(), 'plugin', '--profile', PROFILE, 'install'], {
    env: dshEnv({ ...process.env, DSH_HOME: home }), stdio: 'inherit',
  })
  if (install.error) throw install.error
  if (install.status !== 0) throw new Error(`dsh plugin install failed (${install.signal ?? `status ${install.status}`})`)
  return dir
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
  if (!existsSync(path)) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const found = JSON.parse(readFileSync(path, 'utf8')) as Partial<Discovery>
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
  const names: Record<string, string> = { '--run': 'runId', '--session': 'sessionId', '--type': 'type', '--after': 'afterSeq', '--limit': 'limit' }
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]!]
    const value = args[i + 1]
    if (!name || value === undefined) return undefined
    filter[name] = name === 'afterSeq' || name === 'limit' ? Number(value) : value
  }
  return filter
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
 * Stop the running profile: drain first (REQ-HOST-1), then SIGTERM its process and wait for it to
 * exit. Runs still executing at the deadline are not lost: they resume on the next start.
 */
export async function shutdownHost(deadlineMs: number, options: { home?: string; call?: typeof callTool; pollMs?: number; onActive?: (active: string[]) => void } = {}): Promise<{ drained: boolean; active: string[]; pid: number }> {
  const path = join(options.home ?? dshHome(), 'system', 'mcp.json')
  if (!existsSync(path)) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const { pid } = JSON.parse(readFileSync(path, 'utf8')) as Discovery
  if (!pid) throw new Error(`${path} names no process`)
  const drained = await drainHost(deadlineMs, options)
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
  const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
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
}

/** `system ask [--persist] [--session <id>] [--tier <tier>] (<prompt...> | -)`; `-` reads stdin. */
export async function parseAsk(args: readonly string[], readStdin: () => Promise<string>): Promise<AskRequest | undefined> {
  const rest = [...args]
  const request: Partial<AskRequest> = {}
  while (rest[0]?.startsWith('--')) {
    const flag = rest.shift()
    if (flag === '--persist') request.persist = true
    else if (flag === '--session' && rest[0]) request.sessionId = rest.shift()!
    else if (flag === '--tier' && rest[0]) request.tier = rest.shift()!
    else if (flag === '--classification' && rest[0]) request.classification = rest.shift()!
    else return undefined
  }
  const prompt = (rest.length === 1 && rest[0] === '-' ? await readStdin() : rest.join(' ')).trim()
  return prompt ? { prompt, ...request } : undefined
}

interface UsageNode { nodeId: string; state: string; minTier: string; tier?: string; worker?: string; quotaClass?: string }
interface UsageRun { runId: string; template: string; status: string; createdAt: string; nodes: UsageNode[] }

/** `system usage`: per request and step, the Worker, tier, and quota class that served it. */
export function formatUsage(usage: { runs: UsageRun[] }): string[] {
  return usage.runs.flatMap((run) => [
    `${run.runId}  ${run.template}  ${run.status}  ${run.createdAt}`,
    ...run.nodes.map((n) => `  ${n.nodeId}  ${n.state}  ${n.tier ?? '-'}  ${n.quotaClass ?? '-'}  ${n.worker ?? '-'}`),
  ])
}

interface Explained {
  runId: string
  template: string
  status: string
  specHash: string
  nodes: Array<{ nodeId: string; state: string; worker?: string; quotaClass?: string; turnId?: string; decisions: Array<{ id: string; type: string; outcome: string; reasons: string[] }> }>
}

/** `system explain <runId>`: each step's decisions (egress, tier, route, acceptance) with their reasons. */
export function formatExplanation(explained: Explained): string[] {
  return [
    `${explained.runId}  ${explained.template}  ${explained.status}  spec ${explained.specHash}`,
    ...explained.nodes.flatMap((n) => [
      `  ${n.nodeId}  ${n.state}  ${n.worker ?? '-'}  ${n.quotaClass ?? '-'}  ${n.turnId ?? '-'}`,
      ...n.decisions.map((d) => `    ${d.type}  ${d.outcome}  ${d.reasons.join('; ')}  (${d.id})`),
    ]),
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
