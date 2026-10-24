import type { DriftEvent } from '@tsuuanmi/system-ui-ops'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { GeminiWebDriver } from '../src/index.ts'
import { fakeSite } from './site.ts'

describe.runIf(canRunBrowser)('GeminiWebDriver against the fake site: modes, the Chat tab, and Temporary chat', { timeout: 60_000 }, () => {
  const { open } = fakeSite()

  it('chooses the mode before typing the prompt, and finds each prompt by its bubble with no drift (live 2026-10-17)', async () => {
    const { page, driver } = await open({ startOnSpark: false })
    const drifts: Array<{ element: string }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    await driver.ask(page, 'x'.repeat(2000), { conversation: 'temporary', mode: 'pro' })
    // Every time the picker opened, the composer was still empty.
    const opened = (await page.evaluate(() => document.body.dataset.pickerOpenedWith ?? '')).split(',').filter(Boolean).map(Number)
    expect(opened.length).toBeGreaterThan(0)
    expect(opened.every((n) => n === 0)).toBe(true)
    expect(drifts.filter((d) => d.element === 'turn.user')).toEqual([])
  })

  it('asks in a Temporary chat on the Chat tab, never Spark, with the preset read back before sending', async () => {
    const { page, driver, fake } = await open({ answer: 'Gemini test OK.' })
    const boundaries: unknown[] = []
    const result = await driver.ask(page, 'Say OK', { conversation: 'temporary', mode: 'pro', beforeSend: (b) => void boundaries.push(b) })
    expect(result).toEqual({ text: 'Gemini test OK.', binding: undefined, mode: { model: '3.1 Pro', effort: 'High' } })
    expect(fake.sent).toEqual([{ prompt: 'Say OK', tab: 'chat', temporary: true, model: '3.1 Pro', level: 'High', deepResearch: false }])
    expect(boundaries).toEqual([{ previousResponse: null, mode: { model: '3.1 Pro', effort: 'High' } }])
  })

  it('tells Flash from Flash-Lite, and uses the default preset when a turn names none', async () => {
    const { page, driver, fake } = await open()
    expect((await driver.ask(page, 'one', { conversation: 'temporary', mode: 'flash-lite' })).mode).toEqual({ model: '3.5 Flash-Lite', effort: 'Low' })
    expect((await driver.ask(page, 'two', { conversation: 'temporary' })).mode).toEqual({ model: '3.8 Flash', effort: 'Medium' })
    expect(fake.sent.map((s) => [s.model, s.level])).toEqual([['3.5 Flash-Lite', 'Low'], ['3.8 Flash', 'Medium']])
  })

  it('opens the thinking-level submenu to choose a level (the layout since 2026-10-16)', async () => {
    const { page, driver, fake } = await open()
    expect((await driver.ask(page, 'one', { conversation: 'temporary', mode: 'pro' })).mode).toEqual({ model: '3.1 Pro', effort: 'High' })
    expect(fake.sent.map((s) => s.level)).toEqual(['High'])
  })

  it('reports a level it cannot reach in the submenu as drift, with evidence, and sends nothing', async () => {
    const broken = await open({ submenuBroken: true })
    const drift: DriftEvent[] = []
    broken.driver.onDrift = (event) => drift.push(event)
    await expect(broken.driver.ask(broken.page, 'two', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/thinking level High is offered but cannot be reached/) })
    expect(broken.fake.sent).toEqual([])
    expect(drift).toEqual([expect.objectContaining({ element: 'mode.level', kind: 'unresolved', outline: expect.objectContaining({ nodes: expect.arrayContaining([expect.objectContaining({ role: 'menuitem' })]) }) })])
  })

  it('reads a thinking level with its note on its own line too (the layout before 2026-10-16)', async () => {
    const { page, driver, fake } = await open({ levelsInline: false })
    expect((await driver.ask(page, 'hi', { conversation: 'temporary', mode: 'flash' })).mode).toEqual({ model: '3.8 Flash', effort: 'Medium' })
    expect(fake.sent.map((s) => s.level)).toEqual(['Medium'])
  })

  it('refuses to send when Spark cannot be left', async () => {
    const { page, driver, fake } = await open({ chatTabBroken: true })
    await expect(driver.ask(page, 'hi', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/Chat tab/) })
    expect(fake.sent).toEqual([])
  })

  it('refuses to send when Temporary chat does not turn on, and reports it with an outline of the page: structure, never text', async () => {
    const { page, driver, fake } = await open({ temporaryBroken: true })
    const drift: DriftEvent[] = []
    driver.onDrift = (event) => drift.push(event)
    await expect(driver.ask(page, 'my private question', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(fake.sent).toEqual([])
    expect(drift).toEqual([expect.objectContaining({ provider: 'gemini-web', element: 'temporary.enable', kind: 'postcondition', candidate: -1 })])
    expect(drift[0]!.outline).toMatchObject({ root: 'body', nodes: expect.arrayContaining([expect.objectContaining({ tag: 'button', label: 'Temporary chat' })]) })
    expect(JSON.stringify(drift[0]!.outline)).not.toContain('private question')
    // The account's own name and address never appear, wherever the page shows them.
    expect(JSON.stringify(drift[0]!.outline)).not.toMatch(/Test User|test@example\.test/)
  })

  it('fails closed on a model or level the account does not offer, before sending', async () => {
    const { page, driver, fake } = await open({ models: ['3.5 Flash-Lite', '3.8 Flash'], levels: ['Low', 'Medium'] })
    await expect(driver.ask(page, 'hi', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/Pro is not offered/) })
    const odd = new GeminiWebDriver({ origin: fake.origin, modes: { odd: { model: 'Flash', effort: 'High' } }, timeouts: { readyMs: 5000 } })
    await expect(odd.ask(page, 'hi', { conversation: 'temporary', mode: 'odd' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/High is not offered/) })
    expect(fake.sent).toEqual([])
  })

  it('selects nothing for an empty preset on an account without a mode picker', async () => {
    const { page, driver, fake } = await open({ modePicker: false })
    expect((await driver.ask(page, 'hi', { conversation: 'temporary', mode: 'site' })).mode).toEqual({})
    await expect(driver.ask(page, 'hi', { conversation: 'temporary', mode: 'pro' })).rejects.toMatchObject({ kind: 'ui_drift' })
    expect(fake.sent).toHaveLength(1)
  })
})
