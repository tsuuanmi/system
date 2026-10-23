/**
 * The PreToolUse hook of a gated Codex run (docs/design/agent-runtimes.md#tool-gate). Codex runs it
 * before each tool call, the call as JSON on stdin, inside the run's read confinement but outside
 * Codex's own sandbox. It hands the call to the run's gate over the run's private channel (a unix
 * socket in an owner-only directory, named with the run's key in `SYSTEM_CODEX_GATE_SOCKET` and
 * `SYSTEM_CODEX_GATE_KEY`) and turns the answer into Codex's hook decision:
 * - `none`: no output and exit 0, so Codex's own sandbox and approvals still decide the call;
 * - anything else: the call is blocked, exit 2 with the reason on stderr.
 * Codex runs the tool when a hook fails, prints what it cannot read, or times out (Codex 0.164), so
 * every failure here is a block, and the hook answers by itself well before Codex's timeout.
 * Standalone: Node built-ins only, nothing else to resolve inside the confinement.
 * @module @tsuuanmi/system-runtime-codex-sdk/gate-hook
 */
import { connect } from 'node:net'

/** The largest hook input passed on (a patch writing a large file); a larger call is blocked. */
const MAX_INPUT = 16 * 1024 * 1024
/** The largest answer read back. */
const MAX_ANSWER = 64 * 1024
/** How long the hook waits for the gate, above its 30 s bound and below Codex's hook timeout (120 s). */
const DEADLINE_MS = 90_000

function block(reason: string): never {
  process.stderr.write(`the run's tool gate: ${reason}`.slice(0, 4000))
  process.exit(2)
}

async function readInput(): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += (chunk as Buffer).length
    if (size > MAX_INPUT) block(`the tool call is larger than ${MAX_INPUT} bytes, which the gate does not take`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** Sends the run's key and the hook input, then reads one answer line. */
function ask(path: string, key: string, input: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    const chunks: Buffer[] = []
    let size = 0
    socket.on('connect', () => {
      socket.write(`${key}\n`)
      socket.end(input)
    })
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_ANSWER) {
        socket.destroy()
        reject(new Error('the answer is too large'))
        return
      }
      chunks.push(chunk)
    })
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    socket.on('error', reject)
  })
}

async function main(): Promise<void> {
  const path = process.env.SYSTEM_CODEX_GATE_SOCKET
  const key = process.env.SYSTEM_CODEX_GATE_KEY
  if (!path || !key) block('no gate channel is set for this run')
  const answer = JSON.parse(await ask(path, key, await readInput())) as { decision?: unknown; reason?: unknown } | null
  if (answer?.decision === 'none') process.exit(0)
  if (answer?.decision === 'deny' && typeof answer.reason === 'string') block(answer.reason)
  block('the gate gave an answer the hook does not know')
}

setTimeout(() => block(`no answer within ${DEADLINE_MS / 1000} s`), DEADLINE_MS).unref()
main().catch((error: unknown) => block(`the gate could not be asked: ${(error as Error)?.message ?? String(error)}`))
