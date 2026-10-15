/**
 * Templates the engine's tests run (and the upgrade fixture generator seeds): built in before
 * PROP-0004, now test fixtures only. They exercise graph growth (`investigate`) and a persistent
 * Deep research step with a compaction (`deep-research`).
 */
import type { NodeTemplate } from '../src/spec.ts'

const PLAN_PROMPT = [
  'Plan how to answer the question below in at most 4 independent or chained research steps for another assistant.',
  'Reply with only a JSON object in a ```json block, shaped like:',
  '{"confidence": "high", "nodes": [{"id": "step-1", "objective": "...", "prompt": "the full question for this step", "capabilities": ["reason"], "tier": "economy", "dependsOn": []}]}',
  'Every step uses "capabilities": ["reason"] exactly; no other capability is available.',
  'Use tier "economy" for lookups and "standard" for analysis. Each prompt must stand on its own.',
  '',
  'Question: {{input}}',
].join('\n')

const SYNTHESIS_PROMPT = [
  'Answer the question below from the findings of the research steps. Keep their sources. Be concise.',
  '',
  'Question: {{input}}',
  '',
  '<findings>',
  '{{grown}}',
  '</findings>',
].join('\n')

const COMPACT_PROMPT = [
  'Compact the research report below into a synthesis for another AI agent that will act on it.',
  'Keep every key finding, number, recommendation, and caveat. Keep each claim\'s source link inline as a full URL.',
  'Use short sections and bullets. Add nothing that the report does not say.',
  '',
  '<report>',
  '{{node:research:1}}',
  '</report>',
].join('\n')

export const TEST_TEMPLATES: Record<string, NodeTemplate[]> = {
  investigate: [
    {
      nodeId: 'plan:1', objective: 'Plan research steps for the caller\'s question', prompt: PLAN_PROMPT, capabilities: ['reason'],
      tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', grows: { maxNodes: 4, capabilities: ['reason'] },
    },
    {
      nodeId: 'synthesis:1', objective: 'Answer from the steps\' findings', dependsOn: ['plan:1'], prompt: SYNTHESIS_PROMPT, capabilities: ['reason'],
      tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer',
    },
  ],
  'deep-research': [
    {
      nodeId: 'research:1', objective: 'Write a cited Deep research report on the caller\'s question', prompt: '{{input}}',
      capabilities: ['reason', 'deep-research'], tier: 'frontier', conversation: 'persistent', acceptance: 'acceptance.answer',
    },
    {
      nodeId: 'compact:1', objective: 'Compact the report into a cited synthesis', dependsOn: ['research:1'], prompt: COMPACT_PROMPT,
      capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.answer',
    },
  ],
}
