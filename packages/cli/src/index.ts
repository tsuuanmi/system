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
