// Ported from tsuuanmi/internet test/completion.test.ts.
import { describe, expect, it } from 'vitest'
import { type CompletionSnapshot, ProviderError, type ProviderProgressEvent, waitForStableCompletion } from '../src/index.ts'

const snapshot = (text: string, running: boolean, html = `<p>${text}</p>`): CompletionSnapshot => ({ responsePresent: true, text, html, running })

describe('waitForStableCompletion (two clocks)', () => {
  it('returns the response once present and stable while not running', async () => {
    let calls = 0
    const response = await waitForStableCompletion(async () => (++calls < 5 ? snapshot('Thinking...', true) : snapshot('Final answer', false)), { timeoutMs: 2000, pollMs: 5, stableMs: 20 })
    expect(response).toEqual({ text: 'Final answer', html: '<p>Final answer</p>' })
  })

  it('throws a hard timeout when the response keeps changing', async () => {
    let calls = 0
    await expect(waitForStableCompletion(async () => snapshot(String(++calls), false), { timeoutMs: 80, stallTimeoutMs: 60, pollMs: 5, stableMs: 2000 }))
      .rejects.toMatchObject({ kind: 'timeout' })
  })

  it('classifies an unchanged running response as a stall before the hard deadline', async () => {
    await expect(waitForStableCompletion(async () => snapshot('same', true), { timeoutMs: 500, stallTimeoutMs: 40, pollMs: 5, stableMs: 20 }))
      .rejects.toMatchObject({ kind: 'provider_stalled' })
  })

  it('emits progress only for meaningful transitions', async () => {
    const sequence = [
      { responsePresent: false, text: '', html: '', running: false },
      snapshot('Thinking', true), snapshot('Thinking', true), snapshot('Partial', true),
      snapshot('Final', false), snapshot('Final', false), snapshot('Final', false),
    ]
    const events: ProviderProgressEvent[] = []
    let index = 0
    await waitForStableCompletion(async () => sequence[Math.min(index++, sequence.length - 1)]!, {
      timeoutMs: 1000, stallTimeoutMs: 300, pollMs: 5, stableMs: 8, onProgress: (event) => events.push(event),
    })
    expect(events.map((event) => event.kind)).toEqual([
      'generation_stopped', 'response_started', 'generation_started', 'response_changed', 'generation_stopped', 'response_changed',
    ])
  })

  it('rejects an invalid stall policy before polling', async () => {
    await expect(waitForStableCompletion(async () => snapshot('x', false), { timeoutMs: 100, stallTimeoutMs: 100, pollMs: 5, stableMs: 20 }))
      .rejects.toBeInstanceOf(ProviderError)
  })

  it('rejects when aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitForStableCompletion(async () => snapshot('x', false), { timeoutMs: 2000, pollMs: 5, stableMs: 20, signal: controller.signal }))
      .rejects.toMatchObject({ kind: 'aborted' })
  })
})
