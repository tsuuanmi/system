/**
 * A minimal OpenAI-compatible chat-completions server on 127.0.0.1 for tests: it streams
 * `echo: <last user text>` as server-sent events with a usage chunk, and records each request.
 * Each response can be scripted: fail with a status, or hold the stream open.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeRequest {
  path: string
  authorization: string | undefined
  body: { model: string; messages: Array<{ role: string; content: unknown }>; max_tokens?: number; max_completion_tokens?: number; stream?: boolean }
}

export type FakeStep = { status: number } | { holdMs: number } | { text: string; finish?: 'stop' | 'length' }

export interface FakeOpenAi {
  baseURL: string
  requests: FakeRequest[]
  /** The next responses' behaviour, consumed in order; by default it answers with an echo. */
  script: FakeStep[]
  close(): Promise<void>
}

const text = (content: unknown): string => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : ''

export async function fakeOpenAi(): Promise<FakeOpenAi> {
  const requests: FakeRequest[] = []
  const script: FakeStep[] = []
  const open = new Set<ServerResponse>()
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    req.on('data', (chunk) => (raw += String(chunk)))
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end()
        return
      }
      const body = JSON.parse(raw) as FakeRequest['body']
      requests.push({ path: req.url, authorization: req.headers.authorization, body })
      const step = script.shift()
      if (step && 'status' in step) {
        res.writeHead(step.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `scripted ${step.status}`, type: 'server_error' } }))
        return
      }
      const last = [...body.messages].reverse().find((m) => m.role === 'user')
      const answer = step && 'text' in step ? step.text : `echo: ${text(last?.content)}`
      const id = `chatcmpl-${requests.length}`
      const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      open.add(res)
      res.on('close', () => open.delete(res))
      res.write(chunk({ role: 'assistant', content: '' }, null))
      const finish = (): void => {
        if (res.writableEnded || res.destroyed) return
        res.write(chunk({ content: answer }, null))
        res.write(chunk({}, step && 'finish' in step && step.finish ? step.finish : 'stop'))
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      }
      if (step && 'holdMs' in step) setTimeout(finish, step.holdMs).unref()
      else finish()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/v1`, requests, script,
    close: () => new Promise<void>((resolve) => {
      for (const res of open) res.destroy()
      server.close(() => resolve())
    }),
  }
}
