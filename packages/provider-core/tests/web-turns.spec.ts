import { describe, expect, it } from 'vitest'
import { bindingReporter, completionOptions, modePresets, type ResearchState, waitForReport, withSources } from '../src/index.ts'

const TIMEOUTS = { turnMs: 5000, stallMs: 2000, stableMs: 10, pollMs: 5, reportReadMs: 50 }

/** Turn mechanics both website drivers share, without a page. */
describe('website turn mechanics', () => {
  it('looks up mode presets by name or default, refusing unknown names and an unknown default', () => {
    const preset = modePresets('site', { fast: { model: 'Fast' } }, 'fast')
    expect(preset(undefined)).toEqual({ model: 'Fast' })
    expect(() => preset('nope')).toThrow('site: unknown mode nope (configured: fast)')
    expect(modePresets('site')(undefined)).toBeUndefined()
    expect(() => modePresets('site', {}, 'ultra')).toThrow('site: default mode ultra is not a configured mode')
  })

  it('takes the turn\'s own deadlines over the driver\'s, and polls a report at least every second', () => {
    expect(completionOptions(TIMEOUTS, undefined, undefined)).toEqual({ timeoutMs: 5000, stallTimeoutMs: 2000, stableMs: 10, pollMs: 5 })
    const signal = new AbortController().signal
    expect(completionOptions(TIMEOUTS, { timeoutMs: 9, stallTimeoutMs: 3 }, signal, 1000)).toEqual({ timeoutMs: 9, stallTimeoutMs: 3, stableMs: 10, pollMs: 1000, signal })
  })

  it('reports a binding once, as soon as the page shows it', () => {
    const seen: string[] = []
    let shown: string | undefined
    const report = bindingReporter(() => shown, (b) => seen.push(b))
    report()
    shown = 'c1'
    report()
    report()
    expect(seen).toEqual(['c1'])
    expect(() => bindingReporter(() => 'x', undefined)()).not.toThrow()
  })

  it('waits for a report, and fails as drift when a finished report stays unreadable', async () => {
    const states: ResearchState[] = [{ running: true, done: false, text: '' }, { running: false, done: true, text: 'the report' }]
    let i = 0
    const report = await waitForReport(async () => states[Math.min(i++, 1)]!, { ...TIMEOUTS, pollMs: 1 }, { provider: 'site', element: 'research.report', deadlines: { timeoutMs: 10_000, stallTimeoutMs: 5000 }, signal: undefined })
    expect(report).toBe('the report')
    await expect(waitForReport(async () => ({ running: false, done: true, text: '' }), TIMEOUTS, { provider: 'site', element: 'research.report', deadlines: { timeoutMs: 10_000, stallTimeoutMs: 5000 }, signal: undefined }))
      .rejects.toMatchObject({ kind: 'ui_drift', message: 'site: Deep research completed, but its report cannot be read; update research.report in the UI map' })
  }, 20_000)

  it('lists a report\'s sources under it', () => {
    expect(withSources('Report.', new Map([['https://a.example', 'A'], ['https://b.example', '']]))).toBe('Report.\n\nSources:\n- A https://a.example\n- https://b.example')
  })
})
