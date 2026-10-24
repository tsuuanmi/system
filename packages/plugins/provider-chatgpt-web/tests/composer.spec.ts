import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { DriftEvent } from '@tsuuanmi/system-ui-ops'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { fakeSite } from './site.ts'

describe.runIf(canRunBrowser)('ChatGptWebDriver against the fake site, with no real account (QA-10): the composer, Chat and Work, and healing', () => {
  const { site } = fakeSite()

  it('finds the composer outside any dialog, marked or not, never the floating chat\'s, with no drift (live 2026-10-18)', async () => {
    const { page, driver, fake } = await site({ unmarkedComposer: true, floatingChat: true })
    const drifts: Array<{ element: string }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    expect((await driver.ask(page, 'ping', { conversation: 'persistent' })).text).toBe('OK')
    expect(fake.sent[0]).toMatchObject({ prompt: 'ping' })
    expect(drifts.map((d) => d.element)).not.toContain('composer.form')
  }, 40_000)

  it('never sends from a composer that names Work, though Chat reads as pressed (live 2026-10-18)', async () => {
    const { fake, page, driver } = await site({ workComposer: true })
    await expect(driver.ask(page, 'hello', { conversation: 'persistent' })).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/Work with ChatGPT.*Codex quota/) })
    expect(fake.sent).toEqual([])
    // Nothing typed is left behind.
    expect((await page.locator('#input').textContent())?.trim()).toBe('')
  }, 40_000)

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
})
