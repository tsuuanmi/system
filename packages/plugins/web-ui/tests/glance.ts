/**
 * The page at a glance (T239, docs/design/web-ui.md): what the operator sees on the first screen, measured in a real
 * browser, and the screenshots the design note shows.
 */
import { mkdirSync } from 'node:fs'
import type { Page } from 'patchright-core'

/**
 * The words on each page's first screen (1280×800) before T239, recorded once: the UI of commit 3b535c30 (its script and
 * styles served in place of today's) over the same fixtures, at the same fixed clock, as the bound's tests. Home, a run
 * waiting on its plan, and Workers are web-ui.spec.ts's (the queue's three requests, the roster's accounts and quota);
 * the Board is layout.spec.ts's store-backed composition. T239 holds each page to at most half of its number.
 */
export const BEFORE_WORDS = { home: 169, run: 98, workers: 146, board: 167 } as const

/** Open a page of the UI and wait until it is read whole once (the header says when it was updated). */
export async function opened(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.waitForFunction(() => /updated/.test(document.getElementById('status')?.textContent ?? '') && !document.querySelector('main .loading'), undefined, { timeout: 30_000 })
}

/**
 * The words in sight on the first screen: each word of a rendered text node whose box meets the viewport. A word
 * is a run of non-space characters that holds a letter or a digit ("·", "—", and "?" alone are not words).
 */
export const wordsInSight = (page: Page): Promise<number> => page.evaluate(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let count = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement
    if (!parent || !parent.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue
    const text = node.textContent ?? ''
    for (const match of text.matchAll(/\S*[\p{L}\p{N}]\S*/gu)) {
      range.setStart(node, match.index)
      range.setEnd(node, match.index + match[0].length)
      const box = range.getBoundingClientRect()
      if (box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth) count++
    }
  }
  return count
})

/** The sections of the page with no heading of their own (each section of main is named by one, T239). */
export const sectionsWithoutHeading = (page: Page): Promise<string[]> => page.locator('main section').evaluateAll((sections) =>
  sections.filter((s) => !s.querySelector('h2, h3, h4')).map((s) => s.getAttribute('aria-label') ?? s.id ?? s.outerHTML.slice(0, 80)))

/** How far the page is wider than the screen: 0 when nothing scrolls sideways. */
export const overflow = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)

/**
 * The design note's screenshots (docs/design/web-ui-screenshots/): written only when SYSTEM_UI_SHOTS names a directory (the note's own
 * to update them), so a test run never changes the repository by itself. The first screen only, one pixel per CSS pixel.
 */
export async function shoot(page: Page, name: string): Promise<void> {
  const dir = process.env['SYSTEM_UI_SHOTS']
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: `${dir.replace(/\/?$/, '/')}${name}.png`, scale: 'css' })
}

/** The words measured on a page's first screen, said on the test's output when SYSTEM_UI_SHOTS is set (the design note's table). */
export function noteWords(name: keyof typeof BEFORE_WORDS, words: number): void {
  if (process.env['SYSTEM_UI_SHOTS']) process.stdout.write(`first screen at 1280×800: ${name} ${words} words (before T239: ${BEFORE_WORDS[name]})\n`)
}
