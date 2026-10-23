// The Antigravity CLI's PreToolUse hook for one `system` Worker run (runtime-antigravity-cli).
// The runtime copies this file into the run's own owner-only directory, beside the run's gate
// socket, and starts it there; Antigravity runs it before each tool call, with the call on stdin.
// It asks the run's gate over that socket, with the run's token, and prints Antigravity's hook
// decision. Anything else (no token, no socket, a slow or malformed answer, any error) is a deny.
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The most this hook reads, from Antigravity or from the gate. */
const MAX_BYTES = 1 << 20
/** Below the hook's own timeout in hooks.json (60 s), above the gate's bound (30 s): the hook always answers itself. */
const LIMIT_MS = 45_000

let answered = false
function answer(verdict) {
  if (answered) return
  answered = true
  process.stdout.write(`${JSON.stringify(verdict)}\n`, () => process.exit(0))
}
const deny = (reason) => answer({ decision: 'deny', reason: String(reason).slice(0, 1000) })
const failed = (error) => deny(`the run's tool gate could not be asked: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`)

setTimeout(() => deny(`the run's tool gate did not answer within ${LIMIT_MS / 1000} s`), LIMIT_MS).unref()
process.on('uncaughtException', failed)

function readAll(stream, onDone) {
  const chunks = []
  let size = 0
  stream.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BYTES) return deny('the tool call is larger than the hook reads')
    chunks.push(chunk)
  })
  stream.on('error', failed)
  stream.on('end', () => onDone(Buffer.concat(chunks).toString('utf8')))
}

const token = process.env.SYSTEM_ANTIGRAVITY_GATE_TOKEN
if (!token) deny('no system tool gate is attached to this session')
else {
  readAll(process.stdin, (text) => {
    let event
    try {
      event = JSON.parse(text)
    } catch {
      return deny('the hook input is not JSON')
    }
    const socket = connect(join(dirname(fileURLToPath(import.meta.url)), 'gate.sock'))
    socket.on('error', failed)
    socket.on('connect', () => socket.end(`${JSON.stringify({ token, event })}\n`))
    readAll(socket, (reply) => {
      let verdict
      try {
        verdict = JSON.parse(reply.split('\n')[0])
      } catch {
        return deny('the run\'s tool gate gave no answer')
      }
      if (verdict?.decision === 'allow' && Object.keys(verdict).length === 1) return answer({ decision: 'allow' })
      if (verdict?.decision === 'deny' && typeof verdict.reason === 'string') return deny(verdict.reason)
      return deny('the run\'s tool gate gave an answer the hook does not define')
    })
  })
}
