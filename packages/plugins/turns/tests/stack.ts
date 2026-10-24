/**
 * The real stack the turn runtime's browser tests run on: the kernel, accounts and login, the
 * browser, and a website driver against its fake site. A test file calls {@link turnsStack} once,
 * at its top: that registers the file's one Xvfb and returns the boots, whose stacks are stopped
 * when their test finishes.
 */
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Accounts from '@tsuuanmi/system-accounts'
import Artifacts from '@tsuuanmi/system-artifacts'
import BrowserPool from '@tsuuanmi/system-browser-patchright'
import Vault from '@tsuuanmi/system-credentials-vault'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { contentId, type ProviderAccounts } from '@tsuuanmi/system-libs'
import Login from '@tsuuanmi/system-login'
import ChatGptWeb from '@tsuuanmi/system-provider-chatgpt-web'
import * as GeminiWeb from '@tsuuanmi/system-provider-gemini-web'
import Providers from '@tsuuanmi/system-providers'
import Store from '@tsuuanmi/system-store'
import TurnReceipts from '@tsuuanmi/system-turn-receipts'
import WorkerRouter, { type Tier, type WorkRequirement } from '@tsuuanmi/system-workers'
import { chromium } from 'patchright-core'
import { onTestFinished } from 'vitest'
import { fileDisplay, testChrome } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../../provider-chatgpt-web/fixtures/fake-chatgpt.ts'
import { FakeGemini, type FakeOptions as FakeGeminiOptions } from '../../provider-gemini-web/fixtures/fake-gemini.ts'
import Turns from '../src/index.ts'

export type CatalogEntry = { id: string; provider: string; quotaClass: 'subscription-chat'; tiers: Record<string, string>; description?: string }
export const account = (id: string, tiers: Record<string, string> = { economy: 'instant', standard: 'medium', frontier: 'high' }): CatalogEntry => ({ id, provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers })

export type AskSpec = { prompt: string; tier?: Tier; sessionId?: string; persist?: boolean; research?: boolean; search?: boolean; classification?: WorkRequirement['data']['classification']; key?: string }

/**
 * The fresh-context path (ADR-0016): a driver that is not session-bound works from the account's
 * portable state and writes it back. Both shipped drivers are session-bound (ADR-0030), so the
 * tests of that path turn it off on ChatGPT's.
 */
export const fromCopies = (ctx: Context): void => void Object.defineProperty(ctx.providers.get('chatgpt-web'), 'sessionBound', { value: false })

/** What the workflow engine does before a turn: build the requirement, route it, start it on the admitted Worker. */
export async function ask(ctx: Context, input: AskSpec) {
  const sessionId = input.sessionId ?? (input.persist || input.research ? `ses_${randomBytes(8).toString('hex')}` : undefined)
  const requirement: WorkRequirement = {
    schema: 'work-requirement@1.0', objective: 'test', egressPolicy: 'egress.classification-and-secrets',
    capabilities: ['reason', ...(sessionId ? ['persistent-conversation'] : []), ...(input.research ? ['deep-research'] : []), ...(input.search ? ['web-search'] : [])],
    data: { classification: input.classification ?? 'operator-shared', refs: [] },
    tier: { min: input.tier ?? 'standard', source: input.tier ? 'caller' : 'default' }, acceptance: { contract: 'acceptance.answer' },
  }
  const affinity = sessionId ? ctx.workers.affinity(sessionId) : undefined
  const admitted = await ctx.workers.route(requirement, affinity ? { restrict: { workers: affinity, reason: 'the session stays on its account' } } : {})
  try {
    return ctx.turns.ask({ key: input.key ?? randomBytes(8).toString('hex'), worker: admitted.worker.worker, prompt: input.prompt, sessionId, requirement, decisions: admitted.decisions })
  } finally {
    admitted.release()
  }
}

/** As the live check does for the real site: the fake site's delete flow is the one its map describes. */
export function liveChecked(ctx: Context): void {
  const map = (ctx.providers.get('chatgpt-web') as unknown as { map: { elements: Record<string, { unverified?: true }>; actions: Record<string, { unverified?: true }> } }).map
  for (const spec of [...Object.values(map.elements), ...Object.values(map.actions)]) delete spec.unverified
}

export interface BootOptions { fake?: FakeOptions; accounts?: CatalogEntry[]; providers?: ProviderAccounts[]; ready?: string[]; dir?: string; capacity?: number; shared?: FakeChatGpt; turns?: Record<string, unknown> }

/**
 * The test file's stack: every boot draws its browsers on the file's one Xvfb, and is stopped,
 * with its fake site and directory, when its test finishes. Call it once, at the top of the file.
 */
export function turnsStack() {
  /** The file's one Xvfb: every test's browser draws on it, as a profile's browsers share display-virtual's. */
  const TestDisplay = fileDisplay()

  async function boot(options: BootOptions = {}) {
    const fake = options.shared ?? new FakeChatGpt({ answer: 'OK', ...options.fake })
    if (!options.shared) await fake.start()
    const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-turns-'))
    if (!options.dir) onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    if (!options.shared) onTestFinished(() => fake.stop())
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }),
      ctx.plugin(Artifacts, {}),
      ctx.plugin(EventLog, {}),
      ctx.plugin(Leases, {}),
      ctx.plugin(Egress, {}),
      ctx.plugin(TurnReceipts, {}),
      ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
      ctx.plugin(Accounts, { accounts: options.accounts ?? [account('chatgpt-main')], ...(options.providers ? { providers: options.providers } : {}) }),
      ctx.plugin(TestDisplay),
      ctx.plugin(BrowserPool, { chromePath: testChrome! }),
      ctx.plugin(Providers),
      ctx.plugin(ChatGptWeb, { origin: fake.origin, pageGapMs: 0, overlayPath: join(dir, 'none.yaml'), modes: { instant: { model: 'Latest', effort: 'Instant' }, medium: { model: 'Latest', effort: 'Medium' }, high: { model: 'GPT-6', effort: 'High' } }, defaultMode: 'instant' }),
      ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }),
      ctx.plugin(WorkerRouter, {}),
      ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000, maxConcurrentTurnsPerAccount: options.capacity ?? 2, ...options.turns }),
    ]
    await Promise.all(fibers)
    const stop = async (): Promise<void> => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    }
    onTestFinished(stop)
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

  /**
   * A Gemini account whose site binds its session to the profile that signed in (ADR-0030): the
   * operator signs in in its login profile, as a remote login does, then Saves.
   */
  async function bootBound(options: { fake?: FakeGeminiOptions; turns?: Record<string, unknown> } = {}) {
    const fake = new FakeGemini({ startOnSpark: false, deviceBound: true, answer: 'From the profile.', ...options.fake })
    await fake.start()
    onTestFinished(() => fake.stop())
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-bound-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }),
      ctx.plugin(Artifacts, {}),
      ctx.plugin(EventLog, {}),
      ctx.plugin(Leases, {}),
      ctx.plugin(Egress, {}),
      ctx.plugin(TurnReceipts, {}),
      ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
      ctx.plugin(Accounts, { accounts: [{ id: 'gemini-main', provider: 'gemini-web', quotaClass: 'subscription-chat', tiers: { economy: 'flash-lite', standard: 'flash', frontier: 'pro' } }] }),
      ctx.plugin(TestDisplay),
      ctx.plugin(BrowserPool, { chromePath: testChrome! }),
      ctx.plugin(Providers),
      ctx.plugin(GeminiWeb, { origin: fake.origin, pageGapMs: 0 }),
      ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }),
      ctx.plugin(WorkerRouter, {}),
      ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000, ...options.turns }),
    ]
    await Promise.all(fibers)
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    })
    const profile = await chromium.launchPersistentContext(ctx.login.profileDir('gemini-main'), { executablePath: testChrome!, headless: true })
    const page = await profile.newPage()
    await page.goto(`${fake.origin}/signin`)
    await page.locator('#bound').waitFor({ state: 'visible' })
    await profile.close()
    // Verified in the profile: a copy of this state is signed out, so Save would fail on a copy.
    // Its features first: a background probe that starts once the account is ready finds them fresh, so it loads nothing.
    await ctx.accounts.setFeatures('gemini-main', ['deep-research'])
    await ctx.login.save('gemini-main')
    return { ctx, fake }
  }

  /** A ChatGPT account bound to the profile that signed in, as chatgpt-main was live: signed in there, then Saved. */
  async function bootBoundChatGpt(options: { fake?: FakeOptions; turns?: Record<string, unknown> } = {}) {
    const fake = new FakeChatGpt({ deviceBound: true, answer: 'From the ChatGPT profile.', ...options.fake })
    await fake.start()
    onTestFinished(() => fake.stop())
    const dir = mkdtempSync(join(tmpdir(), 'system-turns-bound-chatgpt-'))
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }),
      ctx.plugin(Artifacts, {}),
      ctx.plugin(EventLog, {}),
      ctx.plugin(Leases, {}),
      ctx.plugin(Egress, {}),
      ctx.plugin(TurnReceipts, {}),
      ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
      ctx.plugin(Accounts, { accounts: [{ id: 'chatgpt-main', provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers: { economy: 'instant', standard: 'medium', frontier: 'high' } }] }),
      ctx.plugin(TestDisplay),
      ctx.plugin(BrowserPool, { chromePath: testChrome! }),
      ctx.plugin(Providers),
      ctx.plugin(ChatGptWeb, { origin: fake.origin, pageGapMs: 0, overlayPath: join(dir, 'none.yaml'), modes: { instant: { model: 'Latest', effort: 'Instant' }, medium: { model: 'Latest', effort: 'Medium' }, high: { model: 'GPT-6', effort: 'High' } }, defaultMode: 'instant' }),
      ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }),
      ctx.plugin(WorkerRouter, {}),
      ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000, ...options.turns }),
    ]
    await Promise.all(fibers)
    onTestFinished(async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    })
    const profile = await chromium.launchPersistentContext(ctx.login.profileDir('chatgpt-main'), { executablePath: testChrome!, headless: true })
    const page = await profile.newPage()
    await page.goto(`${fake.origin}/signin`)
    await page.locator('#bound').waitFor({ state: 'visible' })
    await profile.close()
    await ctx.accounts.setFeatures('chatgpt-main', ['deep-research', 'web-search', 'image-generation'])
    await ctx.login.save('chatgpt-main')
    return { ctx, fake }
  }

  return { boot, bootBound, bootBoundChatGpt }
}
