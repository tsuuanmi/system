import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { type Browser, chromium, type Page } from 'patchright-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { headlessIt, headlessLaunchOptions } from '../../browser-patchright/tests/support.ts'
import * as WebUi from '../src/index.ts'
import { builtClient } from './client-build.ts'
import { opened, overflow, shoot } from './glance.ts'

// The operator's web UI, round 2 (T256, docs/design/web-ui.md): full width on a responsive grid, each step's run time and
// completion, a run's total and timeline, one line per decision, and what dispatch started by itself as a table at the
// bottom of Home, one row per task. Every instant below is fixed; the page's clock stands at NOW (Date and timers faked).

const NOW = '2026-10-24T09:30:00.000Z'
const at = (hhmm: string): string => `2026-10-24T${hhmm}:00.000Z`
const hash = (c: string): string => `sha256:${c.repeat(64)}`

/** A run of three steps: develop ran from 09:00 to 09:14, review runs since 09:20, test waits for them. */
const TIMED = {
  runId: 'run_timed', template: 'relay', status: 'running', specHash: hash('f'), createdAt: at('09:00'), updatedAt: at('09:20'),
  nodes: [
    { nodeId: 'develop:1', state: 'COMPLETED', minTier: 'standard', attempt: 1, worker: 'worker:a/standard', tier: 'standard' },
    { nodeId: 'review:1', state: 'RUNNING', minTier: 'standard', attempt: 1, worker: 'worker:b/standard' },
    { nodeId: 'test:1', state: 'WAITING', minTier: 'economy', attempt: 0 },
  ],
}
/** A run that ended: develop from 08:00 to 08:10, then it failed at review at 08:25. */
const ENDED = {
  runId: 'run_ended', template: 'relay', status: 'failed', specHash: hash('e'), createdAt: at('08:00'), updatedAt: at('08:25'),
  nodes: [
    { nodeId: 'develop:1', state: 'COMPLETED', minTier: 'standard', attempt: 1, worker: 'worker:a/standard', tier: 'standard' },
    { nodeId: 'review:1', state: 'FAILED', minTier: 'standard', attempt: 1, worker: 'worker:b/standard', error: { kind: 'timeout', disposition: 'NONE', message: 'scripted timeout' } },
  ],
  error: { kind: 'timeout', disposition: 'NONE', message: 'scripted timeout' },
}
/** When each step started and ended, as the event log records it. */
const EVENTS = [
  { seq: 1, at: at('08:00'), type: 'workflow.node.started', runId: 'run_ended', nodeId: 'develop:1' },
  { seq: 2, at: at('08:10'), type: 'workflow.node.completed', runId: 'run_ended', nodeId: 'develop:1' },
  { seq: 3, at: at('08:11'), type: 'workflow.node.started', runId: 'run_ended', nodeId: 'review:1' },
  { seq: 4, at: at('08:25'), type: 'workflow.node.failed', runId: 'run_ended', nodeId: 'review:1' },
  { seq: 5, at: at('09:00'), type: 'workflow.node.started', runId: 'run_timed', nodeId: 'develop:1' },
  { seq: 6, at: at('09:14'), type: 'workflow.node.completed', runId: 'run_timed', nodeId: 'develop:1' },
  { seq: 7, at: at('09:20'), type: 'workflow.node.started', runId: 'run_timed', nodeId: 'review:1' },
]
/** How develop was decided: its route, then a tool call its Worker stopped at, waited on, and continued once approved. */
const DECISIONS = [
  { id: hash('1'), type: 'route', outcome: 'worker:a/standard', reasons: ['proves reason'], at: at('09:00') },
  { id: hash('2'), type: 'recovery', outcome: 'wait', reasons: ['its Worker\'s tool gate deferred a call to the operator on approval request apr-9 and stopped there; the step waits for the verdict'], at: at('09:05') },
  { id: hash('3'), type: 'recovery', outcome: 'continue', reasons: ['the operator approved request apr-9 (command: git status), the exact call execution x deferred on; the session continues once'], at: at('09:07') },
]
const CREATED = new Map(DECISIONS.map((d) => [d.id, d.at]))

/** Seven tasks dispatch started by itself, the newest first; task-a twice (its attempt 2 is run_timed). */
const STARTED = [
  { askId: 'ask-a2', taskId: 'task-a', title: 'Write the release notes', projectId: 'p1', attempt: 2, worker: 'worker:b/standard', runId: 'run_timed', runStatus: 'running', mode: 'ask', why: 'free', startedAt: at('09:00') },
  { askId: 'ask-a1', taskId: 'task-a', title: 'Write the release notes', projectId: 'p1', attempt: 1, worker: 'worker:a/standard', runId: 'run_ended', runStatus: 'failed', mode: 'auto', why: 'free', startedAt: at('08:00') },
  ...['b', 'c', 'd', 'e', 'f', 'g'].map((c, i) => ({ askId: `ask-${c}`, taskId: `task-${c}`, title: `Task ${c.toUpperCase()}`, projectId: 'p1', attempt: 1, worker: 'worker:a/standard', runId: `run_${c}`, runStatus: 'completed', mode: 'auto', why: 'free', startedAt: at(`07:${String(50 - i).padStart(2, '0')}`) })),
]

class StubWorkflow extends Service {
  constructor(ctx: Context) {
    super(ctx, 'workflow')
  }
  usage(limit = 50, filter: { status?: readonly string[]; changedSince?: string } = {}) {
    return [TIMED, ENDED].filter((r) => (filter.status === undefined || filter.status.includes(r.status)) && (filter.changedSince === undefined || r.updatedAt > filter.changedSince)).slice(0, limit)
  }
  get(id: string) { return [TIMED, ENDED].find((r) => r.runId === id) }
  explain(id: string) {
    const run = this.get(id)
    return run ? { runId: id, nodes: run.nodes.map((n) => ({ nodeId: n.nodeId, state: n.state, decisions: id === 'run_timed' && n.nodeId === 'develop:1' ? DECISIONS.map(({ at: _at, ...d }) => d) : [] })) } : undefined
  }
  landing() { return undefined }
  async teamExclusion() { return { entries: [], workers: [] } }
  dispatchStatus() {
    return { enabled: true, settings: { maxOpenAsks: 4, maxRunningPerAccount: 1 }, pausedProjects: [], asks: [], bounds: {}, started: STARTED }
  }
}

/** The event log, read newest first (contract 1.1); `fail` makes every read throw. */
class StubEventLog extends Service {
  fail = false
  constructor(ctx: Context) {
    super(ctx, 'eventLog')
  }
  query(filter: { type?: string; runId?: string; nodeId?: string; order: 'desc'; limit: number }) {
    if (this.fail) throw new Error('the log is locked')
    return EVENTS.filter((e) => (!filter.type || e.type === filter.type) && (!filter.runId || e.runId === filter.runId) && (!filter.nodeId || e.nodeId === filter.nodeId))
      .sort((a, b) => b.seq - a.seq).slice(0, filter.limit)
  }
}

/** The artifact store, as far as the page reads it: when each decision was made, and a run's assessments (none). */
class StubArtifacts extends Service {
  constructor(ctx: Context) {
    super(ctx, 'artifacts')
  }
  get(id: string) { return CREATED.has(id) ? { id, createdAt: CREATED.get(id) } : undefined }
  list() { return [] }
}

async function boot(options: { eventLog?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-ui-round2-'))
  writeFileSync(join(dir, 'operator.token'), Buffer.alloc(32, 7), { mode: 0o600 })
  const token = Buffer.alloc(32, 7).toString('base64url')
  const ctx = new Context()
  const fibers = [ctx.plugin(StubWorkflow), ...(options.eventLog === false ? [] : [ctx.plugin(StubEventLog)]), ctx.plugin(StubArtifacts),
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }), ctx.plugin(WebUi, { tokenDir: dir, clientDir: builtClient() })]
  await Promise.all(fibers)
  onTestFinished(async () => { for (const f of [...fibers].reverse()) await f.dispose() })
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const origin = `http://127.0.0.1:${(ctx as unknown as { webServer: { port: number } }).webServer.port}`
  return { ctx, origin, token, log: (ctx as unknown as { eventLog?: StubEventLog }).eventLog }
}

const launch = async (): Promise<Browser> => {
  const browser = await chromium.launch(headlessLaunchOptions())
  onTestFinished(() => browser.close())
  return browser
}

/** A page at this width whose clock stands at NOW, in UTC with a 24-hour clock; its timers run only as the test advances them. */
async function pinned(browser: Browser, origin: string, token: string, width: number, phone = false): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: phone ? 874 : width === 1920 ? 1080 : 800 }, timezoneId: 'UTC', locale: 'en-GB', ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}) })
  const page = await context.newPage()
  await page.clock.install({ time: NOW })
  await opened(page, `${origin}/ui/#token=${token}`)
  return page
}

/** The columns a page's grid lays out now. */
const columns = (page: Page): Promise<number> => page.locator('main .page-grid').first().evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length)
/** How wide main and its grid are, beside the screen's width. */
const widths = (page: Page) => page.evaluate(() => ({ screen: document.documentElement.clientWidth, main: document.getElementById('main')!.getBoundingClientRect().width, grid: document.querySelector('main .page-grid')!.getBoundingClientRect().width }))

describe('web UI round 2: a step\'s timings from the event log (T256)', () => {
  it('gives each step\'s start and, once it ended, its end; with no log, or a log that fails, why they are unknown, never none', async () => {
    const { origin, token, log } = await boot()
    const read = async (runId: string) => (await (await fetch(`${origin}/ui/api/runs/${runId}`, { headers: { authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>
    expect((await read('run_timed'))['timings']).toEqual({ value: { 'develop:1': { startedAt: at('09:00'), endedAt: at('09:14') }, 'review:1': { startedAt: at('09:20') } } })
    expect((await read('run_ended'))['timings']).toEqual({ value: { 'develop:1': { startedAt: at('08:00'), endedAt: at('08:10') }, 'review:1': { startedAt: at('08:11'), endedAt: at('08:25') } } })
    // Each decision with when it was made, from its artifact.
    const explain = (await read('run_timed'))['explain'] as { nodes: Array<{ nodeId: string; decisions: Array<{ id: string; at?: string }> }> }
    expect(explain.nodes[0]!.decisions.map((d) => d.at)).toEqual([at('09:00'), at('09:05'), at('09:07')])
    log!.fail = true
    expect((await read('run_timed'))['timings']).toEqual({ unknown: 'the event log could not be read: the log is locked' })
  })

  it('says the timings are unknown when no event log is mounted', async () => {
    const { origin, token } = await boot({ eventLog: false })
    const run = await (await fetch(`${origin}/ui/api/runs/run_timed`, { headers: { authorization: `Bearer ${token}` } })).json() as Record<string, unknown>
    expect(run['timings']).toEqual({ unknown: 'the event log (ctx.eventLog) is not mounted' })
  })
})

describe('web UI round 2: full width, timings, no text walls (T256)', () => {
  headlessIt('lays Home, a run, and Workers on a full-width grid: three columns at 1920, two at 1280, one below 900; prose held to its measure', async () => {
    const { origin, token } = await boot()
    const browser = await launch()
    for (const [width, home, others] of [[1920, 3, 2], [1280, 2, 2], [899, 1, 1]] as const) {
      const page = await pinned(browser, origin, token, width)
      for (const [name, path, expected] of [['home', '/ui/', home], ['run', '/ui/?run=run_timed', others], ['workers', '/ui/?view=workers', others]] as const) {
        await opened(page, origin + path)
        const where = `${name} at ${width}`
        expect(await columns(page), where).toBe(expected)
        // No maximum width: main is the screen's width, and its grid all of it but the page's sides (24 px each).
        const { screen, main, grid } = await widths(page)
        expect(main, where).toBe(screen)
        expect(grid, where).toBeGreaterThanOrEqual(screen - 2 * 24 - 1)
        // The design note's screenshot of a run with its step times and timeline, its first step's decisions unfolded.
        if (name === 'run' && width !== 899) {
          await page.locator('ol.timeline > li').first().locator('summary', { hasText: 'Details' }).click()
          await shoot(page, `run-timed-${width}`)
          if (width === 1920) { await page.emulateMedia({ colorScheme: 'dark' }); await shoot(page, 'run-timed-1920-dark'); await page.emulateMedia({ colorScheme: 'light' }) }
        }
      }
      // Prose alone is held to about 75 characters, however wide the screen.
      const prose = await page.locator('main p').first().evaluate((p) => getComputedStyle(p).maxWidth)
      expect(prose, `prose at ${width}`).toMatch(/^\d+(\.\d+)?px$/)
      expect(parseFloat(prose)).toBeLessThan(900)
      await page.context().close()
    }
  }, 90_000)

  headlessIt('shows what dispatch started by itself at the bottom of Home as a table, one row per task with its attempts folded into it, the newest 5 and Show all', async () => {
    const { origin, token } = await boot()
    const browser = await launch()
    const page = await pinned(browser, origin, token, 1280)
    const started = page.getByRole('region', { name: 'Started by itself' })
    await expect.poll(() => started.count()).toBe(1)
    // At the page's bottom: nothing of main comes after it.
    expect(await page.locator('main > :last-child').getAttribute('aria-label')).toBe('Started by itself')
    expect(await started.locator('thead th').allInnerTexts()).toEqual(['Task', 'State', 'Worker', 'Run time', 'Started'])
    const rows = started.locator('tbody > tr')
    expect(await rows.count()).toBe(5)
    // Task A started twice: one row, its newest attempt's state, Worker, and run time; both attempts folded into it.
    const a = started.getByRole('row', { name: 'Started by itself: Write the release notes' })
    expect(await a.count()).toBe(1)
    expect(await a.locator('td').allInnerTexts()).toEqual(['Write the release notes 2 attempts', '◆ running', 'worker:b/standard', '30 min', '30 min ago'])
    expect(await a.locator('details').getAttribute('open')).toBeNull()
    await a.locator('summary').click()
    expect(await a.locator('details').innerText()).toMatch(/attempt 2 · running · worker:b\/standard · on your approval · 30 min ago open run\nattempt 1 · failed · worker:a\/standard · by policy \(auto\) · 2 h ago open run/)
    // A run Home did not read says its run time is unknown, never 0.
    expect(await started.getByRole('row', { name: 'Started by itself: Task B' }).locator('td').nth(3).innerText()).toBe('—')
    await started.evaluate((s) => s.scrollIntoView({ block: 'end' }))
    await shoot(page, 'started-1280')
    await started.getByRole('button', { name: 'Show all 7' }).click()
    await expect.poll(() => rows.count()).toBe(7)
    // Its run time ticks while its run runs.
    await page.clock.runFor(120_000)
    await expect.poll(() => a.locator('td').nth(3).innerText()).toBe('32 min')
  }, 60_000)

  headlessIt('shows each step\'s run time and when it ended, a running step\'s elapsed time ticking, the run\'s total and its timeline, the exact times on hover and focus', async () => {
    const { origin, token } = await boot()
    const browser = await launch()
    const page = await pinned(browser, origin, token, 1280)
    await opened(page, `${origin}/ui/?run=run_timed`)
    const steps = page.locator('ol.timeline > li')
    expect(await steps.count()).toBe(3)
    // The run's timeline: a segment per step that ran, its words its accessible name.
    const bar = page.getByRole('img', { name: /^Timeline: / })
    expect(await bar.getAttribute('aria-label')).toBe('Timeline: develop:1 14 min, review:1 10 min; 30 min so far')
    expect(await bar.locator('span').count()).toBe(2)
    // "develop · 14 min · done 09:14": its run time and its end; its start and end exact on hover and on focus.
    expect(await steps.nth(0).locator(':scope > div').first().innerText()).toBe('develop:1 · 14 min · done 09:14 · worker:a/standard')
    const took = steps.nth(0).locator('.took')
    expect(await took.getAttribute('title')).toBe(await page.evaluate(([from, to]) => {
      const exact = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      return exact(from!) + ' – ' + exact(to!)
    }, [at('09:00'), at('09:14')]))
    await took.focus()
    expect(await took.evaluate((e) => getComputedStyle(e, '::after').content)).toContain('09:00')
    expect(await steps.nth(0).locator(':scope > div').first().locator('time').getAttribute('title')).toContain('09:14')
    // A running step: its elapsed time, ticking.
    const running = steps.nth(1).locator(':scope > div').first()
    expect(await running.innerText()).toBe('review:1 · 10 min · running · worker:b/standard')
    await page.clock.runFor(120_000)
    await expect.poll(() => running.innerText()).toBe('review:1 · 12 min · running · worker:b/standard')
    // A step that has not started says only its state.
    expect(await steps.nth(2).locator(':scope > div').first().innerText()).toBe('test:1 waiting for earlier steps')
    // Its start and end under its Details.
    await steps.nth(0).locator('summary', { hasText: 'Details' }).click()
    await expect.poll(() => steps.nth(0).innerText()).toMatch(/started .+09:00 · ended .+09:14/)
    // A run that ended says how long it took in all, beside when it started.
    await opened(page, `${origin}/ui/?run=run_ended`)
    expect(await page.locator('.status-line').innerText()).toMatch(/started .+ ago\s+took 25 min$/)
    expect(await page.locator('ol.timeline > li').nth(1).locator(':scope > div').first().innerText()).toBe('review:1 · 14 min · failed 08:25 · worker:b/standard')
    expect(await page.getByRole('img', { name: /^Timeline: / }).getAttribute('aria-label')).toBe('Timeline: develop:1 10 min, review:1 14 min; 25 min in all')
  }, 60_000)

  headlessIt('says when the step times are unknown, why folded under it, and leaves each step its state', async () => {
    const { origin, token } = await boot({ eventLog: false })
    const browser = await launch()
    const page = await pinned(browser, origin, token, 1280)
    await opened(page, `${origin}/ui/?run=run_timed`)
    const steps = page.getByRole('region', { name: 'Steps' })
    const unknown = steps.locator('details', { hasText: 'Times unknown' })
    expect(await unknown.count()).toBe(1)
    expect(await unknown.getAttribute('open')).toBeNull()
    expect(await unknown.textContent()).toContain('the event log (ctx.eventLog) is not mounted')
    expect(await page.getByRole('img', { name: /^Timeline: / }).count()).toBe(0)
    expect(await page.locator('ol.timeline > li').first().locator(':scope > div').first().innerText()).toBe('develop:1 done · worker:a/standard')
  }, 60_000)

  headlessIt('lists how a step was decided one line a decision, its reasons a click away, and a deferred call\'s wait and approval as one line', async () => {
    const { origin, token } = await boot()
    const browser = await launch()
    const page = await pinned(browser, origin, token, 1280)
    await opened(page, `${origin}/ui/?run=run_timed`)
    const develop = page.locator('ol.timeline > li').first()
    await develop.locator('summary', { hasText: 'Details' }).click()
    const lines = develop.getByRole('list', { name: 'How it was decided' }).locator(':scope > li')
    // Three decisions, two lines: the route, and the call (its wait, then its continue once approved) as one.
    expect(await lines.allInnerTexts()).toEqual(['route · worker:a/standard · 30 min ago', '1 tool call approved by you · 2 min'])
    expect(await develop.innerText()).toContain('How it was decided (3)')
    expect(await page.getByText('proves reason').isVisible()).toBe(false)
    await lines.first().locator('summary').click()
    expect(await page.getByText('proves reason').isVisible()).toBe(true)
    // Its id shortened, the whole behind its copy button.
    expect(await lines.first().locator('code.short').innerText()).toBe('11111111…')
    expect(await lines.first().getByRole('button', { name: 'Copy decision ID' }).getAttribute('data-copy')).toBe(hash('1'))
    await lines.nth(1).locator('summary').click()
    expect(await lines.nth(1).innerText()).toContain('the operator approved request apr-9')
    expect(await lines.nth(1).getByRole('button', { name: 'Copy request ID' }).getAttribute('data-copy')).toBe('apr-9')
    // The spec hash shortened under Technical details, the whole behind its copy button.
    await page.getByText('Technical details', { exact: true }).click()
    expect(await page.getByRole('button', { name: 'Copy spec hash' }).getAttribute('data-copy')).toBe(hash('f'))
  }, 60_000)

  headlessIt('scrolls no page sideways on the phone at 402 px: Home with its table, a run with its timeline, a project\'s reports, and Workers', async () => {
    const { origin, token } = await boot()
    const browser = await launch()
    const page = await pinned(browser, origin, token, 402, true)
    for (const path of ['/ui/', '/ui/?run=run_timed', '/ui/?run=run_ended', '/ui/?view=reports&project=p1', '/ui/?view=workers']) {
      await opened(page, origin + path)
      expect(await overflow(page), `${path} at 402 px`).toBeLessThanOrEqual(0)
      if (await page.locator('main .page-grid').count()) expect(await columns(page), path).toBe(1)
    }
    await opened(page, `${origin}/ui/?run=run_timed`)
    await shoot(page, 'run-timed-402')
    await opened(page, `${origin}/ui/`)
    await page.getByRole('region', { name: 'Started by itself' }).evaluate((s) => s.scrollIntoView({ block: 'start' }))
    expect(await overflow(page)).toBeLessThanOrEqual(0)
    await shoot(page, 'started-402')
  }, 60_000)
})
