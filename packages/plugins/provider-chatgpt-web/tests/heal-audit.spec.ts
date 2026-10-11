import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import Providers from '@tsuuanmi/system-providers'
import Store from '@tsuuanmi/system-store'
import type { Browser } from 'patchright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
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
  const cleanups: Array<() => unknown> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!()
  })

  async function boot(withAudit: boolean) {
    const fake = new FakeChatGpt({ sendLabel: 'Submit message', answer: 'healed' })
    await fake.start()
    const dir = mkdtempSync(join(tmpdir(), 'system-heal-'))
    const ctx = new Context()
    const fibers = [
      ...(withAudit ? [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {})] : []),
      ctx.plugin(Providers),
      ctx.plugin(ChatGptWeb, { origin: fake.origin, overlayPath: join(dir, 'ui', 'chatgpt-web.overlay.yaml') }),
    ]
    await Promise.all(fibers)
    const context = await browser.newContext()
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => fake.stop(), async () => { for (const f of fibers.reverse()) await f.dispose() }, () => context.close())
    return { ctx, fake, dir, page: await context.newPage(), driver: ctx.providers.get('chatgpt-web') as ChatGptWebDriver }
  }

  it('records a recovery decision before the healed click, appends the overlay, and logs the heal', async () => {
    const { ctx, fake, dir, page, driver } = await boot(true)
    await driver.ask(page, 'drift', { conversation: 'temporary' })
    expect(fake.sent).toHaveLength(1)
    const decisions = ctx.artifacts.list({ kind: 'decision' }).map((a) => a.body as { decisionType: string; decider: { id: string }; outcome: { option: string; detail: { element: string } } })
    expect(decisions).toEqual([expect.objectContaining({ decisionType: 'recovery', decider: expect.objectContaining({ id: 'ui-ops.heal.deterministic' }), outcome: expect.objectContaining({ detail: expect.objectContaining({ element: 'composer.send' }) }) })])
    const overlay = join(dir, 'ui', 'chatgpt-web.overlay.yaml')
    expect(statSync(overlay).mode & 0o777).toBe(0o600)
    expect(readFileSync(overlay, 'utf8')).toMatch(/composer\.send:[\s\S]*Submit message/)
    expect(ctx.eventLog.query({ limit: 10 }).map((e) => e.type)).toContain('ui.heal')
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
