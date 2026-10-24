import { ProviderError } from '@tsuuanmi/system-provider-core'
import type { Page } from 'patchright-core'
import { describe, expect, it } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { deletionScenarios } from '../../../provider-core/conformance/deletion.ts'
import { namesOnly } from '../src/driver.ts'
import { fakeSite, TIMEOUTS } from './site.ts'

describe.runIf(canRunBrowser)('GeminiWebDriver against the fake site: deleting a conversation', { timeout: 60_000 }, () => {
  const { open } = fakeSite()

  // The delete flow every website driver shares (provider-core's conformance/deletion.ts), on this site.
  deletionScenarios<Page>({
    open: async (scenario, options) => {
      // Where the driver must give up looking, it looks for less long: a conversation that does not
      // open, a page that never leaves a deletion stopped at the network, a menu with no button.
      const snapshotMs = scenario === 'unopened' ? 1500 : scenario === 'history-row' || scenario === 'network' ? 3000 : undefined
      const opened = await open(options, snapshotMs ? { timeouts: { ...TIMEOUTS, snapshotMs } } : {})
      return { ...opened, newPage: () => opened.context.newPage() }
    },
    deletes: ['chat'],
    // An unknown chat goes to /unavailable, which shows no prompt and no sign of a deletion.
    unknown: 'ffffffffffffffff',
  })

  it('stops a deletion request that names another chat even when a second call in it names this one (guard bypass)', async () => {
    // The page never leaves a deletion stopped at the network: the wait for it runs out (3 s here).
    const { page, driver, fake, context } = await open({ answer: 'x' }, { timeouts: { ...TIMEOUTS, snapshotMs: 3000 } })
    const other = await driver.ask(page, 'the operator\'s chat', { conversation: 'persistent' })
    const doomed = await driver.ask(await context.newPage(), 'delete me', { conversation: 'persistent' })
    fake.options.dialogTarget = other.binding!
    fake.options.dialogExtraCall = true
    await expect(driver.deleteConversation(await context.newPage(), doomed.binding!)).rejects.toBeInstanceOf(ProviderError)
    expect(fake.deleteRequests).toEqual([])
    expect(fake.conversations.has(other.binding!)).toBe(true)
    // The check itself: every conversation id any call carries must be the bound one.
    const body = (calls: unknown[]) => `f.req=${encodeURIComponent(JSON.stringify([calls]))}&at=x`
    expect(namesOnly(body([['GzXR5e', JSON.stringify(['c_aaaaaaaaaaaaaaaa']), null, 'generic']]), 'aaaaaaaaaaaaaaaa')).toBe(true)
    expect(namesOnly(body([['GzXR5e', JSON.stringify(['c_bbbbbbbbbbbbbbbb']), null, 'generic'], ['MaZiqc', JSON.stringify(['c_aaaaaaaaaaaaaaaa']), null, 'generic']]), 'aaaaaaaaaaaaaaaa')).toBe(false)
    expect(namesOnly(body([['ESY5D', '[]', null, 'generic']]), 'aaaaaaaaaaaaaaaa')).toBe(true)
    expect(namesOnly('f.req=%7Bnot json', 'aaaaaaaaaaaaaaaa')).toBe(false)
    // A body with no calls to read is refused, whatever it carries: unreadable is never "names nothing".
    expect(namesOnly('', 'aaaaaaaaaaaaaaaa')).toBe(false)
    expect(namesOnly('{"conversation":"c_bbbbbbbbbbbbbbbb"}', 'aaaaaaaaaaaaaaaa')).toBe(false)
    expect(namesOnly('at=x', 'aaaaaaaaaaaaaaaa')).toBe(false)
  })
})
