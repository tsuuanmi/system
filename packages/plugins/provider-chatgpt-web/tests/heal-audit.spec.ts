import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import Providers from '@tsuuanmi/system-providers'
import Store from '@tsuuanmi/system-store'
import type { Browser } from 'patchright-core'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { canRunBrowser, launchTestBrowser } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt } from '../fixtures/fake-chatgpt.ts'
import ChatGptWeb, { type ChatGptWebDriver } from '../src/index.ts'

describe.runIf(canRunBrowser)('self-heal is audited (INV-13) and persisted to the local overlay', () => {
  let browser: Browser
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ browser, close } = await launchTestBrowser())
  })
  afterAll(async () => close())

  async function boot(withAudit: boolean, sendTestId = '') {
    const fake = new FakeChatGpt({ sendLabel: 'Submit message', sendTestId, answer: 'healed' })
    await fake.start()
    const dir = mkdtempSync(join(tmpdir(), 'system-heal-'))
    const ctx = new Context()
    const fibers = [
      ...(withAudit ? [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {})] : []),
      ctx.plugin(Providers),
      ctx.plugin(ChatGptWeb, { origin: fake.origin, pageGapMs: 0, overlayPath: join(dir, 'ui', 'chatgpt-web.overlay.yaml') }),
    ]
    await Promise.all(fibers)
    const context = await browser.newContext()
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    onTestFinished(() => fake.stop())
    onTestFinished(async () => { for (const f of fibers.reverse()) await f.dispose() })
    onTestFinished(() => context.close())
    return { ctx, fake, dir, page: await context.newPage(), driver: ctx.providers.get('chatgpt-web') as ChatGptWebDriver }
  }

  it('records a recovery decision before the healed click, appends the overlay, and logs the heal', async () => {
    const { ctx, fake, dir, page, driver } = await boot(true)
    await driver.ask(page, 'drift', { conversation: 'temporary' })
    expect(fake.sent).toHaveLength(1)
    const decisions = ctx.artifacts.list({ kind: 'decision' }).map((a) => a.body as { decisionType: string; decider: { id: string }; outcome: { option: string; detail: { element: string } } })
    expect(decisions).toEqual([expect.objectContaining({ decisionType: 'recovery', decider: expect.objectContaining({ id: 'ui-ops.heal.deterministic' }), outcome: expect.objectContaining({ detail: expect.objectContaining({ element: 'composer.send' }) }) })])
    const overlay = join(dir, 'ui', 'chatgpt-web.overlay.yaml')
    // Mode and content are read through one descriptor, so they are of the same file.
    const fd = openSync(overlay, 'r')
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600)
      expect(readFileSync(fd, 'utf8')).toMatch(/composer\.send:[\s\S]*Submit message/)
    } finally {
      closeSync(fd)
    }
    expect(ctx.eventLog.query({ limit: 10 }).map((e) => e.type)).toContain('ui.heal')
  }, 60_000)

  it('logs a stale element as ui.drift, its region\'s outline kept as local-private evidence (drift evidence, INV-12)', async () => {
    const { ctx, page, driver } = await boot(true, 'send-button')
    await driver.ask(page, 'my private question', { conversation: 'temporary' })
    const [event] = ctx.eventLog.query({ type: 'ui.drift', limit: 10 })
    expect(event!.data).toMatchObject({ provider: 'chatgpt-web', element: 'composer.send', kind: 'fallback', candidate: 1, outline: expect.stringMatching(/^sha256:/) })
    const evidence = ctx.artifacts.get(String(event!.data!.outline))!
    expect(evidence).toMatchObject({ kind: 'evidence', bodySchema: 'ui-outline@1.0', classification: 'local-private', body: { root: 'parent of composer.send' } })
    expect(JSON.stringify(evidence.body)).not.toContain('private question')
  }, 60_000)

  it('does not heal without a decision store; the fallback key still sends', async () => {
    const { fake, page, driver } = await boot(false)
    const heals: unknown[] = []
    driver.onHeal = (e) => heals.push(e)
    await driver.ask(page, 'drift', { conversation: 'temporary' })
    expect(heals).toEqual([])
    expect(fake.sent).toHaveLength(1)
  }, 60_000)
})
