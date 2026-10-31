/**
 * The delete flow every website driver that deletes conversations runs against its fake site
 * (PROP-0004 Phase 5; docs/design/provider-turns.md#conversation-ledger): a bound conversation
 * deleted from its own menu, and gone when asked again; its menu inspected without choosing
 * anything; nothing clicked through a history row; a deletion that names another chat stopped at the
 * network; nothing deleted when a conversation does not open as itself. A driver's tests call
 * {@link deletionScenarios} inside their real-browser suite, with a harness over their own fake site.
 */
import { describe, expect, it } from 'vitest'
import type { ProviderDriver } from '../src/driver.ts'
import { ProviderError } from '../src/errors.ts'
import { scaled } from './time.ts'

/** Which scenario a site is opened for, so a harness can set its site and driver up as that one needs. */
export type DeletionScenario = 'delete' | 'inspect' | 'history-row' | 'network' | 'unopened'

/** What the scenarios read and set on the fake site. */
export interface DeletionFake {
  readonly deleted: ReadonlySet<string>
  readonly conversations: ReadonlyMap<string, unknown>
  readonly deleteRequests: readonly unknown[]
  /** Set, the site's delete dialog names this conversation instead of the one it was opened for. */
  options: { dialogTarget?: string }
}

export interface DeletionSite<Page> {
  page: Page
  /** Another page of the same browser context. */
  newPage(): Promise<Page>
  driver: Required<Pick<ProviderDriver<Page>, 'deleteConversation' | 'inspectConversation'>> & Pick<ProviderDriver<Page>, 'ask' | 'deletes'>
  fake: DeletionFake
}

export interface DeletionHarness<Page> {
  /** A fresh fake site and the driver under test; `paneMenu: false` leaves the menu button out of a conversation's own pane. */
  open(scenario: DeletionScenario, options: { answer?: string; paneMenu?: boolean }): Promise<DeletionSite<Page>>
  /** What the driver says it deletes the conversations of (`deletes`). */
  deletes: readonly string[]
  /** A conversation id of the site's form that the site has none of. */
  unknown: string
}

export function deletionScenarios<Page>(harness: DeletionHarness<Page>): void {
  describe('the delete flow (PROP-0004 Phase 5)', () => {
    it('deletes exactly one bound conversation from its own menu, and a deleted one counts as gone (PROP-0004 Phase 5)', async () => {
      const { page, newPage, driver, fake } = await harness.open('delete', { answer: 'to be deleted' })
      const kept = await driver.ask(page, 'keep me', { conversation: 'persistent' })
      const doomed = await driver.ask(await newPage(), 'delete me', { conversation: 'persistent' })
      expect(await driver.deleteConversation(await newPage(), doomed.binding!)).toBe('deleted')
      expect([...fake.deleted]).toEqual([doomed.binding])
      expect(fake.conversations.has(kept.binding!)).toBe(true)
      // Again, as a retry after a crash would: the site shows it is gone, and nothing is clicked.
      expect(await driver.deleteConversation(await newPage(), doomed.binding!)).toBe('gone')
      expect(driver.deletes).toEqual(harness.deletes)
    }, scaled(60_000))

    it('inspects a conversation\'s own menu without choosing anything: outlines, never text', async () => {
      const { page, driver, fake } = await harness.open('inspect', { answer: 'secret answer text' })
      const turn = await driver.ask(page, 'inspect me', { conversation: 'persistent' })
      const outlines = await driver.inspectConversation(page, turn.binding!)
      expect(outlines.map((o) => o.root)).toEqual(['conversation page (shown)', 'conversation menu'])
      expect(JSON.stringify(outlines)).not.toMatch(/secret answer text|inspect me/)
      expect(JSON.stringify(outlines[1])).toMatch(/"role":"menuitem"/)
      expect(fake.deleted.size).toBe(0)
      expect(fake.conversations.has(turn.binding!)).toBe(true)
    }, scaled(60_000))

    it('never deletes another chat through a history row: with no menu button in its own pane, nothing is clicked', async () => {
      const { page, newPage, driver, fake } = await harness.open('history-row', { answer: 'x', paneMenu: false })
      const other = await driver.ask(page, 'the operator\'s chat', { conversation: 'persistent' })
      const doomed = await driver.ask(await newPage(), 'delete me', { conversation: 'persistent' })
      await expect(driver.deleteConversation(await newPage(), doomed.binding!)).rejects.toMatchObject({ kind: 'ui_drift' })
      expect(fake.deleteRequests).toEqual([])
      expect(fake.conversations.has(other.binding!)).toBe(true)
      expect(fake.conversations.has(doomed.binding!)).toBe(true)
    }, scaled(60_000))

    it('stops a deletion that names another chat at the network, after its confirm is marked, and never clicks again once confirmed', async () => {
      const { page, newPage, driver, fake } = await harness.open('network', { answer: 'x' })
      const other = await driver.ask(page, 'the operator\'s chat', { conversation: 'persistent' })
      const doomed = await driver.ask(await newPage(), 'delete me', { conversation: 'persistent' })
      fake.options.dialogTarget = other.binding!
      let marked = 0
      await expect(driver.deleteConversation(await newPage(), doomed.binding!, { beforeConfirm: () => void marked++ })).rejects.toBeInstanceOf(ProviderError)
      expect(marked).toBe(1)
      expect(fake.deleteRequests).toEqual([])
      expect(fake.conversations.has(other.binding!)).toBe(true)
      // After a recorded confirm, only a check: it still opens, so it fails, and nothing is clicked.
      fake.options.dialogTarget = ''
      await expect(driver.deleteConversation(await newPage(), doomed.binding!, { confirmed: true })).rejects.toMatchObject({ kind: 'session_broken', message: expect.stringMatching(/not clicked again/) })
      expect(fake.deleteRequests).toEqual([])
    }, scaled(90_000))

    it('deletes nothing when the conversation does not open as itself', async () => {
      const { page, driver, fake } = await harness.open('unopened', {})
      await expect(driver.deleteConversation(page, harness.unknown)).rejects.toMatchObject({ kind: 'ui_drift', message: expect.stringMatching(/nothing was deleted/) })
      await expect(driver.deleteConversation(page, 'not-an-id')).rejects.toMatchObject({ kind: 'invalid_input' })
      expect(fake.deleted.size).toBe(0)
    }, scaled(60_000))
  })
}
