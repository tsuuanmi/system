import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import Accounts from '@tsuuanmi/system-accounts'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import Leases from '@tsuuanmi/system-leases'
import Login from '@tsuuanmi/system-login'
import BrowserPool from '@tsuuanmi/system-browser-patchright'
import Vault from '@tsuuanmi/system-credentials-vault'
import VirtualDisplay from '@tsuuanmi/system-display-virtual'
import WorkerRouter, { AdmissionFailure, type Tier, type WorkRequirement } from '@tsuuanmi/system-workers'
import ChatGptWeb from '@tsuuanmi/system-provider-chatgpt-web'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import Providers from '@tsuuanmi/system-providers'
import { contentId } from '@tsuuanmi/system-libs'
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
const account = (id: string, tiers: Record<string, string> = { economy: 'instant', standard: 'medium', frontier: 'high' }): CatalogEntry => ({ id, provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers })

type AskSpec = { prompt: string; tier?: Tier; sessionId?: string; persist?: boolean; research?: boolean; search?: boolean; classification?: WorkRequirement['data']['classification']; key?: string }

/** What the workflow engine does before a turn: build the requirement, route it, start it on the admitted Worker. */
async function ask(ctx: Context, input: AskSpec) {
  const sessionId = input.sessionId ?? (input.persist || input.research ? `ses_${randomBytes(8).toString('hex')}` : undefined)
  const requirement: WorkRequirement = {
    schema: 'work-requirement@1.0', objective: 'test', egressPolicy: 'egress.classification-and-secrets',
    capabilities: ['reason', ...(sessionId ? ['persistent-conversation'] : []), ...(input.research ? ['deep-research'] : []), ...(input.search ? ['web-search'] : [])],
    data: { classification: input.classification ?? 'operator-shared', refs: [] },
    tier: { min: input.tier ?? 'standard', source: input.tier ? 'caller' : 'default' }, acceptance: { contract: 'acceptance.answer' },
  }
  const affinity = sessionId ? ctx.workers.affinity(sessionId) : undefined
  const admitted = await ctx.workers.route(requirement, affinity ? { restrict: { workers: affinity, reason: 'the session stays on its account' } } : {})
  return ctx.turns.ask({ key: input.key ?? randomBytes(8).toString('hex'), worker: admitted.worker.worker, prompt: input.prompt, sessionId, requirement, decisions: admitted.decisions })
}

async function boot(options: { fake?: FakeOptions; accounts?: CatalogEntry[]; ready?: string[]; dir?: string; capacity?: number; shared?: FakeChatGpt; turns?: Record<string, unknown> } = {}) {
  const fake = options.shared ?? new FakeChatGpt({ answer: 'OK', ...options.fake })
  if (!options.shared) await fake.start()
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-turns-'))
  if (!options.dir) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (!options.shared) cleanups.push(() => fake.stop())
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }),
    ctx.plugin(Artifacts, {}),
    ctx.plugin(Leases, {}),
    ctx.plugin(Egress, {}),
    ctx.plugin(TurnReceipts, {}),
    ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
    ctx.plugin(Accounts, { accounts: options.accounts ?? [account('chatgpt-main')] }),
    ctx.plugin(VirtualDisplay, {}),
    ctx.plugin(BrowserPool, { chromePath: testChrome! }),
    ctx.plugin(Providers),
    ctx.plugin(ChatGptWeb, { origin: fake.origin, overlayPath: join(dir, 'none.yaml'), modes: { instant: { model: 'Latest', effort: 'Instant' }, medium: { model: 'Latest', effort: 'Medium' }, high: { model: 'GPT-6', effort: 'High' } }, defaultMode: 'instant' }),
    ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }),
    ctx.plugin(WorkerRouter, {}),
    ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000, maxConcurrentTurnsPerAccount: options.capacity ?? 2, ...options.turns }),
  ]
  await Promise.all(fibers)
  const stop = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  cleanups.push(stop)
  for (const id of options.shared ? [] : options.ready ?? ['chatgpt-main']) {
    await ctx.accounts.saveState(id, {
      state: { origins: [fake.origin], cookies: [], capturedAt: '2026-10-11T00:00:00Z' },
      // The identity the account signs in as (a relogin must sign in as the same account).
      identityHash: contentId({ provider: 'chatgpt-web', identity: `chatgpt-web:${id === 'chatgpt-main' ? fake.options.userId : `${id}-user`}` }), verifiedAt: '2026-10-11T00:00:00Z',
    })
    // As a feature probe on the fake site would find (REQ-PRV-7); fresh, so no background probe runs.
    await ctx.accounts.setFeatures(id, ['deep-research', 'web-search', 'image-generation'])
  }
  return { ctx, fake, dir, stop }
}

describe.runIf(canRunBrowser)('ctx.turns: ask through a saved account', () => {
  it('answers a one-shot ask in Temporary chat, in Chat mode, with a receipt, a route decision, and an answer artifact', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'Hello' } })
    const started = await ask(ctx, { prompt: 'Say hello' })
    const turn = await ctx.turns.wait(started.turnId, 30_000)
    expect(turn).toMatchObject({ status: 'completed', account: 'chatgpt-main', mode: 'temporary', answer: 'Hello', submitted: true })
    expect(turn.sessionId).toBeUndefined()
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Say hello', mode: 'chat', temporary: true })])
    const answer = ctx.artifacts.get(turn.answerArtifact!)
    expect(answer?.body).toMatchObject({ schema: 'provider-answer@1.0', text: 'Hello', conversation: { mode: 'temporary' } })
    const route = ctx.artifacts.get(turn.routeDecision!)
    expect(route?.body).toMatchObject({ decisionType: 'route', outcome: { option: 'worker:chatgpt-main/standard' } })
    expect(ctx.turnReceipts.read({ account: 'chatgpt-main', sessionId: turn.turnId, requestId: turn.turnId })).toMatchObject({ status: 'COMPLETED' })
  }, 90_000)

  it('makes a tier mapped to a preset the driver does not have unavailable, so routing never picks it (PROP-0004: the removed site preset)', async () => {
    const { ctx } = await boot({ accounts: [account('chatgpt-free', { economy: 'site', standard: 'site' }), account('chatgpt-main')] })
    const states = Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w.state]))
    expect(states).toMatchObject({ 'worker:chatgpt-free/economy': 'unavailable', 'worker:chatgpt-free/standard': 'unavailable', 'worker:chatgpt-main/standard': 'ready' })
    const admitted = await ctx.workers.route({ schema: 'work-requirement@1.0', objective: 'x', capabilities: ['reason'], data: { classification: 'public', refs: [] }, egressPolicy: 'default', tier: { min: 'economy', source: 'default' }, acceptance: { contract: 'acceptance.answer' } })
    expect(admitted.worker.worker).toBe('worker:chatgpt-main/economy')
  }, 60_000)

  it('proves an account\'s website features by a probe that sends nothing, and routes only on proven ones (REQ-PRV-7)', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'Found it', features: ['web-search'] } })
    expect(await ctx.turns.probe('chatgpt-main')).toEqual(['web-search'])
    expect(fake.sent).toEqual([])
    expect((await ctx.accounts.get('chatgpt-main')).features).toMatchObject({ names: ['web-search'] })
    const worker = (await ctx.workers.list()).find((w) => w.worker === 'worker:chatgpt-main/standard')!
    expect(worker.capabilities.map((c) => [c.capability, c.evidence.kind])).toEqual([['reason', 'conformance'], ['persistent-conversation', 'conformance'], ['web-search', 'probe']])
    // A feature the account does not offer fails closed; one it offers is used for the turn.
    await expect(ask(ctx, { prompt: 'Research it', research: true })).rejects.toThrow(/deep-research/)
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'Latest news?', search: true })).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'completed', answer: 'Found it' })
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Latest news?', webSearch: true, deepResearch: false })])
  }, 90_000)

  it('maps the requested tier through the account catalog to a mode preset, verifies it, and records it', async () => {
    const { ctx, fake } = await boot()
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'hard question', tier: 'frontier' })).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'completed', tier: 'frontier', mode: 'temporary' })
    expect(fake.sent[0]).toMatchObject({ model: 'GPT-6', power: 'High' })
    const receipt = ctx.turnReceipts.read({ account: 'chatgpt-main', sessionId: turn.turnId, requestId: turn.turnId })
    expect(receipt?.mode).toEqual({ verified: true, tier: 'frontier', model: 'GPT-6', effort: 'High', feature: 'chat' })
    expect(turn.worker).toBe('worker:chatgpt-main/frontier')
    const tier = ctx.artifacts.get(turn.tierDecision!)?.body
    expect(tier).toMatchObject({ decisionType: 'tier', outcome: { option: 'frontier' } })
    const plain = await ctx.turns.wait((await ask(ctx, { prompt: 'default tier' })).turnId, 30_000)
    expect(plain.tier).toBe('standard')
    expect(fake.sent[1]).toMatchObject({ model: 'Latest', power: 'Medium' })
  }, 90_000)

  it('starts Deep research at once in a persistent session and delivers the report through result (REQ-PRV-6)', async () => {
    const { ctx, fake } = await boot({ fake: { report: 'Research report', thinkMs: 1500 } })
    const started = await ask(ctx, { research: true, prompt: 'Survey the plugin catalog' })
    expect(started).toMatchObject({ status: 'queued', mode: 'persistent', feature: 'deep-research' })
    expect(started.sessionId).toMatch(/^ses_/)
    const done = await ctx.turns.wait(started.turnId, 60_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'Research findings\nResearch report' })
    expect(fake.sent[0]).toMatchObject({ deepResearch: true, temporary: false, prompt: 'Survey the plugin catalog' })
  }, 90_000)

  it('accepts a follow-up on a new persistent session before its first turn has finished', async () => {
    const { ctx } = await boot({ fake: { thinkMs: 1500 } })
    const first = await ask(ctx, { prompt: 'one', persist: true })
    const second = await ask(ctx, { prompt: 'two', sessionId: first.sessionId! })
    expect((await ctx.turns.wait(second.turnId, 60_000)).status).toBe('completed')
    expect((await ctx.turns.wait(first.turnId, 1000)).status).toBe('completed')
  }, 90_000)

  it('signs a credentials-mode account back in when it was signed out, then runs the turn', async () => {
    const { ctx, fake } = await boot({ fake: { requireCookie: true, mfa: 'totp', answer: 'after relogin' } })
    await ctx.accounts.setCredentials('chatgpt-main', { email: fake.options.email, password: fake.options.password, totpSecret: fake.options.totpSecret })
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'x' })).turnId, 90_000)
    expect(turn).toMatchObject({ status: 'completed', answer: 'after relogin' })
    expect(fake.sent).toHaveLength(1)
    expect(await ctx.accounts.get('chatgpt-main')).toMatchObject({ status: 'ready' })
  }, 150_000)

  it('signs in again only before anything was sent: a sign-out seen after the send fails the turn, never resent (INV-4)', async () => {
    const { ctx, fake } = await boot()
    await ctx.accounts.setCredentials('chatgpt-main', { email: fake.options.email, password: fake.options.password })
    // A driver that sends (its receipt is written), then finds itself signed out.
    const chatgpt = ctx.providers.get('chatgpt-web')
    let asks = 0
    const ask0 = chatgpt.ask.bind(chatgpt)
    chatgpt.ask = async (page, prompt, options) => {
      asks++
      await options.beforeSend?.({ previousResponse: null, mode: {} })
      throw new ProviderError('reauth_required', 'signed out after the send')
    }
    try {
      const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'sent once' })).turnId, 60_000)
      expect(turn).toMatchObject({ status: 'failed', error: { kind: 'reauth_required' } })
      expect(asks).toBe(1)
    } finally {
      chatgpt.ask = ask0
    }
  }, 120_000)

  it('marks the account reauth-required on positive sign-out evidence, so the next turn routes elsewhere (REQ-ACC-5)', async () => {
    const { ctx } = await boot({ fake: { signedIn: false } })
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'x' })).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'failed', error: { kind: 'reauth_required' } })
    expect(await ctx.accounts.get('chatgpt-main')).toMatchObject({ status: 'reauth-required' })
  }, 60_000)

  it('writes the refreshed browser state back to the account after a turn', async () => {
    const { ctx } = await boot()
    const before = await ctx.accounts.get('chatgpt-main')
    await ctx.turns.wait((await ask(ctx, { prompt: 'refresh me' })).turnId, 30_000)
    const after = await ctx.accounts.get('chatgpt-main')
    expect(after.revision).toBe(before.revision + 1)
    expect((await ctx.accounts.portableState('chatgpt-main'))?.cookies.map((c) => c.name)).toContain('session_refresh')
  }, 90_000)

  it('never overwrites a sign-in saved while a turn ran: its write-back is at a stale revision and is skipped', async () => {
    const { ctx, fake } = await boot({ fake: { thinkMs: 1500 } })
    const started = await ask(ctx, { prompt: 'slow one' })
    for (let i = 0; i < 100 && !fake.sent.length; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    // The operator saves the account (Save or relogin) while the turn is still answering.
    const saved = { origins: [fake.origin], cookies: [{ name: 'saved_by_operator', value: 'v', domain: '127.0.0.1', path: '/' }], capturedAt: '2026-10-12T00:00:00Z' }
    await ctx.accounts.saveState('chatgpt-main', { state: saved, identityHash: `sha256:${'a'.repeat(64)}`, verifiedAt: '2026-10-12T00:00:00Z' })
    expect((await ctx.turns.wait(started.turnId, 30_000)).status).toBe('completed')
    expect((await ctx.accounts.portableState('chatgpt-main'))?.cookies.map((c) => c.name)).toEqual(['saved_by_operator'])
  }, 90_000)

  it('keeps a persistent session on one conversation across asks', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'first' } })
    const first = await ctx.turns.wait((await ask(ctx, { prompt: 'one', persist: true })).turnId, 30_000)
    expect(first).toMatchObject({ status: 'completed', mode: 'persistent', answer: 'first' })
    expect(first.sessionId).toMatch(/^ses_/)
    fake.options.answer = 'second'
    const second = await ctx.turns.wait((await ask(ctx, { prompt: 'two', sessionId: first.sessionId! })).turnId, 30_000)
    expect(second).toMatchObject({ status: 'completed', sessionId: first.sessionId, answer: 'second', binding: first.binding })
    expect(first.binding).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.sent[1]).toMatchObject({ conversationId: first.binding, temporary: false })
  }, 120_000)

  it('is idempotent on clientRequestId and sends once (REQ-PRV-1)', async () => {
    const { ctx, fake } = await boot()
    const a = await ask(ctx, { prompt: 'once', key: 'req-1' })
    const b = await ask(ctx, { prompt: 'once', key: 'req-1' })
    expect(b.turnId).toBe(a.turnId)
    await ctx.turns.wait(a.turnId, 30_000)
    expect(fake.sent).toHaveLength(1)
    await expect(ask(ctx, { prompt: 'different', key: 'req-1' })).rejects.toThrow(/different prompt/)
  }, 90_000)

  it('routes through ctx.workers to an admitted Worker and records why every other one was not chosen (REQ-WRK-1, REQ-ART-1)', async () => {
    const { ctx } = await boot({ accounts: [account('chatgpt-main'), account('chatgpt-2')], ready: ['chatgpt-2'] })
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'route me' })).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'completed', account: 'chatgpt-2', worker: 'worker:chatgpt-2/standard' })
    const route = ctx.artifacts.get(turn.routeDecision!)?.body as { candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
    const reasons = Object.fromEntries(route.candidates.map((c) => [c.option, c.reasons]))
    expect(reasons['worker:chatgpt-2/standard']).toContain('proves reason')
    expect(reasons['worker:chatgpt-2/frontier']).toEqual(['admitted; worker:chatgpt-2/standard has the lower tier standard'])
    expect(reasons['worker:chatgpt-main/standard']).toEqual(['state reauth-required'])
    expect(reasons['worker:chatgpt-main/economy']).toEqual(['state reauth-required', 'tier economy is below the minimum standard'])
  }, 90_000)

  it('treats the tier as a minimum, and fails closed when no Worker serves it (REQ-WRK-9)', async () => {
    const { ctx, fake } = await boot({ accounts: [account('chatgpt-main', { economy: 'instant', frontier: 'high' })] })
    const up = await ctx.turns.wait((await ask(ctx, { prompt: 'standard or better', tier: 'standard' })).turnId, 30_000)
    expect(up).toMatchObject({ status: 'completed', tier: 'frontier', worker: 'worker:chatgpt-main/frontier' })
    expect(fake.sent[0]).toMatchObject({ model: 'GPT-6', power: 'High' })
    const cheap = await ctx.turns.wait((await ask(ctx, { prompt: 'easy', tier: 'economy' })).turnId, 30_000)
    expect(cheap.worker).toBe('worker:chatgpt-main/economy')
    const none = await boot({ accounts: [account('chatgpt-main', { economy: 'instant' })] })
    const refused = await ask(none.ctx, { prompt: 'too hard', tier: 'frontier' }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(AdmissionFailure)
    expect(none.ctx.artifacts.get((refused as AdmissionFailure).decision)?.body).toMatchObject({ decisionType: 'admission', outcome: { option: 'none' } })
    expect(none.fake.sent).toEqual([])
  }, 90_000)

  it('recovers a submitted persistent turn after a restart from its conversation, without resending (REQ-PRV-2, QA-1)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { thinkMs: 4000, answer: 'answered while we were down' } })
    const turn = await ask(first.ctx, { prompt: 'survive a crash', persist: true })
    const until = async (check: () => boolean): Promise<void> => {
      const deadline = Date.now() + 30_000
      while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out')
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    await until(() => first.ctx.turns.get(turn.turnId)?.binding !== undefined)
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    // The provider keeps working while the host is down.
    await until(() => [...first.fake.conversations.values()].some((c) => c.turns.some((t) => t.role === 'assistant')))
    const second = await boot({ dir, shared: first.fake })
    const recovered = await second.ctx.turns.wait(turn.turnId, 60_000)
    expect(recovered).toMatchObject({ status: 'completed', answer: 'answered while we were down' })
    expect(first.fake.sent).toHaveLength(1)
    const outcome = second.ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' }).map((a) => (a.body as { outcome: { option: string } }).outcome.option)
    expect(outcome).toEqual(['RECOVER'])
  }, 120_000)

  it('recovers a Deep research turn after a restart from its run, without resending (live 2026-10-12)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { researchMs: 9000, report: 'Report written while we were down.' } })
    const turn = await ask(first.ctx, { research: true, prompt: 'survive a crash' })
    const deadline = Date.now() + 30_000
    while (first.ctx.turns.get(turn.turnId)?.binding === undefined) {
      if (Date.now() > deadline) throw new Error('never bound')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    const second = await boot({ dir, shared: first.fake })
    const recovered = await second.ctx.turns.wait(turn.turnId, 60_000)
    expect(recovered).toMatchObject({ status: 'completed', answer: 'Research findings\nReport written while we were down.' })
    expect(first.fake.sent).toHaveLength(1)
    const outcomes = second.ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' }).map((a) => (a.body as { outcome: { option: string } }).outcome.option)
    expect(outcomes).not.toContain('RESUBMIT')
    expect(outcomes.at(-1)).toBe('RECOVER')
  }, 150_000)

  it('runs a recovered turn in only one of two processes sharing the same home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { thinkMs: 2000, answer: 'once' } })
    const turn = await ask(first.ctx, { prompt: 'only once' })
    const second = await boot({ dir, shared: first.fake })
    await new Promise((resolve) => setTimeout(resolve, 6000))
    expect(first.fake.sent.map((s) => s.prompt)).toEqual(['only once'])
    expect((await first.ctx.turns.wait(turn.turnId, 30_000)).status).toBe('completed')
    expect(second.ctx.turns.get(turn.turnId)?.status).toBe('completed')
  }, 90_000)

  it('bounds the turns it accepts (INV-9): beyond the limit it refuses with a back-off failure', async () => {
    const { ctx } = await boot({ fake: { thinkMs: 3000 }, turns: { maxPendingTurns: 1 } })
    const first = await ask(ctx, { prompt: 'one' })
    await expect(ask(ctx, { prompt: 'two' })).rejects.toMatchObject({ kind: 'overloaded', disposition: 'BACKOFF' })
    await ctx.turns.wait(first.turnId, 30_000)
    await ask(ctx, { prompt: 'three' })
  }, 90_000)

  it('keeps a session\'s turns in order across a restart: a later turn waits while an earlier one cannot be reconciled yet (INV-4)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { thinkMs: 4000, answer: (prompt: string) => `answer to ${prompt}` } })
    const t1 = await ask(first.ctx, { prompt: 'one', persist: true })
    const settled = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await settled(() => first.ctx.turns.get(t1.turnId)?.binding !== undefined)
    const t2 = await ask(first.ctx, { prompt: 'two', sessionId: t1.sessionId! })
    expect(first.ctx.turns.get(t2.turnId)?.status).toBe('queued')
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    // A crash: the dead process's lease on the first turn stays live for a while after the restart.
    const db = new DatabaseSync(join(dir, 'system.db'))
    db.prepare("UPDATE leases SET owner = 'dead:1:x', token = 'dead', expires_at = ? WHERE resource = ?").run(Date.now() + 15_000, `turn:${t1.turnId}`)
    db.close()
    const second = await boot({ dir, shared: first.fake })
    const one = await second.ctx.turns.wait(t1.turnId, 90_000)
    const two = await second.ctx.turns.wait(t2.turnId, 90_000)
    expect([one.answer, two.answer]).toEqual(['answer to one', 'answer to two'])
    expect(first.fake.sent.map((s) => s.prompt)).toEqual(['one', 'two'])
  }, 180_000)

  it('lets the operator cancel, and the runtime stop, while a restarted turn waits for its answer to finish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { researchMs: 120_000, report: 'late report' } })
    const turn = await ask(first.ctx, { research: true, prompt: 'long research' })
    const settled = async (check: () => boolean, ms = 60_000): Promise<void> => {
      for (let t = Date.now(); !check() && Date.now() - t < ms;) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await settled(() => first.ctx.turns.get(turn.turnId)?.binding !== undefined)
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    const second = await boot({ dir, shared: first.fake })
    const waits = () => second.ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' })
      .filter((a) => (a.body as { outcome: { option: string } }).outcome.option === 'WAIT')
    await settled(() => waits().length > 0)
    await new Promise((resolve) => setTimeout(resolve, 25_000))
    // Waiting is one decision, not one per look (INV-9).
    expect(waits()).toHaveLength(1)
    expect(second.ctx.turns.cancel(turn.turnId)).toBe(true)
    await settled(() => second.ctx.turns.get(turn.turnId)?.status === 'failed', 3000)
    expect(second.ctx.turns.get(turn.turnId)).toMatchObject({ status: 'failed', error: { kind: 'aborted' } })
    const started = Date.now()
    await second.stop()
    cleanups.splice(cleanups.indexOf(second.stop), 1)
    expect(Date.now() - started).toBeLessThan(5000)
  }, 240_000)

  it('keeps a completed turn completed when a later step fails (closing its browser turn), never rewriting it as failed', async () => {
    const { ctx } = await boot({ fake: { answer: 'Done' } })
    const browser = ctx.browser as unknown as { openTurn: (...args: unknown[]) => Promise<{ close: () => Promise<void> }> }
    const open = browser.openTurn.bind(browser)
    browser.openTurn = async (...args) => {
      const turn = await open(...args)
      const close = turn.close.bind(turn)
      turn.close = async () => {
        await close()
        throw new Error('the browser turn did not close cleanly')
      }
      return turn
    }
    const started = await ask(ctx, { prompt: 'finish then fail' })
    await ctx.turns.wait(started.turnId, 60_000)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(ctx.turns.get(started.turnId)).toMatchObject({ status: 'completed', answer: 'Done' })
  }, 90_000)

  it('never leaves a failure it cannot record unhandled: with its lease taken, the turn is looked at again, not overwritten (INV-4)', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    cleanups.push(() => process.off('unhandledRejection', onUnhandled))
    const { ctx } = await boot({ fake: { thinkMs: 30_000, answer: 'late' } })
    const turn = await ask(ctx, { prompt: 'slow' })
    for (let t = Date.now(); ctx.turns.get(turn.turnId)?.status !== 'running' && Date.now() - t < 30_000;) await new Promise((resolve) => setTimeout(resolve, 100))
    // Another process took the turn (its lease moved on): this process may no longer write it.
    ctx.leases.invalidate(`turn:${turn.turnId}`)
    expect(ctx.turns.cancel(turn.turnId)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(unhandled).toEqual([])
    expect(ctx.turns.get(turn.turnId)?.status).toBe('running')
  }, 90_000)

  it('forgets finished turns (their prompts and receipts) after the retention period (INV-9)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir })
    const done = await first.ctx.turns.wait((await ask(first.ctx, { prompt: 'old prompt' })).turnId, 30_000)
    first.ctx.store.transaction((db) => void db.prepare("UPDATE turns SET updated_at = '2026-01-01T00:00:00.000Z' WHERE turn_id = ?").run(done.turnId))
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    const second = await boot({ dir, turns: { retainDays: 30 } })
    expect(second.ctx.turns.get(done.turnId)).toBeUndefined()
    expect(second.ctx.turnReceipts.read({ account: 'chatgpt-main', sessionId: done.turnId, requestId: done.turnId })).toBeUndefined()
    expect(second.ctx.artifacts.get(done.answerArtifact!)).toBeDefined()
  }, 90_000)

  it('settles pending waits promptly when the runtime stops', async () => {
    const { ctx, stop } = await boot({ fake: { thinkMs: 30_000 } })
    const started = await ask(ctx, { prompt: 'slow' })
    const waiting = ctx.turns.wait(started.turnId, 55_000)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const t0 = Date.now()
    await stop()
    cleanups.splice(cleanups.indexOf(stop), 1)
    await waiting
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 90_000)

  it('never serves a routed turn by another mode after its tier was unmapped across a restart (INV-2, QA-3)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, capacity: 1, fake: { thinkMs: 60_000 } })
    await ask(first.ctx, { prompt: 'hold the slot' })
    const queued = await ask(first.ctx, { prompt: 'needs frontier', tier: 'frontier' })
    const deadline = Date.now() + 30_000
    while (first.ctx.turns.get(queued.turnId)?.worker === undefined) {
      if (Date.now() > deadline) throw new Error('never routed')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)
    const second = await boot({ dir, shared: first.fake, accounts: [account('chatgpt-main', { economy: 'instant', standard: 'medium' })] })
    const refused = await second.ctx.turns.wait(queued.turnId, 30_000)
    expect(refused).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'config_error' } })
    expect(first.fake.sent.map((s) => s.prompt)).not.toContain('needs frontier')
  }, 120_000)

  it('checks egress before sending: credentials or local-private content never leave (INV-12)', async () => {
    const { ctx, fake } = await boot()
    const pem = String((await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
    const leaked = await ctx.turns.wait((await ask(ctx, { prompt: `why does this key fail?\n${pem}` })).turnId, 30_000)
    expect(leaked).toMatchObject({ status: 'failed', error: { kind: 'egress_denied', disposition: 'USER_ACTION' } })
    // Routing keeps local-private work off remote Workers; the turn's own egress check holds even if a caller skipped that.
    await expect(ask(ctx, { prompt: 'my notes', classification: 'local-private' })).rejects.toBeInstanceOf(AdmissionFailure)
    const admitted = await ask(ctx, { prompt: 'warm-up', classification: 'public' })
    const turn = await ctx.turns.wait(admitted.turnId, 30_000)
    const bypass = ctx.turns.ask({
      key: 'bypass', worker: turn.worker!, prompt: 'my notes', decisions: { tier: turn.tierDecision!, route: turn.routeDecision! },
      requirement: { schema: 'work-requirement@1.0', objective: 'test', egressPolicy: 'egress.classification-and-secrets', capabilities: ['reason'],
        data: { classification: 'local-private', refs: [] }, tier: { min: 'standard', source: 'caller' }, acceptance: { contract: 'acceptance.answer' } },
    })
    expect(await ctx.turns.wait(bypass.turnId, 30_000)).toMatchObject({ status: 'failed', error: { kind: 'egress_denied' } })
    expect(fake.sent.map((s) => s.prompt)).toEqual(['warm-up'])
    const fine = await ctx.turns.wait((await ask(ctx, { prompt: 'public question' })).turnId, 30_000)
    expect(fine.status).toBe('completed')
    expect(ctx.artifacts.get(fine.egressDecision!)?.body).toMatchObject({ decisionType: 'egress', outcome: { option: 'allow' } })
  }, 90_000)

  it('resumes a queued turn after a restart, and never resends one that was already submitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const first = await boot({ dir, fake: { thinkMs: 60_000 }, capacity: 1 })
    const submitted = await ask(first.ctx, { prompt: 'long one' })
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
    const queuedTurn = await ask(first.ctx, { prompt: 'queued before the crash' })
    expect(first.ctx.turns.get(queuedTurn.turnId)).toMatchObject({ status: 'queued' })
    await first.stop()
    cleanups.splice(cleanups.indexOf(first.stop), 1)

    const second = await boot({ dir, fake: { answer: 'resumed' } })
    const turns = second.ctx.turns.list()
    const interrupted = turns.find((t) => t.turnId === submitted.turnId)!
    expect(interrupted).toMatchObject({ status: 'failed', error: { kind: 'reconciliation_failed' } })
    // The restart decision is recorded (INV-13): a temporary conversation cannot be observed.
    const reconciliations = second.ctx.artifacts.list({ kind: 'decision', decisionType: 'reconciliation' })
    expect(reconciliations.map((a) => (a.body as { outcome: { option: string } }).outcome.option)).toEqual(['AMBIGUOUS'])
    expect(turns.map((t) => t.turnId).sort()).toEqual([submitted.turnId, queuedTurn.turnId].sort())
    expect((await second.ctx.turns.wait(queuedTurn.turnId, 60_000)).answer).toBe('resumed')
    expect(second.fake.sent.map((s) => s.prompt)).toEqual(['queued before the crash'])
  }, 150_000)
})
