import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import Providers from '@tsuuanmi/system-providers'
import { ProviderError } from '@tsuuanmi/system-provider-core'
import { loadUiMap } from '@tsuuanmi/system-ui-ops'
import type { Browser, BrowserContext, Page } from 'patchright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../fixtures/fake-chatgpt.ts'
import ChatGptWebPlugin, { ChatGptWebDriver, type DriverTimeouts, shippedMap } from '../src/index.ts'

describe('the shipped ChatGPT UI map', () => {
  it('validates, and Send is irreversible with deterministic healing only', () => {
    const map = shippedMap()
    expect(map.provider).toBe('chatgpt-web')
    expect(map.actions['composer.send']).toMatchObject({ sideEffect: 'irreversible', heal: 'deterministic' })
  })

  it('accepts a local overlay', () => {
    const map = shippedMap('elements:\n  composer.send:\n    candidates:\n      - { testId: composer-submit }\n')
    expect(map.elements['composer.send']!.candidates.at(-1)).toMatchObject({ testId: 'composer-submit', source: 'overlay' })
  })
})

describe.runIf(canRunBrowser)('ChatGptWebDriver against the fake site, with no real account (QA-10)', () => {
  let browser: Browser
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close())

  const cleanups: Array<() => Promise<unknown>> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  async function site(all: FakeOptions & { timeouts?: DriverTimeouts } = {}): Promise<{ fake: FakeChatGpt; page: Page; context: BrowserContext; driver: ChatGptWebDriver }> {
    const { timeouts, ...options } = all
    const fake = new FakeChatGpt(options)
    await fake.start()
    const context = await browser.newContext()
    cleanups.push(() => fake.stop(), () => context.close())
    const page = await context.newPage()
    const driver = new ChatGptWebDriver({
      origin: fake.origin, timeouts: { turnMs: 20_000, stallMs: 10_000, stableMs: 400, pollMs: 100, researchStartMs: 3000, ...timeouts },
      modes: { instant: { model: 'Latest', effort: 'Instant' }, deep: { model: 'GPT-6', effort: 'High' }, locked: { model: 'GPT-5.6 Sol', effort: 'Medium' }, missing: { model: 'GPT-9' } },
      defaultMode: 'instant',
    })
    return { fake, page, context, driver }
  }

  it('reports signed-in and signed-out with positive evidence', async () => {
    const a = await site()
    expect(await a.driver.checkAuth(a.page)).toBe('signed-in')
    const b = await site({ signedIn: false })
    expect(await b.driver.checkAuth(b.page)).toBe('signed-out')
  }, 30_000)

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

  it('asks on an account without a model picker (ChatGPT Free) with an empty preset, assuming no mode', async () => {
    const { fake, page } = await site({ answer: 'free answer', modelPicker: false })
    const sitePreset = new ChatGptWebDriver({ origin: fake.origin, modes: { site: {} }, defaultMode: 'site', timeouts: { stableMs: 200 } })
    expect(await sitePreset.ask(page, 'hello', { conversation: 'temporary' })).toMatchObject({ text: 'free answer', mode: {} })
    expect(fake.sent).toEqual([expect.objectContaining({ prompt: 'hello', mode: 'chat', temporary: true })])
  }, 60_000)

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
    // The live Copy drops the fence's language too; the lines are what matter.
    expect((await driver.ask(page, 'Write add', { conversation: 'temporary' })).text).toBe('Here it is:\n```\ndef add(a, b):\n    return a + b\n```\nDone.')
  }, 40_000)

  it('keeps runs of spaces in the answer (indentation in a tool call\'s arguments)', async () => {
    const answer = '<call tool="Edit">{"new_string": "def add(a, b):\\n    return a + b"}</call>'
    const { page, driver } = await site({ answer })
    expect((await driver.ask(page, 'Fix add', { conversation: 'temporary' })).text).toBe(answer)
  }, 40_000)

  it('keeps a persistent conversation id and continues the same conversation', async () => {
    const { fake, page, driver } = await site({ answer: 'first answer' })
    const first = await driver.ask(page, 'one', { conversation: 'persistent' })
    expect(first.text).toBe('first answer')
    expect(first.binding).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.sent[0]).toMatchObject({ mode: 'chat', temporary: false })

    fake.options.answer = 'second answer'
    const boundaries: Array<string | null> = []
    const second = await driver.ask(page, 'two', { conversation: 'persistent', binding: first.binding, beforeSend: ({ previousResponse }) => { boundaries.push(previousResponse) } })
    expect(boundaries).toEqual(['first answer'])
    expect(second.text).toBe('second answer')
    expect(second.binding).toBe(first.binding)
    expect(fake.sent[1]).toMatchObject({ conversationId: first.binding })
  }, 60_000)

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

  it('runs Deep research from the + tools in a persistent conversation, with the prompt free of the tool chip (REQ-PRV-6)', async () => {
    const report = 'A detailed report <a href="https://src.example/a">[1]</a> with <a href="https://src.example/b">sources</a> <a href="https://src.example/a">[1]</a>.'
    const { fake, page, driver } = await site({ report })
    const turn = await driver.ask(page, 'Survey the DSH plugin catalog', { conversation: 'persistent', feature: 'deep-research' })
    // Not the acknowledgement: the report from the research frame, with its citation links kept.
    expect(turn.text).toBe('Research findings\nA detailed report [1] with sources [1].\n\nSources:\n- [1] https://src.example/a\n- sources https://src.example/b')
    expect(turn.binding).toMatch(/^[0-9a-f-]{36}$/)
    expect(fake.sent[0]).toMatchObject({ prompt: 'Survey the DSH plugin catalog', deepResearch: true, mode: 'chat', temporary: false })
    await expect(driver.ask(page, 'x', { conversation: 'temporary', feature: 'deep-research' })).rejects.toMatchObject({ kind: 'invalid_input' })
  }, 60_000)

  it('reports the conversation binding as soon as the URL shows it, before the answer is complete', async () => {
    const { page, driver } = await site({ answer: 'late answer', thinkMs: 1500 })
    const order: string[] = []
    const turn = await driver.ask(page, 'bind early', { conversation: 'persistent', onBinding: (id) => { order.push(`bound ${id}`) } })
    order.push('answered')
    expect(order).toEqual([`bound ${turn.binding}`, 'answered'])
  }, 40_000)

  it('snapshots a bound conversation: the last answer and whether it is still running', async () => {
    const { page, driver, context } = await site({ answer: 'kept answer' })
    const turn = await driver.ask(page, 'remember me', { conversation: 'persistent' })
    const other = await context.newPage()
    expect(await driver.snapshot(other, turn.binding!)).toEqual({ text: 'kept answer', running: false, observable: true, lastPrompt: expect.stringContaining('remember me') })
  }, 40_000)

  it('returns Deep research\'s clarifying question when no research starts', async () => {
    const { page, driver } = await site({ clarify: true })
    const turn = await driver.ask(page, 'Research something vague', { conversation: 'persistent', feature: 'deep-research' })
    expect(turn.text).toBe('Which aspect should the research focus on?')
  }, 60_000)

  it('snapshots a Deep research conversation: running until the report is complete', async () => {
    const { page, driver, context, fake } = await site({ researchMs: 4000, report: 'Final report.' })
    let binding = ''
    const asking = driver.ask(page, 'long research', { conversation: 'persistent', feature: 'deep-research', onBinding: (id) => { binding = id } })
    await expect.poll(() => fake.conversations.size, { timeout: 15_000 }).toBe(1)
    await expect.poll(() => [...fake.conversations.values()][0]?.researches.length, { timeout: 15_000 }).toBe(1)
    const other = await context.newPage()
    await expect.poll(() => binding, { timeout: 15_000 }).not.toBe('')
    expect(await driver.snapshot(other, binding, { feature: 'deep-research' })).toMatchObject({ running: true, observable: true, lastPrompt: expect.stringContaining('long research') })
    await asking
    expect(await driver.snapshot(other, binding, { feature: 'deep-research' })).toMatchObject({ text: 'Research findings\nFinal report.', running: false, observable: true })
  }, 90_000)

  it('reads only the run after the last prompt when a session holds several Deep research runs', async () => {
    const { fake, page, driver } = await site({ researchMs: 1500, report: 'First report.' })
    const first = await driver.ask(page, 'first research', { conversation: 'persistent', feature: 'deep-research' })
    expect(first.text).toBe('Research findings\nFirst report.')
    fake.options.report = 'Second report.'
    const second = await driver.ask(page, 'second research', { conversation: 'persistent', binding: first.binding, feature: 'deep-research' })
    expect(second.text).toBe('Research findings\nSecond report.')
  }, 120_000)

  it('reports a conversation that shows no turn as not observed, never as nothing new (live 2026-10-12)', async () => {
    const { page, driver } = await site({ timeouts: { snapshotMs: 1500 } })
    // A bound URL whose page never renders a user turn: no evidence either way.
    expect(await driver.snapshot(page, '00000000-0000-4000-8000-000000000000')).toEqual({ text: '', running: false, observable: false })
  }, 60_000)

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

  it('fails closed as reauth_required when signed out', async () => {
    const { fake, page, driver } = await site({ signedIn: false })
    await expect(driver.ask(page, 'x', { conversation: 'temporary' })).rejects.toMatchObject({ kind: 'reauth_required' })
    expect(fake.sent).toEqual([])
  }, 30_000)
})

it('ships a map that loads with the generic loader too', () => {
  const text = readFileSync(new URL('../ui/chatgpt-web.ui.yaml', import.meta.url), 'utf8')
  expect(loadUiMap(text).hash).toMatch(/^sha256:/)
})

describe.runIf(canRunBrowser)('the driver as a provider plugin', () => {
  let browser: Browser
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close())

  it('exposes login support: login URL, state origins, and a hashed-only identity hint', async () => {
    const fake = new FakeChatGpt({ userId: 'user-abc' })
    await fake.start()
    const context = await browser.newContext()
    try {
      const driver = new ChatGptWebDriver({ origin: fake.origin })
      expect(driver.loginUrl).toBe(`${fake.origin}/auth/login`)
      expect(driver.stateOrigins).toEqual([fake.origin])
      const page = await context.newPage()
      expect(await driver.checkAuth(page)).toBe('signed-in')
      expect(await driver.identity(page)).toBe('chatgpt-web:user-abc')
    } finally {
      await context.close()
      await fake.stop()
    }
  }, 30_000)

  it('registers itself on ctx.providers', async () => {
    const ctx = new Context()
    await ctx.plugin(Providers)
    await ctx.plugin(ChatGptWebPlugin, { origin: 'http://127.0.0.1:9' })
    expect(ctx.providers.get('chatgpt-web')).toBeInstanceOf(ChatGptWebDriver)
  })
})

describe('Markdown from the clipboard is kept only when it is the rendered answer (REQ-PRV-5)', () => {
  it('matches Markdown to its rendering, and refuses another answer', async () => {
    const { sameWords } = await import('../src/driver.ts')
    expect(sameWords('A **bold** claim with `code`, and [a source](https://src.example/a).', 'A bold claim with code, and a source.')).toBe(true)
    expect(sameWords('```ts\nconst x = 1\n```\n- one\n- two', 'ts\nCopy code\nconst x = 1\none\ntwo')).toBe(true)
    expect(sameWords('Another account\'s answer.', 'A bold claim with code, and a source.')).toBe(false)
    expect(sameWords('', 'anything')).toBe(false)
  })
})

