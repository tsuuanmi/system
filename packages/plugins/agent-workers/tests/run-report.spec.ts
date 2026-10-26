// A writing run's report file (T265): made fresh and owner-only outside the worktree, read once the
// run ended into what its own test runs did not run, and removed; through a Worker's completion, the
// result says what was skipped, and says so when the report could not be made or read, never taking
// either for a report that names no skip.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { RunSpec } from '@tsuuanmi/system-agent-runtimes'
import type { WorkerExecution } from '@tsuuanmi/system-workers'
import { afterAll, describe, expect, it } from 'vitest'
import { notRunIn, reportedIn, runReport } from '../src/run-report.ts'
import { boot, requirement, ScriptedAgent, worker } from './stack.ts'

const temp = mkdtempSync(join(tmpdir(), 'system-run-report-'))
const parent = join(temp, 'reports')
afterAll(() => rmSync(temp, { recursive: true, force: true }))

describe('a writing run\'s report file (T265)', () => {
  it('is a fresh, empty, owner-only file of its own; what its commands appended is read as what did not run; disposing removes it', () => {
    const report = runReport(parent)
    expect(statSync(report.path).size).toBe(0)
    expect(statSync(report.path).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(report.path)).mode & 0o777).toBe(0o700)
    expect(report.read()).toEqual({})
    // As scripts/browser-skips.ts appends it at the end of a vitest run whose browser tests were skipped.
    appendFileSync(report.path, 'browser-tests-not-run: 58 browser tests skipped: Chrome cannot start here (Failed to create shared memory)\n')
    expect(report.read()).toEqual({ notRun: 'its browser tests (58 browser tests skipped: Chrome cannot start here (Failed to create shared memory))' })
    const other = runReport(parent)
    expect(other.path).not.toBe(report.path)
    report.dispose()
    expect(existsSync(dirname(report.path))).toBe(false)
    other.dispose()
  })

  it('says a report file it cannot read is unread, never a report naming no skip', () => {
    const report = runReport(parent)
    rmSync(report.path)
    mkdirSync(report.path)
    expect(report.read()).toEqual({ unread: expect.stringMatching(/^its report file cannot be read: /) })
    report.dispose()
    expect(reportedIn({ reportUnread: 'x: ENOENT' })).toEqual({ unread: 'its report file cannot be read: x: ENOENT' })
  })

  it('reads only a browser-tests-not-run line, as a check\'s notRun says it', () => {
    expect(notRunIn(undefined)).toBeUndefined()
    expect(notRunIn('nested-confinement-refused: bwrap\n')).toBeUndefined()
    expect(notRunIn('browser-tests-not-run\n')).toBe('its browser tests')
    expect(notRunIn(`noise\nbrowser-tests-not-run: ${'x'.repeat(400)}\n`)).toBe(`its browser tests (${'x'.repeat(280)})`)
  })
})

describe('a writing run\'s result says what its own test runs did not run, or that it is not known (T265)', () => {
  const workspace = (): string => mkdtempSync(join(temp, 'ws-'))
  const writer = (ws: string) => worker({ id: 'dev', sandbox: 'workspace-write', workspace: ws, tools: [] })
  const run = async (ctx: Context): Promise<WorkerExecution> => {
    const source = ctx.workers.source('agents')!
    return source.wait(source.start({ key: 'k', worker: 'agent:dev', prompt: 'change it', requirement: requirement({ capabilities: ['develop'] }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 30_000)
  }
  const body = (ctx: Context, done: WorkerExecution) => ctx.artifacts.get(done.result!)!.body as { schema: string; notRun?: string; reportUnread?: string }
  const developer = (act: (spec: RunSpec) => void) => new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'], executes: true, act: (spec) => (act(spec), 'done') })

  it('names the browser tests its commands skipped, from its report file, which it gave the run and removed after', async () => {
    const agent = developer((spec) => appendFileSync(spec.reportFile!, 'browser-tests-not-run: 3 browser tests skipped: no usable Chrome\n'))
    const { ctx } = await boot(agent, { workers: [writer(workspace())], worktreeRoot: join(temp, 'roots-1') })
    const done = await run(ctx)
    expect(done.status).toBe('completed')
    expect(body(ctx, done)).toMatchObject({ schema: 'agent-result@1.5', notRun: 'its browser tests (3 browser tests skipped: no usable Chrome)' })
    expect(body(ctx, done)).not.toHaveProperty('reportUnread')
    expect(agent.runs[0]!.reportFile).toMatch(new RegExp(`^${join(temp, 'roots-1', '.setup')}/run-report-`))
    expect(existsSync(agent.runs[0]!.reportFile!)).toBe(false)
  })

  it('says nothing when its commands skipped nothing', async () => {
    const agent = developer(() => undefined)
    const { ctx } = await boot(agent, { workers: [writer(workspace())], worktreeRoot: join(temp, 'roots-2') })
    const done = await run(ctx)
    expect(agent.runs[0]!.reportFile).toBeDefined()
    expect(body(ctx, done).schema).not.toBe('agent-result@1.5')
    expect(body(ctx, done)).not.toHaveProperty('notRun')
    expect(body(ctx, done)).not.toHaveProperty('reportUnread')
  })

  it('says its report is not known when the report file cannot be read once the run ended', async () => {
    const agent = developer((spec) => {
      rmSync(spec.reportFile!)
      mkdirSync(spec.reportFile!)
    })
    const { ctx } = await boot(agent, { workers: [writer(workspace())], worktreeRoot: join(temp, 'roots-3') })
    const done = await run(ctx)
    expect(done.status).toBe('completed')
    expect(body(ctx, done)).toMatchObject({ schema: 'agent-result@1.5', reportUnread: expect.stringMatching(/^its report file cannot be read: /) })
    expect(body(ctx, done)).not.toHaveProperty('notRun')
  })

  it('says its report is not known when the report file could not be made, and runs without one', async () => {
    // The directory the report file is made in cannot be: a file holds its place.
    const root = join(temp, 'roots-4')
    mkdirSync(root)
    writeFileSync(join(root, '.setup'), 'not a directory')
    const agent = developer(() => undefined)
    const { ctx } = await boot(agent, { workers: [writer(workspace())], worktreeRoot: root })
    const done = await run(ctx)
    expect(done.status).toBe('completed')
    expect(agent.runs[0]!.reportFile).toBeUndefined()
    expect(body(ctx, done)).toMatchObject({ schema: 'agent-result@1.5', reportUnread: expect.stringMatching(/^its report file could not be made in /) })
  })
})
