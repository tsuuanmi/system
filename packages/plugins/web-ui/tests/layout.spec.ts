import { type Browser, chromium, type Page } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { CHARTER } from '../../../board-core/conformance/board.ts'
import { APP_CSS, APP_JS, PAGE } from '../src/assets.ts'
import { headlessIt, headlessLaunchOptions } from '../../browser-patchright/tests/support.ts'
import { activeProject, readyTask } from '../../workflow/conformance/workflow.ts'
import { BEFORE_WORDS, noteWords, opened, overflow, sectionsWithoutHeading, shoot, wordsInSight } from './glance.ts'
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
  const browser = await chromium.launch(headlessLaunchOptions())
  onTestFinished(() => browser.close())
  return browser
}

/** A page at this width, signed in with the operator's token. */
async function at(browser: Browser, origin: string, width: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: width === 1920 ? 1080 : width >= 1280 ? 800 : 740 } })
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

  it('spaces margins, paddings, and gaps by the spacing scale only, or by a safe-area token made of it (T240)', () => {
    expect(APP_CSS).toMatch(/--s1: 4px; --s2: 8px; --s3: 16px; --s4: 24px;/)
    // A safe-area token is a step of the scale, or the screen's own inset where that is larger (T240).
    for (const side of ['top', 'right', 'bottom', 'left']) expect(APP_CSS).toMatch(new RegExp(`--safe-${side}: max\\(var\\(--s[1-4]\\), env\\(safe-area-inset-${side}\\)\\);`))
    expect(APP_CSS).toContain('--safe-bar: max(var(--s2), env(safe-area-inset-bottom)); --bar-room: calc(var(--s4) * 4 + env(safe-area-inset-bottom));')
    const spaced = declarations(/^(margin|padding|gap)(-(top|right|bottom|left))?$/)
    expect(spaced.length).toBeGreaterThan(50)
    const step = '(0|auto|var\\(--s[1-4]\\)|var\\(--safe-(top|right|bottom|left|bar)\\)|var\\(--bar-room\\))'
    for (const d of spaced) expect(d).toMatch(new RegExp(`^[a-z-]+: ${step}( ${step}){0,3}$`))
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
  headlessIt('holds the Board\'s first screen at 1280×800 to at most half the words it held before T239; the Board and Reviews as the design note shows them', async () => {
    const { origin, pages } = await busyBoard()
    const browser = await launch()
    let words = 0
    // At 1920 px too, for the design note's screenshots of the full-width grid (T256); the words are counted at 1280×800.
    for (const width of [1920, 1280, 360]) {
      const page = await at(browser, origin, width)
      await opened(page, origin + pages.board)
      if (width === 1280) noteWords('board', words = await wordsInSight(page))
      await shoot(page, `board-${width}`)
      await opened(page, origin + pages.home)
      await page.locator('main section[aria-label="Reviews"]').first().evaluate((section) => section.scrollIntoView({ block: 'start' }))
      await shoot(page, `reviews-${width}`)
      await page.context().close()
    }
    expect(words, `the Board's first screen: ${words} words, ${BEFORE_WORDS.board} before T239`).toBeLessThanOrEqual(Math.floor(BEFORE_WORDS.board / 2))
  })

  headlessIt('heads every section of every page, and on a 360 px phone scrolls no page sideways and keeps every button within the screen', async () => {
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

  headlessIt('says what a button does as its tooltip, shown on keyboard focus and on hover, within the screen, hidden by Escape, and its accessible description all along', async () => {
    const { origin } = await busyBoard()
    const browser = await launch()
    for (const width of [1280, 360]) {
      const page = await at(browser, origin, width)
      const accept = page.getByRole('region', { name: 'Reviews' }).getByRole('button', { name: 'Accept', exact: true })
      await expect.poll(() => accept.count()).toBe(1)
      // Out of sight until asked for: no text beside the button; where a pointer hovers, no "?" for a row's buttons (T240).
      expect(await page.locator('.does.shown').count()).toBe(0)
      expect(await page.locator('button.tips:visible').count()).toBe(0)
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

describe('web UI: the operator\'s iPhone 16 Pro (T240)', () => {
  it('lets Safari lay the page under the Dynamic Island and the home indicator, and follows the phone\'s light or dark', () => {
    expect(PAGE).toContain('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">')
    expect(PAGE).toContain('<meta name="color-scheme" content="light dark">')
    // Text on a touch screen is 16 px, so Safari never zooms into a field it focuses; the scale keeps its three sizes.
    expect(APP_CSS).toMatch(/@media \(pointer: coarse\) \{\s*:root \{ --small: 13px; --body: 16px; --large: 20px; \}/)
  })

  headlessIt('on the phone at 402 and 360 px: no page scrolls sideways, every target is at least 44 by 44 px, no field is under 16 px, the sticky header clears the Dynamic Island, and a table below 600 px is a list of cards', async () => {
    const { origin, pages } = await busyBoard()
    const browser = await launch()
    for (const width of [402, 360]) {
      const page = await phone(browser, origin, width)
      for (const [name, path] of Object.entries(pages)) {
        if (name === 'help') {
          await page.goto(origin + path)
          await expect.poll(() => page.getByRole('heading', { name: 'How System works', exact: true }).count()).toBe(1)
        } else await opened(page, origin + path)
        const where = `${name} at ${width}`
        expect(await overflow(page), where).toBeLessThanOrEqual(0)
        // What a finger presses: each button, fold, field, navigation link, and action link in sight (a link inside a sentence is not one).
        const small = await page.locator('main button, main summary, main select, main input, main textarea, header nav a, main .actions > a, main .head > a, main ul.tiles a')
          .evaluateAll((list) => list.filter((t) => t.checkVisibility()).map((t) => ({ name: (t.getAttribute('aria-label') ?? t.textContent ?? '').trim().slice(0, 40), box: t.getBoundingClientRect() }))
            .filter(({ box }) => box.width < 44 || box.height < 44).map(({ name, box }) => `${name} ${Math.round(box.width)}×${Math.round(box.height)}`))
        expect(small, where).toEqual([])
        const fields = await page.locator('main input, main select, main textarea').evaluateAll((list) => list.filter((f) => f.checkVisibility()).map((f) => [f.getAttribute('aria-label') ?? f.id, parseFloat(getComputedStyle(f).fontSize)] as const))
        for (const [field, size] of fields) expect(size, `${where}: ${field}`).toBeGreaterThanOrEqual(16)
        // The header stays at the top, below the Dynamic Island's 62 px.
        const header = await page.locator('header').evaluate((h) => ({ position: getComputedStyle(h).position, top: parseFloat(getComputedStyle(h).paddingTop) }))
        expect(header, where).toEqual({ position: 'sticky', top: 62 })
      }
      // The policy's tables, a card per row, each cell named by its column.
      await opened(page, origin + pages.policy)
      const table = page.locator('main table').first()
      expect(await table.locator('thead').evaluate((h) => h.getBoundingClientRect().height)).toBeLessThanOrEqual(1)
      const row = table.locator('tbody > tr').first()
      expect(await row.evaluate((r) => getComputedStyle(r).display)).toBe('block')
      expect(await row.locator('td').first().getAttribute('data-label')).toBe('Action type')
      if (width === 402) {
        await opened(page, origin + pages.board)
        await shoot(page, 'board-402')
        await opened(page, origin + pages.home)
        await page.locator('main section[aria-label="Reviews"]').first().evaluate((section) => section.scrollIntoView({ block: 'start' }))
        await shoot(page, 'reviews-402')
      }
      await page.context().close()
    }
  })

  headlessIt('opens a row\'s tooltips on a tap of its "?", where nothing hovers, and closes them on a second tap, a tap outside, or Escape; a word\'s "?" the same', async () => {
    const { origin } = await busyBoard()
    const browser = await launch()
    const page = await phone(browser, origin)
    const card = page.getByRole('region', { name: 'Reviews' }).getByRole('article').first()
    const toggle = card.getByRole('button', { name: 'What these buttons do' })
    await expect.poll(() => toggle.count()).toBe(1)
    const tips = card.locator(':scope > .actions > .does')
    expect(await tips.evaluateAll((list) => list.map((t) => t.checkVisibility()))).toEqual([false, false])
    // A tap opens them under the buttons, each after its button's label.
    await toggle.tap()
    expect(await toggle.getAttribute('aria-expanded')).toBe('true')
    expect(await tips.evaluateAll((list) => list.map((t) => t.checkVisibility()))).toEqual([true, true])
    expect(await tips.evaluateAll((list) => list.map((t) => [t.getAttribute('data-for'), t.textContent]))).toEqual([['Accept', 'marks it done'], ['Send back', 'sends it back for another attempt, if it has one left']])
    // Under the row of buttons, never between them.
    const [accept, back] = await card.locator(':scope > .actions > button:not(.tips)').evaluateAll((list) => list.map((b) => b.getBoundingClientRect().bottom))
    for (const top of await tips.evaluateAll((list) => list.map((t) => t.getBoundingClientRect().top))) expect(top).toBeGreaterThanOrEqual(Math.max(accept!, back!))
    // A second tap, a tap outside, or Escape closes them.
    await toggle.tap()
    expect(await tips.evaluateAll((list) => list.map((t) => t.checkVisibility()))).toEqual([false, false])
    await toggle.tap()
    await page.locator('main h2.page').tap()
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    expect(await tips.evaluateAll((list) => list.map((t) => t.checkVisibility()))).toEqual([false, false])
    await toggle.tap()
    await page.keyboard.press('Escape')
    expect(await toggle.getAttribute('aria-expanded')).toBe('false')
    // A word's "?" opens its sentence on a tap, and a tap outside closes it.
    const why = page.getByRole('region', { name: 'Reviews' }).getByRole('button', { name: 'What is review?' })
    const note = page.locator(`#${await why.getAttribute('aria-controls')}`)
    await why.tap()
    expect(await note.isVisible()).toBe(true)
    await page.locator('main h2.page').tap()
    expect(await note.isVisible()).toBe(false)
    await page.context().close()
  })
})

describe('web UI: polish after T256 (T274)', () => {
  headlessIt('at 1920 px: Home\'s middle column also holds the starts awaiting approval, the "Since you last looked" notes are one quiet line, the run page has its Summary in the right column, and the All projects cards are compact', async () => {
    const { origin, pages } = await busyBoard()
    const browser = await launch()
    const page = await at(browser, origin, 1920)
    // (1) The second look: no italic explanation line, at most one quiet line for what could not be read.
    await opened(page, origin + pages.home)
    await opened(page, origin + pages.home)
    const since = page.getByRole('region', { name: 'Since you last looked' })
    await expect.poll(() => since.count()).toBe(1)
    expect(await since.locator('p.unknown').count()).toBe(0)
    expect(await since.locator('p.unread').count()).toBeLessThanOrEqual(1)
    // (2) Three columns side by side from the top; the starts awaiting approval are not in the last one.
    const boxes = await page.evaluate(() => Object.fromEntries(['.col-main', '.col-more', '.col-side'].map((s) => { const b = document.querySelector(`.page-grid.three > ${s}`)!.getBoundingClientRect(); return [s, { left: b.left, right: b.right, top: b.top }] })))
    expect(boxes['.col-main']!.right).toBeLessThanOrEqual(boxes['.col-more']!.left)
    expect(boxes['.col-more']!.right).toBeLessThanOrEqual(boxes['.col-side']!.left)
    expect(Math.round(boxes['.col-more']!.top)).toBe(Math.round(boxes['.col-main']!.top))
    expect(await page.locator('.page-grid.three > .col-side [aria-label="Starts awaiting approval"]').count()).toBe(0)
    await shoot(page, 'home-1920')
    // (3) The run page: its Summary beside the steps, not below them.
    await opened(page, origin + pages.run)
    const summary = page.getByRole('region', { name: 'Summary' })
    await expect.poll(() => summary.count()).toBe(1)
    const side = (await summary.boundingBox())!
    const steps = (await page.getByRole('region', { name: 'Steps' }).boundingBox())!
    expect(side.x).toBeGreaterThanOrEqual(steps.x + steps.width)
    await shoot(page, 'run-1920')
    // (4) All projects: each card at most 420 px wide, the two side by side.
    await opened(page, origin + pages.board)
    const cards = await page.locator('.portfolio .projects > .panel').evaluateAll((list) => list.map((c) => { const b = c.getBoundingClientRect(); return { width: b.width, top: Math.round(b.top) } }))
    expect(cards.length).toBeGreaterThanOrEqual(2)
    for (const c of cards) expect(c.width).toBeLessThanOrEqual(420)
    expect(new Set(cards.map((c) => c.top)).size, 'one row').toBe(1)
    // (5) Wide, the navigation still reads "Autonomy policy".
    expect(await page.locator('#policy-link').innerText()).toBe('Autonomy policy')
    await page.context().close()
  })

  headlessIt('at 402 px: the navigation names Policy like the other pages, and no "?" leaves the line of its word', async () => {
    const { origin, pages } = await busyBoard()
    const browser = await launch()
    const page = await phone(browser, origin, 402)
    await opened(page, origin + pages.home)
    // (5) Capitalised, as Home, Board, Workers, and Help are.
    expect(await page.locator('#policy-link').innerText()).toBe('Policy')
    for (const id of ['home-link', 'board-link', 'workers-link', 'policy-link', 'help-link']) expect(await page.locator(`#${id}`).innerText()).toMatch(/^[A-Z]/)
    // (6) Each word's "?" lies on the line of the character before it; a "?" with nothing before it fails the check.
    let seen = 0
    for (const path of [pages.workers, pages.home, pages.board]) {
      await opened(page, origin + path)
      const found = await page.locator('main button.why').evaluateAll((list) => list.filter((b) => b.checkVisibility()).map((b) => {
        const before = b.parentElement!.previousSibling
        const text = before && (before.nodeType === Node.TEXT_NODE ? before : before.lastChild ?? before)
        if (!text || !text.textContent) return { name: b.getAttribute('aria-label') ?? '', stray: true }
        const range = document.createRange()
        range.selectNodeContents(text)
        const rects = range.getClientRects()
        const last = rects[rects.length - 1]
        const middle = b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2
        return { name: b.getAttribute('aria-label') ?? '', stray: !last || middle < last.top || middle > last.bottom }
      }))
      seen += found.length
      expect(found.filter((f) => f.stray).map((f) => f.name), `${path}: a "?" on a line of its own`).toEqual([])
      expect(await overflow(page), path).toBeLessThanOrEqual(0)
    }
    expect(seen, 'some "?" in sight on these pages').toBeGreaterThan(0)
    // (1, 2) Home at 402: one column in order (the grid is one track), the quiet line not italic, nothing sideways.
    await opened(page, origin + pages.home)
    await opened(page, origin + pages.home)
    const since = page.getByRole('region', { name: 'Since you last looked' })
    await expect.poll(() => since.count()).toBe(1)
    expect(await since.locator('p.unknown').count()).toBe(0)
    expect(await since.locator('p.unread').count()).toBeLessThanOrEqual(1)
    expect(await page.locator('main .page-grid').first().evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length)).toBe(1)
    // (.col-side is display: contents below 1600 px: it has no box of its own, its panels are the grid's items.)
    const cols = await page.evaluate(() => ['.col-main', '.col-more'].map((s) => { const b = document.querySelector(`.page-grid.three > ${s}`)!.getBoundingClientRect(); return { left: Math.round(b.left), top: b.top } }))
    expect(new Set(cols.map((c) => c.left)).size, 'Home\'s columns stacked at 402 px').toBe(1)
    expect(cols[1]!.top, 'the middle column under the first').toBeGreaterThan(cols[0]!.top)
    expect(await overflow(page), 'home').toBeLessThanOrEqual(0)
    // (3) The run page at 402: its steps in sight, the Summary (a 1600 px addition) hidden, nothing sideways.
    await opened(page, origin + pages.run)
    await expect.poll(() => page.getByRole('region', { name: 'Steps' }).count()).toBe(1)
    expect(await page.locator('.panel.summary').evaluate((s) => getComputedStyle(s).display)).toBe('none')
    expect(await page.getByRole('region', { name: 'Summary' }).count()).toBe(0)
    expect(await overflow(page), 'run').toBeLessThanOrEqual(0)
    // (4) All projects at 402: the cards one under another, each within the screen.
    await opened(page, origin + pages.board)
    const cards = await page.locator('.portfolio .projects > .panel').evaluateAll((list) => list.map((c) => { const b = c.getBoundingClientRect(); return { left: Math.round(b.left), right: b.right, width: b.width } }))
    expect(cards.length).toBeGreaterThanOrEqual(2)
    for (const c of cards) { expect(c.right).toBeLessThanOrEqual(402); expect(c.width).toBeLessThanOrEqual(420) }
    expect(new Set(cards.map((c) => c.left)).size, 'one column').toBe(1)
    await shoot(page, 'workers-402')
    await page.context().close()
  })
})

/**
 * A page as the operator's iPhone 16 Pro shows it in Safari: 402×874 CSS px at 3 device pixels each, touch (nothing hovers,
 * a finger points), and its safe areas, 62 px under the Dynamic Island and 34 px above the home indicator.
 */
async function phone(browser: Browser, origin: string, width = 402): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await (await context.newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top: 62, bottom: 34, left: 0, right: 0 } } as never)
  await opened(page, `${origin}/ui/#token=${OPERATOR}`)
  return page
}
