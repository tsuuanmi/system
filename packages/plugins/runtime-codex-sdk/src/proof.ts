/**
 * The probe's proof that Codex asks the run's gate before a tool call, on this host, with no model
 * and no account: Codex runs one turn against a scripted model on loopback (a Responses endpoint
 * that only this probe serves, under a random path), through the same confinement, configuration,
 * and gate hook as a run. The scripted model asks for two commands and then answers:
 * 1. `echo <nonce>`, which the probe's gate denies: its reason must come back as the call's output,
 *    and the command must not have run (the hook ran before the tool, and its deny held);
 * 2. `cat` on a terminal (`tty`), which the gate allows: no terminal session may start, since
 *    `write_stdin` writes to a running session without asking any hook;
 * 3. a final message, which must come back as the turn's last message.
 * The first request must offer only tools Codex runs itself (`function`, `custom`): a hosted tool
 * (web search, image generation) runs at the model's provider, where no hook sees it.
 * @module @tsuuanmi/system-runtime-codex-sdk/proof
 */
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ToolCall, ToolGate } from '@tsuuanmi/system-agent-runtime-core'

/** The largest request the scripted model reads. */
const MAX_REQUEST = 8 * 1024 * 1024

interface ProbeRequest {
  tools: Array<{ type?: unknown; name?: unknown }>
  outputs: Map<string, string>
}

export interface ProbeModel {
  /** The Responses base URL Codex is given (`…/v1`). */
  readonly baseUrl: string
  /** What Codex sent, in order: the tools it offered and the outputs of earlier calls by call id. */
  readonly requests: ProbeRequest[]
  close(): Promise<void>
}

const fc = (n: number, cmd: string, extra: Record<string, unknown> = {}) => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'exec_command', arguments: JSON.stringify({ cmd, ...extra }) })
const message = (text: string) => ({ type: 'message', role: 'assistant', id: 'msg_probe', content: [{ type: 'output_text', text }] })

/** The scripted model: serves `POST <random>/v1/responses` on loopback, three answers in turn. */
export async function startProbeModel(nonce: string): Promise<ProbeModel> {
  const requests: ProbeRequest[] = []
  const prefix = `/${nonce}/v1`
  const reply = (n: number): unknown[] => {
    if (n === 0) return [fc(1, `echo ${nonce}`)]
    if (n === 1) return [fc(2, 'cat', { tty: true, yield_time_ms: 1000 })]
    return [message(`probe-ok-${nonce}`)]
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST) req.destroy()
      else chunks.push(chunk)
    })
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== `${prefix}/responses`) {
        res.writeHead(404).end()
        return
      }
      let body: { tools?: unknown; input?: unknown }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
      } catch {
        res.writeHead(400).end()
        return
      }
      const outputs = new Map<string, string>()
      for (const item of Array.isArray(body.input) ? body.input as Array<Record<string, unknown>> : []) {
        if (item?.type === 'function_call_output' && typeof item.call_id === 'string') outputs.set(item.call_id, typeof item.output === 'string' ? item.output : JSON.stringify(item.output))
      }
      const n = requests.length
      requests.push({ tools: Array.isArray(body.tools) ? body.tools as ProbeRequest['tools'] : [], outputs })
      const id = `resp_probe_${n}`
      const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      send('response.created', { response: { id } })
      for (const item of reply(n)) send('response.output_item.done', { item })
      send('response.completed', { response: { id, usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } })
      res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}${prefix}`, requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

/** The probe's own gate: it denies the first scripted command, allows the second, and denies anything else. */
export function probeGate(nonce: string, calls: ToolCall[]): ToolGate {
  return async (call) => {
    calls.push(call)
    const command = (call.input as { command?: unknown } | null)?.command
    if (call.tool === 'Bash' && command === `echo ${nonce}`) return { decision: 'deny', reason: `probe-deny-${nonce}` }
    if (call.tool === 'Bash' && command === 'cat') return { decision: 'allow' }
    return { decision: 'deny', reason: 'not a call of the probe' }
  }
}

/**
 * Why the proof failed, or undefined when it holds: what the gate was asked, what the scripted
 * model saw, and the turn's JSON events (Codex's stdout).
 */
export function proofFailure(nonce: string, calls: ToolCall[], model: ProbeModel, stdout: string): string | undefined {
  const [first, second, third] = model.requests
  if (!first) return 'Codex did not reach the probe\'s scripted model'
  const hosted = first.tools.find((tool) => tool.type !== 'function' && tool.type !== 'custom')
  if (hosted) return `Codex offers the ${String(hosted.type)} tool, which runs where no hook sees it`
  const commands = calls.map((c) => `${c.tool}: ${String((c.input as { command?: unknown } | null)?.command)}`)
  if (!calls.length) return 'the PreToolUse hook did not run before a tool call (no call reached the gate)'
  const denied = second?.outputs.get('call_1')
  if (denied === undefined) return 'Codex did not return the first call\'s output'
  if (!denied.includes(`probe-deny-${nonce}`)) return 'the gate\'s deny did not reach the model as the call\'s output'
  if (/exited with code/i.test(denied)) return 'a command the gate denied ran anyway'
  if (commands.join('\n') !== `Bash: echo ${nonce}\nBash: cat`) return `the gate was asked about other calls than the probe's (${commands.join('; ').slice(0, 160)})`
  const terminal = third?.outputs.get('call_2')
  if (terminal === undefined) return 'Codex did not return the second call\'s output'
  if (/session ID \d+/i.test(terminal)) return 'a terminal session started, so write_stdin could reach a command no hook asks about'
  if (model.requests.length !== 3) return `Codex asked the scripted model ${model.requests.length} times, not 3`
  const last = stdout.split('\n').flatMap((line) => {
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } }
      return event.type === 'item.completed' && event.item?.type === 'agent_message' ? [event.item.text] : []
    } catch {
      return []
    }
  }).at(-1)
  if (last !== `probe-ok-${nonce}`) return 'the turn did not end with the scripted model\'s answer'
  return undefined
}
