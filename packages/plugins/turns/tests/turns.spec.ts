import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import Accounts from '@tsuuanmi/system-accounts'
import Artifacts from '@tsuuanmi/system-artifacts'
import BrowserPool from '@tsuuanmi/system-browser-patchright'
import Vault from '@tsuuanmi/system-credentials-vault'
import VirtualDisplay from '@tsuuanmi/system-display-virtual'
import McpEndpoint from '@tsuuanmi/system-mcp-server'
import ChatGptWeb from '@tsuuanmi/system-provider-chatgpt-web'
import Providers from '@tsuuanmi/system-providers'
import Store from '@tsuuanmi/system-store'
import TurnReceipts from '@tsuuanmi/system-turn-receipts'
import { afterEach, describe, expect, it } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../../provider-chatgpt-web/fixtures/fake-chatgpt.ts'
import Turns from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

type CatalogEntry = { id: string; provider: string; quotaClass: 'subscription-chat'; tiers: Record<string, string> }
const account = (id: string): CatalogEntry => ({ id, provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers: { standard: 'instant' } })

async function boot(options: { fake?: FakeOptions; accounts?: CatalogEntry[]; ready?: string[]; dir?: string; capacity?: number } = {}) {
  const fake = new FakeChatGpt({ answer: 'OK', ...options.fake })
  await fake.start()
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-turns-'))
  if (!options.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.push(() => fake.stop())
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }),
    ctx.plugin(Artifacts, {}),
    ctx.plugin(TurnReceipts, {}),
    ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
    ctx.plugin(Accounts, { accounts: options.accounts ?? [account('chatgpt-main')] }),
    ctx.plugin(VirtualDisplay, {}),
    ctx.plugin(BrowserPool, { chromePath: testChrome! }),
    ctx.plugin(Providers),
    ctx.plugin(ChatGptWeb, { origin: fake.origin, overlayPath: join(dir, 'none.yaml') }),
    ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000, maxConcurrentTurnsPerAccount: options.capacity ?? 2 }),
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(McpEndpoint, { tokenFile: join(dir, 'mcp.token'), discoveryFile: join(dir, 'mcp.json') }),
  ]
  await Promise.all(fibers)
  const stop = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  cleanups.push(stop)
  for (const id of options.ready ?? ['chatgpt-main']) {
    await ctx.accounts.saveState(id, {
      state: { origins: [fake.origin], cookies: [], capturedAt: '2026-10-11T00:00:00Z' },
      identityHash: `sha256:${id === 'chatgpt-main' ? 'a'.repeat(64) : 'b'.repeat(64)}`, verifiedAt: '2026-10-11T00:00:00Z',
    })
  }
  return { ctx, fake, dir, stop }
}

describe.runIf(canRunBrowser)('ctx.turns: ask through a saved account', () => {
  it('answers a one-shot ask in Temporary chat, in Chat mode, with a receipt, a route decision, and an answer artifact', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'Hello' } })
    const started = ctx.turns.ask({ prompt: 'Say hello' })
    const turn = await ctx.turns.wait(started.turnId, 30_000)
    expect(turn).toMatchObject({ status: 'completed', account: 'chatgpt-main', mode: 'temporary', answer: 'Hello' })
    expect(turn.sessionId).toBeUndefined()
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Say hello', mode: 'chat', temporary: true })])
    const answer = ctx.artifacts.get(turn.answerArtifact!)
    expect(answer?.body).toMatchObject({ schema: 'provider-answer@1.0', text: 'Hello', conversation: { mode: 'temporary' } })
    const route = ctx.artifacts.get(turn.routeDecision!)
    expect(route?.body).toMatchObject({ decisionType: 'route', outcome: { option: 'chatgpt-main' } })
    expect(ctx.turnReceipts.read({ account: 'chatgpt-main', sessionId: turn.turnId, requestId: turn.turnId })).toMatchObject({ status: 'COMPLETED' })
  }, 90_000)

  it('keeps a persistent session on one conversation across asks', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'first' } })
    const first = await ctx.turns.wait(ctx.turns.ask({ prompt: 'one', persist: true }).turnId, 30_000)
    expect(first).toMatchObject({ status: 'completed', mode: 'persistent', answer: 'first' })
    expect(first.sessionId).toMatch(/^ses_/)
    fake.options.answer = 'second'
    const second = await ctx.turns.wait(ctx.turns.ask({ prompt: 'two', sessionId: first.sessionId! }).turnId, 30_000)
    expect(second).toMatchObject({ status: 'completed', sessionId: first.sessionId, answer: 'second', binding: first.binding })
    expect(first.binding).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.sent[1]).toMatchObject({ conversationId: first.binding, temporary: false })
  }, 120_000)

  it('is idempotent on clientRequestId and sends once', async () => {
    const { ctx, fake } = await boot()
    const a = ctx.turns.ask({ prompt: 'once', clientRequestId: 'req-1' })
    const b = ctx.turns.ask({ prompt: 'once', clientRequestId: 'req-1' })
    expect(b.turnId).toBe(a.turnId)
    await ctx.turns.wait(a.turnId, 30_000)
    expect(fake.sent).toHaveLength(1)
    expect(() => ctx.turns.ask({ prompt: 'different', clientRequestId: 'req-1' })).toThrow(/different prompt/)
  }, 90_000)

  it('routes to the first ready account and records why the others were skipped', async () => {
    const { ctx } = await boot({ accounts: [account('chatgpt-main'), account('chatgpt-2')], ready: ['chatgpt-2'] })
    const turn = await ctx.turns.wait(ctx.turns.ask({ prompt: 'route me' }).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'completed', account: 'chatgpt-2' })
    const route = ctx.artifacts.get(turn.routeDecision!)?.body as { candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
    expect(route.candidates).toEqual([
      { option: 'chatgpt-main', selected: false, reasons: ['status new'] },
      { option: 'chatgpt-2', selected: true, reasons: ['first ready account'] },
    ])
  }, 90_000)

  it('fails closed with USER_ACTION when no account is ready, and sends nothing', async () => {
    const { ctx, fake } = await boot({ ready: [] })
    const turn = await ctx.turns.wait(ctx.turns.ask({ prompt: 'nobody' }).turnId, 10_000)
    expect(turn).toMatchObject({ status: 'failed', error: { kind: 'reauth_required', disposition: 'USER_ACTION' } })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('serves ask and result over MCP in place of the placeholders', async () => {
    const { dir } = await boot({ fake: { answer: 'via mcp' } })
    const { url, tokenFile } = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFile: string }
    const client = new Client({ name: 'claude-code', version: '0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${readFileSync(tokenFile).toString('base64url')}` } } }) as unknown as Transport)
    cleanups.push(() => client.close())
    const asked = await client.callTool({ name: 'ask', arguments: { prompt: 'hi', waitSeconds: 25 } })
    expect(asked.isError).toBeFalsy()
    expect(asked.structuredContent).toMatchObject({ status: 'completed', answer: 'via mcp' })
    const { turnId } = asked.structuredContent as { turnId: string }
    const fetched = await client.callTool({ name: 'result', arguments: { turnId } })
    expect(fetched.structuredContent).toMatchObject({ turnId, status: 'completed', answer: 'via mcp' })
    const missing = await client.callTool({ name: 'result', arguments: { turnId: 'turn_nope' } })
    expect(missing.isError).toBe(true)
  }, 90_000)

  it('resumes a queued turn after a restart, and never resends one that was already submitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { thinkMs: 60_000 }, capacity: 1 })
    const submitted = first.ctx.turns.ask({ prompt: 'long one' })
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 30_000
      const poll = (): void => {
        if (first.fake.sent.length) return resolve()
        if (Date.now() > deadline) return reject(new Error('never sent'))
        setTimeout(poll, 100)
      }
      poll()
    })
    // Capacity 1: this turn waits behind the first one when the host goes down.
    const queuedTurn = first.ctx.turns.ask({ prompt: 'queued before the crash' })
    expect(first.ctx.turns.get(queuedTurn.turnId)).toMatchObject({ status: 'queued' })
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)

    const second = await boot({ dir, fake: { answer: 'resumed' } })
    const turns = second.ctx.turns.list()
    const interrupted = turns.find((t) => t.turnId === submitted.turnId)!
    expect(interrupted).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed' } })
    expect(turns.map((t) => t.turnId).sort()).toEqual([submitted.turnId, queuedTurn.turnId].sort())
    expect((await second.ctx.turns.wait(queuedTurn.turnId, 60_000)).answer).toBe('resumed')
    expect(second.fake.sent.map((s) => s.prompt)).toEqual(['queued before the crash'])
  }, 150_000)
})
