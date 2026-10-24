import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import type { FakeOptions } from '../fixtures/fake-gemini.ts'
import { GeminiWebDriver } from '../src/index.ts'
import { fakeSite, PRESETS } from './site.ts'

describe.runIf(canRunBrowser)('GeminiWebDriver against the fake site: stalls and progress', { timeout: 60_000 }, () => {
  const { open } = fakeSite()

  it('outlines a stalled answer with the page\'s visibility, focus, and path, and fails it as provider_stalled', async () => {
    const { page, fake } = await open({ startOnSpark: false, holdAnswer: true })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 30_000, stallMs: 1500 } })
    const stalls: Array<{ provider: string; phase: string; visibility?: string; focused?: boolean; url?: string; outline?: { nodes: unknown[] } }> = []
    driver.onStall = (event) => void stalls.push(event as never)
    await expect(driver.ask(page, 'hello', { conversation: 'persistent' })).rejects.toMatchObject({ kind: 'provider_stalled' })
    expect(stalls).toEqual([expect.objectContaining({ provider: 'gemini-web', phase: 'answer', visibility: 'visible', focused: true, url: expect.stringMatching(/^\/app/) })])
    expect(stalls[0]!.outline!.nodes.length).toBeGreaterThan(0)
  })

  it('takes a long think whose thinking the answer shows for progress, past the stall deadline (REQ-PRV-4; live 2026-10-23: a review member stalled at 5 min)', async () => {
    // Four seconds of thinking with no answer text, nearly three times the stall deadline: its summary changes, so it is not a stall.
    const { page, fake } = await open({ startOnSpark: false, thinkMs: 4000, answer: 'Reviewed: no blocking defect.' })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 30_000, stallMs: 1500 } })
    const stalls: unknown[] = []
    driver.onStall = (event) => void stalls.push(event)
    expect((await driver.ask(page, 'review this', { conversation: 'persistent' })).text).toBe('Reviewed: no blocking defect.')
    expect(stalls).toEqual([])
  })

  /**
   * A think that shows nothing new fails as provider_stalled once the stall clock runs out, before
   * the turn's hard deadline. Both clocks start at the send, so the wait is timed from there
   * (`beforeSend`), never from opening the page. The think outlasts the deadline: a stall left
   * undetected would end the turn at the deadline as a timeout. The deadline is far enough past
   * the stall for a slow runner's polls.
   */
  async function stallsBeforeTheDeadline(options: FakeOptions): Promise<void> {
    const stallMs = 1500
    const timeouts = { readyMs: 5000, stableMs: 300, pollMs: 100, stallMs, turnMs: 8 * stallMs }
    const { page, fake } = await open({ startOnSpark: false, thoughts: false, answer: 'too late', ...options, thinkMs: 2 * timeouts.turnMs })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts })
    let sent: number | undefined
    await expect(driver.ask(page, 'review this', { conversation: 'persistent', beforeSend: () => { sent = Date.now() } })).rejects.toMatchObject({ kind: 'provider_stalled' })
    const waited = Date.now() - sent!
    expect(waited).toBeGreaterThanOrEqual(timeouts.stallMs)
    expect(waited).toBeLessThan(timeouts.turnMs)
  }

  it('still fails a think that shows nothing new as provider_stalled, before the turn\'s hard deadline', async () => {
    await stallsBeforeTheDeadline({})
  })

  it('takes no count that changes only its numbers for progress: a think whose summary stands still stalls while its timer counts up', async () => {
    await stallsBeforeTheDeadline({ thinkTimer: true })
  })

  it('still takes a summary whose words change for progress, a timer counting beside it', async () => {
    const { page, fake } = await open({ startOnSpark: false, thinkMs: 4000, thinkTimer: true, answer: 'Reviewed: no blocking defect.' })
    const driver = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', timeouts: { readyMs: 5000, stableMs: 300, pollMs: 100, turnMs: 30_000, stallMs: 1500 } })
    expect((await driver.ask(page, 'review this', { conversation: 'persistent' })).text).toBe('Reviewed: no blocking defect.')
  })
})
