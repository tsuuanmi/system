import { chromium } from 'patchright-core'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { canRunBrowser, testChrome } from '../../browser-patchright/tests/support.ts'
import { activeProject, readyTask } from '../../workflow/conformance/workflow.ts'
import { boot, OPERATOR, reviewed } from './store-backed.ts'

// Help for an operator who is not a developer (T126): how System works, in plain words, a glossary,
// a "?" beside each such word that opens its sentence in place by keyboard or touch, and empty
// states that say what would appear and how it gets there.
vi.setConfig({ testTimeout: 120_000 })

const GLOSSARY = ['worker', 'account', 'role', 'tier', 'kind', 'quota', 'window', 'resting', 'project', 'task', 'run', 'step', 'attempt', 'review', 'checks', 'landing', 'merge', 'branch', 'approval', 'action-class', 'batch', 'policy', 'mode', 'always-ask', 'policy-change', 'quarantine', 'stalled', 'held', 'derived', 'team', 'carry', 'resend', 'stale']

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
    for (const section of ['Workers', 'Task lifecycle', 'Your decisions', 'Autonomy', 'Troubleshooting', 'Glossary']) {
      expect(await page.getByRole('region', { name: section, exact: true }).count(), section).toBe(1)
    }
    // The lifecycle as a compact flow of states, each state's details (Start, accepting or sending back, the merge approval) folded under it (T171).
    const lifecycle = page.getByRole('region', { name: 'Task lifecycle', exact: true })
    const flow = await lifecycle.innerText()
    for (const stage of ['Proposed', 'Ready', 'Working', 'Review', 'Accepted', 'Merged']) expect(flow, stage).toContain(stage)
    expect(flow).not.toContain('You press Start on its card')
    const folded = await lifecycle.textContent()
    for (const said of ['Start: you press Start on its card', 'You accept it, or send it back for another', 'the system asks you to approve its merge', 'Nothing is pushed anywhere.']) expect(folded, said).toContain(said)
    await lifecycle.getByText('Ready', { exact: true }).click()
    expect(await lifecycle.innerText()).toContain('Start: you press Start on its card')
    // Troubleshooting: each symptom folded until chosen.
    const stuck = page.getByRole('region', { name: 'Troubleshooting', exact: true })
    for (const symptom of ['Run failed', 'Task retried', 'Run stalled', 'Nothing starts', 'Account unavailable', 'Task needs input']) expect(await stuck.innerText(), symptom).toContain(symptom)
    expect(await stuck.innerText()).not.toContain('Retry failed step')
    expect(await stuck.textContent()).toContain('Retry failed step runs the failed step again; completed steps are kept.')
    // Every glossary word is an entry with its own anchor, its definition folded; a word in the text links to it, opens it, and focuses it.
    for (const key of GLOSSARY) expect(await page.locator(`dt#term-${key}`).count(), key).toBe(1)
    expect(await page.locator('dd#def-quota').isVisible()).toBe(false)
    await page.getByRole('region', { name: 'Workers', exact: true }).getByRole('link', { name: 'quota' }).click()
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('term-quota')
    expect(new URL(page.url()).hash).toBe('#term-quota')
    expect(await page.locator('dd#def-quota').innerText()).toContain('Quota is how much an account may use')
    expect(await page.locator('dt#term-quota button').getAttribute('aria-expanded')).toBe('true')
    // The glossary is searchable: a search keeps the terms whose word or sentence holds it.
    const search = page.getByRole('searchbox', { name: 'Search terms' })
    await search.fill('quarantined')
    expect(await page.locator('dt#term-quarantine').isVisible()).toBe(true)
    expect(await page.locator('dt#term-batch').isVisible()).toBe(false)
    await search.fill('no such word anywhere')
    expect(await page.getByText('No term matches.').isVisible()).toBe(true)
    await search.fill('')
    expect(await page.locator('dt#term-batch').isVisible()).toBe(true)
    // A term's button opens and closes its definition.
    await page.locator('dt#term-batch button').click()
    expect(await page.locator('dd#def-batch').innerText()).toContain('A batch is a group of related requests')
    await page.locator('dt#term-batch button').click()
    expect(await page.locator('dd#def-batch').isVisible()).toBe(false)
    // Its links reach the real pages.
    await page.getByRole('region', { name: 'Workers', exact: true }).locator('a[href="/ui/?view=workers"]').click()
    await expect.poll(() => page.getByRole('heading', { name: 'Workers', exact: true }).count()).toBe(1)
    // A link straight to an entry opens and focuses it; Help needs no token.
    const bare = await browser.newPage()
    await bare.goto(`${origin}/ui/?view=help#term-resting`)
    await expect.poll(() => bare.evaluate(() => document.activeElement?.id)).toBe('term-resting')
    expect(await bare.locator('dd#def-resting').isVisible()).toBe(true)
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

  it.runIf(canRunBrowser)('says every empty state in one short line, with a link where there is a next step, and keeps how things get there in Help (T126, T171)', async () => {
    const booted = await boot()
    const origin = `http://127.0.0.1:${(booted.ctx as unknown as { webServer: { port: number } }).webServer.port}`
    const browser = await chromium.launch({ executablePath: testChrome!, headless: true })
    onTestFinished(() => browser.close())
    const page = await browser.newPage()
    await page.goto(`${origin}/ui/#token=${OPERATOR}`)
    // The reviews' empty state is the review card's own (T160 changes it); Home's others are one line each.
    await expect.poll(() => page.locator('main').innerText()).toContain('No review waits. When a Worker finishes a task, its result waits here for you to accept it or send it back.')
    const home = await page.locator('main').innerText()
    for (const said of ['You’re all caught up.', 'No approvals needed.', 'No runs yet · Open Board']) expect(home, said).toContain(said)
    for (const gone of ['A request, a review, or a run that needs you appears here', 'When a run, the board, or a Worker needs your yes or no', 'A run appears here once one starts']) expect(home, gone).not.toContain(gone)
    await page.goto(`${origin}/ui/?view=board`)
    await expect.poll(() => page.locator('main').innerText()).toContain('No projects yet · How projects start')
    await activeProject(booted.ctx)
    await page.goto(`${origin}/ui/?view=board`)
    const column = (name: string) => page.getByRole('region', { name, exact: true })
    await expect.poll(() => column('Ready').innerText()).toContain('No ready tasks')
    expect(await column('Proposed').innerText()).toContain('No proposed tasks')
    expect(await column('Working').innerText()).toContain('No active tasks')
    expect(await column('Review').innerText()).toContain('No reviews')
    expect(await column('Needs your attention').innerText()).toContain('Nothing needs you')
    // How a task moves between them is Help's Task lifecycle, folded under each state there.
    await page.goto(`${origin}/ui/?view=help`)
    const lifecycle = page.getByRole('region', { name: 'Task lifecycle', exact: true })
    await expect.poll(() => lifecycle.count()).toBe(1)
    for (const said of ['A project shows on the Board once the lead proposes its charter, and starts once you approve it on Home.', 'Once what it depends on is done and the autonomy policy allows it, it is ready.',
      'you press Start on its card on the Board, or the lead starts it']) expect(await lifecycle.textContent(), said).toContain(said)
  }, 60_000)
})
