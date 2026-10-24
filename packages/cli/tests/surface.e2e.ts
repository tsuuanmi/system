// The MCP surface's token budget (QA-12, INV-9): the shipped profile, booted through the real dsh
// launcher from built lib/, measured the way a client sees it. Ceilings and the estimator are in
// packages/plugins/mcp-server/tests/budget.ts, the one place they are raised (a reviewed change).
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BUDGET, bytesOf, tokens } from '../../plugins/mcp-server/tests/budget.ts'

const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'system-surface-'))
const env = { ...process.env, DSH_HOME: home }
let child: ChildProcess | undefined

type Scope = 'operator' | 'client' | 'model'
interface Tool { name: string; description?: string; inputSchema?: unknown }

/** One JSON-RPC request to `/mcp`, and the response message exactly as the server sent it. */
async function rpc(url: string, token: string, method: string, params: object = {}): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await res.text()
  // A Streamable HTTP reply is one SSE event, or plain JSON: the message is its data.
  const data = body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
  return { status: res.status, text: data || body }
}

/** The UTF-8 bytes of a response message. */
const size = (text: string): number => Buffer.byteLength(text, 'utf8')

async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await sleep(200)
  }
}

beforeAll(() => {
  execFileSync(process.execPath, [bin, 'init'], { env, stdio: 'pipe' })
  writeFileSync(join(home, 'port0.yml'), '- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n')
}, 180_000)

afterAll(() => {
  // The whole process group: SIGKILL on the wrapper alone would orphan the dsh child.
  if (child?.pid !== undefined && child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // the group already exited
    }
  }
  rmSync(home, { recursive: true, force: true })
})

describe('MCP surface budget (e2e through dsh)', () => {
  it('keeps tools/list per scope and the canonical status, result, and usage replies under their ceilings (QA-12, INV-9, REQ-GW-3)', async () => {
    child = spawn(process.execPath, [bin, 'start', '--patch', join(home, 'port0.yml')], { env, stdio: 'pipe', detached: true })
    const discoveryPath = join(home, 'system', 'mcp.json')
    await waitFor(discoveryPath, 60_000)
    const { url, tokenFiles } = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { url: string; tokenFiles: Record<Scope, string> }
    const tokenOf = (scope: Scope): string => readFileSync(tokenFiles[scope]).toString('base64url')
    try {
      // What each measure was, printed only when one is over its ceiling: what grew, tool by tool.
      const report: string[] = []
      let over = false
      const within = (label: string, bytes: number, ceiling: number): void => {
        if (bytes > ceiling) over = true
        expect.soft(bytes, `${label}: ${bytes} B (~${tokens(bytes)} tokens) over its ceiling`).toBeLessThanOrEqual(ceiling)
      }
      for (const scope of ['operator', 'client'] as const) {
        const listed = await rpc(url, tokenOf(scope), 'tools/list')
        expect(listed.status).toBe(200)
        const tools = (JSON.parse(listed.text) as { result: { tools: Tool[] } }).result.tools
        const bytes = size(listed.text)
        report.push(`tools/list as ${scope}: ${tools.length} tools, ${bytes} B, ~${tokens(bytes)} tokens`)
        for (const tool of [...tools].sort((a, b) => bytesOf(b) - bytesOf(a))) {
          report.push(`  ${tool.name}: ${bytesOf(tool)} B (description ${bytesOf(tool.description ?? '')} B, input schema ${bytesOf(tool.inputSchema ?? {})} B)`)
        }
        within(`tools/list as ${scope}`, bytes, BUDGET.toolsList[scope].ceiling)
        for (const tool of tools) within(`tool ${tool.name}`, bytesOf(tool), BUDGET.tool.ceiling)
      }
      // A Worker holds the model token at most: /mcp refuses it, so it pays for no tool list.
      expect((await rpc(url, tokenOf('model'), 'tools/list')).status).toBe(401)

      const call = async (scope: Scope, name: string, args: object = {}) => rpc(url, tokenOf(scope), 'tools/call', { name, arguments: args })
      const statusOperator = await call('operator', 'status')
      const statusClient = await call('client', 'status')
      // With no account, an ask fails closed at once: its run is the profile's canonical failed run.
      const asked = JSON.parse((await call('client', 'ask', { prompt: 'hi', waitSeconds: 10 })).text) as { result: { structuredContent: { runId: string; status: string } } }
      expect(asked.result.structuredContent.status).toBe('failed')
      const resultFailed = await call('client', 'result', { runId: asked.result.structuredContent.runId, waitSeconds: 0 })
      const usageOneRun = await call('client', 'usage')
      const replies = { statusOperator, statusClient, resultFailed, usageOneRun }
      for (const [name, reply] of Object.entries(replies) as Array<[keyof typeof replies, { status: number; text: string }]>) {
        expect(reply.status).toBe(200)
        report.push(`reply ${name}: ${size(reply.text)} B, ~${tokens(size(reply.text))} tokens`)
        within(`reply ${name}`, size(reply.text), BUDGET.replies[name].ceiling)
      }
      if (over) console.log(report.join('\n'))
    } finally {
      const exited = new Promise((resolve) => child?.on('exit', resolve))
      child.kill('SIGTERM')
      await exited
    }
  }, 120_000)
})
