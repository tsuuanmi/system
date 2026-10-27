import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { WorkerExecution } from '@tsuuanmi/system-workers-core'
import { describe, expect, it } from 'vitest'
import { requirement } from '../../../workers-core/conformance/workers.ts'
import * as FakeWorkers from '../src/index.ts'

type Appended = { caller: { runId: string; nodeId: string; execution: string }; input: { kind: string; text: string } }

async function boot(options: { workflow?: { appended: Appended[]; refuse?: boolean } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-workers-fake-'))
  const ctx = new Context()
  /** The one method of `ctx.workflow` the fake calls: a step's Worker's dossier entry, recorded, or refused as the engine refuses a step that writes none. */
  class Workflow extends Service {
    constructor(ctx: Context) {
      super(ctx, 'workflow')
    }

    appendToDossier(caller: Appended['caller'], input: Appended['input']): { seq: number } {
      if (options.workflow?.refuse) throw new Error('a review appends review, not evidence; nothing was appended')
      options.workflow!.appended.push({ caller, input })
      return { seq: options.workflow!.appended.length }
    }
  }
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(WorkerRouter, {}), ...(options.workflow ? [ctx.plugin(Workflow)] : [])]
  await Promise.all(fibers)
  const fake = ctx.plugin(FakeWorkers)
  await fake
  return {
    ctx, fake,
    dispose: async () => {
      for (const fiber of [...fibers, fake].reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const admitted = { requirement: requirement(), decisions: { tier: 'sha256:0' as never, route: 'sha256:0' as never } }

describe('the fake Worker source (T323)', () => {
  it('offers Workers that prove what the canary\'s templates ask for, and takes them away with the plugin', async () => {
    const { ctx, fake, dispose } = await boot()
    try {
      const listed = await ctx.workers.list()
      expect(listed.map((w) => w.worker)).toEqual(expect.arrayContaining(['fake:economy', 'fake:developer', 'fake:reviewer', 'fake:reviewer-2']))
      const developer = listed.find((w) => w.worker === 'fake:developer')!
      expect(developer.capabilities.map((c) => c.capability)).toEqual(expect.arrayContaining(['reason', 'develop', 'review', 'dossier']))
      const routed = await ctx.workers.route(requirement({ capabilities: ['review', 'local-data'] }))
      expect(routed.worker.worker.startsWith('fake:')).toBe(true)
      routed.release()
      await fake.dispose()
      expect(ctx.workers.source('fake')).toBeUndefined()
      expect(await ctx.workers.list()).toEqual([])
    } finally {
      await dispose()
    }
  })

  it('answers once per key, after it started: an approving review for a subject, a vote for a verification, else the prompt', async () => {
    const { ctx, dispose } = await boot()
    try {
      const source = ctx.workers.source('fake')!
      const run = async (key: string, prompt: string): Promise<{ started: WorkerExecution; done: WorkerExecution; text: string }> => {
        const started = source.start({ key, worker: 'fake:standard', prompt, ...admitted })
        const done = await source.wait(started.id, 5000)
        return { started, done, text: (ctx.artifacts.get(done.result!)!.body as { text: string }).text }
      }
      const review = await run('a', 'Review this.\nSubject: git:abc:def\n')
      // Running at its start, so the engine records it as its step's execution first; completed by the next turn.
      expect(review.started.status).toBe('running')
      expect(review.done.status).toBe('completed')
      expect(JSON.parse(review.text.replace(/```json\n|\n```/g, ''))).toMatchObject({ subject: 'git:abc:def', verdict: 'approve' })
      const vote = await run('b', '## Verify these findings\nVerified subject: git:abc:def\n- f1 important: x\n')
      expect(JSON.parse(vote.text.replace(/```json\n|\n```/g, ''))).toEqual({ subject: 'git:abc:def', votes: [{ finding: 'f1', vote: 'confirm', reason: 'scripted confirm' }] })
      expect((await run('c', 'hello')).text).toBe('answer: hello')
      // The same key is the same execution: nothing runs twice.
      expect((await run('c', 'hello')).started.id).toBe((await run('c', 'hello')).started.id)
      expect(source.get(review.done.id)!.result).toBe(review.done.result)
    } finally {
      await dispose()
    }
  })

  it('appends its evidence for a board task\'s step before it completes, as its writing Worker does, and goes on when the engine refuses it', async () => {
    const appended: Appended[] = []
    const writing = await boot({ workflow: { appended } })
    try {
      const source = writing.ctx.workers.source('fake')!
      const started = source.start({ key: 'd', worker: 'fake:developer', prompt: 'Develop it.', runId: 'run_1', step: { template: 'algorithm-development', node: 'develop:1' }, ...admitted })
      expect(appended).toEqual([])
      expect((await source.wait(started.id, 5000)).status).toBe('completed')
      expect(appended).toEqual([{ caller: { runId: 'run_1', nodeId: 'develop:1', execution: started.id }, input: { kind: 'evidence', text: FakeWorkers.EVIDENCE } }])
      // A step of no run appends nothing.
      await source.wait(source.start({ key: 'e', worker: 'fake:developer', prompt: 'Answer it.', ...admitted }).id, 5000)
      expect(appended).toHaveLength(1)
    } finally {
      await writing.dispose()
    }
    const review = await boot({ workflow: { appended: [], refuse: true } })
    try {
      const source = review.ctx.workers.source('fake')!
      const started = source.start({ key: 'r', worker: 'fake:reviewer', prompt: 'Review.\nSubject: git:a:b\n', runId: 'run_2', step: { template: 'algorithm-development', node: 'review:1' }, ...admitted })
      expect((await source.wait(started.id, 5000)).status).toBe('completed')
    } finally {
      await review.dispose()
    }
  })
})
