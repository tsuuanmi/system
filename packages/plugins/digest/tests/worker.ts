/**
 * A scripted digest Worker for the provider's tests: a read-only Worker on this machine (it proves
 * `review` and `local-data`) on each of `tiers` (`w:digest` on economy, `w:digest:<tier>` above),
 * that answers each run as the drafter says, given the sources its brief points at and its tier.
 * With no drafter it describes no Worker at all. Its runs outlive a restart of the provider, as a
 * Worker's own runtime does.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { type Brief, startPrompt } from '@tsuuanmi/system-libs'
import { type ArtifactRef, type Tier, TIERS, type WorkerExecution, type WorkerSource, type WorkerStart } from '@tsuuanmi/system-workers-core'
import type { Drafter } from '../../../digest-core/conformance/digests.ts'
import { worker } from '../../../workers-core/conformance/workers.ts'

const idOf = (tier: Tier): string => (tier === 'economy' ? 'w:digest' : `w:digest:${tier}`)

export class DigestWorker {
  /** Every run started, with the prompt its brief rendered to; a repeated key starts none. */
  readonly started: Array<WorkerStart & { id: string; prompt: string; sources: ArtifactRef[]; tier: Tier }> = []
  readonly cancelled: string[] = []
  /** Runs stay running until {@link release}. */
  hold = false
  /** The tiers it describes a Worker on. */
  tiers: Tier[] = ['economy', 'standard', 'frontier']
  private readonly executions = new Map<string, WorkerExecution>()
  private readonly keys = new Map<string, string>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private ctx: Context | undefined

  constructor(private readonly drafter: Drafter | undefined) {}

  readonly source = (ctx: Context): WorkerSource => {
    this.ctx = ctx
    return {
      name: 'digest-worker',
      describe: async () => (this.drafter ? this.tiers.map((tier) => worker(idOf(tier), { tier, locality: 'local', proves: ['review', 'local-data'] })) : []),
      start: (request) => this.start(request),
      get: (id) => {
        const execution = this.executions.get(id)
        return execution && { ...execution }
      },
      wait: (id, timeoutMs) => this.wait(id, timeoutMs),
      cancel: (id) => {
        const execution = this.executions.get(id)
        if (execution?.status !== 'running') return false
        this.cancelled.push(id)
        this.finish(id, { fail: 'aborted' })
        return true
      },
    }
  }

  /** End a held run as the drafter says. */
  release(id: string): void {
    const run = this.started.find((s) => s.id === id)!
    this.finish(id, this.drafter!(run.sources, run.tier))
  }

  private start(request: WorkerStart): WorkerExecution {
    const known = this.keys.get(request.key)
    if (known) return { ...this.executions.get(known)! }
    const ctx = this.ctx!
    const prompt = startPrompt(request, (ref) => ctx.artifacts.get(ref)).prompt
    const sources = (ctx.artifacts.get(request.brief!)!.body as Brief).artifacts.map((p) => p.ref as ArtifactRef)
    const id = `d-${this.started.length + 1}`
    const tier = TIERS.find((t) => idOf(t) === request.worker)!
    this.keys.set(request.key, id)
    this.started.push({ ...request, id, prompt, sources, tier })
    this.executions.set(id, { id, status: 'running', submitted: true, decisions: [] })
    if (!this.hold) this.finish(id, this.drafter!(sources, tier))
    return { ...this.executions.get(id)! }
  }

  private finish(id: string, answer: { text: string } | { fail: string }): void {
    const execution = this.executions.get(id)!
    if ('text' in answer) {
      execution.result = this.ctx!.artifacts.put({
        kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: 'w:digest' },
        body: { schema: 'provider-answer@1.0', provider: 'scripted', account: 'scripted', turnId: id, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text: answer.text },
      }).id as ArtifactRef
      execution.status = 'completed'
    } else {
      execution.status = 'failed'
      execution.error = { kind: answer.fail, disposition: 'NONE', message: `scripted ${answer.fail}` }
    }
    for (const wake of this.waiters.get(id) ?? []) wake()
    this.waiters.delete(id)
  }

  private wait(id: string, timeoutMs: number): Promise<WorkerExecution> {
    const execution = this.executions.get(id)
    if (!execution || execution.status !== 'running') return Promise.resolve({ ...execution! })
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set()
      this.waiters.set(id, set)
      const done = (): void => {
        clearTimeout(timer)
        set.delete(done)
        resolve({ ...this.executions.get(id)! })
      }
      const timer = setTimeout(done, timeoutMs)
      timer.unref()
      set.add(done)
    })
  }
}
