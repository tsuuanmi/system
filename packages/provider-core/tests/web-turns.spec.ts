import { describe, expect, it } from 'vitest'
import { bindingReporter, completionOptions, modePresets, type ResearchState, waitForReport, withMissingSources, withoutTracking, withoutTrackingLinks, withSources } from '../src/index.ts'

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
    // A title that only repeats the link, its URL or its site, is left out (live 2026-10-19).
    expect(withSources('Report.', new Map([['https://sqlite.org/wal.html', 'https://sqlite.org/wal.html'], ['https://www.sqlite.org/pragma.html', 'sqlite.org'], ['https://sqlite.org/changes.html', 'Release history']])))
      .toBe('Report.\n\nSources:\n- https://sqlite.org/wal.html\n- https://www.sqlite.org/pragma.html\n- Release history https://sqlite.org/changes.html')
  })

  it('adds only the sources an answer does not carry, without tracking parameters', () => {
    const sources = new Map([['https://a.example/x?utm_source=chat.example', 'A'], ['https://b.example/y?id=1&utm_medium=x', 'B'], ['https://a.example/x', 'A again']])
    expect(withMissingSources('See https://a.example/x?utm_source=chat.example.', sources)).toBe('See https://a.example/x?utm_source=chat.example.\n\nSources:\n- B https://b.example/y?id=1')
    expect(withMissingSources('See https://a.example/x and https://b.example/y?id=1.', sources)).toBe('See https://a.example/x and https://b.example/y?id=1.')
    expect(withMissingSources('See [example.com](https://example.com).', new Map([['https://example.com/', 'example.com']]))).toBe('See [example.com](https://example.com).')
    expect(withoutTracking('not a url')).toBe('not a url')
  })

  it('counts a source as carried only by that exact URL, not by a longer one it begins', () => {
    const sources = new Map([['https://a.example/x', 'X']])
    expect(withMissingSources('See https://a.example/xyz.', sources)).toBe('See https://a.example/xyz.\n\nSources:\n- X https://a.example/x')
    expect(withMissingSources('See https://a.example/x.', sources)).toBe('See https://a.example/x.')
    expect(withMissingSources('See [x](https://a.example/x/?utm_source=s).', sources)).toBe('See [x](https://a.example/x/?utm_source=s).')
  })

  it('drops tracking parameters from link and reference targets, and leaves other text alone', () => {
    expect(withoutTrackingLinks('Pin by SHA ([GitHub Docs][1]) and [attest](https://github.com/actions/attest?utm_source=chatgpt.com "attest").\n\n[1]: https://docs.github.com/a?id=2&utm_source=chatgpt.com#pin "Security"'))
      .toBe('Pin by SHA ([GitHub Docs][1]) and [attest](https://github.com/actions/attest "attest").\n\n[1]: https://docs.github.com/a?id=2#pin "Security"')
    expect(withoutTrackingLinks('Text that says ?utm_source=x stays, and [plain](https://a.example/b) too.')).toBe('Text that says ?utm_source=x stays, and [plain](https://a.example/b) too.')
  })
})
