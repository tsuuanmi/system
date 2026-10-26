/**
 * The bridge between a gated Codex run and its tool gate (docs/design/agent-runtimes.md#tool-gate).
 * Codex asks a PreToolUse hook before each tool call; the hook is a command Codex runs, so it
 * reaches the run's in-process gate through a private channel the run opens:
 * - a unix socket in a fresh owner-only directory under the runtime's run directory, bound into
 *   the run's read confinement read-only, and a 256-bit key the hook must send first; Codex's own
 *   commands never see the key (`shell_environment_policy.exclude`);
 * - one connection per call: the key, then the hook's input; one answer: `none` or `deny`;
 * - bounded: the input's size, the connections at once, and each connection's time.
 * The hook's definition is passed as a `--config` override per run, trusted by its hash, so Codex
 * runs it without a prompt and without trusting any other hook. The verdicts: `allow` answers
 * `none` (Codex's own sandbox still decides), `deny` blocks with the reason, `defer` blocks with the
 * reason and ends the run (Codex's hooks cannot stop a turn), and every later call is denied.
 * @module @tsuuanmi/system-runtime-codex-sdk/gate
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { type Server, type Socket, createServer } from 'node:net'
import { join } from 'node:path'
import { type ToolGate, askToolGate } from '@tsuuanmi/system-agent-runtime-core'
import { ensurePrivateDir } from '@tsuuanmi/system-libs'

/** The environment variables that name a run's channel to its hook. */
export const GATE_ENV = { socket: 'SYSTEM_CODEX_GATE_SOCKET', key: 'SYSTEM_CODEX_GATE_KEY' } as const
/** Codex's hook timeout, in its unit (seconds): above the hook's own deadline (90 s), so the hook always answers itself. */
const HOOK_TIMEOUT_S = 120
/** The largest hook input the channel takes (the hook refuses a larger one first). */
const MAX_INPUT = 16 * 1024 * 1024
/** Calls asked at once; a further one is refused (blocked by its hook). */
const MAX_CONNECTIONS = 16
/** How long one connection may stay open: past the hook's own deadline. */
const CONNECTION_MS = 100_000
/** The longest path a unix socket takes on Linux (`sun_path`, less its NUL). */
const MAX_SOCKET_PATH = 107

/** The tool call a run's gate deferred: the run stops there. */
export interface Deferral {
  tool: string
  callId?: string | undefined
  requestId: string
  reason: string
}

/**
 * Codex's own items a tool call produces, by the tool name its hook reports: a command
 * (`exec_command`, reported as `Bash`), a patch, an MCP tool. A call whose tool produces none
 * (`view_image`) is not counted.
 */
function itemOf(tool: string): string | undefined {
  if (tool === 'Bash') return 'command_execution'
  if (tool === 'apply_patch') return 'file_change'
  if (tool.startsWith('mcp__')) return 'mcp_tool_call'
  return undefined
}

const shellQuote = (arg: string): string => `'${arg.replaceAll("'", "'\\''")}'`
const tomlString = (value: string): string => JSON.stringify(value)

/** Sorted-key JSON, as Codex hashes a hook's definition. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}

/**
 * The `--config` overrides that install the gate hook for one run: the PreToolUse hook on every
 * tool (`*`), and its trust, so Codex runs exactly this hook without a prompt. Codex trusts a hook
 * by the hash of its definition (`sha256` of its sorted-key JSON: event, matcher, handlers), kept
 * under its key (`<source>:pre_tool_use:<group>:<handler>`, the source of a `--config` hook being
 * `/<session-flags>/config.toml`); a definition that hashes otherwise stays untrusted and never
 * runs, which the probe would see (Codex 0.164). The command runs the hook script with `node`.
 */
export function hookOverrides(node: string, script: string): string[] {
  const command = `${shellQuote(node)} ${shellQuote(script)}`
  const definition = { event_name: 'pre_tool_use', matcher: '*', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S, async: false }] }
  const hash = `sha256:${createHash('sha256').update(canonical(definition)).digest('hex')}`
  return [
    `hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command=${tomlString(command)},timeout=${HOOK_TIMEOUT_S}}]}]`,
    `hooks.state={${tomlString('/<session-flags>/config.toml:pre_tool_use:0:0')}={trusted_hash=${tomlString(hash)}}}`,
  ]
}

/** What the channel answers the hook. */
type Answer = { decision: 'none' } | { decision: 'deny'; reason: string }

export interface GateChannel {
  /** The owner-only directory that holds the socket; bound into the run's confinement read-only. */
  readonly dir: string
  /** The variables that name the channel to the hook (Codex passes its environment to hooks). */
  readonly env: Record<string, string>
  /** The call the gate deferred, once it deferred one. */
  deferral(): Deferral | undefined
  /** Takes one allowed call that produces Codex items of `item`; false when the gate allowed none. */
  consume(item: string): boolean
  close(): Promise<void>
}

export interface ChannelOptions {
  /** The owner-only directory a run's channel directory is made in. */
  parent: string
  gate: ToolGate
  /** The run's workspace: a call Codex reports from another directory is denied. */
  workspace: string
  /** The run's signal: aborts a pending gate. */
  signal: AbortSignal
  /** Called once, when the gate defers a call: the run ends there. */
  onDefer: () => void
}

const real = (path: string): string | undefined => {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** Opens a run's channel: listening when it resolves. Throws when the socket cannot be made. */
export async function openGateChannel(options: ChannelOptions): Promise<GateChannel> {
  ensurePrivateDir(options.parent)
  const dir = mkdtempSync(join(options.parent, 'codex-gate-'))
  const path = join(dir, 'gate.sock')
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(`the gate socket path ${path} is longer than a unix socket takes (${MAX_SOCKET_PATH} bytes); give the runtime a shorter DSH home`)
  }
  const key = randomBytes(32).toString('hex')
  const presented = Buffer.from(key)
  const workspace = real(options.workspace)
  let deferred: Deferral | undefined
  const allowed = new Map<string, number>()
  const sockets = new Set<Socket>()

  /** Once a call is deferred, every other call is denied: the run stops at the deferred one. */
  const stopped = (): Answer | undefined => deferred && { decision: 'deny', reason: `the run stopped at tool call ${deferred.tool}, which waits for approval request ${deferred.requestId}; no further tool call runs` }

  const judge = async (raw: Buffer): Promise<Answer> => {
    const newline = raw.indexOf(10)
    const given = newline < 0 ? Buffer.alloc(0) : raw.subarray(0, newline)
    if (given.length !== presented.length || !timingSafeEqual(given, presented)) {
      return { decision: 'deny', reason: 'the hook did not present this run\'s key' }
    }
    let input: Record<string, unknown>
    try {
      input = JSON.parse(raw.subarray(newline + 1).toString('utf8')) as Record<string, unknown>
    } catch {
      return { decision: 'deny', reason: 'the hook input is not JSON' }
    }
    if (!input || typeof input !== 'object' || input.hook_event_name !== 'PreToolUse' || typeof input.tool_name !== 'string' || !input.tool_name || !('tool_input' in input)) {
      return { decision: 'deny', reason: 'the hook input is not a PreToolUse call' }
    }
    const tool = input.tool_name
    // The gate places relative paths in the run's workspace: a call from anywhere else is not one it judged.
    if (typeof input.cwd !== 'string' || !workspace || real(input.cwd) !== workspace) {
      return { decision: 'deny', reason: `${tool} comes from ${typeof input.cwd === 'string' ? input.cwd : 'no directory'}, not the run's workspace` }
    }
    const before = stopped()
    if (before) return before
    const callId = typeof input.tool_use_id === 'string' && input.tool_use_id ? input.tool_use_id : undefined
    const verdict = await askToolGate(options.gate, { tool, input: input.tool_input, ...(callId ? { callId } : {}) }, options.signal)
    if (verdict.decision === 'allow') {
      // A call judged meanwhile may have deferred: the run stops there, and this one does not run.
      const after = stopped()
      if (after) return after
      const item = itemOf(tool)
      if (item) allowed.set(item, (allowed.get(item) ?? 0) + 1)
      return { decision: 'none' }
    }
    if (verdict.decision === 'defer') {
      if (!deferred) {
        deferred = { tool, callId, requestId: verdict.requestId, reason: verdict.reason }
        queueMicrotask(options.onDefer)
      }
      return { decision: 'deny', reason: `${verdict.reason} (approval request ${verdict.requestId}); the run stops here` }
    }
    return { decision: 'deny', reason: verdict.reason }
  }

  const serve = (socket: Socket): void => {
    if (sockets.size >= MAX_CONNECTIONS) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.setTimeout(CONNECTION_MS, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    const chunks: Buffer[] = []
    let size = 0
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_INPUT + 1024) {
        socket.destroy()
        return
      }
      chunks.push(chunk)
    })
    socket.on('end', () => {
      judge(Buffer.concat(chunks))
        .catch((error: unknown): Answer => ({ decision: 'deny', reason: `the gate could not judge this call: ${(error as Error)?.message?.slice(0, 200) ?? String(error)}` }))
        .then((answer) => {
          if (!socket.destroyed) socket.end(`${JSON.stringify(answer.decision === 'deny' ? { ...answer, reason: answer.reason.slice(0, 2000) } : answer)}\n`)
        }, () => socket.destroy())
    })
  }

  const server: Server = createServer({ allowHalfOpen: true }, serve)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return {
    dir,
    env: { [GATE_ENV.socket]: path, [GATE_ENV.key]: key },
    deferral: () => deferred,
    consume: (item) => {
      const left = allowed.get(item) ?? 0
      if (left <= 0) return false
      allowed.set(item, left - 1)
      return true
    },
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
      await closed
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
