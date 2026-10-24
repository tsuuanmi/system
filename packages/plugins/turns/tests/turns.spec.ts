import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentId, SchemaRegistry } from '@tsuuanmi/system-libs'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { AdmissionFailure, type WorkRequirement } from '@tsuuanmi/system-workers'
import { describe, expect, it, onTestFinished } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { account, ask, fromCopies, turnsStack } from './stack.ts'

const { boot } = turnsStack()

describe.runIf(canRunBrowser)('ctx.turns: ask through a saved account', () => {
  it('answers a one-shot ask in Temporary chat, in Chat mode, with a receipt, a route decision, and an answer artifact', async () => {
    const { ctx, fake } = await boot({ fake: { answer: 'Hello' } })
    const started = await ask(ctx, { prompt: 'Say hello' })
    // The first turn launches the browser; a loaded CI runner can take longer than 30 s.
    const turn = await ctx.turns.wait(started.turnId, 90_000)
    expect(turn).toMatchObject({ status: 'completed', account: 'chatgpt-main', mode: 'temporary', answer: 'Hello', submitted: true })
    expect(turn.sessionId).toBeUndefined()
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Say hello', mode: 'chat', temporary: true })])
    const answer = ctx.artifacts.get(turn.answerArtifact!)
    expect(answer?.body).toMatchObject({ schema: 'provider-answer@1.0', text: 'Hello', conversation: { mode: 'temporary' } })
    const route = ctx.artifacts.get(turn.routeDecision!)
    expect(route?.body).toMatchObject({ decisionType: 'route', outcome: { option: 'worker:chatgpt-main/standard' } })
    expect(ctx.turnReceipts.read({ account: 'chatgpt-main', sessionId: turn.turnId, requestId: turn.turnId })).toMatchObject({ status: 'COMPLETED' })
  }, 150_000)

  it('makes a tier mapped to a preset the driver does not have unavailable, so routing never picks it (PROP-0004: the removed site preset)', async () => {
    const { ctx } = await boot({ accounts: [account('chatgpt-free', { economy: 'site', standard: 'site' }), account('chatgpt-main')] })
    const states = Object.fromEntries((await ctx.workers.list()).map((w) => [w.worker, w.state]))
    expect(states).toMatchObject({ 'worker:chatgpt-free/economy': 'unavailable', 'worker:chatgpt-free/standard': 'unavailable', 'worker:chatgpt-main/standard': 'ready' })
    const admitted = await ctx.workers.route({ schema: 'work-requirement@1.0', objective: 'x', capabilities: ['reason'], data: { classification: 'public', refs: [] }, egressPolicy: 'default', tier: { min: 'economy', source: 'default' }, acceptance: { contract: 'acceptance.answer' } })
    expect(admitted.worker.worker).toBe('worker:chatgpt-main/economy')
  }, 60_000)

  it('describes each tier\'s Worker with its account\'s description and the tier (capability-descriptor@1.7), and its site\'s title from the driver (@1.8, T116)', async () => {
    const { ctx } = await boot({ accounts: [{ ...account('chatgpt-main', { economy: 'instant', frontier: 'high' }), description: 'The studio\'s chat subscription' }, account('chatgpt-2', { standard: 'medium' })] })
    const listed = new Map((await ctx.workers.list()).map((w) => [w.worker, w]))
    expect(listed.get('worker:chatgpt-main/economy')).toMatchObject({ schema: 'capability-descriptor@1.8', title: 'ChatGPT', description: 'The studio\'s chat subscription (economy tier)' })
    expect(listed.get('worker:chatgpt-main/frontier')).toMatchObject({ description: 'The studio\'s chat subscription (frontier tier)' })
    expect(listed.get('worker:chatgpt-2/standard')).toMatchObject({ schema: 'capability-descriptor@1.8', title: 'ChatGPT' })
    expect(listed.get('worker:chatgpt-2/standard')).not.toHaveProperty('description')
    const schemas = new SchemaRegistry()
    for (const w of listed.values()) schemas.assertRecord(w)
    expect((await ctx.accounts.get('chatgpt-main')).description).toBe('The studio\'s chat subscription')
  }, 60_000)

  it('re-verifies a falsely signed-out account from its stored state, without a login, and keeps a really signed-out one marked (REQ-ACC-5)', async () => {
    // A "Log in" offer beside the composer: the maps before 431508f took it for a sign-out.
    const { ctx, fake } = await boot({ fake: { loginOffer: true, answer: 'back' } })
    const ready = await ctx.accounts.get('chatgpt-main')
    expect(await ctx.turns.verify('chatgpt-main')).toMatchObject({ status: 'ready', verified: false, reason: expect.stringMatching(/only a reauth-required account/) })
    await ctx.accounts.markSignedOut('chatgpt-main', 'login-surface', ready.revision)
    const restored = await ctx.turns.verify('chatgpt-main')
    expect(restored).toMatchObject({ account: 'chatgpt-main', status: 'ready', verified: true })
    const view = await ctx.accounts.get('chatgpt-main')
    expect(view.status).toBe('ready')
    expect(Date.parse(view.verifiedAt!)).toBeGreaterThan(Date.parse(ready.verifiedAt!))
    expect(ctx.eventLog.query({ type: 'account.re-verified' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ account: 'chatgpt-main' }) })])
    // Nothing was sent to verify; the account works again.
    expect(fake.sent).toEqual([])
    expect((await ctx.turns.wait((await ask(ctx, { prompt: 'are you back?' })).turnId, 30_000)).answer).toBe('back')
    // Really signed out: it stays marked, and says what to do.
    fake.options.signedIn = false
    await ctx.accounts.markSignedOut('chatgpt-main', 'login-surface', (await ctx.accounts.get('chatgpt-main')).revision)
    expect(await ctx.turns.verify('chatgpt-main')).toMatchObject({ status: 'reauth-required', verified: false, reason: expect.stringMatching(/does not sign in: sign in again/) })
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('reauth-required')
  }, 90_000)

  it('marks an account challenged when its site shows a check only the operator can pass: its Workers stop, nothing is sent (live 2026-10-16)', async () => {
    const { ctx, fake } = await boot()
    const driver = ctx.providers.get('chatgpt-web') as unknown as { checkAuth: () => Promise<string> }
    driver.checkAuth = async () => {
      throw new ProviderError('challenge', 'chatgpt-web: the site shows a CAPTCHA')
    }
    const turn = await ctx.turns.wait((await ask(ctx, { prompt: 'blocked' })).turnId, 30_000)
    expect(turn).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'challenge', disposition: 'USER_ACTION' } })
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('challenge')
    expect((await ctx.workers.list()).filter((w) => w.worker.startsWith('worker:chatgpt-main/')).every((w) => w.state === 'unavailable')).toBe(true)
    expect(ctx.eventLog.query({ type: 'account.challenged' })).toEqual([expect.objectContaining({ data: expect.objectContaining({ account: 'chatgpt-main' }) })])
    expect(fake.sent).toEqual([])
  }, 90_000)

  it('takes every Worker of two accounts signed in as one person out of work, and sends nothing on a turn routed before (REQ-ACC-7)', async () => {
    const { ctx, fake } = await boot({ accounts: [account('chatgpt-main'), account('chatgpt-2')], ready: ['chatgpt-main', 'chatgpt-2'] })
    const statesOf = async (): Promise<string[]> => [...new Set((await ctx.workers.list()).map((w) => w.state))]
    expect(await statesOf()).toEqual(['ready'])
    const requirement: WorkRequirement = {
      schema: 'work-requirement@1.0', objective: 'x', capabilities: ['reason'], data: { classification: 'public', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
      tier: { min: 'standard', source: 'default' }, acceptance: { contract: 'acceptance.answer' },
    }
    // Routed to chatgpt-main while the two were distinct; then chatgpt-2 is signed in as the same person.
    const admitted = await ctx.workers.route(requirement, { restrict: { workers: ['worker:chatgpt-main/standard'], reason: 'test' } })
    const saved = await ctx.accounts.get('chatgpt-2')
    await ctx.accounts.saveState('chatgpt-2', {
      state: { origins: [fake.origin], cookies: [], capturedAt: '2026-10-23T00:00:00Z' },
      identityHash: contentId({ provider: 'chatgpt-web', identity: `chatgpt-web:${fake.options.userId}` }), verifiedAt: '2026-10-23T00:00:00Z',
    }, saved.revision)
    expect(await ctx.accounts.duplicateIdentities()).toEqual([['chatgpt-main', 'chatgpt-2']])
    // Both entries, every tier: neither is a distinct account, and their status is untouched.
    expect(await statesOf()).toEqual(['unavailable'])
    expect((await ctx.accounts.list()).map((a) => a.status)).toEqual(['ready', 'ready'])
    await expect(ctx.workers.route(requirement)).rejects.toBeInstanceOf(AdmissionFailure)
    const started = ctx.turns.ask({ key: 'routed-before', worker: admitted.worker.worker, prompt: 'never sent', requirement, decisions: admitted.decisions })
    admitted.release()
    const turn = await ctx.turns.wait(started.turnId, 30_000)
    expect(turn).toMatchObject({ status: 'failed', submitted: false, error: { kind: 'reauth_required', disposition: 'USER_ACTION', message: expect.stringMatching(/chatgpt-main is signed in as the same person as chatgpt-2.*nothing was sent/) } })
    expect(fake.sent).toEqual([])
    // Signed in as another person, chatgpt-2 is a distinct account again, and both take work.
    await ctx.accounts.saveState('chatgpt-2', {
      state: { origins: [fake.origin], cookies: [], capturedAt: '2026-10-23T00:00:00Z' },
      identityHash: contentId({ provider: 'chatgpt-web', identity: 'chatgpt-web:someone-else' }), verifiedAt: '2026-10-23T00:00:00Z',
    })
    expect(await ctx.accounts.duplicateIdentities()).toEqual([])
    expect(await statesOf()).toEqual(['ready'])
  }, 90_000)

  it('checks a ready account\'s sign-in, sending nothing, and marks it signed out only on positive evidence (health sees it before a turn)', async () => {
    const { ctx, fake } = await boot({ fake: { loginOffer: true } })
    expect(await ctx.turns.checkSignIn('chatgpt-main')).toBe('signed-in')
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('ready')
    fake.options.signedIn = false
    expect(await ctx.turns.checkSignIn('chatgpt-main')).toBe('signed-out')
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('reauth-required')
    expect(ctx.eventLog.query({ type: 'account.signed-out' })).toEqual([expect.objectContaining({ data: { account: 'chatgpt-main', by: 'sign-in check' } })])
    // An account that is not ready is not checked again.
    expect(await ctx.turns.checkSignIn('chatgpt-main')).toBe('unknown')
    expect(fake.sent).toEqual([])
  }, 90_000)

  it('writes back the state a signed-in check refreshed, and never one from a check that found it signed out', async () => {
    const { ctx, fake } = await boot({ fake: { rotateOnLoad: true } })
    fromCopies(ctx)
    const before = await ctx.accounts.get('chatgpt-main')
    expect(await ctx.turns.checkSignIn('chatgpt-main')).toBe('signed-in')
    const after = await ctx.accounts.get('chatgpt-main')
    expect(after.revision).toBe(before.revision + 1)
    expect((await ctx.accounts.portableState('chatgpt-main'))?.cookies.map((c) => c.name)).toContain('session_seen')
    // Signed out: marked, and the page's state is never kept.
    fake.options.signedIn = false
    const kept = await ctx.accounts.portableState('chatgpt-main')
    expect(await ctx.turns.checkSignIn('chatgpt-main')).toBe('signed-out')
    expect(await ctx.accounts.portableState('chatgpt-main')).toEqual(kept)
    expect(ctx.eventLog.query({ type: 'account.write-back-skipped' })).toEqual([])
    expect(fake.sent).toEqual([])
  }, 90_000)

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
    fromCopies(ctx)
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

  it('reports each account\'s load, busy at its limit, and routes the next turn to the least busy account (ADR-0033)', async () => {
    const { ctx } = await boot({ accounts: [account('chatgpt-main'), account('chatgpt-2')], ready: ['chatgpt-main', 'chatgpt-2'], capacity: 1, fake: { thinkMs: 4000 } })
    const loadOf = async (id: string) => (await ctx.workers.list()).find((w) => w.worker === `worker:${id}/standard`)!
    // With equal loads the id decides: chatgpt-2 first.
    const first = await ask(ctx, { prompt: 'one' })
    expect(first.account).toBe('chatgpt-2')
    await expect.poll(async () => (await loadOf('chatgpt-2')).load, { timeout: 30_000 }).toEqual({ running: 1, queued: 0, pending: 0, slots: 1 })
    expect((await loadOf('chatgpt-2')).state).toBe('busy')
    // Routed and not started yet: pending on its account until released.
    const routed = await ctx.workers.route({ schema: 'work-requirement@1.0', objective: 'test', egressPolicy: 'egress.classification-and-secrets', capabilities: ['reason'],
      data: { classification: 'operator-shared', refs: [] }, tier: { min: 'standard', source: 'default' }, acceptance: { contract: 'acceptance.answer' } })
    expect(routed.worker.worker).toBe('worker:chatgpt-main/standard')
    expect((await loadOf('chatgpt-main')).load).toEqual({ running: 0, queued: 0, pending: 1, slots: 1 })
    routed.release()
    expect((await loadOf('chatgpt-main')).load).toEqual({ running: 0, queued: 0, pending: 0, slots: 1 })
    const second = await ask(ctx, { prompt: 'two' })
    expect(second.account).toBe('chatgpt-main')
    const route = ctx.artifacts.get(second.routeDecision!)?.body as { candidates: Array<{ option: string; reasons: string[] }> }
    expect(route.candidates.find((c) => c.option === 'worker:chatgpt-2/standard')!.reasons).toEqual(['admitted; worker:chatgpt-main/standard is less busy (load 0 of 1; this one load 1 of 1)'])
    await Promise.all([ctx.turns.wait(first.turnId, 30_000), ctx.turns.wait(second.turnId, 30_000)])
  }, 90_000)

  it('cools an account the site answers with its usage limit, keeps its status ready, and ends the limit by a used feature or the operator (ADR-0034)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    // The operator's overlay recognizes the site's limit answers, with no release.
    writeFileSync(join(dir, 'none.yaml'), [
      'elements:',
      '  answer.limit:',
      "    candidates: [{ text: { en: '^You have reached your usage limit' } }]",
      '  answer.search-limit:',
      "    candidates: [{ text: { en: '^You have reached your search limit' } }]",
      'errors:',
      '  - { when: { visible: answer.limit }, kind: quota_exhausted, on: answer }',
      '  - { when: { visible: answer.search-limit }, kind: quota_exhausted, feature: web-search, on: answer }',
    ].join('\n'))
    const { ctx, fake } = await boot({ dir, fake: { answer: 'You have reached your usage limit until 18:40.', features: ['web-search'] } })
    const stateOf = async () => (await ctx.workers.list()).find((w) => w.worker === 'worker:chatgpt-main/standard')!
    // The whole account: sent, so it fails and is never resent; its Workers are out of quota for a while.
    const limited = await ctx.turns.wait((await ask(ctx, { prompt: 'one' })).turnId, 30_000)
    expect(limited).toMatchObject({ status: 'failed', error: { kind: 'quota_exhausted' } })
    expect(fake.sent).toHaveLength(1)
    expect(ctx.turns.cooldowns()).toEqual([expect.objectContaining({ account: 'chatgpt-main', feature: '*', source: expect.stringMatching(/quota_exhausted/) })])
    expect((await stateOf()).state).toBe('quota-exhausted')
    // Its account, assigned by default, says when it is back, so work only it could take waits for it (ADR-0052).
    expect((await stateOf()).account).toEqual({ id: 'chatgpt-main', group: 'chatgpt-web', mode: 'assigned', limitUntil: ctx.turns.cooldowns()[0]!.until })
    expect((await ctx.accounts.get('chatgpt-main')).status).toBe('ready')
    expect(ctx.turns.clearCooldown('chatgpt-main')).toBe(1)
    expect((await stateOf()).state).toBe('ready')
    expect((await stateOf()).account).toEqual({ id: 'chatgpt-main', group: 'chatgpt-web', mode: 'assigned' })
    // One feature: only work that needs it is kept away; a turn that used it and succeeded ends it.
    await ctx.turns.probe('chatgpt-main')
    fake.options.answer = 'You have reached your search limit for today.'
    await ctx.turns.wait((await ask(ctx, { prompt: 'news?', search: true })).turnId, 30_000)
    expect((await stateOf()).cooldowns).toEqual([{ capability: 'web-search', until: expect.any(String) }])
    await expect(ask(ctx, { prompt: 'more news?', search: true })).rejects.toThrow(/web-search limit until/)
    fake.options.answer = 'Plain answer'
    expect(await ctx.turns.wait((await ask(ctx, { prompt: 'plain' })).turnId, 30_000)).toMatchObject({ status: 'completed' })
    const requirement: WorkRequirement = { schema: 'work-requirement@1.0', objective: 'test', egressPolicy: 'egress.classification-and-secrets', capabilities: ['reason', 'web-search'],
      data: { classification: 'operator-shared', refs: [] }, tier: { min: 'standard', source: 'default' }, acceptance: { contract: 'acceptance.answer' } }
    const used = ctx.turns.ask({ key: 'used-search', worker: 'worker:chatgpt-main/standard', prompt: 'news now', requirement, decisions: limited.routeDecision ? { route: limited.routeDecision, tier: limited.tierDecision! } : (undefined as never) })
    expect(await ctx.turns.wait(used.turnId, 30_000)).toMatchObject({ status: 'completed' })
    expect(ctx.turns.cooldowns()).toEqual([])
  }, 120_000)

  it('names a pooled provider\'s accounts pooled, only with the operator\'s recorded terms, recorded at start as a gate decision (REQ-ACC-10, ADR-0052)', async () => {
    const pooledTerms = { confirmedBy: 'operator', confirmedAt: '2026-10-24T09:00:00Z', terms: 'Team plan terms, read 2026-10-24' }
    const { ctx } = await boot({ providers: [{ provider: 'chatgpt-web', accounts: 'pooled', pooledTerms }] })
    expect((await ctx.workers.list()).find((w) => w.worker === 'worker:chatgpt-main/standard')!.account).toEqual({ id: 'chatgpt-main', group: 'chatgpt-web', mode: 'pooled' })
    const gates = ctx.artifacts.list({ kind: 'decision', decisionType: 'gate', limit: 10 }).map((a) => a.body as { decider: { id: string }; outcome: unknown })
    expect(gates.filter((g) => g.decider.id === 'turns.pooled-terms').map((g) => g.outcome)).toEqual([{ option: 'pooled', detail: { provider: 'chatgpt-web', ...pooledTerms } }])
  })

  it('never takes a limit an earlier answer of the conversation gave for the next answer\'s (ADR-0034)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(join(dir, 'none.yaml'), [
      'elements:',
      '  answer.limit:',
      "    candidates: [{ text: { en: '^You have reached your usage limit' } }]",
      'errors:',
      '  - { when: { visible: answer.limit }, kind: quota_exhausted, on: answer }',
    ].join('\n'))
    const { ctx, fake } = await boot({ dir, fake: { answer: 'You have reached your usage limit until 18:40.' } })
    const first = await ctx.turns.wait((await ask(ctx, { prompt: 'one', persist: true })).turnId, 30_000)
    expect(first).toMatchObject({ status: 'failed', error: { kind: 'quota_exhausted' } })
    ctx.turns.clearCooldown('chatgpt-main')
    // The limit answer stays in the conversation; the next answer is read on its own.
    fake.options.answer = 'A plain answer'
    const second = await ctx.turns.wait((await ask(ctx, { prompt: 'two', sessionId: first.sessionId! })).turnId, 30_000)
    expect(second).toMatchObject({ status: 'completed', answer: 'A plain answer' })
    expect(ctx.turns.cooldowns()).toEqual([])
  }, 120_000)

  it('holds a session to its account only once something was sent, so an unsent first turn may move to a sibling (ADR-0034)', async () => {
    const { ctx, fake } = await boot({ accounts: [account('chatgpt-main'), account('chatgpt-2')], ready: ['chatgpt-main', 'chatgpt-2'], fake: { captcha: true } })
    const requirement: WorkRequirement = { schema: 'work-requirement@1.0', objective: 'test', egressPolicy: 'egress.classification-and-secrets', capabilities: ['reason', 'persistent-conversation'],
      data: { classification: 'operator-shared', refs: [] }, tier: { min: 'standard', source: 'default' }, acceptance: { contract: 'acceptance.answer' } }
    // Each start carries the decisions of a real route to its Worker.
    const routed = async (worker: string) => {
      const admitted = await ctx.workers.route(requirement, { restrict: { workers: [worker], reason: 'this test' } })
      admitted.release()
      return admitted.decisions
    }
    const first = ctx.turns.ask({ key: 'first', worker: 'worker:chatgpt-2/standard', prompt: 'one', sessionId: 'ses_move', requirement, decisions: await routed('worker:chatgpt-2/standard') })
    expect(await ctx.turns.wait(first.turnId, 30_000)).toMatchObject({ status: 'failed', error: { kind: 'challenge' } })
    expect(fake.sent).toEqual([])
    // Nothing was sent: the session holds no account, and its next turn may run on another one.
    expect(ctx.workers.affinity('ses_move')).toBeUndefined()
    fake.options.captcha = false
    const moved = ctx.turns.ask({ key: 'moved', worker: 'worker:chatgpt-main/standard', prompt: 'one', sessionId: 'ses_move', requirement, decisions: await routed('worker:chatgpt-main/standard') })
    expect(await ctx.turns.wait(moved.turnId, 30_000)).toMatchObject({ status: 'completed', account: 'chatgpt-main' })
    // Sent now: held to its account.
    expect(ctx.workers.affinity('ses_move')).toEqual(['worker:chatgpt-main/economy', 'worker:chatgpt-main/standard', 'worker:chatgpt-main/frontier'])
    const stray = await routed('worker:chatgpt-main/frontier')
    expect(() => ctx.turns.ask({ key: 'stray', worker: 'worker:chatgpt-2/standard', prompt: 'two', sessionId: 'ses_move', requirement, decisions: stray })).toThrow(/bound to chatgpt-main/)
  }, 120_000)

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

  it('checks egress before sending: credentials or local-private content never leave (INV-12)', async () => {
    const { ctx, fake } = await boot()
    const pem = String((await import('node:crypto')).generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }))
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
})
