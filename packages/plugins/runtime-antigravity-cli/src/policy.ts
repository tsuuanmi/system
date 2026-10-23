/**
 * The runtime's own policy for the Antigravity CLI's tool calls, held by its PreToolUse hook
 * before the run's gate is asked (docs/design/agent-runtimes.md#tool-gate). Antigravity has no
 * per-tool allow-list or workspace-scoped permission of its own that a headless run can be held
 * to, so the hook is where the configured policy is enforced, exactly or not at all:
 * - only the tools of the run's sandbox exist: reading tools for `read-only`, file edits added for
 *   `workspace-write`; no command, browser, web, subagent, MCP, or scheduling tool in any run;
 * - every location a call names is inside the run's workspace, on disk (symlinks followed);
 * - nothing writes a customization root (`.agents/` and its spellings), whose hooks and MCP
 *   servers Antigravity would run outside every gate.
 * Tool names are as Antigravity's hooks name them: the name the model calls (`read_file`), which is
 * also the stream's `tool_name`, not the lowercased step type its hooks guide describes, as the
 * supervised live check of agy 1.4.6 with `gemini-3.8-flash` recorded
 * (`tests/fixtures/agy-1.4.6-hook-inputs.json`). That model's file tools are `read_file`,
 * `write_file`, and `edit_file`; it has no tool that lists or searches a directory (it would run a
 * command for that, which no run offers), and other models' toolsets are not verified, so their
 * tools are denied. Their inputs are the model's arguments; only the fields that hold text, never
 * a location, are known by name. Every other string is read as a location, so an input this
 * runtime does not know is held to the workspace or denied.
 * @module @tsuuanmi/system-runtime-antigravity-cli/policy
 */
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SandboxMode } from '@tsuuanmi/system-agent-runtime-core'

/** Tools that only read the workspace: `read_file` (`Path`, and a line or byte range). */
export const READ_TOOLS = ['read_file'] as const
/** Tools that change one file: `write_file` (`Path`, `Content`, to create, overwrite, or append) and `edit_file` (`Path`, `Target` replaced by `Replacement`). */
export const WRITE_TOOLS = ['write_file', 'edit_file'] as const

/** The tools each sandbox offers; absent from both, a tool is denied in every run. */
export const TOOLS: Record<SandboxMode, readonly string[]> = { 'read-only': READ_TOOLS, 'workspace-write': [...READ_TOOLS, ...WRITE_TOOLS] }

/**
 * Input fields that hold text, never a location: a file's new content, and the text an edit
 * replaces and its replacement. Their strings, at any depth, are not read as locations.
 */
const TEXT_FIELDS = new Set(['Content', 'Target', 'Replacement'])

/** The directory names Antigravity discovers customizations in, walking up from its working directory to the repository root. */
export const CUSTOMIZATION_ROOTS = ['.agents', '.agent', '_agents', '_agent'] as const
/** What in a customization root runs outside every gate: lifecycle hooks, MCP servers, and plugins (which bundle both). */
const EXECUTABLE_CUSTOMIZATIONS = ['hooks.json', 'mcp_config.json', 'plugins.json', 'plugins'] as const

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Where `path` (absolute) is on disk: its real path, or for one that does not exist yet its
 * deepest existing ancestor's real path with the rest appended (which must hold no `..`).
 * Undefined when it cannot be resolved (a dangling symlink, a loop, a permission error).
 */
function realLocation(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
  }
  const segments = path.split(sep).filter((s) => s !== '' && s !== '.')
  for (let i = segments.length; i >= 0; i -= 1) {
    const ancestor = sep + segments.slice(0, i).join(sep)
    try {
      lstatSync(ancestor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      return undefined
    }
    const rest = segments.slice(i)
    if (rest.includes('..')) return undefined
    try {
      return join(realpathSync.native(ancestor), ...rest)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * The real location inside the workspace that `value` names, or why it is not one: an absolute
 * path, a `file:` URI, or a path relative to the workspace, each inside it both as written and on
 * disk. A home path (`~`), a `..` segment, a NUL, and any other URI are never inside.
 */
function locate(workspace: string, value: string): { at: string } | { refused: string } {
  const shown = JSON.stringify(value.length > 120 ? `${value.slice(0, 119)}…` : value)
  if (value.includes('\0') || value.startsWith('~')) return { refused: `${shown} is not inside the workspace` }
  let path = value
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    if (!value.toLowerCase().startsWith('file:')) return { refused: `${shown} is not a location inside the workspace` }
    try {
      path = fileURLToPath(value)
    } catch {
      return { refused: `${shown} is not a location inside the workspace` }
    }
  }
  if (path.split(/[\\/]/).includes('..')) return { refused: `${shown} climbs out with ..` }
  const root = resolve(workspace)
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path)
  let realRoot: string
  try {
    realRoot = realpathSync.native(root)
  } catch {
    return { refused: 'the workspace cannot be resolved' }
  }
  const real = inside(root, absolute) ? realLocation(absolute) : undefined
  return real !== undefined && inside(realRoot, real) ? { at: real } : { refused: `${shown} is not inside the workspace` }
}

/** Every string an input holds outside its text fields, each with the field it is under. */
function locations(input: Record<string, unknown>): Array<{ field: string; value: string }> {
  const found: Array<{ field: string; value: string }> = []
  const walk = (field: string, value: unknown): void => {
    if (typeof value === 'string') found.push({ field, value })
    else if (Array.isArray(value)) for (const item of value) walk(field, item)
    else if (isObject(value)) for (const [key, inner] of Object.entries(value)) if (!TEXT_FIELDS.has(key)) walk(`${field}.${key}`, inner)
  }
  for (const [key, value] of Object.entries(input)) if (!TEXT_FIELDS.has(key)) walk(key, value)
  return found
}

/** Whether `real` (inside the real workspace `realRoot`) lies in a customization root. */
function inCustomizationRoot(realRoot: string, real: string): boolean {
  const parts = real.slice(realRoot.length).split(sep).filter(Boolean)
  return parts.some((part) => (CUSTOMIZATION_ROOTS as readonly string[]).includes(part))
}

/**
 * Why the runtime's own policy refuses one tool call, or undefined when it allows it: the tool
 * must be one `offered` (the run's sandbox, narrowed by its tool list), its input an object, every
 * location it names inside the workspace, and a file edit must not touch a customization root.
 */
export function refusal(call: { tool: string; input: unknown }, workspace: string, offered: readonly string[]): string | undefined {
  if (!offered.includes(call.tool)) return `${call.tool} is not a tool this run offers (${offered.join(', ')})`
  if (!isObject(call.input)) return `the input of ${call.tool} is not an object`
  const writes = (WRITE_TOOLS as readonly string[]).includes(call.tool)
  let realRoot: string
  try {
    realRoot = realpathSync.native(resolve(workspace))
  } catch {
    return 'the workspace cannot be resolved'
  }
  for (const { field, value } of locations(call.input)) {
    const where = locate(workspace, value)
    if ('refused' in where) return `${call.tool} ${field}: ${where.refused}`
    if (writes && inCustomizationRoot(realRoot, where.at)) return `${call.tool} ${field}: a customization root (${CUSTOMIZATION_ROOTS.join(', ')}) is never written, since Antigravity would run its hooks and MCP servers outside the run's gate`
  }
  return undefined
}

/**
 * The customization roots Antigravity would load for a session in `workspace` that hold hooks,
 * MCP servers, or plugins: it walks from its working directory up to the repository root (the
 * nearest directory holding `.git`); with no repository above, only the workspace itself. Each is
 * named as `<root>/<entry>`; an empty list means none.
 */
export function workspaceCustomizations(workspace: string): string[] {
  const chain: string[] = []
  let dir = resolve(workspace)
  for (;;) {
    chain.push(dir)
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) {
      chain.splice(1)
      break
    }
    dir = parent
  }
  return chain.flatMap((d) => CUSTOMIZATION_ROOTS.flatMap((root) => EXECUTABLE_CUSTOMIZATIONS.filter((entry) => existsSync(join(d, root, entry))).map((entry) => join(d, root, entry))))
}
