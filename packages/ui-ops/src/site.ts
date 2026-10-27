/** What the website drivers (ChatGPT, Gemini) share: their map, their deletion's map entries, their idle wait, and the conversation inspection. */
import { readFileSync } from 'node:fs'
import type { Page } from 'patchright-core'
import type { UiEngine } from './engine.ts'
import { loadUiMap, unverifiedEntries, type UiMap } from './map.ts'
import { outlineOf, type UiOutline } from './outline.ts'

/** The map entries a conversation's deletion depends on: each must be checked on the live site before anything is deleted. */
const DELETION_ENTRIES = ['conversation.pane', 'conversation.options', 'conversation.delete', 'conversation.delete-dialog', 'conversation.delete-confirm', 'conversation.missing', 'conversation.open-options', 'conversation.choose-delete', 'conversation.confirm-delete']

/** How long a page may take to settle (its Stop control gone) before it counts as busy and is not kept. */
const PAGE_IDLE_WAIT_MS = 3000

/** A driver's shipped map file, with an optional local overlay merged after it. */
export const shippedMapOf = (file: URL, overlay?: string): UiMap => loadUiMap(readFileSync(file, 'utf8'), overlay)

/** The deletion's map entries of `map` not yet checked on the live site: while any is, nothing is deleted. */
export const deletionUnverified = (map: UiMap): string[] => unverifiedEntries(map, DELETION_ENTRIES)

/** Nothing generating, no dialog or menu open; the Stop control may linger after an answer, so this waits briefly first. */
export const pageIdle = (engine: UiEngine): Promise<boolean> => engine.waitFor({ state: 'page.idle' }, PAGE_IDLE_WAIT_MS).then(() => true, () => false)

/** Outline a conversation page (`shown` is how it opened) and its own menu, choosing nothing; the menu is closed with Escape. */
export async function inspectConversationMenu(page: Page, engine: UiEngine, shown: string): Promise<UiOutline[]> {
  const outlines = [await outlineOf(page, `conversation page (${shown})`)]
  if (shown !== 'shown') return outlines
  const opened = await engine.act('conversation.open-options').then(() => true, () => false)
  outlines.push(await outlineOf(page, opened ? 'conversation menu' : 'conversation menu (not opened)'))
  await page.keyboard.press('Escape')
  return outlines
}
