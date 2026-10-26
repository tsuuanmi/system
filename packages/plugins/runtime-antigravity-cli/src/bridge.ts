/**
 * The bridge from the Antigravity CLI's PreToolUse hook to a run's gate (docs/design/approvals.md#a-workers-tool-calls).
 * Antigravity runs a hook as a command before each tool call, with the call as JSON on stdin, and
 * reads its decision from stdout. The runtime's home holds one `hooks.json`, written by the runtime
 * and never by anyone else, with one PreToolUse hook on every tool; its command starts the hook
 * of the run in progress, which the run names in Antigravity's environment, and denies when none
 * is named. Per run:
 * - an owner-only directory under `<DSH_HOME>/system/run` (hidden from every agent, bound back
 *   read-only into this run's confinement only) holds the run's gate socket, a copy of the hook
 *   script, and its launcher;
 * - the hook connects to that socket with the run's token (random, per run) and prints the answer;
 *   a request without the token, malformed, larger than 1 MiB, or unanswered is denied;
 * - every failure on the way is a deny: the hook's own (no token, no socket, a slow or malformed
 *   answer) and the runtime's (a gate that throws, gives an undefined verdict, or takes longer than
 *   its bound).
 * The token keeps a stale or misrouted hook from being answered; it is not a secret from the agent
 * itself, whose processes share the run's user and namespaces.
 * @module @tsuuanmi/system-runtime-antigravity-cli/bridge
 */
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { type Confinement, confinedCommand } from '@tsuuanmi/system-agent-runtime-core'
import { ensurePrivateDir, writeFileDurable } from '@tsuuanmi/system-libs'

/** The variable that names the run's hook launcher to the command in hooks.json. */
export const HOOK_ENV = 'SYSTEM_ANTIGRAVITY_GATE_HOOK'
/** The variable that carries the run's token to its hook. */
export const TOKEN_ENV = 'SYSTEM_ANTIGRAVITY_GATE_TOKEN'
/** The one hook the runtime's home configures. */
export const HOOK_NAME = 'system-tool-gate'
/** The hook's timeout in Antigravity, in seconds: above the hook script's own bound (45 s). */
const HOOK_TIMEOUT_S = 60

/**
 * The command Antigravity runs (`sh -c`, in the directory of hooks.json) before each tool call. It
 * always prints a decision itself: the run's hook's answer when the run named an executable hook
 * and it exited 0 with an answer; a deny in every other case. agy 1.4.6 blocks the tool when a hook
 * exits non-zero, times out, or prints what it cannot read, but runs it when a hook exits 0 and
 * prints nothing (the supervised live check, `tests/fixtures/agy-1.4.6-hook-inputs.json`), so an
 * empty answer is never left to agy. A session in the runtime's home that no run started (the
 * operator signing in) runs no tool without a gate.
 */
export const HOOK_COMMAND = [
  `if [ ! -x "$${HOOK_ENV}" ]; then echo '{"decision":"deny","reason":"no system tool gate is attached to this session"}'; exit 0; fi`,
  `answer=$("$${HOOK_ENV}"); status=$?`,
  `if [ "$status" -eq 0 ] && [ -n "$answer" ]; then printf '%s\\n' "$answer"; else echo '{"decision":"deny","reason":"the tool gate hook of this run gave no answer"}'; fi`,
].join('; ')

/** The runtime's hooks.json: one PreToolUse hook, on every tool (`*`), and nothing else. */
export const HOOKS_JSON = `${JSON.stringify({ [HOOK_NAME]: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_S }] }] } }, null, 2)}\n`

/** The hook script, shipped with the package (not compiled), copied into each run's directory. */
const HOOK_SCRIPT = new URL('../hook/gate-hook.mjs', import.meta.url)

/** Antigravity's global customization root inside a home it runs with (`$HOME/.gemini/config`). */
const configDir =(home: string): string => join(home, '.gemini', 'config')

/**
 * Keep the runtime's hooks.json in `home`, and say what in that home would reach a Worker outside
 * its gate. The home itself must be owner-only (it is created so; agy makes its own directories
 * inside it readable to others, which the home's mode keeps closed). The runtime's own file is
 * written when absent or stale (a single hook named {@link HOOK_NAME}); any other hooks.json, and
 * any MCP server in `mcp_config.json`, is a problem, never overwritten or ignored. Returns the
 * problems; empty when the home holds none. Throws when the home cannot be used.
 */
export function prepareHome(home: string): string[] {
  ensurePrivateDir(home)
  const dir = configDir(home)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const problems: string[] = []
  const hooks = join(dir, 'hooks.json')
  if (!existsSync(hooks)) writeFileDurable(hooks, HOOKS_JSON)
  else {
    const text = readFileSync(hooks, 'utf8')
    if (text !== HOOKS_JSON) {
      let ours = false
      try {
        const parsed = JSON.parse(text) as unknown
        ours = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).join() === HOOK_NAME
      } catch {
        // not JSON: not ours
      }
      if (ours) writeFileDurable(hooks, HOOKS_JSON)
      else problems.push(`${hooks} configures hooks other than the runtime's own`)
    }
  }
  const mcp = join(dir, 'mcp_config.json')
  if (existsSync(mcp)) {
    const text = readFileSync(mcp, 'utf8').trim()
    let servers: string[] | undefined
    try {
      const parsed = (text ? JSON.parse(text) : {}) as { mcpServers?: unknown }
      servers = parsed.mcpServers === undefined ? [] : typeof parsed.mcpServers === 'object' && parsed.mcpServers !== null ? Object.keys(parsed.mcpServers) : undefined
    } catch {
      servers = undefined
    }
    if (servers === undefined) problems.push(`${mcp} cannot be read as an MCP configuration`)
    else if (servers.length) problems.push(`${mcp} configures MCP server(s) ${servers.join(', ')}`)
  }
  return problems
}

/** A hook's answer, as the hook prints it for Antigravity. */
export type HookAnswer = { decision: 'allow' } | { decision: 'deny'; reason: string }

/** A PreToolUse call as the hook received it from Antigravity. */
export interface HookEvent {
  tool: string
  input: unknown
  /** `<conversationId>:<stepIdx>`, when Antigravity names both. */
  callId?: string | undefined
}

/** One run's gate channel: the hook's environment, and the directory to bind back read-only. */
export interface Channel {
  /** The run's owner-only directory: the socket, the hook script, and its launcher. */
  readonly dir: string
  /** What Antigravity's environment must carry for the hook to reach this channel. */
  readonly env: Record<string, string>
  close(): Promise<void>
}

/** Bounds of a channel (tests shorten them). */
export interface ChannelTiming {
  /** How long one request may take, the gate included, before it is denied (default 40 s). */
  requestMs?: number
}

/** The most one request may carry. */
const MAX_REQUEST = 1 << 20
/** The most requests answered at once; more are denied (Antigravity runs its hooks one call at a time). */
const MAX_OPEN = 16
/** The longest socket path Linux takes (`sun_path` holds 108 bytes, NUL included). */
const MAX_SOCKET_PATH = 107

const deny = (reason: string): HookAnswer => ({ decision: 'deny', reason: reason.slice(0, 1000) })

/** The tool call a PreToolUse hook carries (`toolCall.name`, `toolCall.args`), or undefined when it is not one. */
function eventOf(raw: unknown): HookEvent | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const event = raw as { toolCall?: { name?: unknown; args?: unknown }; conversationId?: unknown; stepIdx?: unknown }
  const name = event.toolCall?.name
  if (typeof name !== 'string' || !name) return undefined
  const callId = typeof event.conversationId === 'string' && event.conversationId && typeof event.stepIdx === 'number' ? `${event.conversationId}:${event.stepIdx}` : undefined
  return { tool: name, input: event.toolCall?.args === undefined ? {} : event.toolCall.args, ...(callId ? { callId } : {}) }
}

/**
 * Open one run's channel under `parent` (owner-only): its directory, the hook script and launcher
 * (`node` runs the script), and the socket, answering each request with `decide`. A request that
 * fails anywhere is denied; `decide` is never asked without the run's token.
 */
export async function openChannel(parent: string, node: string, decide: (event: HookEvent) => Promise<HookAnswer>, timing: ChannelTiming = {}): Promise<Channel> {
  ensurePrivateDir(parent)
  const dir = mkdtempSync(join(parent, 'antigravity-'))
  const socketPath = join(dir, 'gate.sock')
  try {
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw new Error(`the run's gate socket path ${socketPath} is longer than a socket path can be`)
    const script = join(dir, 'gate-hook.mjs')
    writeFileSync(script, readFileSync(HOOK_SCRIPT), { mode: 0o600, flag: 'wx' })
    const launcher = join(dir, 'hook')
    // Node takes options and module paths from its environment: the hook runs with none of them.
    writeFileSync(launcher, `#!/bin/sh\nunset NODE_OPTIONS NODE_PATH\nexec ${quote(node)} ${quote(script)}\n`, { mode: 0o700, flag: 'wx' })
    const token = randomBytes(32).toString('hex')
    const server = await listen(socketPath, token, decide, timing.requestMs ?? 40_000)
    return {
      dir,
      env: { [HOOK_ENV]: launcher, [TOKEN_ENV]: token },
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        rmSync(dir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

const quote = (arg: string): string => `'${arg.replaceAll("'", "'\\''")}'`

function listen(path: string, token: string, decide: (event: HookEvent) => Promise<HookAnswer>, requestMs: number): Promise<Server> {
  const expected = Buffer.from(token)
  let open = 0
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    open += 1
    let settled = false
    const reply = (answer: HookAnswer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.end(`${JSON.stringify(answer)}\n`)
    }
    const timer = setTimeout(() => reply(deny(`the run's tool gate did not answer within ${Math.round(requestMs / 1000)} s`)), requestMs)
    socket.on('close', () => {
      open -= 1
      clearTimeout(timer)
    })
    socket.on('error', () => socket.destroy())
    if (open > MAX_OPEN) return reply(deny('too many tool calls wait on the run\'s gate at once'))
    let buffered = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      if (settled) return
      buffered += chunk
      if (buffered.length > MAX_REQUEST) return reply(deny('the tool call is larger than the gate reads'))
      const end = buffered.indexOf('\n')
      if (end >= 0) void answer(buffered.slice(0, end))
    })
    socket.on('end', () => {
      if (!settled) void answer(buffered)
    })
    const answer = async (line: string): Promise<void> => {
      let request: { token?: unknown; event?: unknown }
      try {
        request = JSON.parse(line) as { token?: unknown; event?: unknown }
      } catch {
        return reply(deny('the hook\'s request is not JSON'))
      }
      const given = Buffer.from(typeof request.token === 'string' ? request.token : '')
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(deny('the hook did not present this run\'s token'))
      const event = eventOf(request.event)
      if (!event) return reply(deny('the hook\'s input names no tool call'))
      try {
        reply(await decide(event))
      } catch (error) {
        reply(deny(`the run's tool gate failed: ${(error as Error)?.message?.slice(0, 200) ?? String(error)}`))
      }
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      try {
        chmodSync(path, 0o600)
      } catch (error) {
        server.close()
        return reject(error as Error)
      }
      resolve(server)
    })
  })
}

/** Runs a confined command line with an environment and a working directory; resolves its stdout, rejects on a non-zero exit. */
export type ConfinedExec = (command: { command: string; args: string[] }, options: { env: Record<string, string>; cwd: string; input?: string | undefined; signal?: AbortSignal | undefined }) => Promise<string>

/** `execFile` with a bound, feeding `input` on stdin, ended by `signal`; a failure names the command's last word on stderr, not its (long, confined) command line. */
export const execConfined: ConfinedExec = (command, options) => new Promise((resolve, reject) => {
  const child = execFile(command.command, command.args, { env: options.env, cwd: options.cwd, timeout: 30_000, maxBuffer: 4 << 20, ...(options.signal ? { signal: options.signal } : {}) }, (error, stdout, stderr) => {
    if (!error) return resolve(String(stdout))
    const failure = error as Error & { code?: unknown; signal?: unknown; killed?: boolean }
    const why = failure.killed ? 'timed out' : `exit ${String(failure.code ?? failure.signal)}`
    const last = String(stderr).trim().split('\n').filter(Boolean).at(-1)
    reject(new Error(last ? `${last.slice(0, 300)} (${why})` : why))
  })
  child.stdin?.end(options.input ?? '')
})

/** The decision `answer` (a line the hook printed) says it is, or undefined. */
function printed(stdout: string): HookAnswer | undefined {
  try {
    const answer = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { decision?: unknown; reason?: unknown }
    if (answer.decision === 'allow') return { decision: 'allow' }
    if (answer.decision === 'deny' && typeof answer.reason === 'string') return { decision: 'deny', reason: answer.reason }
  } catch {
    // not an answer
  }
  return undefined
}

/** The reason a self-test's channel gives every call it is asked about. */
export const SELF_TEST_REASON = 'the hook self-test denies every call'

/**
 * Prove the host's half of the bridge for a channel whose `decide` answers {@link SELF_TEST_REASON}:
 * the command in hooks.json, run as Antigravity runs it (`sh -c` in the home's config directory,
 * with the run's environment) inside the run's confinement, reaches the channel and prints its
 * answer; and with another token it is denied before the channel is asked. What it cannot show is
 * Antigravity itself running the hook before each tool call: that takes a model turn.
 */
export async function selfTest(home: string, confinement: Confinement, env: Record<string, string>, run: ConfinedExec = execConfined): Promise<{ ok: boolean; detail: string }> {
  const event = JSON.stringify({ toolCall: { name: 'read_file', args: {} }, stepIdx: 0, conversationId: 'self-test' })
  const hook = (token: string): Promise<HookAnswer | undefined> =>
    run(confinedCommand('sh', ['-c', HOOK_COMMAND], confinement), { env: { ...env, [TOKEN_ENV]: token }, cwd: configDir(home), input: event }).then(printed)
  try {
    const answered = await hook(env[TOKEN_ENV] ?? '')
    if (answered?.decision !== 'deny' || answered.reason !== SELF_TEST_REASON) {
      return { ok: false, detail: `the hook does not reach the run's gate inside the confinement (it answered ${answered ? JSON.stringify(answered).slice(0, 160) : 'nothing'})` }
    }
    const forged = await hook(randomBytes(32).toString('hex'))
    if (forged?.decision !== 'deny' || forged.reason === SELF_TEST_REASON) return { ok: false, detail: 'the run\'s gate answered a hook without the run\'s token' }
    return { ok: true, detail: 'the hook reaches the run\'s gate inside the confinement' }
  } catch (error) {
    return { ok: false, detail: `the hook does not run inside the confinement: ${(error as Error).message.split('\n')[0]!.slice(0, 160)}` }
  }
}
