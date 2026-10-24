import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { fakeSite } from './site.ts'

describe.runIf(canRunBrowser)('ChatGptWebDriver against the fake site, with no real account (QA-10): modes, features, and answers', () => {
  const { site } = fakeSite()

  it('asks in Temporary chat after switching Work to Chat, and waits for completion though the stream stays open', async () => {
    const { fake, page, driver } = await site({ answer: 'Hello from the fake site' })
    const drift: unknown[] = []
    driver.onDrift = (event) => drift.push(event)
    const turn = await driver.ask(page, 'Reply with a greeting', { conversation: 'temporary' })
    expect(drift).toEqual([]) // the shipped primary candidates match the live structure
    expect(turn.text).toBe('Hello from the fake site')
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'Reply with a greeting', mode: 'chat', temporary: true })])
    expect(turn.binding).toBeUndefined()
  }, 40_000)

  it('returns the answer as the Markdown that was streamed, not its rendering (REQ-PRV-5)', async () => {
    const answer = 'A **bold** claim with `code`, and [a source](https://src.example/a).'
    const { page, driver } = await site({ answer })
    expect((await driver.ask(page, 'Answer in Markdown', { conversation: 'temporary' })).text).toBe(answer)
  }, 40_000)

  // A web-cited answer: the page renders each citation as a link chip, and Copy yields
  // reference-style links whose URLs carry tracking parameters (2026-10-15).
  const cited = 'Pin actions by SHA ([GitHub Docs](https://docs.github.com/a)) and attest the tarballs ([GitHub](https://github.com/actions/attest)).'
  const referenced = 'Pin actions by SHA ([GitHub Docs][1]) and attest the tarballs ([GitHub][2]).\n\n[1]: https://docs.github.com/a?utm_source=chatgpt.com "Security hardening"\n[2]: https://github.com/actions/attest?utm_source=chatgpt.com "attest"'

  it('keeps a cited answer\'s reference-style Copy, URLs and all, without tracking parameters (REQ-PRV-5)', async () => {
    const { page, driver } = await site({ answer: cited, copied: () => referenced })
    const refused: unknown[] = []
    driver.onCopyRefused = (event) => void refused.push(event)
    expect((await driver.ask(page, 'Cite your sources', { conversation: 'temporary' })).text).toBe(referenced.replaceAll('?utm_source=chatgpt.com', ''))
    expect(refused).toEqual([])
  }, 40_000)

  it('keeps a cited answer\'s URLs from its links when its Copy is refused', async () => {
    const { page, driver } = await site({ answer: cited, copied: () => 'Something else on the clipboard.' })
    const refused: unknown[] = []
    driver.onCopyRefused = (event) => void refused.push(event)
    expect((await driver.ask(page, 'Cite your sources', { conversation: 'temporary' })).text).toBe(
      'Pin actions by SHA (GitHub Docs) and attest the tarballs (GitHub).\n\nSources:\n- GitHub Docs https://docs.github.com/a\n- GitHub https://github.com/actions/attest')
    // Recorded as counts only, so which side differed is decidable without the text.
    expect(refused).toEqual([{ provider: 'chatgpt-web', reason: 'words', prose: 5, shown: 11, matched: 0, links: 0, linkWords: 0, allowance: 2 }])
  }, 40_000)

  it('probes the account\'s features from the tools popover, sending nothing (REQ-PRV-7)', async () => {
    const all = await site()
    expect(await all.driver.probeFeatures(all.page)).toEqual(['deep-research', 'web-search', 'image-generation'])
    const some = await site({ features: ['web-search'] })
    expect(await some.driver.probeFeatures(some.page)).toEqual(['web-search'])
    expect([...all.fake.sent, ...some.fake.sent]).toEqual([])
  }, 60_000)

  it('turns Web search on for a web-search turn', async () => {
    const { fake, page, driver } = await site({ answer: 'News' })
    expect((await driver.ask(page, 'What happened today?', { conversation: 'temporary', feature: 'web-search' })).text).toBe('News')
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'What happened today?', webSearch: true })])
  }, 40_000)

  it('keeps a code block\'s lines, which the answer\'s Copy loses, from the rendered block (REQ-PRV-5)', async () => {
    const answer = 'Here it is:\n```python\ndef add(a, b):\n    return a + b\n```\nDone.'
    const { page, driver } = await site({ answer })
    const drift: unknown[] = []
    driver.onDrift = (event) => drift.push(event)
    // The live Copy drops the fence's language too; the lines are what matter.
    expect((await driver.ask(page, 'Write add', { conversation: 'temporary' })).text).toBe('Here it is:\n```\ndef add(a, b):\n    return a + b\n```\nDone.')
    expect(drift).toEqual([]) // the code block resolves on its primary candidate, as live
  }, 40_000)

  it('keeps runs of spaces in the answer (indentation in a tool call\'s arguments)', async () => {
    const answer = '<call tool="Edit">{"new_string": "def add(a, b):\\n    return a + b"}</call>'
    const { page, driver } = await site({ answer })
    expect((await driver.ask(page, 'Fix add', { conversation: 'temporary' })).text).toBe(answer)
  }, 40_000)

  it('sends nothing when beforeSend throws (the receipt could not be persisted)', async () => {
    const { fake, page, driver } = await site()
    const failure = driver.ask(page, 'x', { conversation: 'temporary', beforeSend: () => { throw new Error('store unavailable') } })
    await expect(failure).rejects.toThrow(/store unavailable/)
    expect(fake.sent).toEqual([])
  }, 30_000)

  it('selects and verifies the configured model and power before sending, and reports them (REQ-PRV-3)', async () => {
    const { fake, page, driver } = await site({ answer: 'deep' })
    const turn = await driver.ask(page, 'think hard', { conversation: 'temporary', mode: 'deep' })
    expect(turn.mode).toEqual({ model: 'GPT-6', effort: 'High' })
    expect(fake.sent[0]).toMatchObject({ model: 'GPT-6', power: 'High', mode: 'chat' })
  }, 40_000)

  it('sends a multi-line prompt intact', async () => {
    const { fake, page, driver } = await site()
    await driver.ask(page, 'first line\nsecond line', { conversation: 'temporary' })
    expect(fake.sent[0]!.prompt.split(/\n+/)).toEqual(['first line', 'second line'])
  }, 40_000)

  it('uses the default mode when none is requested', async () => {
    const { fake, page, driver } = await site()
    const turn = await driver.ask(page, 'plain', { conversation: 'temporary' })
    expect(turn.mode).toEqual({ model: 'Latest', effort: 'Instant' })
    expect(fake.sent[0]).toMatchObject({ model: 'Latest', power: 'Instant' })
  }, 40_000)

  it('fails before sending on an unknown preset, an unknown model, or a locked model (REQ-PRV-3)', async () => {
    const { fake, page, driver } = await site({ lockedModels: ['GPT-5.6 Sol'] })
    await expect(driver.ask(page, 'x', { conversation: 'temporary', mode: 'nope' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/unknown mode nope/) })
    await expect(driver.ask(page, 'x', { conversation: 'temporary', mode: 'missing' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/GPT-9.*Latest, GPT-6/) })
    await expect(driver.ask(page, 'x', { conversation: 'temporary', mode: 'locked' })).rejects.toMatchObject({ kind: 'config_error', message: expect.stringMatching(/locked/) })
    expect(fake.sent).toEqual([])
  }, 60_000)
})
