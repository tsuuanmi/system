import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Providers from '@tsuuanmi/system-providers'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { type DriftEvent, loadUiMap } from '@tsuuanmi/system-ui-ops'
import type { Browser, BrowserContext, Page } from 'patchright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../fixtures/fake-chatgpt.ts'
import ChatGptWebPlugin, { ChatGptWebDriver, type DriverTimeouts, shippedMap } from '../src/index.ts'

describe('the shipped ChatGPT UI map', () => {
  it('validates, and Send is irreversible with deterministic healing only', () => {
    const map = shippedMap()
    expect(map.provider).toBe('chatgpt-web')
    expect(map.actions['composer.send']).toMatchObject({ sideEffect: 'irreversible', heal: 'deterministic' })
  })

  it('accepts a local overlay', () => {
    const map = shippedMap('elements:\n  composer.send:\n    candidates:\n      - { testId: composer-submit }\n')
    expect(map.elements['composer.send']!.candidates.at(-1)).toMatchObject({ testId: 'composer-submit', source: 'overlay' })
  })
})

describe.runIf(canRunBrowser)('ChatGptWebDriver against the fake site, with no real account (QA-10)', () => {
  let browser: Browser
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close())

  const cleanups: Array<() => Promise<unknown>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  async function site(all: FakeOptions & { timeouts?: DriverTimeouts } = {}): Promise<{ fake: FakeChatGpt; page: Page; context: BrowserContext; driver: ChatGptWebDriver }> {
    const { timeouts, ...options } = all
    const fake = new FakeChatGpt(options)
    await fake.start()
    const context = await browser.newContext()
    cleanups.push(() => fake.stop(), () => context.close())
    const page = await context.newPage()
    const driver = new ChatGptWebDriver({
      origin: fake.origin, timeouts: { turnMs: 20_000, stallMs: 10_000, stableMs: 400, pollMs: 100, researchStartMs: 3000, ...timeouts },
      modes: { instant: { model: 'Latest', effort: 'Instant' }, deep: { model: 'GPT-6', effort: 'High' }, locked: { model: 'GPT-5.6 Sol', effort: 'Medium' }, missing: { model: 'GPT-9' } },
      defaultMode: 'instant',
    })
    return { fake, page, context, driver }
  }

  it('stops at a challenge page as a challenge, at once and with nothing sent', async () => {
    const { page, driver, fake } = await site({ captcha: true })
    const started = Date.now()
    await expect(driver.checkAuth(page)).rejects.toMatchObject({ kind: 'challenge', disposition: 'USER_ACTION', message: expect.stringMatching(/Verify you are human/) })
    expect(Date.now() - started).toBeLessThan(20_000)
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'challenge' })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('loads the site\'s own error page once more before anything is typed, and fails a second one as transient, unsent (live 2026-10-17)', async () => {
    const { page, driver, fake } = await site({ errorPages: 1, timeouts: { readyMs: 5000 } })
    const drifts: unknown[] = []
    driver.onDrift = (event) => void drifts.push(event)
    expect((await driver.ask(page, 'ping', { conversation: 'temporary' })).text).toBe('OK')
    expect(fake.errorPagesShown).toBe(1)
    expect(fake.sent).toHaveLength(1)
    // Twice in a row: transient, and nothing sent; never drift.
    fake.options.errorPages = 3
    const started = Date.now()
    await expect(driver.ask(page, 'again', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'overloaded', disposition: 'BACKOFF', message: expect.stringMatching(/its own error page/) })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(fake.errorPagesShown).toBe(3)
    expect(fake.sent).toHaveLength(1)
    // A sign-in check never reloads: it reports the error page as it is.
    fake.options.errorPages = 4
    await page.goto(`${fake.origin}/`)
    await expect(driver.checkAuth(page)).rejects.toMatchObject({ kind: 'overloaded' })
    expect(drifts).toEqual([])
  }, 60_000)

  it('outlines a page that shows neither signed in nor signed out, and fails it once as drift, never as a session to retry', async () => {
    const { page, fake } = await site({ interstitial: true })
    const driver = new ChatGptWebDriver({ origin: fake.origin, timeouts: { readyMs: 1500 }, modes: { instant: { model: 'Latest', effort: 'Instant' } }, defaultMode: 'instant' })
    const drifts: Array<{ element: string; kind: string; outline?: { nodes: Array<{ role?: string }> } }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    expect(await driver.checkAuth(page)).toBe('unknown')
    expect(drifts).toEqual([expect.objectContaining({ element: 'composer.input', kind: 'unresolved' })])
    expect(drifts[0]!.outline!.nodes.some((n) => n.role === 'dialog')).toBe(true)
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'ui_drift', disposition: 'CONFIG_FIX' })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('outlines a stalled answer with the page\'s visibility, focus, and path, and fails it as provider_stalled', async () => {
    const { page, driver } = await site({ thinkMs: 60_000, timeouts: { stallMs: 1500 } })
    const stalls: Array<{ provider: string; phase: string; visibility?: string; focused?: boolean; url?: string; outline?: { nodes: unknown[] } }> = []
    driver.onStall = (event) => void stalls.push(event as never)
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'provider_stalled' })
    expect(stalls).toEqual([expect.objectContaining({ provider: 'chatgpt-web', phase: 'answer', visibility: 'visible', focused: true, url: '/' })])
    expect(stalls[0]!.outline!.nodes.length).toBeGreaterThan(0)
  }, 60_000)

  it('reports a page idle only with nothing open, and keeps one that already shows its conversation as it is (kept tabs, ADR-0030)', async () => {
    const { page, driver, fake } = await site({ answer: 'one' })
    const first = await driver.ask(page, 'hello', { conversation: 'persistent' })
    expect(await driver.pageIdle(page)).toBe(true)
    const requests: string[] = []
    page.on('request', (r) => { if (r.resourceType() === 'document') requests.push(new URL(r.url()).pathname) })
    await driver.ask(page, 'again', { conversation: 'persistent', binding: first.binding! })
    expect(requests).toEqual([])
    expect(fake.sent).toHaveLength(2)
    // An open menu (rendered by the page, hidden until opened).
    await page.evaluate(() => { document.getElementById('conv-menu')!.hidden = false })
    expect(await driver.pageIdle(page)).toBe(false)
  }, 60_000)

  it('reports signed-in and signed-out with positive evidence', async () => {
    const a = await site()
    expect(await a.driver.checkAuth(a.page)).toBe('signed-in')
    const b = await site({ signedIn: false })
    expect(await b.driver.checkAuth(b.page)).toBe('signed-out')
  }, 30_000)

  it('reads the logged-out home as signed out, so the turn fails as reauth_required, not drift', async () => {
    const { page, driver, fake } = await site({ loggedOutHome: true })
    const drifts: unknown[] = []
    driver.onDrift = (event) => void drifts.push(event)
    expect(await driver.checkAuth(page)).toBe('signed-out')
    await expect(driver.ask(page, 'hello', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(drifts).toEqual([])
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('counts the logged-out marks only while visible, and never beside a working composer', async () => {
    const hidden = await site({ loggedOutHome: true, timeouts: { readyMs: 1500 } })
    await hidden.page.goto(`${hidden.fake.origin}/`)
    await hidden.page.evaluate(() => document.querySelectorAll('[data-login-button], form[data-logged-out]').forEach((e) => e.setAttribute('hidden', '')))
    expect(await hidden.driver.checkAuth(hidden.page)).toBe('unknown')
    // A signed-in app showing a sign-in button (an offer to switch accounts) stays signed in.
    const offer = await site({ loginOffer: true })
    await offer.page.goto(`${offer.fake.origin}/`)
    expect(await offer.page.locator('[data-login-button]').isVisible()).toBe(true)
    expect(await offer.driver.checkAuth(offer.page)).toBe('signed-in')
  }, 60_000)

  it('holds a logged-out home verdict: a signed-in app that paints that shell first stays signed in', async () => {
    const { page, driver, fake } = await site({ logoutFlashMs: 1000 })
    await page.goto(`${fake.origin}/`)
    expect(await page.locator('form[data-logged-out]').isVisible()).toBe(true)
    expect(await driver.checkAuth(page)).toBe('signed-in')
    expect((await driver.ask(page, 'hello', { conversation: 'temporary' })).text).toBe('OK')
  }, 60_000)

  it('asks in Temporary chat after switching Work to Chat, and waits for completion though the stream stays open', async () => {
    const { fake, page, driver } = await site({ answer: 'Hello from the fake site' })
    const drift: unknown[] = []
    driver.onDrift = (event) => drift.push(event)
    const turn = await driver.ask(page, 'Reply with a greeting', { conversation: 'temporary' })
    expect(drift).toEqual([]) // the shipped primary candidates match the live structure
    expect(turn.text).toBe('Hello from the fake site')
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Reply with a greeting', mode: 'chat', temporary: true })])
    expect(turn.binding).toBeUndefined()
  }, 40_000)

  it('returns the answer as the Markdown that was streamed, not its rendering (REQ-PRV-5)', async () => {
    const answer = 'A **bold** claim with `code`, and [a source](https://src.example/a).'
    const { page, driver } = await site({ answer })
    expect((await driver.ask(page, 'Answer in Markdown', { conversation: 'temporary' })).text).toBe(answer)
  }, 40_000)

  // A web-cited answer: the page renders each citation as a link chip, and Copy yields
  // reference-style links whose URLs carry tracking parameters (2026-10-15).
  const cited = 'Pin actions by SHA ([GitHub Docs](https://docs.github.com/a)) and attest the tarballs ([GitHub](https://github.com/actions/attest)).'
  const referenced = 'Pin actions by SHA ([GitHub Docs][1]) and attest the tarballs ([GitHub][2]).\n\n[1]: https://docs.github.com/a?utm_source=chatgpt.com "Security hardening"\n[2]: https://github.com/actions/attest?utm_source=chatgpt.com "attest"'

  it('keeps a cited answer\'s reference-style Copy, URLs and all, without tracking parameters (REQ-PRV-5)', async () => {
    const { page, driver } = await site({ answer: cited, copied: () => referenced })
    expect((await driver.ask(page, 'Cite your sources', { conversation: 'temporary' })).text).toBe(referenced.replaceAll('?utm_source=chatgpt.com', ''))
  }, 40_000)

  it('keeps a cited answer\'s URLs from its links when its Copy is refused', async () => {
    const { page, driver } = await site({ answer: cited, copied: () => 'Something else on the clipboard.' })
    expect((await driver.ask(page, 'Cite your sources', { conversation: 'temporary' })).text).toBe(
      'Pin actions by SHA (GitHub Docs) and attest the tarballs (GitHub).\n\nSources:\n- GitHub Docs https://docs.github.com/a\n- GitHub https://github.com/actions/attest')
  }, 40_000)

  it('refuses to send on an account without a model picker, assuming no mode (PROP-0004: no ChatGPT Free)', async () => {
    const { fake, page, driver } = await site({ answer: 'free answer', modelPicker: false })
    const error = await driver.ask(page, 'hello', { conversation: 'temporary' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ kind: 'ui_drift' })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('probes the account\'s features from the tools popover, sending nothing (REQ-PRV-7)', async () => {
    const all = await site()
    expect(await all.driver.probeFeatures(all.page)).toEqual(['deep-research', 'web-search', 'image-generation'])
    const some = await site({ features: ['web-search'] })
    expect(await some.driver.probeFeatures(some.page)).toEqual(['web-search'])
    expect([...all.fake.sent, ...some.fake.sent]).toEqual([])
  }, 60_000)

  it('turns Web search on for a web-search turn', async () => {
    const { fake, page, driver } = await site({ answer: 'News' })
    expect((await driver.ask(page, 'What happened today?', { conversation: 'temporary', feature: 'web-search' })).text).toBe('News')
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'What happened today?', webSearch: true })])
  }, 40_000)

  it('keeps a code block\'s lines, which the answer\'s Copy loses, from the rendered block (REQ-PRV-5)', async () => {
    const answer = 'Here it is:\n```python\ndef add(a, b):\n    return a + b\n```\nDone.'
    const { page, driver } = await site({ answer })
    const drift: unknown[] = []
    driver.onDrift = (event) => drift.push(event)
    // The live Copy drops the fence's language too; the lines are what matter.
    expect((await driver.ask(page, 'Write add', { conversation: 'temporary' })).text).toBe('Here it is:\n```\ndef add(a, b):\n    return a + b\n```\nDone.')
    expect(drift).toEqual([]) // the code block resolves on its primary candidate, as live
  }, 40_000)

  it('keeps runs of spaces in the answer (indentation in a tool call\'s arguments)', async () => {
    const answer = '<call tool="Edit">{"new_string": "def add(a, b):\\n    return a + b"}</call>'
    const { page, driver } = await site({ answer })
    expect((await driver.ask(page, 'Fix add', { conversation: 'temporary' })).text).toBe(answer)
  }, 40_000)

  it('keeps a persistent conversation id and continues the same conversation', async () => {
    const { fake, page, driver } = await site({ answer: 'first answer' })
    const first = await driver.ask(page, 'one', { conversation: 'persistent' })
    expect(first.text).toBe('first answer')
    expect(first.binding).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.sent[0]).toMatchObject({ mode: 'chat', temporary: false })

    fake.options.answer = 'second answer'
    const boundaries: Array<string | null> = []
    const second = await driver.ask(page, 'two', { conversation: 'persistent', binding: first.binding, beforeSend: ({ previousResponse }) => { boundaries.push(previousResponse) } })
    expect(boundaries).toEqual(['first answer'])
    expect(second.text).toBe('second answer')
    expect(second.binding).toBe(first.binding)
    expect(fake.sent[1]).toMatchObject({ conversationId: first.binding })
  }, 60_000)

  it('sends nothing when beforeSend throws (the receipt could not be persisted)', async () => {
    const { fake, page, driver } = await site()
    const failure = driver.ask(page, 'x', { conversation: 'temporary', beforeSend: () => { throw new Error('store unavailable') } })
    await expect(failure).rejects.toThrow(/store unavailable/)
    expect(fake.sent).toEqual([])
  }, 30_000)

  it('selects and verifies the configured model and power before sending, and reports them (REQ-PRV-3)', async () => {
    const { fake, page, driver } = await site({ answer: 'deep' })
    const turn = await driver.ask(page, 'think hard', { conversation: 'temporary', mode: 'deep' })
    expect(turn.mode).toEqual({ model: 'GPT-6', effort: 'High' })
    expect(fake.sent[0]).toMatchObject({ model: 'GPT-6', power: 'High', mode: 'chat' })
  }, 40_000)

  it('sends a multi-line prompt intact', async () => {
    const { fake, page, driver } = await site()
    await driver.ask(page, 'first line\nsecond line', { conversation: 'temporary' })
    expect(fake.sent[0]!.prompt.split(/\n+/)).toEqual(['first line', 'second line'])
  }, 40_000)

  it('uses the default mode when none is requested', async () => {
    const { fake, page, driver } = await site()
    const turn = await driver.ask(page, 'plain', { conversation: 'temporary' })
    expect(turn.mode).toEqual({ model: 'Latest', effort: 'Instant' })
    expect(fake.sent[0]).toMatchObject({ model: 'Latest', power: 'Instant' })
  }, 40_000)

  it('fails before sending on an unknown preset, an unknown model, or a locked model (REQ-PRV-3)', async () => {
    const { fake, page, driver } = await site({ lockedModels: ['GPT-5.6 Sol'] })
    await expect(driver.ask(page, 'x', { conversation: 'temporary', mode: 'nope' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/unknown mode nope/) })
    await expect(driver.ask(page, 'x', { conversation: 'temporary', mode: 'missing' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/GPT-9.*Latest, GPT-6/) })
    await expect(driver.ask(page, 'x', { conversation: 'temporary', mode: 'locked' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/locked/) })
    expect(fake.sent).toEqual([])
  }, 60_000)

  it('runs Deep research from the + tools in a persistent conversation, with the prompt free of the tool chip (REQ-PRV-6)', async () => {
    const report = 'A detailed report <a href="https://src.example/a">[1]</a> with <a href="https://src.example/b">sources</a> <a href="https://src.example/a">[1]</a>.'
    const { fake, page, driver } = await site({ report })
    const turn = await driver.ask(page, 'Survey the DSH plugin catalog', { conversation: 'persistent', feature: 'deep-research' })
    // Not the acknowledgement: the report from the research frame, with its citation links kept.
    expect(turn.text).toBe('Research findings\nA detailed report [1] with sources [1].\n\nSources:\n- [1] https://src.example/a\n- sources https://src.example/b')
    expect(turn.binding).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.sent[0]).toMatchObject({ prompt: 'Survey the DSH plugin catalog', deepResearch: true, mode: 'chat', temporary: false })
    await expect(driver.ask(page, 'x', { conversation: 'temporary', feature: 'deep-research' })).rejects.toMatchObject({ kind: 'invalid_input' })
  }, 60_000)

  it('reads a report the app shell shows inline as the last answer, with no frame, in a turn and in a snapshot (live 2026-10-18)', async () => {
    const { page, driver, context } = await site({ researchInline: true, report: 'Inline report body.' })
    const turn = await driver.ask(page, 'Survey inline', { conversation: 'persistent', feature: 'deep-research' })
    // Not the acknowledgement: the answer after the completion line, as its Copy gives it.
    expect(turn.text).toBe('Inline report body.')
    const other = await context.newPage()
    expect(await driver.snapshot(other, turn.binding!, { feature: 'deep-research' })).toMatchObject({ text: expect.stringMatching(/Inline report body\.$/), running: false, observable: true })
  }, 60_000)

  it('keeps reading a report marked complete before its answer renders, and never takes the earlier answer for it', async () => {
    const { page, driver } = await site({ researchInline: true, inlineReportDelayMs: 3000, report: 'Late report body.' })
    expect((await driver.ask(page, 'Survey late', { conversation: 'persistent', feature: 'deep-research' })).text).toBe('Late report body.')
  }, 60_000)

  it('fails a completed report it cannot read as drift, outlined, and never takes the acknowledgement for it', async () => {
    const { page, driver } = await site({ untitledReport: true, timeouts: { reportReadMs: 1000 } })
    const drifts: Array<{ element: string; outline?: unknown }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    await expect(driver.ask(page, 'Survey untitled', { conversation: 'persistent', feature: 'deep-research' })).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/report cannot be read/) })
    expect(drifts.filter((d) => d.element === 'research.report-title')).toEqual([expect.objectContaining({ outline: expect.anything() })])
  }, 60_000)

  it('reports the conversation binding as soon as the URL shows it, before the answer is complete', async () => {
    const { page, driver } = await site({ answer: 'late answer', thinkMs: 1500 })
    const order: string[] = []
    const turn = await driver.ask(page, 'bind early', { conversation: 'persistent', onBinding: (id) => { order.push(`bound ${id}`) } })
    order.push('answered')
    expect(order).toEqual([`bound ${turn.binding}`, 'answered'])
  }, 40_000)

  it('snapshots a bound conversation: the last answer and whether it is still running', async () => {
    const { page, driver, context } = await site({ answer: 'kept answer' })
    const turn = await driver.ask(page, 'remember me', { conversation: 'persistent' })
    const other = await context.newPage()
    expect(await driver.snapshot(other, turn.binding!)).toEqual({ text: 'kept answer', running: false, observable: true, lastPrompt: expect.stringContaining('remember me') })
  }, 40_000)

  it('returns Deep research\'s clarifying question when no research starts', async () => {
    const { page, driver } = await site({ clarify: true })
    const turn = await driver.ask(page, 'Research something vague', { conversation: 'persistent', feature: 'deep-research' })
    expect(turn.text).toBe('Which aspect should the research focus on?')
  }, 60_000)

  it('snapshots a Deep research conversation: running until the report is complete', async () => {
    // Running until the test says otherwise: no window to race, however loaded the host.
    const { page, driver, context, fake } = await site({ researchHeld: true, report: 'Final report.' })
    let binding = ''
    const asking = driver.ask(page, 'long research', { conversation: 'persistent', feature: 'deep-research', onBinding: (id) => { binding = id } })
    // Awaited below; a failed assertion before that must not leave its rejection unhandled when the page closes.
    asking.catch(() => undefined)
    await expect.poll(() => fake.conversations.size, { timeout: 15_000 }).toBe(1)
    await expect.poll(() => [...fake.conversations.values()][0]?.researches.length, { timeout: 15_000 }).toBe(1)
    const other = await context.newPage()
    await expect.poll(() => binding, { timeout: 15_000 }).not.toBe('')
    expect(await driver.snapshot(other, binding, { feature: 'deep-research' })).toMatchObject({ running: true, observable: true, lastPrompt: expect.stringContaining('long research') })
    fake.finishResearch()
    await asking
    expect(await driver.snapshot(other, binding, { feature: 'deep-research' })).toMatchObject({ text: 'Research findings\nFinal report.', running: false, observable: true })
  }, 90_000)

  it('reads only the run after the last prompt when a session holds several Deep research runs', async () => {
    const { fake, page, driver } = await site({ researchMs: 1500, report: 'First report.' })
    const first = await driver.ask(page, 'first research', { conversation: 'persistent', feature: 'deep-research' })
    expect(first.text).toBe('Research findings\nFirst report.')
    fake.options.report = 'Second report.'
    const second = await driver.ask(page, 'second research', { conversation: 'persistent', binding: first.binding, feature: 'deep-research' })
    expect(second.text).toBe('Research findings\nSecond report.')
  }, 120_000)

  it('deletes exactly one bound conversation from its own menu, and a deleted one counts as gone (PROP-0004 Phase 5)', async () => {
    const { page, driver, context, fake } = await site({ answer: 'to be deleted' })
    const kept = await driver.ask(page, 'keep me', { conversation: 'persistent' })
    const doomed = await driver.ask(await context.newPage(), 'delete me', { conversation: 'persistent' })
    expect(await driver.deleteConversation(await context.newPage(), doomed.binding!)).toBe('deleted')
    expect([...fake.deleted]).toEqual([doomed.binding])
    expect(fake.conversations.has(kept.binding!)).toBe(true)
    // Again, as a retry after a crash would: the site shows it is gone, and nothing is clicked.
    expect(await driver.deleteConversation(await context.newPage(), doomed.binding!)).toBe('gone')
    expect(driver.deletes).toEqual(['chat', 'web-search'])
  }, 60_000)

  it('inspects a conversation\'s own menu without choosing anything: outlines, never text', async () => {
    const { page, driver, fake } = await site({ answer: 'secret answer text' })
    const turn = await driver.ask(page, 'inspect me', { conversation: 'persistent' })
    const outlines = await driver.inspectConversation(page, turn.binding!)
    expect(outlines.map((o) => o.root)).toEqual(['conversation page (shown)', 'conversation menu'])
    expect(JSON.stringify(outlines)).not.toMatch(/secret answer text|inspect me/)
    expect(JSON.stringify(outlines[1])).toMatch(/"role":"menuitem"/)
    expect(fake.deleted.size).toBe(0)
    expect(fake.conversations.has(turn.binding!)).toBe(true)
  }, 60_000)

  it('never deletes another chat through a history row: with no menu button in its own pane, nothing is clicked', async () => {
    const { page, driver, context, fake } = await site({ answer: 'x', paneMenu: false, timeouts: { snapshotMs: 3000 } })
    const other = await driver.ask(page, 'the operator\'s chat', { conversation: 'persistent' })
    const doomed = await driver.ask(await context.newPage(), 'delete me', { conversation: 'persistent' })
    await expect(driver.deleteConversation(await context.newPage(), doomed.binding!)).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(fake.deleteRequests).toEqual([])
    expect(fake.conversations.has(other.binding!)).toBe(true)
    expect(fake.conversations.has(doomed.binding!)).toBe(true)
  }, 60_000)

  it('stops a deletion that names another chat at the network, after its confirm is marked, and never clicks again once confirmed', async () => {
    const { page, driver, context, fake } = await site({ answer: 'x', timeouts: { snapshotMs: 3000 } })
    const other = await driver.ask(page, 'the operator\'s chat', { conversation: 'persistent' })
    const doomed = await driver.ask(await context.newPage(), 'delete me', { conversation: 'persistent' })
    fake.options.dialogTarget = other.binding!
    let marked = 0
    await expect(driver.deleteConversation(await context.newPage(), doomed.binding!, { beforeConfirm: () => void marked++ })).rejects.toBeInstanceOf(ProviderError)
    expect(marked).toBe(1)
    expect(fake.deleteRequests).toEqual([])
    expect(fake.conversations.has(other.binding!)).toBe(true)
    // After a recorded confirm, only a check: it still opens, so it fails, and nothing is clicked.
    fake.options.dialogTarget = ''
    await expect(driver.deleteConversation(await context.newPage(), doomed.binding!, { confirmed: true })).rejects.toMatchObject({ kind: 'session_broken', message: expect.stringMatching(/not clicked again/) })
    expect(fake.deleteRequests).toEqual([])
  }, 90_000)

  it('deletes nothing when the conversation does not open as itself', async () => {
    const { page, driver, fake } = await site({ timeouts: { snapshotMs: 1500 } })
    await expect(driver.deleteConversation(page, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/nothing was deleted/) })
    await expect(driver.deleteConversation(page, 'not-an-id')).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(fake.deleted.size).toBe(0)
  }, 60_000)

  it('reports a conversation that shows no turn as not observed, never as nothing new (live 2026-10-12)', async () => {
    const { page, driver } = await site({ timeouts: { snapshotMs: 1500 } })
    // A bound URL whose page never renders a user turn: no evidence either way.
    expect(await driver.snapshot(page, '00000000-0000-4000-8000-000000000000')).toEqual({ text: '', running: false, observable: false })
  }, 60_000)

  it('refuses to send when Chat cannot be selected (Work spends the Codex quota)', async () => {
    const { fake, page, driver } = await site({ chatToggleBroken: true })
    const failure = driver.ask(page, 'never sent', { conversation: 'temporary' })
    await expect(failure).rejects.toBeInstanceOf(ProviderError)
    expect(fake.sent).toEqual([])
  }, 30_000)

  it('survives a renamed Send button by healing it, and reports the drift', async () => {
    const { fake, page, driver } = await site({ sendLabel: 'Submit message', answer: 'healed' })
    const heals: unknown[] = []
    driver.onHeal = (event) => heals.push(event)
    const turn = await driver.ask(page, 'drift', { conversation: 'temporary' })
    expect(turn.text).toBe('healed')
    expect(fake.sent).toHaveLength(1)
    expect(heals).toEqual([expect.objectContaining({ element: 'composer.send', outcome: 'healed' })])
  }, 40_000)

  it('reports a Send button found only by a later candidate, with an outline of the composer: its structure, never the prompt', async () => {
    const { fake, page, driver } = await site({ sendLabel: 'Submit message', sendTestId: 'send-button', answer: 'ok' })
    const drift: DriftEvent[] = []
    driver.onDrift = (event) => drift.push(event)
    expect((await driver.ask(page, 'my private question', { conversation: 'temporary' })).text).toBe('ok')
    expect(fake.sent).toHaveLength(1)
    expect(drift).toEqual([expect.objectContaining({ provider: 'chatgpt-web', element: 'composer.send', kind: 'fallback', candidate: 1 })])
    const nodes = drift[0]!.outline!.nodes
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ tag: 'button', label: 'Submit message', testid: 'send-button' }),
    ]))
    expect(JSON.stringify(drift[0]!.outline)).not.toContain('private question')
  }, 40_000)

  it('is signed in with a "Log in" offer beside a working composer', async () => {
    const { fake, page, driver } = await site({ loginOffer: true, answer: 'still here' })
    expect(await driver.checkAuth(page)).toBe('signed-in')
    expect((await driver.ask(page, 'hi', { conversation: 'temporary' })).text).toBe('still here')
    expect(fake.sent).toHaveLength(1)
  }, 40_000)

  it('fails closed as reauth_required when signed out', async () => {
    const { fake, page, driver } = await site({ signedIn: false })
    await expect(driver.ask(page, 'x', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(fake.sent).toEqual([])
  }, 30_000)
})

it('ships a map that loads with the generic loader too', () => {
  const text = readFileSync(new URL('../ui/chatgpt-web.ui.yaml', import.meta.url), 'utf8')
  expect(loadUiMap(text).hash).toMatch(/^sha256:/)
})

describe.runIf(canRunBrowser)('the driver as a provider plugin', () => {
  let browser: Browser
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close())

  it('exposes login support: login URL, state origins, and a hashed-only identity hint', async () => {
    const fake = new FakeChatGpt({ userId: 'user-abc' })
    await fake.start()
    const context = await browser.newContext()
    try {
      const driver = new ChatGptWebDriver({ origin: fake.origin })
      expect(driver.loginUrl).toBe(`${fake.origin}/auth/login`)
      expect(driver.stateOrigins).toEqual([fake.origin])
      const page = await context.newPage()
      expect(await driver.checkAuth(page)).toBe('signed-in')
      expect(await driver.identity(page)).toBe('chatgpt-web:user-abc')
    } finally {
      await context.close()
      await fake.stop()
    }
  }, 30_000)

  it('registers itself on ctx.providers', async () => {
    const ctx = new Context()
    await ctx.plugin(Providers)
    await ctx.plugin(ChatGptWebPlugin, { origin: 'http://127.0.0.1:9' })
    expect(ctx.providers.get('chatgpt-web')).toBeInstanceOf(ChatGptWebDriver)
  })
})

