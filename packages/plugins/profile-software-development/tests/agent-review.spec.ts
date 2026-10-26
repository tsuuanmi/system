import type { RunView } from '@tsuuanmi/system-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_REVIEW, ALGORITHM_DEVELOPMENT } from '../src/index.ts'
import { bootPilot, decide, type Pilot, queued, until } from './pilot.ts'

// The agent-review template's review node in a remediation cycle, on the pilot in miniature: the
// real engine, approval queue, and agents source with a worktree per run; only the agent runtime is
// scripted.
vi.setConfig({ testTimeout: 120_000 })

const pilots: Pilot[] = []
afterEach(async () => {
  while (pilots.length) await pilots.pop()!.dispose()
})

const subject = (prompt: string): string => /^Subject: (\S+)$/m.exec(prompt)![1]!

describe('the agent-review template\'s review in a remediation cycle', () => {
  it('gives the re-review the instructions the review was given: the caller\'s input composed in place of {{input}}, on the subject the fix left (REQ-WF-5, INV-2)', async () => {
    const pilot = await bootPilot({ changes: 1 })
    pilots.push(pilot)
    const { ctx, agent } = pilot
    // An agent's change reviewed exactly as agent-review words its review: the caller's text alone.
    ctx.workflow.template('develop-then-agent-review', [ALGORITHM_DEVELOPMENT[0]!, { ...AGENT_REVIEW[0]!, dependsOn: ['develop:1'] }])
    const input = 'Fix add() so it adds'
    const run = ctx.workflow.start({ template: 'develop-then-agent-review', input, classification: 'operator-shared' })
    await decide(ctx, (await queued(ctx, run.runId)).approvalRequest)
    const done = await until((): RunView | undefined => {
      const view = ctx.workflow.get(run.runId)
      return view && view.status !== 'running' ? view : undefined
    }, 'the run to finish', 60_000)
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => [n.nodeId, n.state])).toEqual([
      ['develop:1', 'COMPLETED'], ['review:1', 'COMPLETED'], ['review:1:verify', 'COMPLETED'], ['review:1:approve:1', 'COMPLETED'], ['review:1:fix:1', 'COMPLETED'], ['review:1:review:2', 'COMPLETED'],
    ])
    const reviews = agent.runs.filter((r) => r.role === 'review')
    expect(reviews.map((r) => r.sandbox)).toEqual(['read-only', 'read-only'])
    for (const review of reviews) {
      expect(review.prompt.startsWith(`${input}\n\n## The exact subject of this review\n`)).toBe(true)
      expect(review.prompt).not.toContain('{{')
      // The engine tells every bound review, this one too, to read and judge and run no test or build.
      expect(review.prompt).toContain('Read and judge the change: never run the project\'s tests or builds')
      expect(review.prompt).toContain('an environment limit (a read-only sandbox, a denied or failing command) is at most a "nit", never an "important" finding.')
    }
    expect(subject(reviews[1]!.prompt)).not.toBe(subject(reviews[0]!.prompt))
  })
})
