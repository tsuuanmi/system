// A `codex app-server` stand-in for the usage report's tests: JSON-RPC over stdio, one message per
// line, without the `jsonrpc` member. It answers `initialize` (after a notification of its own) and
// `account/rateLimits/read` as FAKE_APP_SERVER_MODE says, with FAKE_APP_SERVER_ANSWER as the rate
// limits' result, and appends its argv, directory, and every line it reads to FAKE_APP_SERVER_LOG.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_APP_SERVER_MODE ?? 'answer'
const answer = JSON.parse(process.env.FAKE_APP_SERVER_ANSWER ?? '{}')
const log = process.env.FAKE_APP_SERVER_LOG
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
if (log) appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  if (log) appendFileSync(log, `${line}\n`)
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    if (mode === 'refuse-initialize') return write({ id: message.id, error: { code: -32600, message: 'Invalid request: clientInfo' } })
    write({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: null, secondary: null } } })
    return write({ id: message.id, result: { userAgent: 'codex_cli_rs/0.164.0' } })
  }
  if (message.method === 'account/rateLimits/read') {
    if (mode === 'hang') return undefined
    if (mode === 'exit') process.exit(3)
    if (mode === 'garbage') return process.stdout.write('thread panicked\n')
    if (mode === 'error') return write({ id: message.id, error: { code: -32603, message: 'codex account authentication required to read rate limits' } })
    return write({ id: message.id, result: answer })
  }
  return undefined
})
