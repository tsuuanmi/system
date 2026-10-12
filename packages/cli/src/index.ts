/**
 * The `system` CLI: creates the `system` DSH profile (only `@tsuuanmi/system-bundle`, no
 * dsh-base) and boots it through the `dsh` launcher, the supported pattern (ADR-0018/0019).
 * @module @tsuuanmi/system-cli
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHROME_LOCK, type ChromeChoice, discoverChrome, installManagedChrome } from '@tsuuanmi/system-browser-patchright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { dshHome } from '@tsuuanmi/system-libs'

const require = createRequire(import.meta.url)
export const PROFILE = 'system'

/** The `dsh` launcher entry of the pinned DSH installation. */
export function dshBin(): string {
  const manifest = require.resolve('@deepseek-ai/dsh/package.json')
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as { bin: Record<string, string> }
  return join(dirname(manifest), bin['dsh'] ?? 'lib/bin.js')
}

/** Environment for every DSH invocation: telemetry off as defense in depth (ADR-0019). */
export function dshEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
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

interface Discovery { url: string; tokenFile: string; pid?: number }

/** Client configuration snippets for Claude Code and Codex, from the running profile's discovery file. */
export function mcpConfig(client: 'claude' | 'codex', home: string = dshHome()): string {
  const path = join(home, 'system', 'mcp.json')
  if (!existsSync(path)) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const { url } = JSON.parse(readFileSync(path, 'utf8')) as Discovery
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
 * (ADR-0022). Its apiKeyHelper runs `system mcp-token` per connection, so the token is never
 * printed, exported, or written to Claude Code's settings.
 */
export function claudeGatewayCommand(home: string = dshHome()): string {
  const path = join(home, 'system', 'mcp.json')
  if (!existsSync(path)) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const { url } = JSON.parse(readFileSync(path, 'utf8')) as Discovery
  const helper = `${process.execPath} ${fileURLToPath(new URL('./bin.js', import.meta.url))} mcp-token`
  return `ANTHROPIC_BASE_URL=${new URL(url).origin}/anthropic claude --settings '${JSON.stringify({ apiKeyHelper: helper })}'`
}

/**
 * A command that runs Codex on the Responses gateway with a `system` model provider (ADR-0022).
 * The token reaches Codex only through its env_key variable, set from `system mcp-token` in a
 * subshell, so it is never printed. Codex's own retries are off: a retried request would send a
 * website turn again.
 */
export function codexGatewayCommand(home: string = dshHome()): string {
  const path = join(home, 'system', 'mcp.json')
  if (!existsSync(path)) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const { url } = JSON.parse(readFileSync(path, 'utf8')) as Discovery
  const helper = `${process.execPath} ${fileURLToPath(new URL('./bin.js', import.meta.url))} mcp-token`
  const provider = `{name="system",base_url="${new URL(url).origin}/openai/v1",env_key="SYSTEM_MCP_TOKEN",wire_api="responses",request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=900000}`
  return `SYSTEM_MCP_TOKEN="$(${helper})" codex -c model_provider=system -c 'model_providers.system=${provider}' -m system-standard`
}

/** `{"Authorization": "Bearer <token>"}` for a client's headersHelper (Claude Code). */
export function mcpHeaders(home: string = dshHome()): string {
  return JSON.stringify({ Authorization: `Bearer ${mcpToken(home)}` })
}

/** The bearer token alone, for `export SYSTEM_MCP_TOKEN="$(system mcp-token)"`. */
export function mcpToken(home: string = dshHome()): string {
  const { tokenFile } = JSON.parse(readFileSync(join(home, 'system', 'mcp.json'), 'utf8')) as Discovery
  return readFileSync(tokenFile).toString('base64url')
}

/**
 * The web UI's address for the running profile. The token rides in the fragment, which a
 * browser never sends to a server; the page moves it to session storage and drops it.
 */
export function uiUrl(home: string = dshHome()): string {
  const { url } = JSON.parse(readFileSync(join(home, 'system', 'mcp.json'), 'utf8')) as Discovery
  return `${new URL(url).origin}/ui/#token=${mcpToken(home)}`
}

export interface ToolOutcome {
  isError: boolean
  text: string
  structured: Record<string, unknown> | undefined
}

/** Call a tool on the running profile's MCP endpoint, authenticated from the discovery file. */
export async function callTool(name: string, args: Record<string, unknown>, home: string = dshHome()): Promise<ToolOutcome> {
  const path = join(home, 'system', 'mcp.json')
  if (!existsSync(path)) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const { url, tokenFile } = JSON.parse(readFileSync(path, 'utf8')) as Discovery
  const token = readFileSync(tokenFile).toString('base64url')
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
    const path = join(home, 'system', 'mcp.json')
    if (!existsSync(path)) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
    const { url, tokenFile } = JSON.parse(readFileSync(path, 'utf8')) as Discovery
    const client = new Client({ name: 'system-mcp-stdio', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${readFileSync(tokenFile).toString('base64url')}` } } }) as unknown as Transport)
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
