import { chromium } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { activeProject, readyTask } from '../../workflow/conformance/workflow.ts'
import { boot, OPERATOR, reviewed } from './store-backed.ts'

// Help for an operator who is not a developer (T126): how System works, in plain words, a glossary,
// a "?" beside each such word that opens its sentence in place by keyboard or touch, and empty
// states that say what would appear and how it gets there.
vi.setConfig({ testTimeout: 120_000 })

const GLOSSARY = ['worker', 'account', 'role', 'tier', 'kind', 'quota', 'window', 'resting', 'project', 'task', 'run', 'step', 'attempt', 'review', 'checks', 'landing', 'merge', 'branch', 'approval', 'action-class', 'batch', 'policy', 'mode', 'always-ask', 'policy-change', 'quarantine', 'stalled', 'held', 'derived']

describe('web UI: help in plain words (T126)', () => {
  it.runIf(canRunBrowser)('has Help in the navigation: how System works, with links into the real pages, and a glossary whose entries are anchors a link focuses; it shows without a token too', async () => {
    const booted = await boot()
    const origin = `http://127.0.0.1:${(booted.ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    const nav = page.getByRole('navigation', { name: 'Pages' })
    await nav.getByRole('link', { name: 'Help' }).click()
    await expect.poll(() => page.getByRole('heading', { name: 'How System works', exact: true }).count()).toBe(1)
    expect(new URL(page.url()).search).toBe('?view=help')
    expect(await nav.getByRole('link', { name: 'Help' }).getAttribute('aria-current')).toBe('page')
    await expect.poll(() => page.title()).toMatch(/^(\(\d+\) )?system — How System works$/)
    for (const section of ['Who does the work', 'How a task goes from idea to merged', 'What waits for you, and why', 'What runs without asking', 'When something is stuck', 'Words used here']) {
      expect(await page.getByRole('region', { name: section }).count(), section).toBe(1)
    }
    const flow = await page.getByRole('region', { name: 'How a task goes from idea to merged' }).innerText()
    for (const stage of ['Proposed.', 'Ready.', 'Start.', 'Working.', 'Review.', 'You accept,', 'Merge request.', 'You approve,']) expect(flow, stage).toContain(stage)
    // Every glossary word is an entry with its own anchor, and a word in the text links to it and focuses it.
    for (const key of GLOSSARY) expect(await page.locator(`dt#term-${key}`).count(), key).toBe(1)
    await page.getByRole('region', { name: 'Who does the work' }).getByRole('link', { name: 'quota' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('term-quota')
    expect(new URL(page.url()).hash).toBe('#term-quota')
    // Its links reach the real pages.
    await page.getByRole('region', { name: 'Who does the work' }).locator('a[href="/ui/?view=workers"]').click()
    await expect.poll(() => page.getByRole('heading', { name: 'Workers', exact: true }).count()).toBe(1)
    // A link straight to an entry focuses it; Help needs no token.
    const bare = await browser.newPage()
    await bare.goto(`${origin}/ui/?view=help#term-resting`)
    await expect.poll(() => bare.evaluate(() => document.activeElement?.id)).toBe('term-resting')
  }, 60_000)

  it.runIf(canRunBrowser)('puts a "?" beside each such word that opens its plain sentence in place by keyboard, and links to its entry in Help; every "?" names what it explains and controls a note that exists (T126)', async () => {
    const booted = await boot()
    const { ctx } = booted
    await activeProject(ctx)
    await reviewed(ctx, 'Fix the slow image build')
    await readyTask(ctx, 'Write the release notes', { template: 'solo' })
    const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    const reviews = page.getByRole('region', { name: 'Reviews' })
    const why = reviews.getByRole('button', { name: 'What is review?' })
    await expect.poll(() => why.count()).toBe(1)
    const note = page.locator(`#${await why.getAttribute('aria-controls')}`)
    expect(await why.getAttribute('aria-expanded')).toBe('false')
    expect(await note.isVisible()).toBe(false)
    // By keyboard: focus it, Enter opens the sentence in place, Enter again closes it.
    await why.focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => why.getAttribute('aria-expanded')).toBe('true')
    expect(await note.innerText()).toContain('A review is a finished task\'s result waiting for you')
    await page.keyboard.press('Enter')
    await expect.poll(() => note.isVisible()).toBe(false)
    // Every "?" on the page names what it explains and controls a note that is there.
    for (const page_ of ['/ui/', '/ui/?view=board', '/ui/?view=policy']) {
      await page.goto(origin + page_)
      await expect.poll(() => page.locator('#status').innerText(), { message: page_ }).toContain('updated')
      const buttons = page.locator('button.why')
      expect(await buttons.count(), page_).toBeGreaterThan(0)
      for (const button of await buttons.all()) {
        expect(await button.getAttribute('aria-label'), page_).toMatch(/^What is .+\?$/)
        expect(await page.locator(`#${await button.getAttribute('aria-controls')}`).count(), page_).toBe(1)
      }
    }
    // Its "more in Help" link opens the entry in Help, focused.
    await page.goto(`${origin}/ui/?view=policy`)
    const mode = page.getByRole('button', { name: 'What is mode?' })
    await expect.poll(() => mode.count()).toBe(1)
    await mode.click()
    await page.locator(`#${await mode.getAttribute('aria-controls')}`).getByRole('link', { name: 'more in Help' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('term-mode')
  }, 60_000)

  it.runIf(canRunBrowser)('says in every empty state what would appear there and how it gets there (T126)', async () => {
    const booted = await boot()
    const origin = `http://127.0.0.1:${(booted.ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    await expect.poll(() => page.locator('main').innerText()).toContain('No review waits. When a Worker finishes a task, its result waits here for you to accept it or send it back.')
    const home = await page.locator('main').innerText()
    for (const said of ['Nothing waits for you now. A request, a review, or a run that needs you appears here as it comes.', 'No request waits for your verdict. When a run, the board, or a Worker needs your yes or no',
      'No run yet. A run appears here once one starts: when you press Start on a ready task on the Board']) expect(home, said).toContain(said)
    await page.goto(`${origin}/ui/?view=board`)
    await expect.poll(() => page.locator('main').innerText()).toContain('No project is on the board yet. A project appears here when the lead proposes its charter, and starts once you approve it on Home.')
    await activeProject(booted.ctx)
    await page.goto(`${origin}/ui/?view=board`)
    const column = (name: string) => page.getByRole('region', { name, exact: true })
    await expect.poll(() => column('Ready').innerText()).toContain('None ready. A proposed task becomes ready once what it depends on is done and the policy allows it.')
    expect(await column('Working').innerText()).toContain('A ready task moves here when you press Start, or the lead starts it.')
    expect(await column('Review').innerText()).toContain('A task moves here when its run finishes, for you to accept or send back.')
  }, 60_000)
})
