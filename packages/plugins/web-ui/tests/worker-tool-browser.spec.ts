// A Worker's own tool call runs the web UI's browser tests (T265), proven through the real thing: the
// claude-agent-sdk runtime runs the installed Claude Code, under the agents' read confinement (the
// managed Chrome bound back read-only and named in SYSTEM_BROWSERS_DIR, the run's report file bound
// back writable and named in SYSTEM_CHECK_REPORT_PATH, the host's unix sockets masked), with exactly
// the command sandbox a workspace-write run gets in production (the runtime's own `commandSandbox`
// settings, its default `unixSockets`), and Claude Code's own sandbox runs the command. Only the model
// is scripted: a local Messages endpoint (ANTHROPIC_BASE_URL) answers with one Bash call,
// `corepack pnpm exec vitest run <a web-ui browser spec>`, then reads its output from the tool result
// Claude Code sends back. The browser test passes there; and with every Chrome hidden, the same call
// skips it and the run's report file says so, which is what the run's result and its review are told
// (agent-workers `runReport`, workflow `reviewSubject`). Needs Claude Code on PATH, bubblewrap, and a
// Chrome; skipped, with why, where any is missing.
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir, userInfo } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { dshHome } from '@tsuuanmi/system-libs'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { needsBubblewrap } from '../../../agent-runtime-core/tests/host.ts'
import AgentRuntimeRegistry, { type Confinement } from '../../agent-runtimes/src/index.ts'
import { notRunIn } from '../../agent-workers/src/run-report.ts'
import { BROWSER_LEFT_OUT, browserUnavailable, testChrome } from '../../browser-patchright/tests/support.ts'
import { ClaudeAgentRuntime } from '../../runtime-claude-agent-sdk/src/index.ts'

const root = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)))
/** The one web UI browser test run: Help, in a headless Chrome on the store-backed daemon. */
const FILE = 'packages/plugins/web-ui/tests/help.spec.ts'
const NAME = 'has Help in the navigation'
/** The Worker's Bash call, word for word as a develop step makes it. */
const COMMAND = `corepack pnpm exec vitest run ${FILE} --testNamePattern '${NAME}'`
/** Where a Chrome could be found that the hidden run must not see. */
const CHROMES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
const TOOL_USE = 'toolu_t265_bash'

/** The installed Claude Code, as the runtime finds it (on PATH). */
function claudeOnPath(): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    try {
      accessSync(join(dir, 'claude'), constants.X_OK)
      return join(dir, 'claude')
    } catch {
      // not here
    }
  }
  return undefined
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }

/** The text of the tool result for {@link TOOL_USE} in a Messages request, if it holds one. */
function toolResult(body: { messages?: Array<{ content?: unknown }> }): string | undefined {
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content as Array<{ type?: string; tool_use_id?: string; content?: unknown }>) {
      if (part.type !== 'tool_result' || part.tool_use_id !== TOOL_USE) continue
      return typeof part.content === 'string' ? part.content : Array.isArray(part.content) ? (part.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n') : ''
    }
  }
  return undefined
}

/** A Messages answer, streamed as server-sent events or whole, as the request asks. */
function answer(response: ServerResponse, stream: boolean, content: Block[], stop: 'end_turn' | 'tool_use'): void {
  const message = { id: 'msg_t265', type: 'message', role: 'assistant', model: 'scripted', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  if (!stream) {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...message, content, stop_reason: stop }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const send = (event: string, data: unknown): void => void response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } })
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
    } else {
      send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
      send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    }
    send('content_block_stop', { type: 'content_block_stop', index })
  })
  send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } })
  send('message_stop', { type: 'message_stop' })
  response.end()
}

/**
 * The scripted model: the main loop's first turn (a request offering Bash) is one Bash call of
 * {@link COMMAND}; once Claude Code sends back that call's result, it is kept and the run ends. Any
 * other request (a title, a count) gets a plain answer.
 */
async function scriptedModel(): Promise<{ url: string; output: () => string | undefined }> {
  let output: string | undefined
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (request.url?.includes('count_tokens')) return void response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}')
      if (request.method !== 'POST' || !request.url?.includes('/messages')) return void response.writeHead(404).end()
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { stream?: boolean; tools?: Array<{ name?: string }>; messages?: Array<{ content?: unknown }> }
      const stream = body.stream === true
      const result = toolResult(body)
      if (result !== undefined) {
        output = result
        return answer(response, stream, [{ type: 'text', text: 'Ran the browser test.' }], 'end_turn')
      }
      if (body.tools?.some((tool) => tool.name === 'Bash')) {
        return answer(response, stream, [{ type: 'tool_use', id: TOOL_USE, name: 'Bash', input: { command: COMMAND, description: 'Run one web UI browser test', timeout: 600_000 } }], 'tool_use')
      }
      answer(response, stream, [{ type: 'text', text: 'ok' }], 'end_turn')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, output: () => output }
}

interface Ran { output: string; report: string }

/** One writing run of the real runtime, in this repository, its model scripted: what its Bash call printed, and its report file. */
async function workerBashCall(confine: (bind: { readOnly?: readonly string[]; writable?: readonly string[] }) => Confinement): Promise<Ran> {
  const scratch = mkdtempSync(join(tmpdir(), 'system-worker-tool-browser-'))
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }))
  const home = mkdtempSync(join(scratch, 'home-'))
  const runDir = mkdtempSync(join(scratch, 'run-'))
  const report = join(scratch, 'report')
  writeFileSync(report, '', { mode: 0o600 })
  const model = await scriptedModel()
  const runtime = new ClaudeAgentRuntime({
    home, runDir, confine,
    // The scripted model, and nothing else off the host; a skip is reported, never turned into a failure here.
    env: { ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: 'sk-t265-scripted', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', NO_COLOR: '1', SYSTEM_REQUIRE_BROWSER: '0' },
  })
  const result = await runtime.run({ prompt: 'Run the web UI browser test of Help.', workspace: root, sandbox: 'workspace-write', tools: ['Bash'], maxTurns: 4, reportFile: report }, AbortSignal.timeout(560_000))
  expect(result.text).toBe('Ran the browser test.')
  const output = model.output()
  expect(output, 'Claude Code never sent back the Bash call\'s result').toBeDefined()
  return { output: output!, report: readFileSync(report, 'utf8') }
}

describe('a Worker\'s own tool call runs the browser tests (T265)', { timeout: 600_000 }, () => {
  needsBubblewrap()
  beforeEach((context) => {
    if (!claudeOnPath()) context.skip('Claude Code is not installed (no claude on PATH): a Worker\'s own tool call cannot be run here')
    const why = browserUnavailable({ headless: true })
    if (why === BROWSER_LEFT_OUT || (why && process.env.SYSTEM_REQUIRE_BROWSER !== '1')) context.skip(why)
  })

  const registry = async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRuntimeRegistry)
    return ctx.agentRuntimes
  }

  it('passes a headless web UI browser test in a writing run\'s own Bash call, in Claude Code\'s command sandbox with its production settings; its report file names nothing skipped', async () => {
    const runtimes = await registry()
    expect(runtimes.confinement().readOnly).toContain(join(dshHome(), 'system', 'browsers'))
    const ran = await workerBashCall((bind) => runtimes.confinement(bind))
    expect(ran.output, ran.output.slice(-3000)).toMatch(/Tests\s+1 passed/)
    expect(ran.output).not.toMatch(/BROWSER TESTS DID NOT RUN/)
    expect(notRunIn(ran.report)).toBeUndefined()
  })

  it('where no Chrome is visible, the same call skips the test and the run\'s report file says so: what the run\'s result and its review are told', async () => {
    const runtimes = await registry()
    const homes = [...new Set([homedir(), userInfo().homedir])]
    const hidden = [...CHROMES, ...(testChrome ? [testChrome] : []), ...homes.flatMap((home) => [join(home, '.dsh', 'system', 'browsers'), join(home, '.cache', 'system-chrome')])].filter((path) => existsSync(path))
    // No managed Chrome bound back, nor named; every other one hidden.
    const confine = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => {
      const base = runtimes.confinement(bind)
      return { bwrap: base.bwrap, hide: [...base.hide, ...hidden], readOnly: base.readOnly.filter((path) => !path.endsWith(join('system', 'browsers'))), writable: base.writable }
    }
    const ran = await workerBashCall(confine)
    expect(ran.output).not.toMatch(/Tests\s+1 passed/)
    expect(ran.output).toMatch(/BROWSER TESTS DID NOT RUN: 1 browser test skipped/)
    expect(notRunIn(ran.report)).toMatch(/^its browser tests \(1 browser test skipped: /)
  })
})
