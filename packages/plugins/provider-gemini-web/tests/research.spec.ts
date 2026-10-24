import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { fakeSite } from './site.ts'

describe.runIf(canRunBrowser)('GeminiWebDriver against the fake site: Deep research and its presets', { timeout: 60_000 }, () => {
  const { open } = fakeSite()

  it('runs Deep research: chosen from More tools, its plan started, and its report returned with the sources it used', async () => {
    const { page, driver, fake } = await open()
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    expect(result.text).toBe('HTTP/3 runs over QUIC, not TCP.\n\nSources:\n- RFC 9114: HTTP/3 https://www.rfc-editor.org/rfc/rfc9114')
    expect(fake.sent).toEqual([expect.objectContaining({ deepResearch: true, temporary: false })])
    expect(fake.started).toEqual([result.binding])
  })

  it('applies no mode preset to Deep research: the picker stays as the site has it, and the mode is recorded as the site\'s (live 2026-10-18)', async () => {
    const { page, driver, fake } = await open()
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research', mode: 'pro' })
    expect(result.mode).toEqual({})
    // Sent with the site's own selection, not the frontier preset's Pro.
    expect(fake.sent[0]!.model).not.toMatch(/Pro/)
    expect(fake.sent[0]).toMatchObject({ deepResearch: true })
  })

  it('selects the research preset for Deep research, whatever the turn names, with the tool on, and records it as read back', async () => {
    const { page, driver, fake } = await open({}, { researchMode: 'pro' })
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research', mode: 'flash-lite' })
    expect(result.mode).toEqual({ model: '3.1 Pro', effort: 'High' })
    expect(fake.sent[0]).toMatchObject({ deepResearch: true, model: '3.1 Pro', level: 'High' })
    // A plain turn still takes its own preset.
    expect((await driver.ask(page, 'hi', { conversation: 'temporary', mode: 'flash-lite' })).mode).toEqual({ model: '3.5 Flash-Lite', effort: 'Low' })
  })

  it('selects the research preset\'s model only when the picker shows no thinking level with Deep research chosen, with no drift', async () => {
    const { page, driver, fake } = await open({ researchHidesLevels: true }, { researchMode: 'pro' })
    const drifts: unknown[] = []
    driver.onDrift = (event) => void drifts.push(event)
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    expect(result.mode).toEqual({ model: '3.1 Pro' })
    expect(fake.sent[0]).toMatchObject({ deepResearch: true, model: '3.1 Pro', level: 'Low' })
    expect(drifts).toEqual([])
  })

  it('returns a clarifying question as the answer when Deep research asks one instead of a plan', async () => {
    const { page, driver, fake } = await open({ clarify: 'Which aspect should the research focus on?' })
    const result = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    expect(result.text).toBe('Which aspect should the research focus on?')
    expect(fake.started).toEqual([])
  })

  it('clears Deep research, which a reopened conversation keeps chosen, before a plain follow-up', async () => {
    const { page, driver, fake } = await open({ clarify: 'Which aspect?', answer: 'a plain answer' })
    const { binding } = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    const follow = await driver.ask(page, 'Which RFC defines HTTP/3?', { conversation: 'persistent', binding })
    expect(follow.text).toBe('a plain answer')
    expect(fake.sent.map((s) => s.deepResearch)).toEqual([true, false])
  })

  it('keeps Deep research chosen, never toggled off, for a Deep research follow-up in the same conversation', async () => {
    const { page, driver, fake } = await open({ clarify: 'Which aspect?' })
    const { binding } = await driver.ask(page, 'Compare HTTP/2 and HTTP/3', { conversation: 'persistent', feature: 'deep-research' })
    await driver.ask(page, 'Latency, please', { conversation: 'persistent', feature: 'deep-research', binding })
    expect(fake.sent.map((s) => s.deepResearch)).toEqual([true, true])
  })
})
