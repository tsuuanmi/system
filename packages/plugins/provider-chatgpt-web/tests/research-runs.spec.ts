import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { fakeSite } from './site.ts'

describe.runIf(canRunBrowser)('ChatGptWebDriver against the fake site, with no real account (QA-10): a Deep research run as it starts, runs, and repeats', () => {
  const { site } = fakeSite()

  it('waits for a run that shows running only in a panel outside the thread, and reads its report (live 2026-10-19)', async () => {
    // The run outlasts researchStartMs (3 s here), shown running only outside main meanwhile.
    const { page, driver } = await site({ researchInline: true, researchPanel: true, researchMs: 9000, report: 'Paneled report body.' })
    const turn = await driver.ask(page, 'Survey with a panel', { conversation: 'persistent', feature: 'deep-research' })
    expect(turn.text).toMatch(/^Paneled report body\.\n\nSources:\n- https:\/\/www\.sqlite\.org\/wal\.html/)
  }, 60_000)

  it('returns Deep research\'s clarifying question when no research starts', async () => {
    const { page, driver } = await site({ clarify: true })
    const stalls: Array<{ phase: string; outline?: unknown }> = []
    driver.onStall = (event) => void stalls.push(event)
    const turn = await driver.ask(page, 'Research something vague', { conversation: 'persistent', feature: 'deep-research' })
    expect(turn.text).toBe('Which aspect should the research focus on?')
    // No run seen: the page is outlined first, in case it was a run the map missed.
    expect(stalls).toEqual([expect.objectContaining({ phase: 'research-start', outline: expect.anything() })])
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
})
