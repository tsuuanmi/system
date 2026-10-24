import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { fakeSite, TIMEOUTS } from './site.ts'

describe.runIf(canRunBrowser)('GeminiWebDriver against the fake site: persistent conversations and their snapshots', { timeout: 60_000 }, () => {
  const { open } = fakeSite()

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

  it('does not observe a conversation whose prompt it cannot read, so nothing is resent blind', async () => {
    // The read gives up when its bound runs out: 20 s by default, 3 s here.
    const { page, driver, fake } = await open({}, { timeouts: { ...TIMEOUTS, snapshotMs: 3000 } })
    const { binding } = await driver.ask(page, 'the prompt', { conversation: 'persistent' })
    fake.options.promptParagraphs = false
    expect(await driver.snapshot(page, binding!)).toEqual({ text: '', running: false, observable: false })
  })

  it('waits for a reopened prompt\'s text before judging it: a bubble that renders first is still observed', async () => {
    const { page, driver, fake, context } = await open({ answer: 'done' })
    const first = await driver.ask(page, 'remember this', { conversation: 'persistent' })
    fake.options.promptLagMs = 1500
    const other = await context.newPage()
    expect(await driver.snapshot(other, first.binding!)).toMatchObject({ observable: true, running: false, text: 'done', lastPrompt: 'remember this' })
  })

  it('probes the account\'s features in a new chat, sending nothing (REQ-PRV-7)', async () => {
    const { page, driver, fake } = await open()
    expect(await driver.probeFeatures(page)).toEqual(['deep-research'])
    const none = await open({ deepResearch: false })
    expect(await none.driver.probeFeatures(none.page)).toEqual([])
    expect([...fake.sent, ...none.fake.sent]).toEqual([])
  })
})
