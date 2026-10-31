// A step's own test runs have a share of the host (T348): the budget a writing run is given, from
// the core budget and the runs the dispatch lets run at once.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, describe, expect, it } from 'vitest'
import { stepWorkers } from '../src/check-queue.ts'
import { checkConfig } from '../src/index.ts'
import { boot, requirement, ScriptedAgent, worker } from './stack.ts'

const temp = mkdtempSync(join(tmpdir(), 'system-step-tests-'))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

describe('stepWorkers: the test workers of one writing step (T348)', () => {
  it('is the core budget (default half the host) shared among the runs at once (default 6), 1 to 32', () => {
    expect(stepWorkers({}, 256)).toBe(21)
    expect(stepWorkers({ runs: 12 }, 256)).toBe(10)
    expect(stepWorkers({ coreBudget: 64, runs: 8 }, 256)).toBe(8)
    expect(stepWorkers({ coreBudget: 1000, runs: 1 }, 256)).toBe(32)
    expect(stepWorkers({ runs: 20 }, 8)).toBe(1)
  })
})

describe('a writing run is given its test-worker budget (T348)', () => {
  const workspace = (): string => mkdtempSync(join(temp, 'ws-'))
  const run = async (ctx: Context, id: string) => {
    const source = ctx.workers.source('agents')!
    return source.wait(source.start({ key: `k-${id}`, worker: `agent:${id}`, prompt: 'change it', requirement: requirement({ capabilities: ['develop'] }), decisions: { tier: 'sha256:0', route: 'sha256:0' } as never }).id, 30_000)
  }

  it('says it in the run\'s spec, from the configuration: a writing run only', async () => {
    const agent = new ScriptedAgent({ sandboxes: ['read-only', 'workspace-write'], executes: true, act: () => 'done' })
    const { ctx } = await boot(agent, {
      workers: [worker({ id: 'dev', sandbox: 'workspace-write', workspace: workspace(), tools: [] }), worker({ id: 'rev', sandbox: 'read-only', workspace: workspace(), tools: [] })],
      worktreeRoot: join(temp, 'roots-1'), stepTests: { coreBudget: 48, runs: 6 },
    })
    await run(ctx, 'dev')
    await run(ctx, 'rev')
    expect(agent.runs[0]!.testWorkers).toBe(8)
    expect(agent.runs[1]!.testWorkers).toBeUndefined()
  })

  it('refuses a budget out of its range', () => {
    expect(checkConfig({ workers: [worker()], stepTests: { runs: 0 } })).toEqual([expect.stringMatching(/stepTests\.runs is 1 to 64/)])
    expect(checkConfig({ workers: [worker()], stepTests: { coreBudget: 2000 } })).toEqual([expect.stringMatching(/stepTests\.coreBudget is 1 to 1024/)])
    expect(checkConfig({ workers: [worker()], stepTests: { runs: 12 } })).toEqual([])
  })
})
