/**
 * The software-development profile (docs/architecture/plugin-model.md, REQ-WF-9): a domain
 * procedure contributed to the workflow engine through `ctx.workflow.template`, with no engine
 * code of its own. A planner proposes implementation steps for local agent Workers and a
 * review; writing steps wait for the operator's approval of the exact plan; the review runs in
 * a fresh session on a read-only Worker, bound to the exact subject of the change, and blocking
 * findings grow remediation cycles (engine rules for any profile).
 * @module @tsuuanmi/system-profile-software-development
 */
import type { Context } from '@deepseek-ai/cordis'
import type { NodeTemplate } from '@tsuuanmi/system-workflow'

export const name = 'profile-software-development'
export const inject = ['workflow']

const DEVELOP_PLAN_PROMPT = [
  'Plan the software change below for local coding agents working in the operator\'s workspace.',
  'Reply with only a JSON object in a ```json block, shaped like:',
  '{"confidence": "high", "nodes": [{"id": "implement", "objective": "...", "prompt": "the full instruction", "capabilities": ["develop", "local-data"], "tier": "standard", "dependsOn": []},',
  ' {"id": "review", "objective": "...", "prompt": "review the change against the request", "capabilities": ["review", "local-data"], "tier": "standard", "dependsOn": ["implement"]}]}',
  'Implementation steps use ["develop", "local-data"]; end with one review step using ["review", "local-data"] that depends on them. Each prompt must stand on its own.',
  '',
  'Change: {{input}}',
].join('\n')

const DEVELOP_REPORT_PROMPT = [
  'Report to the operator what was changed and what the independent review found, from the steps below. Be concise and list open issues.',
  '',
  'Change: {{input}}',
  '',
  '<steps>',
  '{{grown}}',
  '</steps>',
].join('\n')

export const DEVELOP: NodeTemplate[] = [
  {
    nodeId: 'plan:1', objective: 'Plan the change', prompt: DEVELOP_PLAN_PROMPT, capabilities: ['reason'], tier: 'standard',
    conversation: 'temporary', acceptance: 'acceptance.answer',
    grows: { maxNodes: 4, capabilities: ['develop', 'review', 'local-data'], approvalRequired: ['develop'] },
  },
  {
    nodeId: 'report:1', objective: 'Report the change and its review', dependsOn: ['plan:1'], prompt: DEVELOP_REPORT_PROMPT, capabilities: ['reason'],
    tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer',
  },
]

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.workflow.template('develop', DEVELOP))
}
