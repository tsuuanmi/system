/**
 * The `system` CLI: creates the `system` DSH profile (only `@tsuuanmi/system-bundle`, no
 * dsh-base) and boots it through the `dsh` launcher, the supported pattern (ADR-0018/0019).
 * @module @tsuuanmi/system-cli
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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
export function init(home: string = dshHome()): string {
  const dir = profileDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const bundleDir = dirname(require.resolve('@tsuuanmi/system-bundle/package.json'))
  const manifest = {
    name: 'dsh-profile-system',
    private: true,
    dependencies: { '@tsuuanmi/system-bundle': `link:${bundleDir}` },
    dsh: { profile: { bundles: ['@tsuuanmi/system-bundle'] } },
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  if (!existsSync(join(dir, 'cordis.patch.yml'))) writeFileSync(join(dir, 'cordis.patch.yml'), '# Operator overrides for the system profile.\n[]\n')
  const install = spawnSync(process.execPath, [dshBin(), 'plugin', '--profile', PROFILE, 'install'], {
    env: dshEnv({ ...process.env, DSH_HOME: home }), stdio: 'inherit',
  })
  if (install.status !== 0) throw new Error(`dsh plugin install failed with status ${install.status}`)
  return dir
}

/** Boot the profile in the foreground, forwarding extra launcher arguments (e.g. `--patch`). */
export function start(args: readonly string[] = [], home: string = dshHome()): Promise<number> {
  const child = spawn(process.execPath, [dshBin(), '--profile', PROFILE, ...args], { env: dshEnv({ ...process.env, DSH_HOME: home }), stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  return new Promise((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1))))
}

interface Discovery { url: string; tokenFile: string }

/** Client configuration snippets for Claude Code and Codex, from the running profile's discovery file. */
export function mcpConfig(client: 'claude' | 'codex', home: string = dshHome()): string {
  const path = join(home, 'system', 'mcp.json')
  if (!existsSync(path)) throw new Error(`no discovery file at ${path}; is \`system start\` running?`)
  const { url, tokenFile } = JSON.parse(readFileSync(path, 'utf8')) as Discovery
  const token = readFileSync(tokenFile).toString('base64url')
  if (client === 'claude') return `claude mcp add --transport http system ${url} --header "Authorization: Bearer ${token}"`
  return [
    '# ~/.codex/config.toml',
    '[mcp_servers.system]',
    `url = "${url}"`,
    'bearer_token_env_var = "SYSTEM_MCP_TOKEN"',
    '',
    `# then: export SYSTEM_MCP_TOKEN=${token}`,
  ].join('\n')
}
