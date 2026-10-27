/**
 * The workflow engine's side of the dispatch advisor seam's conformance suite
 * (`decision-core/conformance/dispatch-advisor.ts`, `ctx.dispatchAdvisor`; PROP-0015 J1): the
 * dispatch harness the suite runs in, over a booted engine whose dispatch pass is the seam's
 * consumer. It puts the advisor under test in place one of the two ways the engine takes one:
 * `setDispatchAdvisor` (contract 1.11, the thin path), or a plugin that provides
 * `ctx.dispatchAdvisor` (contract 1.12, the seam), removed once the pass has run. It reads back what
 * the pass recorded: the ask, its `dispatch.choice`, the advice decisions the choice names, and the
 * request the ask opened.
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-ledger-core'
import type { BoardTask } from '@tsuuanmi/system-board-core'
import { type Advice, type Advisor, type AdvisorFeatures, type AdvisorSignal, DispatchAdvisor } from '@tsuuanmi/system-decision-core'
import type { Dispatched, DispatchHarness, RecordedDecision } from '../../../decision-core/conformance/dispatch-advisor.ts'
import type {} from '../src/index.ts'

/** How the harness puts an advisor in place: through `setDispatchAdvisor`, or as the provider of `ctx.dispatchAdvisor`. */
export type Placement = 'setDispatchAdvisor' | 'seam'

/** A booted engine the harness dispatches on. */
export interface DispatchBoot {
  ctx: Context
  /** A ready board task of the engine's active project, which the next dispatch pass takes. */
  ready: (title: string, goal: string) => Promise<BoardTask>
  /** The Worker dispatch chooses. */
  chosen: string
  /** Every Worker id, account, and project id of the boot. */
  hidden: string[]
}

/** A provider of `ctx.dispatchAdvisor` that answers as `inner` does. */
export class SeamAdvisor extends DispatchAdvisor {
  readonly id: string
  private readonly inner: Advisor

  constructor(ctx: Context, inner: Advisor) {
    super(ctx)
    this.id = inner.id
    this.inner = inner
  }

  advise(features: AdvisorFeatures, signal: AdvisorSignal): Promise<Advice> {
    return this.inner.advise(features, signal)
  }
}

/** Register `advisor` as the provider of `ctx.dispatchAdvisor`, ready once it resolves; its fiber removes it. */
export async function provideAdvisor(ctx: Context, advisor: Advisor): Promise<Fiber> {
  const fiber = ctx.plugin({ name: 'conformance-dispatch-advisor', apply: (c: Context) => void new SeamAdvisor(c, advisor) })
  await fiber
  return fiber
}

/** The dispatch harness of the seam's suite over `boot`, with advisors put in place by `placement`. */
export function dispatchHarness(boot: DispatchBoot, placement: Placement): DispatchHarness {
  const { ctx } = boot
  const decisionOf = (id: string | undefined): RecordedDecision => {
    const body = ctx.artifacts.get(id as `sha256:${string}`)?.body as RecordedDecision | undefined
    if (!body) throw new Error(`decision ${id} is not recorded`)
    return body
  }
  return {
    ctx, chosen: boot.chosen, hidden: boot.hidden,
    announced: () => ctx.eventLog.query({ type: 'workflow.dispatch.advised', limit: 10 }).map((e) => String(e.data?.['status'])),
    dispatch: async (advisor, title, goal): Promise<Dispatched> => {
      let fiber: Fiber | undefined
      if (placement === 'setDispatchAdvisor') ctx.workflow.setDispatchAdvisor(advisor)
      else {
        ctx.workflow.setDispatchAdvisor(undefined)
        if (advisor) fiber = await provideAdvisor(ctx, advisor)
      }
      try {
        const task = await boot.ready(title, goal)
        const pass = await ctx.workflow.sweepDispatch()
        const ask = ctx.workflow.dispatchStatus().asks.find((a) => a.taskId === task.taskId)
        if (!ask) throw new Error(`dispatch asked nothing about ${task.taskId}`)
        const choice = decisionOf(ask.decisions[1])
        const advice = choice.inputs.map((id) => ctx.artifacts.get(id as `sha256:${string}`)?.body as RecordedDecision | undefined)
          .filter((d): d is RecordedDecision => d?.decider?.id === 'advisor.dispatch')
        const requests = await ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })
        const request = requests.find((r) => r.requestId === ask.requestId)
        return {
          taskId: task.taskId, took: pass.took.map((t) => ({ taskId: t.taskId, worker: t.worker })), worker: ask.worker, choice, advice,
          ...(request ? { request: request.subject.version !== undefined ? { version: request.subject.version } : {} } : {}),
        }
      } finally {
        await fiber?.dispose()
      }
    },
  }
}
