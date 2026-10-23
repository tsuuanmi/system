import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import Providers from '@tsuuanmi/system-providers'
import Store from '@tsuuanmi/system-store'
import { type DriftEvent, UiEngine } from '@tsuuanmi/system-ui-ops'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { ProviderError, type ProviderDriver } from '@tsuuanmi/system-provider-core'
import type { Browser, BrowserContext, Page } from 'patchright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeGemini, type FakeOptions } from '../fixtures/fake-gemini.ts'
import { GeminiWebDriver, shippedMap } from '../src/index.ts'
import { type DriverOptions, namesOnly } from '../src/driver.ts'
import * as GeminiWebPlugin from '../src/index.ts'

const PRESETS = { 'flash-lite': { model: 'Flash-Lite', effort: 'Low' }, flash: { model: 'Flash', effort: 'Medium' }, pro: { model: 'Pro', effort: 'High' }, site: {} }

describe('the Gemini Web UI map and driver contract', () => {
  it('is a valid ui-map', () => {
    const map = shippedMap()
    expect(map.provider).toBe('gemini-web')
    expect(() => new SchemaRegistry().assert('ui-map@1.1', { ...map, elements: map.elements })).toBeDefined()
    expect(Object.keys(map.states)).toEqual(expect.arrayContaining(['auth.signed-in', 'auth.signed-out', 'turn.running']))
  })

  it('proves reasoning and persistent conversations, and offers Deep research as an account feature', async () => {
    const driver: ProviderDriver<Page> = new GeminiWebDriver({ modes: PRESETS })
    expect(driver.capabilities).toEqual(['reason', 'persistent-conversation'])
    expect(driver.features).toEqual(['deep-research'])
  })

  it('refuses what the site does not offer, before opening anything', async () => {
    const driver = new GeminiWebDriver({ modes: PRESETS })
    // Temporary chat offers no Deep research, and a temporary turn has no conversation to continue.
    await expect(driver.ask({} as Page, 'hi', { conversation: 'temporary', feature: 'deep-research' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(driver.ask({} as Page, 'hi', { conversation: 'temporary', binding: '7b75f8c2d641e476' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(driver.ask({} as Page, 'hi', { conversation: 'persistent', feature: 'web-search' })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('fails closed on an unknown preset, before opening anything', async () => {
    const driver = new GeminiWebDriver({ modes: PRESETS })
    await expect(driver.ask({} as Page, 'hi', { conversation: 'temporary', mode: 'ultra' })).rejects.toMatchObject({ kind: 'config_error' })
    expect(() => new GeminiWebDriver({ modes: PRESETS, defaultMode: 'ultra' })).toThrow(/default mode ultra/)
    expect(() => new GeminiWebDriver({ modes: PRESETS, researchMode: 'ultra' })).toThrow(/research mode ultra/)
  })

  it('registers itself on ctx.providers', async () => {
    const ctx = new Context()
    await ctx.plugin(Providers)
    await ctx.plugin(GeminiWebPlugin, { origin: 'http://127.0.0.1:9' })
    expect(ctx.providers.get('gemini-web')).toBeInstanceOf(GeminiWebDriver)
  })

  it('logs drift as ui.drift, its outline kept as local-private evidence (drift evidence, INV-12)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-gemini-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Providers), ctx.plugin(GeminiWebPlugin, { origin: 'http://127.0.0.1:9' })]
    try {
      await Promise.all(fibers)
      const driver = ctx.providers.get('gemini-web') as GeminiWebDriver
      driver.onDrift!({ provider: 'gemini-web', element: 'temporary.enable', kind: 'postcondition', candidate: -1, mapHash: 'sha256:00', outline: { schema: 'ui-outline@1.0', root: 'body', truncated: false, nodes: [{ depth: 0, tag: 'body', text: 3 }] } })
      const [event] = ctx.eventLog.query({ type: 'ui.drift', limit: 10 })
      expect(event!.data).toEqual({ provider: 'gemini-web', element: 'temporary.enable', kind: 'postcondition', candidate: -1, mapHash: 'sha256:00', outline: expect.stringMatching(/^sha256:/) })
      expect(ctx.artifacts.get(String(event!.data!.outline))).toMatchObject({ kind: 'evidence', bodySchema: 'ui-outline@1.0', classification: 'local-private' })
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.runIf(canRunBrowser)('GeminiWebDriver against the fake site', { timeout: 60_000 }, () => {
  let browser: Browser
  let close: () => Promise<void>
  let context: BrowserContext | undefined
  let fake: FakeGemini | undefined
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close())
  afterEach(async () => {
    await context?.close()
    await fake?.stop()
    context = undefined
    fake = undefined
  })

  async function open(options: FakeOptions = {}, driverOptions: DriverOptions = {}): Promise<{ page: Page; driver: GeminiWebDriver; fake: FakeGemini }> {
    fake = new FakeGemini(options)
    const origin = await fake.start()
    context = await browser.newContext()
    const page = await context.newPage()
    const driver = new GeminiWebDriver({ origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 30_000, stallMs: 15_000 }, ...driverOptions })
    return { page, driver, fake }
  }

  it('chooses the mode before typing the prompt, and finds each prompt by its bubble with no drift (live 2026-10-17)', async () => {
    const { page, driver } = await open({ startOnSpark: false })
    const drifts: Array<{ element: string }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    await driver.ask(page, 'x'.repeat(2000), { conversation: 'temporary', mode: 'pro' })
    // Every time the picker opened, the composer was still empty.
    const opened = (await page.evaluate(() => document.body.dataset.pickerOpenedWith ?? '')).split(',').filter(Boolean).map(Number)
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every((n) => n === 0)).toBe(true)
    expect(drifts.filter((d) => d.element === 'turn.user')).toEqual([])
  })

  it('outlines a stalled answer with the page\'s visibility, focus, and path, and fails it as provider_stalled', async () => {
    const { page, fake } = await open({ startOnSpark: false, holdAnswer: true })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 30_000, stallMs: 1500 } })
    const stalls: Array<{ provider: string; phase: string; visibility?: string; focused?: boolean; url?: string; outline?: { nodes: unknown[] } }> = []
    driver.onStall = (event) => void stalls.push(event as never)
    await expect(driver.ask(page, 'hello', { conversation: 'persistent' })).rejects.toMatchObject({ kind: 'provider_stalled' })
    expect(stalls).toEqual([expect.objectContaining({ provider: 'gemini-web', phase: 'answer', visibility: 'visible', focused: true, url: expect.stringMatching(/^\/app/) })])
    expect(stalls[0]!.outline!.nodes.length).toBeGreaterThan(0)
  })

  it('keeps a page that already shows its conversation as it is, and reports it idle only with nothing open (kept tabs, ADR-0030)', async () => {
    const { page, driver, fake } = await open({ startOnSpark: false })
    const first = await driver.ask(page, 'hello', { conversation: 'persistent' })
    expect(await driver.pageIdle(page)).toBe(true)
    const loads = fake.pageLoads.length
    // The page shows the conversation already: the next turn does not load it again.
    await driver.ask(page, 'again', { conversation: 'persistent', binding: first.binding! })
    expect(fake.pageLoads.length).toBe(loads)
    await page.locator('#conv-options').click()
    expect(await driver.pageIdle(page)).toBe(false)
  })

  it('outlines a page that shows neither signed in nor signed out, as drift evidence, and reports it unknown', async () => {
    const { page, fake } = await open({ interstitial: true })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 1500 } })
    const drifts: Array<{ element: string; outline?: { nodes: Array<{ role?: string }> } }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    expect(await driver.checkAuth(page)).toBe('unknown')
    expect(drifts).toEqual([expect.objectContaining({ element: 'auth.account', kind: 'unresolved' })])
    expect(drifts[0]!.outline!.nodes.some((n) => n.role === 'dialog')).toBe(true)
  })

  it('stops at Google\'s unusual-traffic check as a challenge, at once and with nothing sent (live 2026-10-16)', async () => {
    const { page, driver, fake } = await open({ captcha: true })
    const started = Date.now()
    await expect(driver.checkAuth(page)).rejects.toMatchObject({ kind: 'challenge', disposition: 'USER_ACTION', message: expect.stringMatching(/unusual-traffic check/) })
    // Not the 60 s a page that never becomes ready waits.
    expect(Date.now() - started).toBeLessThan(20_000)
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'challenge' })
    expect(fake.sent).toEqual([])
  })

  it('fails an answer that is the site\'s own error before anything judges it, and reads a longer answer about errors as an answer (live 2026-10-17)', async () => {
    const { page, driver, fake } = await open({ answer: 'I seem to be encountering an error. Can I try something else for you?' })
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'overloaded', message: expect.stringMatching(/the site answered with its own error instead of an answer \("I seem to be encountering an error/) })
    expect(fake.sent).toHaveLength(1)
    fake.options.answer = `Something went wrong in the build: ${'the cache was stale, so the step ran twice. '.repeat(10)}`
    expect((await driver.ask(page, 'why?', { conversation: 'temporary' })).text).toMatch(/^Something went wrong in the build/)
  })

  it('stops at a terms notice over the input as a challenge for the operator, at once, never clicking it and with nothing sent (live 2026-10-17)', async () => {
    const { page, driver, fake } = await open({ termsNotice: true })
    const notice = { kind: 'challenge', disposition: 'USER_ACTION', message: 'gemini-web: the site shows a terms notice over the input; acknowledge it in the login profile (system account login) and Save' }
    await expect(driver.checkAuth(page)).rejects.toMatchObject(notice)
    const started = Date.now()
    // Not the wait for a textbox it covers (readyMs here is 5 s), nor a mode switch it hides.
    await expect(driver.ask(page, 'hello', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject(notice)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(fake.sent).toEqual([])
    expect(await page.locator('gem-banner').count()).toBe(1)
  })

  it('fails a page that shows neither signed in nor signed out once, as drift, never as a session to retry', async () => {
    const { page, fake } = await open({ interstitial: true })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 1500 } })
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'ui_drift', disposition: 'CONFIG_FIX' })
    expect(fake.sent).toEqual([])
  })

  it('fails a bound conversation the site no longer has at once, as conversation_lost: reopening it cannot help (live 2026-10-16)', async () => {
    const { page, driver, fake } = await open({ answer: 'first' })
    const first = await driver.ask(page, 'remember', { conversation: 'persistent' })
    // Gone on the site (as after the live re-login, which closes kept tabs): a fresh page opens it,
    // and the site sends that page to /app.
    fake.conversations.delete(first.binding!)
    const fresh = await page.context().newPage()
    await expect(driver.ask(fresh, 'again', { conversation: 'persistent', binding: first.binding })).rejects.toMatchObject({ kind: 'conversation_lost', disposition: 'USER_ACTION', message: expect.stringMatching(/no longer opens/) })
    expect(fake.sent).toHaveLength(1)
  })

  it('refuses a prompt over its input limit before anything is sent, and calls a dropped prompt dropped, not UI drift', async () => {
    const { page, fake } = await open({ answer: 'never', dropOver: 50 })
    const limited = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', maxPromptChars: 40, timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 30_000, stallMs: 15_000 } })
    await expect(limited.ask(page, 'x'.repeat(41), { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/41 characters, over the 40 .*nothing was sent/) })
    // Under the driver's limit but over the site's: the site empties the composer and asks nothing.
    const loose = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', maxPromptChars: 1000, timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 30_000, stallMs: 15_000 } })
    await expect(loose.ask(page, 'y'.repeat(60), { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'input_dropped', disposition: 'USER_ACTION' })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('asks in a Temporary chat on the Chat tab, never Spark, with the preset read back before sending', async () => {
    const { page, driver, fake } = await open({ answer: 'Gemini test OK.' })
    const boundaries: unknown[] = []
    const result = await driver.ask(page, 'Say OK', { conversation: 'temporary', mode: 'pro', beforeSend: (b) => void boundaries.push(b) })
    expect(result).toEqual({ text: 'Gemini test OK.', binding: undefined, mode: { model: '3.1 Pro', effort: 'High' } })
    expect(fake.sent).toEqual([{ prompt: 'Say OK', tab: 'chat', temporary: true, model: '3.1 Pro', level: 'High', deepResearch: false }])
    expect(boundaries).toEqual([{ previousResponse: null, mode: { model: '3.1 Pro', effort: 'High' } }])
  })

  it('tells Flash from Flash-Lite, and uses the default preset when a turn names none', async () => {
    const { page, driver, fake } = await open()
    expect((await driver.ask(page, 'one', { conversation: 'temporary', mode: 'flash-lite' })).mode).toEqual({ model: '3.5 Flash-Lite', effort: 'Low' })
    expect((await driver.ask(page, 'two', { conversation: 'temporary' })).mode).toEqual({ model: '3.8 Flash', effort: 'Medium' })
    expect(fake.sent.map((s) => [s.model, s.level])).toEqual([['3.5 Flash-Lite', 'Low'], ['3.8 Flash', 'Medium']])
  })

  it('opens the thinking-level submenu to choose a level (the layout since 2026-10-16)', async () => {
    const { page, driver, fake } = await open()
    expect((await driver.ask(page, 'one', { conversation: 'temporary', mode: 'pro' })).mode).toEqual({ model: '3.1 Pro', effort: 'High' })
    expect(fake.sent.map((s) => s.level)).toEqual(['High'])
  })

  it('reports a level it cannot reach in the submenu as drift, with evidence, and sends nothing', async () => {
    const broken = await open({ submenuBroken: true })
    const drift: DriftEvent[] = []
    broken.driver.onDrift = (event) => drift.push(event)
    await expect(broken.driver.ask(broken.page, 'two', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/thinking level High is offered but cannot be reached/) })
    expect(broken.fake.sent).toEqual([])
    expect(drift).toEqual([expect.objectContaining({ element: 'mode.level', kind: 'unresolved', outline: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ role: 'menuitem' })]) }) })])
  })

  it('reads a thinking level with its note on its own line too (the layout before 2026-10-16)', async () => {
    const { page, driver, fake } = await open({ levelsInline: false })
    expect((await driver.ask(page, 'hi', { conversation: 'temporary', mode: 'flash' })).mode).toEqual({ model: '3.8 Flash', effort: 'Medium' })
    expect(fake.sent.map((s) => s.level)).toEqual(['Medium'])
  })

  it('returns the answer as Markdown from its Copy, with code lines kept (REQ-PRV-5)', async () => {
    const markdown = '## Plan\n\n* **First** item\n* **Second** item\n\nSee `x` and [example.com](https://example.com).\n\n```python\ndef add(a, b):\n    return a + b\n```'
    const { page, driver } = await open({ answer: markdown })
    expect((await driver.ask(page, 'Markdown please', { conversation: 'temporary' })).text).toBe(markdown)
  })

  it('is signed in with a "Sign in" offer beside the account\'s own button, and signed out only without it', async () => {
    const { page, driver, fake } = await open({ signInOffer: true, answer: 'still here' })
    expect(await driver.checkAuth(page)).toBe('signed-in')
    expect((await driver.ask(page, 'hi', { conversation: 'temporary' })).text).toBe('still here')
    expect(fake.sent).toHaveLength(1)
  })

  it('refuses to send when Spark cannot be left', async () => {
    const { page, driver, fake } = await open({ chatTabBroken: true })
    await expect(driver.ask(page, 'hi', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/Chat tab/) })
    expect(fake.sent).toEqual([])
  })

  it('refuses to send when Temporary chat does not turn on, and reports it with an outline of the page: structure, never text', async () => {
    const { page, driver, fake } = await open({ temporaryBroken: true })
    const drift: DriftEvent[] = []
    driver.onDrift = (event) => drift.push(event)
    await expect(driver.ask(page, 'my private question', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(fake.sent).toEqual([])
    expect(drift).toEqual([expect.objectContaining({ provider: 'gemini-web', element: 'temporary.enable', kind: 'postcondition', candidate: -1 })])
    expect(drift[0]!.outline).toMatchObject({ root: 'body', nodes: expect.arrayContaining([expect.objectContaining({ tag: 'button', label: 'Temporary chat' })]) })
    expect(JSON.stringify(drift[0]!.outline)).not.toContain('private question')
    // The account's own name and address never appear, wherever the page shows them.
    expect(JSON.stringify(drift[0]!.outline)).not.toMatch(/Test User|test@example\.test/)
  })

  it('fails closed on a model or level the account does not offer, before sending', async () => {
    const { page, driver, fake } = await open({ models: ['3.5 Flash-Lite', '3.8 Flash'], levels: ['Low', 'Medium'] })
    await expect(driver.ask(page, 'hi', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/Pro is not offered/) })
    const odd = new GeminiWebDriver({ origin: fake.origin, modes: { odd: { model: 'Flash', effort: 'High' } }, timeouts: { readyMs: 5000 } })
    await expect(odd.ask(page, 'hi', { conversation: 'temporary', mode: 'odd' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/High is not offered/) })
    expect(fake.sent).toEqual([])
  })

  it('selects nothing for an empty preset on an account without a mode picker', async () => {
    const { page, driver, fake } = await open({ modePicker: false })
    expect((await driver.ask(page, 'hi', { conversation: 'temporary', mode: 'site' })).mode).toEqual({})
    await expect(driver.ask(page, 'hi', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(fake.sent).toHaveLength(1)
  })

  it('continues a persistent conversation by its /app/<id> binding, reported as soon as it exists', async () => {
    const { page, driver, fake } = await open({ answer: 'first answer' })
    const bound: string[] = []
    const first = await driver.ask(page, 'one', { conversation: 'persistent', onBinding: (b) => void bound.push(b) })
    expect(first.binding).toMatch(/^[0-9a-f]{16}$/)
    expect(bound).toEqual([first.binding])
    const boundaries: unknown[] = []
    const second = await driver.ask(page, 'two', { conversation: 'persistent', binding: first.binding, beforeSend: (b) => void boundaries.push(b) })
    expect(second.binding).toBe(first.binding)
    expect(boundaries).toEqual([{ previousResponse: 'first answer', mode: { model: '3.8 Flash', effort: 'Medium' } }])
    expect(fake.sent.map((s) => [s.temporary, s.conversationId])).toEqual([[false, undefined], [false, first.binding]])
  })

  it('reopens a bound conversation for reconciliation; a missing one is not observed', async () => {
    const { page, driver } = await open({ answer: 'kept answer' })
    const { binding } = await driver.ask(page, 'a prompt longer than its heading', { conversation: 'persistent' })
    expect(await driver.snapshot(page, binding!)).toEqual({ text: 'kept answer', running: false, observable: true, lastPrompt: 'a prompt longer than its heading' })
    expect(await driver.snapshot(page, 'ffffffffffffffff')).toEqual({ text: '', running: false, observable: false })
  })

  it('deletes exactly one bound conversation from its own menu, and a deleted one counts as gone (PROP-0004 Phase 5)', async () => {
    const { page, driver, fake } = await open({ answer: 'to be deleted' })
    const kept = await driver.ask(page, 'keep me', { conversation: 'persistent' })
    const doomed = await driver.ask(await context!.newPage(), 'delete me', { conversation: 'persistent' })
    expect(await driver.deleteConversation(await context!.newPage(), doomed.binding!)).toBe('deleted')
    expect([...fake.deleted]).toEqual([doomed.binding])
    expect(fake.conversations.has(kept.binding!)).toBe(true)
    // Again, as a retry after a crash would: the site shows it is gone, and nothing is clicked.
    expect(await driver.deleteConversation(await context!.newPage(), doomed.binding!)).toBe('gone')
    expect(driver.deletes).toEqual(['chat'])
  })

  it('inspects a conversation\'s own menu without choosing anything: outlines, never text', async () => {
    const { page, driver, fake } = await open({ answer: 'secret answer text' })
    const turn = await driver.ask(page, 'inspect me', { conversation: 'persistent' })
    const outlines = await driver.inspectConversation(page, turn.binding!)
    expect(outlines.map((o) => o.root)).toEqual(['conversation page (shown)', 'conversation menu'])
    expect(JSON.stringify(outlines)).not.toMatch(/secret answer text|inspect me/)
    expect(JSON.stringify(outlines[1])).toMatch(/"role":"menuitem"/)
    expect(fake.deleted.size).toBe(0)
  })

  it('never deletes another chat through a history row: with no menu button in its own pane, nothing is clicked', async () => {
    const { page, driver, fake } = await open({ answer: 'x', paneMenu: false })
    const other = await driver.ask(page, 'the operator\'s chat', { conversation: 'persistent' })
    const doomed = await driver.ask(await context!.newPage(), 'delete me', { conversation: 'persistent' })
    await expect(driver.deleteConversation(await context!.newPage(), doomed.binding!)).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(fake.deleteRequests).toEqual([])
    expect(fake.conversations.has(other.binding!)).toBe(true)
  })

  it('stops a deletion that names another chat at the network, after its confirm is marked, and never clicks again once confirmed', async () => {
    const { page, driver, fake } = await open({ answer: 'x' })
    const other = await driver.ask(page, 'the operator\'s chat', { conversation: 'persistent' })
    const doomed = await driver.ask(await context!.newPage(), 'delete me', { conversation: 'persistent' })
    fake.options.dialogTarget = other.binding!
    let marked = 0
    await expect(driver.deleteConversation(await context!.newPage(), doomed.binding!, { beforeConfirm: () => void marked++ })).rejects.toBeInstanceOf(ProviderError)
    expect(marked).toBe(1)
    expect(fake.deleteRequests).toEqual([])
    expect(fake.conversations.has(other.binding!)).toBe(true)
    fake.options.dialogTarget = ''
    await expect(driver.deleteConversation(await context!.newPage(), doomed.binding!, { confirmed: true })).rejects.toMatchObject({ kind: 'session_broken', message: expect.stringMatching(/not clicked again/) })
    expect(fake.deleteRequests).toEqual([])
  })

  it('stops a deletion request that names another chat even when a second call in it names this one (guard bypass)', async () => {
    const { page, driver, fake } = await open({ answer: 'x' })
    const other = await driver.ask(page, 'the operator\'s chat', { conversation: 'persistent' })
    const doomed = await driver.ask(await context!.newPage(), 'delete me', { conversation: 'persistent' })
    fake.options.dialogTarget = other.binding!
    fake.options.dialogExtraCall = true
    await expect(driver.deleteConversation(await context!.newPage(), doomed.binding!)).rejects.toBeInstanceOf(ProviderError)
    expect(fake.deleteRequests).toEqual([])
    expect(fake.conversations.has(other.binding!)).toBe(true)
    // The check itself: every conversation id any call carries must be the bound one.
    const body = (calls: unknown[]) => `f.req=${encodeURIComponent(JSON.stringify([calls]))}&at=x`
    expect(namesOnly(body([['GzXR5e', JSON.stringify(['c_aaaaaaaaaaaaaaaa']), null, 'generic']]), 'aaaaaaaaaaaaaaaa')).toBe(true)
    expect(namesOnly(body([['GzXR5e', JSON.stringify(['c_bbbbbbbbbbbbbbbb']), null, 'generic'], ['MaZiqc', JSON.stringify(['c_aaaaaaaaaaaaaaaa']), null, 'generic']]), 'aaaaaaaaaaaaaaaa')).toBe(false)
    expect(namesOnly(body([['ESY5D', '[]', null, 'generic']]), 'aaaaaaaaaaaaaaaa')).toBe(true)
    expect(namesOnly('f.req=%7Bnot json', 'aaaaaaaaaaaaaaaa')).toBe(false)
  })

  it('deletes nothing when the conversation does not open as itself', async () => {
    const { page, driver, fake } = await open()
    const quick = new GeminiWebDriver({ origin: fake.origin, timeouts: { readyMs: 5000, snapshotMs: 1500 } })
    // An unknown chat goes to /unavailable, which shows no prompt and no sign of a deletion.
    await expect(quick.deleteConversation(page, 'ffffffffffffffff')).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/nothing was deleted/) })
    await expect(driver.deleteConversation(page, 'not-an-id')).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(fake.deleted.size).toBe(0)
  })

  it('does not observe a conversation whose prompt it cannot read, so nothing is resent blind', async () => {
    const { page, driver, fake } = await open()
    const { binding } = await driver.ask(page, 'the prompt', { conversation: 'persistent' })
    fake.options.promptParagraphs = false
    expect(await driver.snapshot(page, binding!)).toEqual({ text: '', running: false, observable: false })
  })

  it('runs Deep research: chosen from More tools, its plan started, and its report returned with the sources it used', async () => {
    const { page, driver, fake } = await open()
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    expect(result.text).toBe('HTTP/3 runs over QUIC, not TCP.\n\nSources:\n- RFC 9114: HTTP/3 https://www.rfc-editor.org/rfc/rfc9114')
    expect(fake.sent).toEqual([expect.objectContaining({ deepResearch: true, temporary: false })])
    expect(fake.started).toEqual([result.binding])
  })

  it('loads a conversation once more when its plan never renders, resending nothing, then starts the plan (live 2026-10-19)', async () => {
    const { page, driver, fake } = await open({ planHangs: true }, { timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 30_000, stallMs: 15_000, planHangMs: 2000 } })
    const reloads: unknown[] = []
    const stalls: Array<{ phase: string }> = []
    driver.onReload = (event) => void reloads.push(event)
    driver.onStall = (event) => void stalls.push(event)
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    expect(result.text).toBe('HTTP/3 runs over QUIC, not TCP.\n\nSources:\n- RFC 9114: HTTP/3 https://www.rfc-editor.org/rfc/rfc9114')
    expect(reloads).toEqual([{ provider: 'gemini-web', phase: 'research-plan', binding: result.binding }])
    // The page as it hung is outlined before the reload.
    expect(stalls.map((e) => e.phase)).toEqual(['research-plan'])
    expect(fake.sent).toHaveLength(1)
    expect(fake.started).toEqual([result.binding])
  }, 60_000)

  it('takes a run whose activity keeps growing past the stall deadline for progress, and one that shows none for a stall (live 2026-10-18)', async () => {
    // The deadline leaves room for the click on Start research to render its card on a loaded CI
    // runner: until the card shows, no snapshot can show progress (production waits 3 minutes).
    const { page, fake } = await open({ researchMs: 20_000, researchActivity: true })
    const patient = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 45_000, stallMs: 6000 } })
    const stalls: unknown[] = []
    patient.onStall = (event) => void stalls.push(event)
    // Twenty seconds of research, more than three times the stall deadline: its thoughts grow, so it is not a stall.
    const growing = await patient.ask(page, 'A long survey', { conversation: 'persistent', feature: 'deep-research' }).catch((error: Error) => {
      throw new Error(`${error.message}; the page as it stalled: ${JSON.stringify(stalls).slice(0, 4000)}`)
    })
    expect(growing.text).toMatch(/^HTTP\/3 runs over QUIC/)
    fake.options.researchActivity = false
    await expect(patient.ask(page, 'Another long survey', { conversation: 'persistent', feature: 'deep-research' })).rejects.toMatchObject({ kind: 'provider_stalled' })
  }, 90_000)

  it('reads Deep research\'s activity at once: a run that completes between finding its activity and reading it is not waited on', async () => {
    const { page, driver, fake } = await open({ researchMs: 60_000, researchActivity: true }, { timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 20_000, stallMs: 15_000 } })
    const resolve = UiEngine.prototype.resolve
    let completed = false
    const spy = vi.spyOn(UiEngine.prototype, 'resolve').mockImplementation(async function (this: UiEngine, id: string, timeoutMs?: number) {
      const found = await resolve.call(this, id, timeoutMs)
      if (id === 'research.activity' && !completed) {
        completed = true
        // The research completes now: its report takes the panel, and no activity is left to read.
        fake.options.researchMs = 0
        await page.waitForFunction(() => !document.querySelector('thinking-panel'))
      }
      return found
    })
    try {
      // A read that waited for the activity to come back (30 s) would take the completed run for a stall.
      expect((await driver.ask(page, 'A long survey', { conversation: 'persistent', feature: 'deep-research' })).text).toMatch(/^HTTP\/3 runs over QUIC/)
      expect(completed).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('applies no mode preset to Deep research: the picker stays as the site has it, and the mode is recorded as the site\'s (live 2026-10-18)', async () => {
    const { page, driver, fake } = await open()
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research', mode: 'pro' })
    expect(result.mode).toEqual({})
    // Sent with the site's own selection, not the frontier preset's Pro.
    expect(fake.sent[0]!.model).not.toMatch(/Pro/)
    expect(fake.sent[0]).toMatchObject({ deepResearch: true })
  })

  it('selects the research preset for Deep research, whatever the turn names, with the tool on, and records it as read back', async () => {
    const { page, driver, fake } = await open({}, { researchMode: 'pro' })
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research', mode: 'flash-lite' })
    expect(result.mode).toEqual({ model: '3.1 Pro', effort: 'High' })
    expect(fake.sent[0]).toMatchObject({ deepResearch: true, model: '3.1 Pro', level: 'High' })
    // A plain turn still takes its own preset.
    expect((await driver.ask(page, 'hi', { conversation: 'temporary', mode: 'flash-lite' })).mode).toEqual({ model: '3.5 Flash-Lite', effort: 'Low' })
  })

  it('selects the research preset\'s model only when the picker shows no thinking level with Deep research chosen, with no drift', async () => {
    const { page, driver, fake } = await open({ researchHidesLevels: true }, { researchMode: 'pro' })
    const drifts: unknown[] = []
    driver.onDrift = (event) => void drifts.push(event)
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    expect(result.mode).toEqual({ model: '3.1 Pro' })
    expect(fake.sent[0]).toMatchObject({ deepResearch: true, model: '3.1 Pro', level: 'Low' })
    expect(drifts).toEqual([])
  })

  it('returns a clarifying question as the answer when Deep research asks one instead of a plan', async () => {
    const { page, driver, fake } = await open({ clarify: 'Which aspect should the research focus on?' })
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    expect(result.text).toBe('Which aspect should the research focus on?')
    expect(fake.started).toEqual([])
  })

  it('clears Deep research, which a reopened conversation keeps chosen, before a plain follow-up', async () => {
    const { page, driver, fake } = await open({ clarify: 'Which aspect?', answer: 'a plain answer' })
    const { binding } = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    const follow = await driver.ask(page, 'Which RFC defines HTTP/3?', { conversation: 'persistent', binding })
    expect(follow.text).toBe('a plain answer')
    expect(fake.sent.map((s) => s.deepResearch)).toEqual([true, false])
  })

  it('keeps Deep research chosen, never toggled off, for a Deep research follow-up in the same conversation', async () => {
    const { page, driver, fake } = await open({ clarify: 'Which aspect?' })
    const { binding } = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    await driver.ask(page, 'Latency, please', { conversation: 'persistent', feature: 'deep-research', binding })
    expect(fake.sent.map((s) => s.deepResearch)).toEqual([true, true])
  })

  it('never sends a draft the site kept: the composer is emptied first, and a turn that fails unsent leaves none (live 2026-10-17)', async () => {
    const { page, driver, fake } = await open({ startOnSpark: false, draftPersist: true, answer: 'ok' })
    // A draft left from an earlier, unsent attempt (as in the live login profile).
    await page.goto(`${fake.origin}/app`)
    await page.evaluate(() => localStorage.setItem('draft:home', 'an old unsent draft'))
    expect((await driver.ask(page, 'the real prompt', { conversation: 'temporary' })).text).toBe('ok')
    expect(fake.sent.map((s) => s.prompt)).toEqual(['the real prompt'])
    // Typed, then refused before the send: nothing is left as a draft for the next turn.
    await expect(driver.ask(page, 'never sent', { conversation: 'temporary', beforeSend: () => { throw new Error('stop before sending') } })).rejects.toThrow(/stop before sending/)
    await page.goto(`${fake.origin}/app`)
    expect((await page.evaluate(() => localStorage.getItem('draft:home') ?? '')).trim()).toBe('')
    expect((await driver.ask(page, 'next prompt', { conversation: 'temporary' })).text).toBe('ok')
    expect(fake.sent.map((s) => s.prompt)).toEqual(['the real prompt', 'next prompt'])
  })

  it('outlines a composer that rewrote a paste, with where it differs and never the text, and sends nothing', async () => {
    const { page, driver, fake } = await open({ startOnSpark: false, rewritePaste: true })
    const drifts: Array<{ element: string; kind: string; readback?: Record<string, unknown>; outline?: { nodes: unknown[] } }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    await expect(driver.ask(page, 'Review this:\n```\nconst x = 1\n```', { conversation: 'temporary' }))
      .rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/readback differs .*first difference at line 1, offset 0: punctuation ` against letter/) })
    const readback = drifts.find((d) => d.kind === 'readback')!
    expect(readback).toMatchObject({ element: 'composer.input', readback: { line: 1, offset: 0, inserted: 'punctuation `', read: 'letter', truncated: false } })
    expect(readback.outline!.nodes.length).toBeGreaterThan(0)
    expect(JSON.stringify(readback.readback)).not.toMatch(/Review|const/)
    expect(fake.sent).toEqual([])
  })

  it('waits for a reopened prompt\'s text before judging it: a bubble that renders first is still observed', async () => {
    const { page, driver, fake } = await open({ answer: 'done' })
    const first = await driver.ask(page, 'remember this', { conversation: 'persistent' })
    fake.options.promptLagMs = 1500
    const other = await context!.newPage()
    expect(await driver.snapshot(other, first.binding!)).toMatchObject({ observable: true, running: false, text: 'done', lastPrompt: 'remember this' })
  })

  it('reopens a Deep research turn as running while its card works, then as its report', async () => {
    // Running until the test says otherwise: no window to race, however loaded the host.
    const { page, driver, fake } = await open({ researchHeld: true })
    let binding: string | undefined
    const asked = driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research', onBinding: (b) => { binding = b } })
    // Awaited below; a failed assertion before that must not leave its rejection unhandled when the page closes.
    asked.catch(() => undefined)
    for (let i = 0; i < 100 && !fake.started.length; i++) await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fake.started).toEqual([binding])
    const other = await context!.newPage()
    expect(await driver.snapshot(other, binding!, { feature: 'deep-research' })).toMatchObject({ text: '', running: true, observable: true })
    fake.options.researchHeld = false
    const result = await asked
    // Starting the plan is the conversation's last user turn.
    expect(await driver.snapshot(other, binding!, { feature: 'deep-research' })).toEqual({ text: result.text, running: false, observable: true, lastPrompt: 'Start research' })
  })

  it('probes the account\'s features in a new chat, sending nothing (REQ-PRV-7)', async () => {
    const { page, driver, fake } = await open()
    expect(await driver.probeFeatures(page)).toEqual(['deep-research'])
    const none = await open({ deepResearch: false })
    expect(await none.driver.probeFeatures(none.page)).toEqual([])
    expect([...fake.sent, ...none.fake.sent]).toEqual([])
  })

  it('sends nothing when the receipt cannot be written', async () => {
    const { page, driver, fake } = await open()
    await expect(driver.ask(page, 'hi', { conversation: 'temporary', beforeSend: () => { throw new Error('store down') } })).rejects.toThrow('store down')
    expect(fake.sent).toEqual([])
  })
})

describe.runIf(canRunBrowser)('GeminiWebDriver sign-in against static pages', () => {
  let browser: Browser
  let close: () => Promise<void>
  let server: Server
  let origin: string
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
    server = createServer((req, res) => {
      const body = req.url?.startsWith('/app') && req.url.includes('in')
        ? '<header><button aria-label="Google Account: Test User (test@example.test)">T</button></header><main>Hello</main>'
        : '<header><a href="/signin">Sign in</a></header>'
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><body>${body}</body></html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await close()
    server.close()
  })

  it('tells signed-in from signed-out, and reads the account from its button', async () => {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const driver = new GeminiWebDriver({ origin, timeouts: { readyMs: 5000 } })
      await page.goto(`${origin}/app?signed=out`)
      expect(await driver.checkAuth(page)).toBe('signed-out')
      await page.goto(`${origin}/app?signed=in`)
      expect(await driver.checkAuth(page)).toBe('signed-in')
      expect(await driver.identity(page)).toBe('Test User (test@example.test)')
    } finally {
      await context.close()
    }
  }, 60_000)
})
