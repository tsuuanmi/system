import { type Browser, chromium, type Page } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { CHARTER } from '../../../board-core/conformance/board.ts'
import { APP_CSS, APP_JS, PAGE } from '../src/assets.ts'
import { testChrome } from '../../browser-patchright/tests/support.ts'
import { activeProject, readyTask } from '../../workflow/conformance/workflow.ts'
import { BEFORE_WORDS, inBrowser, noteWords, opened, overflow, sectionsWithoutHeading, shoot, wordsInSight } from './glance.ts'
import { boot, OPERATOR, reviewed } from './store-backed.ts'
import { descriptionOf } from './wording.ts'

// The page at a glance (T239, docs/design/web-ui.md), over the store-backed board, queue, and engine: the Board's first
// screen holds at most half the words it held before; every section has a heading; nothing scrolls sideways on a 360 px
// phone and every button there is within the screen; each button's effect is a tooltip a keyboard reaches. The words on
// Home, a run, and Workers are bounded in web-ui.spec.ts, over its fuller roster and queue.
vi.setConfig({ testTimeout: 180_000 })

/** A board with a task in review (its run done), a ready task, a task waiting for approval, and a project whose charter waits. */
async function busyBoard() {
  const booted = await boot()
  const { ctx } = booted
  await activeProject(ctx)
  const { run } = await reviewed(ctx, 'Fix the slow image build')
  await readyTask(ctx, 'Write the release notes', { template: 'solo' })
  await ctx.board.propose({ projectId: 'p1', title: 'Merge the login fix', goal: 'merge the branch', acceptance: [{ id: 'a1', statement: 'merged' }], actionClass: 'merge' })
  await ctx.board.sweep(new Date())
  await ctx.board.charter({ projectId: 'docs', title: 'Handbook rewrite', charter: CHARTER })
  const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
  return { ...booted, origin, pages: { home: '/ui/', board: '/ui/?view=board', run: `/ui/?run=${encodeURIComponent(run.runId)}`, workers: '/ui/?view=workers', policy: '/ui/?view=policy', help: '/ui/?view=help' } }
}

const launch = async (): Promise<Browser> => {
  const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
  onTestFinished(() => browser.close())
  return browser
}

/** A page at this width, signed in with the operator's token. */
async function at(browser: Browser, origin: string, width: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: width >= 1280 ? 800 : 740 } })
  const page = await context.newPage()
  await opened(page, `${origin}/ui/#token=${OPERATOR}`)
  return page
}

describe('web UI: one spacing scale, one type scale (T239)', () => {
  const declarations = (property: RegExp): string[] => [...APP_CSS.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/g)].filter(([, name]) => property.test(name!)).map(([, name, value]) => `${name}: ${value!.trim()}`)

  it('sizes text in three sizes only, each a token of the type scale', () => {
    expect(APP_CSS).toMatch(/--small: 12px; --body: 14px; --large: 18px;/)
    for (const d of declarations(/^font-size$/)) expect(d).toMatch(/^font-size: var\(--(small|body|large)\)$/)
    for (const d of declarations(/^font$/)) expect(d).toMatch(/^font: (inherit|var\(--(small|body|large)\)\/[\d.]+ .+)$/)
  })

  it('spaces margins, paddings, and gaps by the spacing scale only', () => {
    expect(APP_CSS).toMatch(/--s1: 4px; --s2: 8px; --s3: 16px; --s4: 24px;/)
    const spaced = declarations(/^(margin|padding|gap)(-(top|right|bottom|left))?$/)
    expect(spaced.length).toBeGreaterThan(50)
    for (const d of spaced) expect(d).toMatch(/^[a-z-]+: (0|auto|var\(--s[1-4]\))( (0|auto|var\(--s[1-4]\))){0,3}$/)
  })

  it('takes light and dark from the system\'s preference, and stills motion when reduced motion is asked', () => {
    expect(APP_CSS).toContain('color-scheme: light dark')
    expect(APP_CSS).toMatch(/@media \(prefers-color-scheme: dark\) \{ :root \{ --fg: /)
    expect(APP_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{ animation: none !important;/)
  })

  it('serves a script that parses, and loads nothing from another origin: no font, no CDN', () => {
    expect(() => new Function(APP_JS)).not.toThrow()
    for (const asset of [PAGE, APP_CSS, APP_JS]) {
      expect(asset).not.toMatch(/@import|@font-face|url\(\s*['"]?(https?:)?\/\//)
      expect(asset).not.toMatch(/<(script|link)[^>]+(src|href)="(https?:)?\/\//)
    }
  })
})

describe('web UI: clearer at a glance (T239)', () => {
  inBrowser('holds the Board\'s first screen at 1280×800 to at most half the words it held before T239; the Board and Reviews as the design note shows them', async () => {
    const { origin, pages } = await busyBoard()
    const browser = await launch()
    let words = 0
    for (const width of [1280, 360]) {
      const page = await at(browser, origin, width)
      await opened(page, origin + pages.board)
      if (width === 1280) noteWords('board', words = await wordsInSight(page))
      await shoot(page, `board-${width}`)
      await opened(page, origin + pages.home)
      await page.locator('#reviews').evaluate((section) => section.scrollIntoView({ block: 'start' }))
      await shoot(page, `reviews-${width}`)
      await page.context().close()
    }
    expect(words, `the Board's first screen: ${words} words, ${BEFORE_WORDS.board} before T239`).toBeLessThanOrEqual(Math.floor(BEFORE_WORDS.board / 2))
  })

  inBrowser('heads every section of every page, and on a 360 px phone scrolls no page sideways and keeps every button within the screen', async () => {
    const { origin, pages } = await busyBoard()
    const browser = await launch()
    for (const width of [1280, 360]) {
      const page = await at(browser, origin, width)
      for (const [name, path] of Object.entries(pages)) {
        if (name === 'help') {
          await page.goto(origin + path)
          await expect.poll(() => page.getByRole('heading', { name: 'How System works', exact: true }).count()).toBe(1)
        } else await opened(page, origin + path)
        expect(await sectionsWithoutHeading(page), `${name} at ${width}`).toEqual([])
        if (width !== 360) continue
        expect(await overflow(page), `${name} scrolls sideways at 360 px`).toBeLessThanOrEqual(0)
        // Every button in sight lies within the screen's width, so a thumb reaches it without scrolling sideways.
        const outside = await page.locator('main button:visible, header a:visible').evaluateAll((list) => list
          .map((b) => ({ name: b.getAttribute('aria-label') ?? b.textContent ?? '', box: b.getBoundingClientRect() }))
          .filter(({ box }) => box.left < 0 || box.right > innerWidth).map(({ name }) => name))
        expect(outside, `${name} at 360 px`).toEqual([])
      }
      await page.context().close()
    }
  })

  inBrowser('says what a button does as its tooltip, shown on keyboard focus and on hover, within the screen, hidden by Escape, and its accessible description all along', async () => {
    const { origin } = await busyBoard()
    const browser = await launch()
    for (const width of [1280, 360]) {
      const page = await at(browser, origin, width)
      const accept = page.getByRole('region', { name: 'Reviews' }).getByRole('button', { name: 'Accept', exact: true })
      await expect.poll(() => accept.count()).toBe(1)
      // Out of sight until asked for: no text beside the button.
      expect(await page.locator('.does.shown').count()).toBe(0)
      // By keyboard: Tab from the top of the page reaches Accept, and its tooltip shows what it does. While the focus is
      // in the page, the page does not refresh: the button and its tooltip stay the ones read here.
      await page.locator('main').focus()
      for (let i = 0; i < 200 && !(await accept.evaluate((b) => b === document.activeElement)); i++) await page.keyboard.press('Tab')
      expect(await accept.evaluate((b) => b === document.activeElement)).toBe(true)
      const tip = page.locator(`#${await accept.getAttribute('aria-describedby')}`)
      expect(await tip.getAttribute('role')).toBe('tooltip')
      await expect.poll(() => tip.isVisible()).toBe(true)
      expect(await tip.innerText()).toBe('marks it done')
      expect(await descriptionOf(accept)).toBe('marks it done')
      const box = (await tip.boundingBox())!
      expect(box.x, `width ${width}`).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, `width ${width}`).toBeLessThanOrEqual(width)
      expect(await overflow(page), `width ${width}`).toBeLessThanOrEqual(0)
      // Escape hides it; the next button's shows as the focus moves on.
      await page.keyboard.press('Escape')
      await expect.poll(() => tip.isVisible()).toBe(false)
      await page.keyboard.press('Tab')
      const back = page.getByRole('region', { name: 'Reviews' }).getByRole('button', { name: 'Send back', exact: true })
      expect(await back.evaluate((b) => b === document.activeElement)).toBe(true)
      const backTip = page.locator(`#${await back.getAttribute('aria-describedby')}`)
      await expect.poll(() => backTip.isVisible()).toBe(true)
      // By pointer: hovering shows it, leaving hides it (hovered again on each look: a refresh may replace the button).
      await page.locator('main h2.page').click()
      await expect.poll(async () => {
        await accept.hover()
        return page.locator('.does.shown').allInnerTexts()
      }).toEqual(['marks it done'])
      await page.mouse.move(0, 0)
      await expect.poll(() => page.locator('.does.shown').count()).toBe(0)
      await page.context().close()
    }
  })
})
