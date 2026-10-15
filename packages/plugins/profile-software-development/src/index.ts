/**
 * The software-development profile (docs/architecture/plugin-model.md, REQ-WF-9): the
 * `agent-review` template for local agent Workers, contributed to the workflow engine through
 * `ctx.workflow.template`, with no engine code of its own. It is mounted with the agent Worker
 * rows, which the MVP composition leaves off (PROP-0004); `review` is the team review.
 * @module @tsuuanmi/system-profile-software-development
 */
import type { Context } from '@deepseek-ai/cordis'
import type { NodeTemplate } from '@tsuuanmi/system-workflow'

export const name = 'profile-software-development'
export const inject = ['workflow']

/** A review on this machine by a local agent Worker, which alone proves `review` and `local-data`. */
export const AGENT_REVIEW: NodeTemplate[] = [
  {
    nodeId: 'review:1', objective: 'Review the caller\'s subject on this machine and report findings', prompt: '{{input}}',
    capabilities: ['review', 'local-data'], tier: 'standard', callerTier: true, conversation: 'caller', acceptance: 'acceptance.answer',
  },
]

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.workflow.template('agent-review', AGENT_REVIEW))
}
