import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { fakeSite } from './site.ts'

describe.runIf(canRunBrowser)('ChatGptWebDriver against the fake site, with no real account (QA-10): reading a Deep research report', () => {
  const { site } = fakeSite()

  it('runs Deep research from the + tools in a persistent conversation, with the prompt free of the tool chip (REQ-PRV-6)', async () => {
    const report = 'A detailed report <a href="https://src.example/a">[1]</a> with <a href="https://src.example/b">sources</a> <a href="https://src.example/a">[1]</a>.'
    const { fake, page, driver } = await site({ report })
    const reports: unknown[] = []
    driver.onReport = (event) => void reports.push(event)
    const turn = await driver.ask(page, 'Survey the DSH plugin catalog', { conversation: 'persistent', feature: 'deep-research' })
    // Not the acknowledgement: the report from the research frame, with its citation links kept.
    expect(turn.text).toBe('Research findings\nA detailed report [1] with sources [1].\n\nSources:\n- [1] https://src.example/a\n- sources https://src.example/b')
    expect(turn.binding).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.sent[0]).toMatchObject({ prompt: 'Survey the DSH plugin catalog', deepResearch: true, mode: 'chat', temporary: false })
    await expect.poll(() => reports).toEqual([{ provider: 'chatgpt-web', path: 'frame', chars: turn.text.length, links: 2 }])
    await expect(driver.ask(page, 'x', { conversation: 'temporary', feature: 'deep-research' })).rejects.toMatchObject({ kind: 'invalid_input' })
  }, 60_000)

  it('reads a framed report with the source pills its conversation shows outside the frame (live 2026-10-18)', async () => {
    const reports: unknown[] = []
    const { page, driver } = await site({ framePills: true, report: 'Framed report body.' })
    driver.onReport = (event) => void reports.push(event)
    const drifts: Array<{ element: string }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    const turn = await driver.ask(page, 'Survey framed', { conversation: 'persistent', feature: 'deep-research' })
    expect(turn.text).toBe('Research findings\nFramed report body.\n\nSources:\n- https://www.sqlite.org/wal.html\n- https://docs.example/notes')
    await expect.poll(() => reports).toEqual([{ provider: 'chatgpt-web', path: 'frame', chars: turn.text.length, links: 2 }])
    // The thread is found by its region, whose name is not an aria-label attribute (live 2026-10-18).
    expect(drifts.map((d) => d.element)).not.toContain('conversation.thread')
  }, 60_000)

  it('reads a report the app shell shows inline as the last answer, with no frame, in a turn and in a snapshot (live 2026-10-18)', async () => {
    const { page, driver, context } = await site({ researchInline: true, report: 'Inline report body.' })
    const turn = await driver.ask(page, 'Survey inline', { conversation: 'persistent', feature: 'deep-research' })
    // Not the acknowledgement: the answer after the completion line, as its Copy gives it, then its
    // source pills' links (one of them in the overflow), which stand outside the answer's container.
    expect(turn.text).toBe('Inline report body.\n\nSources:\n- https://www.sqlite.org/wal.html\n- https://docs.example/notes')
    const other = await context.newPage()
    expect(await driver.snapshot(other, turn.binding!, { feature: 'deep-research' })).toMatchObject({ text: expect.stringMatching(/^Inline report body\.\n\nSources:/), running: false, observable: true })
  }, 60_000)

  it('reads the conversation in its own thread, never a floating copy of it, so the report keeps its citations (live 2026-10-18)', async () => {
    const reports: unknown[] = []
    const { page, driver } = await site({ researchInline: true, floatingChat: true, report: 'Floating report body.' })
    driver.onReport = (event) => void reports.push(event)
    const turn = await driver.ask(page, 'Survey with a floating chat', { conversation: 'persistent', feature: 'deep-research' })
    expect(turn.text).toMatch(/^Floating report body\.\n\nSources:\n- https:\/\/www\.sqlite\.org\/wal\.html/)
    // The read is reported as counts: its path, its length, and its links.
    await expect.poll(() => reports).toEqual([{ provider: 'chatgpt-web', path: 'inline', chars: turn.text.length, links: 2 }])
  }, 60_000)

  it('keeps reading a report marked complete before its answer renders, and never takes the earlier answer for it', async () => {
    const { page, driver } = await site({ researchInline: true, inlineReportDelayMs: 3000, report: 'Late report body.' })
    expect((await driver.ask(page, 'Survey late', { conversation: 'persistent', feature: 'deep-research' })).text).toMatch(/^Late report body\.\n\nSources:\n- https:\/\/www\.sqlite\.org\/wal\.html/)
  }, 60_000)

  it('fails a completed report it cannot read as drift, outlined, and never takes the acknowledgement for it', async () => {
    const { page, driver } = await site({ untitledReport: true, timeouts: { reportReadMs: 1000 } })
    const drifts: Array<{ element: string; outline?: unknown }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    await expect(driver.ask(page, 'Survey untitled', { conversation: 'persistent', feature: 'deep-research' })).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/report cannot be read/) })
    expect(drifts.filter((d) => d.element === 'research.report-title')).toEqual([expect.objectContaining({ outline: expect.anything() })])
  }, 60_000)
})
