import { type Browser, chromium, type Page } from 'patchright-core'
import { describe, expect, onTestFinished, vi } from 'vitest'
import { headlessIt, headlessLaunchOptions } from '../../browser-patchright/tests/support.ts'
import { activeProject, readyTask } from '../../workflow/conformance/workflow.ts'
import { BEFORE_WORDS, noteWords, opened, overflow, sectionsWithoutHeading, shoot, wordsInSight } from './glance.ts'
import { boot, OPERATOR, reviewed } from './store-backed.ts'

// The operator's web UI across projects (T253, D88: each project has its own lead, and the operator sees every project in
// one UI), over the store-backed board, queue, and engine with two active projects: Home's "Needs your attention" grouped
// by project, the most urgent first, with a filter kept in the address and each project's reports one press away; the
// Board one project at a time, or every project's counts; Workers naming the project each step's run is for. With two
// projects, each first screen holds T239's word bound, and no page scrolls sideways on the operator's phone (T240).
vi.setConfig({ testTimeout: 180_000 })

/**
 * Two active projects: p2 with a review held for the operator and a merge waiting for approval, p1 with a merge waiting
 * for approval only, so p2 needs more and comes first though p1 sorts first by name; and a run of each on a Worker now.
 * With `calm`, a third, p3, is active with nothing waiting: its group, and its reports, stay on Home after the others.
 */
async function twoProjects(options: { calm?: boolean } = {}) {
  const booted = await boot()
  const { ctx, workers } = booted
  await activeProject(ctx, 'p1')
  await activeProject(ctx, 'p2')
  if (options.calm) await activeProject(ctx, 'p3')
  await reviewed(ctx, 'Fix the slow image build', 'p2')
  for (const [projectId, title] of [['p2', 'Merge the login fix'], ['p1', 'Merge the release branch']] as const) {
    await ctx.board.propose({ projectId, title, goal: 'merge the branch', acceptance: [{ id: 'a1', statement: 'merged' }], actionClass: 'merge' })
  }
  await ctx.board.sweep(new Date())
  const busy = [await readyTask(ctx, 'Research the hosting options', { projectId: 'p1' }), await readyTask(ctx, 'Outline the chapters', { projectId: 'p2' })]
  workers.reply = () => 'hold'
  for (const task of busy) {
    const run = await ctx.workflow.start({ template: 'solo', input: task.title, classification: 'public', task: { taskId: task.taskId } })
    await vi.waitFor(() => expect(ctx.workflow.get(run.runId)?.nodes[0]?.state).toBe('RUNNING'), { timeout: 10_000 })
  }
  const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
  return { ...booted, origin }
}

const launch = async (): Promise<Browser> => {
  const browser = await chromium.launch(headlessLaunchOptions())
  onTestFinished(() => browser.close())
  return browser
}

/** A page at this width (1280×800 as the word bound measures it), signed in with the operator's token. */
async function at(browser: Browser, origin: string, width = 1280): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: width >= 1280 ? 800 : 740 } })
  const page = await context.newPage()
  await opened(page, `${origin}/ui/#token=${OPERATOR}`)
  return page
}

/** The operator's iPhone 16 Pro, as layout.spec.ts emulates it: 402×874 at 3 device pixels, touch, its safe areas. */
async function phone(browser: Browser, origin: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await (await context.newCDPSession(page)).send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top: 62, bottom: 34, left: 0, right: 0 } } as never)
  await opened(page, `${origin}/ui/#token=${OPERATOR}`)
  return page
}

/** The groups in "Needs your attention", in order, by their headings; and the card groups below it, by their names. */
const attention = (page: Page) => page.getByRole('region', { name: 'Needs your attention', exact: true })
const groupHeads = (page: Page): Promise<string[]> => attention(page).locator('section.group > h4').allInnerTexts()
const cardGroups = (page: Page): Promise<Array<string | null>> => page.locator('main section.group[id^="group-"]').evaluateAll((list) => list.map((s) => s.getAttribute('aria-label')))
/** A project's reports page (T256), opened from its group's Reports link: each report's command, behind its copy button. */
async function reportCommands(page: Page, group: ReturnType<Page['getByRole']>, project: string): Promise<Array<string | null>> {
  await group.getByRole('link', { name: `Reports of ${project}` }).click()
  await expect.poll(() => page.locator('main h2.page').innerText()).toBe(`Reports · ${project}`)
  return page.locator('main table.reports button.copy').evaluateAll((list) => list.map((b) => b.getAttribute('data-copy')))
}

/** Unfold the Workers page's Workers, each account's (they are folded by default, T239). */
async function openWorkers(page: Page): Promise<void> {
  for (const fold of await page.locator('main details.workers-fold:not([open]) > summary').all()) await fold.click()
  await expect.poll(() => page.locator('main ul[aria-label="Doing now"] > li').count()).toBeGreaterThan(0)
}

describe('web UI: every project in one UI (T253)', () => {
  headlessIt('groups Home\'s "Needs your attention" and its cards by project, the most urgent first, each with its own counts and its reports, a project with nothing waiting too; the filter in the address', async () => {
    const { origin } = await twoProjects({ calm: true })
    const browser = await launch()
    const page = await at(browser, origin)
    // Each group headed by its project's name, its own counts as tiles; p2 needs more, so it leads.
    await expect.poll(() => groupHeads(page)).toEqual(['project p2', 'project p1'])
    const p2 = page.getByRole('region', { name: 'Needs you in project p2' })
    const p1 = page.getByRole('region', { name: 'Needs you in project p1' })
    expect(await p2.locator('ul.tiles > li > a:first-child').allInnerTexts()).toEqual(['Approvals · 1', 'Reviews · 1'])
    expect(await p1.locator('ul.tiles > li > a:first-child').allInnerTexts()).toEqual(['Approvals · 1'])
    // The cards in the same groups and order, each headed by its project's name: p2's approval and review, p1's approval;
    // then p3, which needs nothing (so it has no counts above), its group there all the same.
    expect(await cardGroups(page)).toEqual(['Project project p2', 'Project project p1', 'Project project p3'])
    const cards3 = page.getByRole('region', { name: 'Project project p3', exact: true })
    expect(await cards3.innerText()).toContain('Nothing needs you here.')
    expect(await cards3.getByRole('link', { name: 'Reports of project p3' }).getAttribute('href')).toBe('/ui/?view=reports&project=p3')
    const cards2 = page.getByRole('region', { name: 'Project project p2', exact: true })
    const cards1 = page.getByRole('region', { name: 'Project project p1', exact: true })
    expect(await cards2.getByRole('heading', { level: 2 }).innerText()).toBe('project p2')
    expect(await cards2.getByRole('article', { name: 'Allow a merge step: Merge the login fix' }).count()).toBe(1)
    expect(await cards2.getByRole('article', { name: 'Fix the slow image build' }).count()).toBe(1)
    expect(await cards1.getByRole('article', { name: 'Allow a merge step: Merge the release branch' }).count()).toBe(1)
    expect(await cards1.getByRole('article', { name: 'Fix the slow image build' }).count()).toBe(0)
    // A count leads to its kind's cards in its group.
    await p2.getByRole('link', { name: 'Reviews · 1' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('reviews-p-p2')
    expect(await sectionsWithoutHeading(page)).toEqual([])
    // Each project's weekly report and its metrics on a small page of their own (T256), one link from its group: the
    // commands that print them in a table, each with its copy button; Back returns to Home.
    expect(await reportCommands(page, cards2, 'project p2')).toEqual(['system report --project p2', 'system metrics --project p2'])
    expect(new URL(page.url()).search).toBe('?view=reports&project=p2')
    expect(await page.locator('main table.reports').innerText()).toContain('Weekly report')
    expect(await sectionsWithoutHeading(page)).toEqual([])
    await page.goBack()
    await expect.poll(() => groupHeads(page)).toEqual(['project p2', 'project p1'])
    expect((await reportCommands(page, cards1, 'project p1'))[0]).toBe('system report --project p1')
    await page.goBack()
    await expect.poll(() => groupHeads(page)).toEqual(['project p2', 'project p1'])

    // The filter: a project's name shows it alone, kept in the address through a reload; All projects shows every one again.
    await p1.getByRole('link', { name: 'Show only project p1' }).click()
    await expect.poll(() => groupHeads(page)).toEqual(['project p1'])
    expect(new URL(page.url()).search).toBe('?project=p1')
    expect(await cardGroups(page)).toEqual(['Project project p1'])
    expect(await page.locator('main').innerText()).not.toContain('Fix the slow image build')
    await page.reload()
    await expect.poll(() => groupHeads(page)).toEqual(['project p1'])
    expect(await cardGroups(page)).toEqual(['Project project p1'])
    await attention(page).getByRole('link', { name: 'All projects' }).click()
    await expect.poll(() => groupHeads(page)).toEqual(['project p2', 'project p1'])
    expect(new URL(page.url()).search).toBe('')
    // A link to one project's Home opens it filtered; Back returns to every project.
    await page.goto(`${origin}/ui/?project=p2`)
    await expect.poll(() => groupHeads(page)).toEqual(['project p2'])
    await page.goBack()
    await expect.poll(() => groupHeads(page)).toEqual(['project p2', 'project p1'])
    // A project with nothing waiting, filtered alone: its group says so, its reports still in it.
    await page.goto(`${origin}/ui/?project=p3`)
    await expect.poll(() => groupHeads(page)).toEqual(['project p3'])
    expect(await cardGroups(page)).toEqual(['Project project p3'])
    expect((await reportCommands(page, page.getByRole('region', { name: 'Project project p3', exact: true }), 'project p3'))[0]).toBe('system report --project p3')
  })

  headlessIt('shows the Board one project at a time with a switcher, and All projects as each project\'s counts only, the choice in the address', async () => {
    const { origin } = await twoProjects()
    const browser = await launch()
    const page = await at(browser, origin)
    await opened(page, `${origin}/ui/?view=board`)
    const region = (name: string) => page.getByRole('region', { name, exact: true })
    // Several projects: All projects first, each project's counts and what of it needs you; no task's card, no column.
    await expect.poll(() => region('All projects').count()).toBe(1)
    expect(await page.getByLabel('Show').inputValue()).toBe('all')
    expect(await region('Ready').count()).toBe(0)
    expect(await page.getByLabel('State of project p2').innerText()).toBe('Needs you 2 · Working 1 · Ready 0 · Proposed 0')
    expect(await page.getByLabel('State of project p1').innerText()).toBe('Needs you 1 · Working 1 · Ready 0 · Proposed 0')
    for (const title of ['Merge the login fix', 'Outline the chapters', 'Research the hosting options']) expect(await page.locator('main').innerText(), title).not.toContain(title)
    // A project's name opens its own board; the switcher says which, and the address keeps it through a reload.
    await region('All projects').getByRole('link', { name: 'project p2', exact: true }).click()
    await expect.poll(() => region('Working').innerText()).toContain('Outline the chapters')
    expect(new URL(page.url()).search).toBe('?view=board&project=p2')
    expect(await page.getByLabel('Show').inputValue()).toBe('p2')
    expect(await region('Needs your attention').innerText()).toContain('Merge the login fix')
    expect(await page.locator('main').innerText()).not.toContain('Research the hosting options')
    await page.reload()
    await expect.poll(() => region('Working').innerText()).toContain('Outline the chapters')
    await page.getByLabel('Show').selectOption('p1')
    await expect.poll(() => region('Working').innerText()).toContain('Research the hosting options')
    expect(new URL(page.url()).search).toBe('?view=board&project=p1')
    expect(await page.locator('main').innerText()).not.toContain('Outline the chapters')
    // Away to Workers and back by the navigation: the Board's address still names p1, so a reload shows p1's board.
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Workers' }).click()
    await expect.poll(() => page.getByRole('heading', { name: 'Workers', exact: true }).count()).toBe(1)
    await page.getByRole('navigation', { name: 'Pages' }).getByRole('link', { name: 'Board' }).click()
    await expect.poll(() => new URL(page.url()).search).toBe('?view=board&project=p1')
    await page.reload()
    await expect.poll(() => region('Working').innerText()).toContain('Research the hosting options')
    expect(await page.getByLabel('Show').inputValue()).toBe('p1')
    await page.getByLabel('Show').selectOption('all')
    await expect.poll(() => region('All projects').count()).toBe(1)
    expect(new URL(page.url()).search).toBe('?view=board&project=all')
    expect(await region('Ready').count()).toBe(0)
  })

  headlessIt('keeps the Workers page shared, naming for each Worker the project its current run is for', async () => {
    const { origin } = await twoProjects()
    const browser = await launch()
    const page = await at(browser, origin)
    await opened(page, `${origin}/ui/?view=workers`)
    await openWorkers(page)
    const doing = page.locator('main ul[aria-label="Doing now"] > li')
    await expect.poll(() => doing.count()).toBe(2)
    const lines = await doing.evaluateAll((list) => list.map((li) => [li.getAttribute('data-project'), li.querySelector('.tag.project')?.textContent ?? null, li.textContent ?? '']))
    expect(lines.map(([project, tag]) => [project, tag]).sort()).toEqual([['p1', 'project p1'], ['p2', 'project p2']])
    for (const [project, , text] of lines) expect(text).toContain(project === 'p1' ? 'Working on "Research the hosting options"' : 'Working on "Outline the chapters"')
  })

  headlessIt('holds Home, the Board, and Workers to T239\'s word bound at 1280×800 with two projects, and scrolls no page sideways on the phone at 402 px (T240); the screenshots', async () => {
    const { origin } = await twoProjects()
    const browser = await launch()
    const page = await at(browser, origin)
    const pages = { home: '/ui/', board: '/ui/?view=board', workers: '/ui/?view=workers' } as const
    for (const [name, path] of Object.entries(pages) as Array<[keyof typeof pages, string]>) {
      await opened(page, origin + path)
      const words = await wordsInSight(page)
      noteWords(name, words)
      if (name !== 'workers') await shoot(page, `portfolio-${name}-1280`)
      expect(words, `${name}'s first screen with two projects: ${words} words, ${BEFORE_WORDS[name]} before T239`).toBeLessThanOrEqual(Math.floor(BEFORE_WORDS[name] / 2))
      // Workers' screenshot with its Workers unfolded, so each running step's project is in it.
      if (name === 'workers') { await openWorkers(page); await shoot(page, `portfolio-${name}-1280`) }
    }
    // One project's board holds it too.
    await opened(page, `${origin}/ui/?view=board&project=p2`)
    expect(await wordsInSight(page), 'the board of project p2').toBeLessThanOrEqual(Math.floor(BEFORE_WORDS.board / 2))
    await page.context().close()
    const small = await phone(browser, origin)
    const shots: Record<string, string> = { '/ui/': 'portfolio-home-402', '/ui/?view=board': 'portfolio-board-402', '/ui/?view=workers': 'portfolio-workers-402' }
    for (const path of ['/ui/', '/ui/?project=p1', '/ui/?view=board', '/ui/?view=board&project=p2', '/ui/?view=workers']) {
      await opened(small, origin + path)
      expect(await overflow(small), `${path} scrolls sideways at 402 px`).toBeLessThanOrEqual(0)
      // What a finger presses is at least 44 by 44 px: each project's name that filters Home or opens its board too.
      const tiny = await small.locator('main button, main summary, main select, header nav a, main .actions > a, main .head > a, main ul.tiles a, main section.group > h4 > a, main .portfolio h3 > a')
        .evaluateAll((list) => list.filter((t) => t.checkVisibility()).map((t) => ({ name: (t.getAttribute('aria-label') ?? t.textContent ?? '').trim().slice(0, 40), box: t.getBoundingClientRect() }))
          .filter(({ box }) => box.width < 44 || box.height < 44).map(({ name, box }) => `${name} ${Math.round(box.width)}×${Math.round(box.height)}`))
      expect(tiny, path).toEqual([])
      if (path === '/ui/?view=workers') {
        await openWorkers(small)
        expect(await overflow(small), 'Workers unfolded scroll sideways at 402 px').toBeLessThanOrEqual(0)
        // On the phone the working Worker is below the first screen: its screenshot shows its steps, each naming its project.
        await small.locator('main ul[aria-label="Doing now"]').first().evaluate((list) => list.scrollIntoView({ block: 'center' }))
      }
      if (shots[path]) await shoot(small, shots[path])
    }
  })
})
