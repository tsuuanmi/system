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

interface Discovery { url: string; tokenFile: string }

/** Client configuration snippets for Claude Code and Codex, from the running profile's discovery file. */
export function mcpConfig(client: 'claude' | 'codex', home: string = dshHome()): string {
  const path = join(home, 'system', 'mcp.json')
  if (!existsSync(path)) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const { url } = JSON.parse(readFileSync(path, 'utf8')) as Discovery
  // The token is never printed here (shell history); clients read it from the environment.
  const exportLine = 'export SYSTEM_MCP_TOKEN="$(system mcp-token)"'
  if (client === 'claude') return [exportLine, `claude mcp add --transport http system ${url} --header "Authorization: Bearer $SYSTEM_MCP_TOKEN"`].join('\n')
  return [exportLine, '', '# ~/.codex/config.toml', '[mcp_servers.system]', `url = "${url}"`, 'bearer_token_env_var = "SYSTEM_MCP_TOKEN"'].join('\n')
}

/** The bearer token alone, for `export SYSTEM_MCP_TOKEN="$(system mcp-token)"`. */
export function mcpToken(home: string = dshHome()): string {
  const { tokenFile } = JSON.parse(readFileSync(join(home, 'system', 'mcp.json'), 'utf8')) as Discovery
  return readFileSync(tokenFile).toString('base64url')
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

export interface AskRequest {
  prompt: string
  persist?: true
  sessionId?: string
  tier?: string
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
    else return undefined
  }
  const prompt = (rest.length === 1 && rest[0] === '-' ? await readStdin() : rest.join(' ')).trim()
  return prompt ? { prompt, ...request } : undefined
}

export async function readAllStdin(): Promise<string> {
  let text = ''
  for await (const chunk of process.stdin) text += String(chunk)
  return text
}
