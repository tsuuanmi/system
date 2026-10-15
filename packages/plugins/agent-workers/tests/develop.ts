/**
 * The `develop` template the agent Worker tests run: built in by the software-development profile
 * before PROP-0004, now a test fixture. It exercises graph growth, the approval gate,
 * exact-subject review, and remediation on agent Workers.
 */
import type { NodeTemplate } from '@tsuuanmi/system-workflow'

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
