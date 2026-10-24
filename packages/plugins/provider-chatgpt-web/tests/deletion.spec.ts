import type { Page } from 'patchright-core'
import { describe } from 'vitest'
import { canRunBrowser } from '../../browser-patchright/tests/support.ts'
import { deletionScenarios } from '../../../provider-core/conformance/deletion.ts'
import { fakeSite } from './site.ts'

describe.runIf(canRunBrowser)('ChatGptWebDriver against the fake site, with no real account (QA-10): deleting a conversation', () => {
  const { site } = fakeSite()

  // The delete flow every website driver shares (provider-core's conformance/deletion.ts), on this site.
  deletionScenarios<Page>({
    open: async (scenario, options) => {
      // Where the driver must give up looking, it looks for less long.
      const timeouts = scenario === 'history-row' || scenario === 'network' ? { snapshotMs: 3000 } : scenario === 'unopened' ? { snapshotMs: 1500 } : undefined
      const opened = await site({ ...options, ...(timeouts ? { timeouts } : {}) })
      return { ...opened, newPage: () => opened.context.newPage() }
    },
    deletes: ['chat', 'web-search'],
    unknown: '00000000-0000-4000-8000-000000000000',
  })
})
