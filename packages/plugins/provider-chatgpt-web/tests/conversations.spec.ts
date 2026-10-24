import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { fakeSite } from './site.ts'

describe.runIf(canRunBrowser)('ChatGptWebDriver against the fake site, with no real account (QA-10): persistent conversations, stalls, and snapshots', () => {
  const { site } = fakeSite()

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

  it('reports a conversation that shows no turn as not observed, never as nothing new (live 2026-10-12)', async () => {
    const { page, driver } = await site({ timeouts: { snapshotMs: 1500 } })
    // A bound URL whose page never renders a user turn: no evidence either way.
    expect(await driver.snapshot(page, '00000000-0000-4000-8000-000000000000')).toEqual({ text: '', running: false, observable: false })
  }, 60_000)
})
