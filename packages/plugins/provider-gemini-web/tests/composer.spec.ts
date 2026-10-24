import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { GeminiWebDriver } from '../src/index.ts'
import { fakeSite, PRESETS, TIMEOUTS } from './site.ts'

describe.runIf(canRunBrowser)('GeminiWebDriver against the fake site: the prompt and the answer', { timeout: 60_000 }, () => {
  const { open } = fakeSite()

  it('counts the prompt in code points against its input bound, as admission does (ADR-0032)', async () => {
    const { page, fake } = await open({ startOnSpark: false, answer: 'OK' })
    const limited = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', maxPromptChars: 40, timeouts: TIMEOUTS })
    // Thirty emoji: 60 UTF-16 units, 30 characters as admission counts them.
    expect((await limited.ask(page, '🙂'.repeat(30), { conversation: 'temporary' })).text).toBe('OK')
    await expect(limited.ask(page, '🙂'.repeat(41), { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/41 characters, over the 40 /) })
    expect(fake.sent).toHaveLength(1)
  })

  it('refuses a prompt over its input limit before anything is sent, and calls a dropped prompt dropped, not UI drift', async () => {
    const { page, fake } = await open({ answer: 'never', dropOver: 50 })
    const limited = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', maxPromptChars: 40, timeouts: TIMEOUTS })
    await expect(limited.ask(page, 'x'.repeat(41), { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/41 characters, over the 40 .*nothing was sent/) })
    // Under the driver's limit but over the site's: the site empties the composer and asks nothing.
    const loose = new GeminiWebDriver({ origin: fake.origin, modes: PRESETS, defaultMode: 'flash', maxPromptChars: 1000, timeouts: TIMEOUTS })
    // Nothing the send's check waits for comes, so it runs out its bound: the map's 20 s, 3 s here.
    const send = loose.map.actions['composer.send']!
    send.timeouts = { ...send.timeouts, verifyMs: 3000 }
    await expect(loose.ask(page, 'y'.repeat(60), { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'input_dropped', disposition: 'USER_ACTION' })
    expect(fake.sent).toEqual([])
  })

  it('returns the answer as Markdown from its Copy, with code lines kept (REQ-PRV-5)', async () => {
    const markdown = '## Plan\n\n* **First** item\n* **Second** item\n\nSee `x` and [example.com](https://example.com).\n\n```python\ndef add(a, b):\n    return a + b\n```'
    const { page, driver } = await open({ answer: markdown })
    expect((await driver.ask(page, 'Markdown please', { conversation: 'temporary' })).text).toBe(markdown)
  })

  it('never sends a draft the site kept: the composer is emptied first, and a turn that fails unsent leaves none (live 2026-10-17)', async () => {
    const { page, driver, fake } = await open({ startOnSpark: false, draftPersist: true, answer: 'ok' })
    // A draft left from an earlier, unsent attempt (as in the live login profile).
    await page.goto(`${fake.origin}/app`)
    await page.evaluate(() => localStorage.setItem('draft:home', 'an old unsent draft'))
    expect((await driver.ask(page, 'the real prompt', { conversation: 'temporary' })).text).toBe('ok')
    expect(fake.sent.map((s) => s.prompt)).toEqual(['the real prompt'])
    // Typed, then refused before the send: nothing is left as a draft for the next turn.
    await expect(driver.ask(page, 'never sent', { conversation: 'temporary', beforeSend: () => { throw new Error('stop before sending') } })).rejects.toThrow(/stop before sending/)
    await page.goto(`${fake.origin}/app`)
    expect((await page.evaluate(() => localStorage.getItem('draft:home') ?? '')).trim()).toBe('')
    expect((await driver.ask(page, 'next prompt', { conversation: 'temporary' })).text).toBe('ok')
    expect(fake.sent.map((s) => s.prompt)).toEqual(['the real prompt', 'next prompt'])
  })

  it('outlines a composer that rewrote a paste, with where it differs and never the text, and sends nothing', async () => {
    const { page, driver, fake } = await open({ startOnSpark: false, rewritePaste: true })
    const drifts: Array<{ element: string; kind: string; readback?: Record<string, unknown>; outline?: { nodes: unknown[] } }> = []
    driver.onDrift = (event) => void drifts.push(event as never)
    await expect(driver.ask(page, 'Review this:\n```\nconst x = 1\n```', { conversation: 'temporary' }))
      .rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/readback differs .*first difference at line 1, offset 0: punctuation ` against letter/) })
    const readback = drifts.find((d) => d.kind === 'readback')!
    expect(readback).toMatchObject({ element: 'composer.input', readback: { line: 1, offset: 0, inserted: 'punctuation `', read: 'letter', truncated: false } })
    expect(readback.outline!.nodes.length).toBeGreaterThan(0)
    expect(JSON.stringify(readback.readback)).not.toMatch(/Review|const/)
    expect(fake.sent).toEqual([])
  })

  it('sends nothing when the receipt cannot be written', async () => {
    const { page, driver, fake } = await open()
    await expect(driver.ask(page, 'hi', { conversation: 'temporary', beforeSend: () => { throw new Error('store down') } })).rejects.toThrow('store down')
    expect(fake.sent).toEqual([])
  })
})
