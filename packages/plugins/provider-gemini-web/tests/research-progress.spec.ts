import { UiEngine } from '@tsuuanmi/system-ui-ops'
import { describe, expect, it, vi } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { GeminiWebDriver } from '../src/index.ts'
import { fakeSite, PRESETS } from './site.ts'

describe.runIf(canRunBrowser)('GeminiWebDriver against the fake site: a Deep research run in progress', { timeout: 60_000 }, () => {
  const { open } = fakeSite()

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
  })

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

  it('reopens a Deep research turn as running while its card works, then as its report', async () => {
    // Running until the test says otherwise: no window to race, however loaded the host.
    const { page, driver, fake, context } = await open({ researchHeld: true })
    let binding: string | undefined
    const asked = driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research', onBinding: (b) => { binding = b } })
    // Awaited below; a failed assertion before that must not leave its rejection unhandled when the page closes.
    asked.catch(() => undefined)
    // The site marks the plan started: the run is on.
    await vi.waitFor(() => expect(fake.started).toHaveLength(1), { timeout: 10_000, interval: 100 })
    expect(fake.started).toEqual([binding])
    const other = await context.newPage()
    expect(await driver.snapshot(other, binding!, { feature: 'deep-research' })).toMatchObject({ text: '', running: true, observable: true })
    fake.options.researchHeld = false
    const result = await asked
    // Starting the plan is the conversation's last user turn.
    expect(await driver.snapshot(other, binding!, { feature: 'deep-research' })).toEqual({ text: result.text, running: false, observable: true, lastPrompt: 'Start research' })
  })
})
