/**
 * The `--config` overrides every Codex run and probe starts with: the operator's configuration,
 * then what the runtime pins (docs/design/agent-runtimes.md#tool-gate). One serialization for both,
 * so the probe proves what a run gets.
 * @module @tsuuanmi/system-runtime-codex-sdk/overrides
 */
import { GATE_ENV } from './gate.ts'

/**
 * Codex features the runtime turns off: each adds tools a hook does not see (hosted tools that run
 * at the model's provider), work that runs outside the run (subagents, remote apps), or servers
 * started outside Codex's sandbox (plugins, MCP installs). A name Codex does not know is ignored by it.
 */
export const FEATURES_OFF: readonly string[] = [
  'apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'image_generation', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser',
  'code_mode', 'code_mode_only', 'tool_suggest', 'skill_mcp_dependency_install', 'standalone_web_search', 'goals', 'memories',
]

const BARE_KEY = /^[A-Za-z0-9_-]+$/
const isTable = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A TOML value, as `--config` parses it; `where` names it in an error. */
function toml(value: unknown, where: string): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${where} is not a finite number`)
    return String(value)
  }
  if (typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map((v, i) => toml(v, `${where}[${i}]`)).join(', ')}]`
  if (isTable(value)) return `{${Object.entries(value).map(([k, v]) => `${BARE_KEY.test(k) ? k : JSON.stringify(k)} = ${toml(v, `${where}.${k}`)}`).join(', ')}}`
  throw new Error(`${where} holds a value TOML does not take`)
}

/** `config` as dotted `key=value` overrides, one per leaf, as the Codex SDK flattens it. */
function flatten(config: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(config).flatMap(([key, value]) => {
    if (!BARE_KEY.test(key)) throw new Error(`the config key ${JSON.stringify(key)} is not a bare TOML key`)
    const path = prefix ? `${prefix}.${key}` : key
    if (isTable(value) && Object.keys(value).length) return flatten(value, path)
    if (value === undefined) return []
    return [`${path}=${toml(value, path)}`]
  })
}

/**
 * Why the operator's configuration cannot be held exactly, or undefined: an MCP server (started
 * outside Codex's sandbox), its own hooks (the gate's hook is the run's), a feature the runtime
 * turns off turned on, hooks turned off, or an environment exclusion that is not a list of names.
 */
export function refused(config: Record<string, unknown>): string | undefined {
  if ('mcp_servers' in config) return 'mcp_servers in config would reach the Worker outside its sandbox'
  if ('hooks' in config) return 'hooks in config: the run\'s tool gate is its only hook'
  const features = isTable(config.features) ? config.features : {}
  const on = FEATURES_OFF.find((name) => features[name] !== undefined && features[name] !== false)
  if (on) return `features.${on} in config: the runtime keeps it off, since its tools or servers would bypass the run's tool gate`
  if (features.hooks !== undefined && features.hooks !== true) return 'features.hooks in config: the run\'s tool gate is a hook'
  const exclude = isTable(config.shell_environment_policy) ? config.shell_environment_policy.exclude : undefined
  if (exclude !== undefined && !(Array.isArray(exclude) && exclude.every((e) => typeof e === 'string'))) return 'shell_environment_policy.exclude in config is not a list of names'
  try {
    flatten(config)
  } catch (error) {
    return (error as Error).message
  }
  return undefined
}

/**
 * The operator's configuration, then the runtime's pins: the features above off, hooks on, and the
 * gate channel's variables kept from Codex's commands (added to the operator's own exclusions). Call
 * only on a configuration {@link refused} accepts.
 */
export function configOverrides(config: Record<string, unknown> = {}): string[] {
  const policy = isTable(config.shell_environment_policy) ? config.shell_environment_policy : undefined
  const own = (policy?.exclude as string[] | undefined) ?? []
  const rest = policy ? { ...config, shell_environment_policy: Object.fromEntries(Object.entries(policy).filter(([k]) => k !== 'exclude')) } : config
  return [
    ...flatten(rest),
    ...FEATURES_OFF.map((name) => `features.${name}=false`), 'features.hooks=true',
    `shell_environment_policy.exclude=${toml([...own, `${GATE_ENV.socket}`, `${GATE_ENV.key}`], 'shell_environment_policy.exclude')}`,
  ]
}
