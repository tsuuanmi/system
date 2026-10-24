/**
 * What the re-planning specs share (replan.spec.ts, replan-edits.spec.ts, replan-approved.spec.ts):
 * a gated planner with an input upstream of it and the answers its steps give. The specs are split
 * by theme so they run side by side.
 */
import { TEST_TEMPLATES } from './templates.ts'

/**
 * A gated planner with an input upstream of it: what re-planning invalidates (REQ-ART-2,
 * REQ-WF-11). `plan:1:extra` is a template node that only shares the planner's id prefix.
 */
export const replanTemplate = (approvalRequired = ['reason']) => {
  const [planner, synthesis] = TEST_TEMPLATES.investigate!
  const step = (nodeId: string, prompt: string, dependsOn: string[] = []) => ({ nodeId, objective: nodeId, prompt, dependsOn, capabilities: ['reason'], tier: 'economy' as const, conversation: 'temporary' as const, acceptance: 'acceptance.answer' })
  return [
    step('context:1', 'context for: {{input}}'),
    step('plan:1:extra', 'extra for: {{input}}', ['context:1']),
    { ...planner!, dependsOn: ['context:1'], prompt: `${planner!.prompt}\n\nContext: {{node:context:1}}`, grows: { maxNodes: 2, approvalRequired } },
    { ...synthesis!, dependsOn: ['plan:1', 'plan:1:extra'] },
  ]
}

export const planOf = (step: string) => '```json\n' + JSON.stringify({ confidence: 'high', nodes: [{ id: step, objective: `Do ${step}`, prompt: `the ${step}`, capabilities: ['reason'], tier: 'economy' }] }) + '\n```'

export const replanAnswer = (prompt: string): string => {
  if (prompt.includes('context for:')) return 'context v1'
  if (prompt.includes('extra for:')) return 'extra'
  if (prompt.includes('Plan how to answer')) return planOf(prompt.includes('Corrected context') ? 'new-step' : 'old-step')
  if (prompt.includes('<findings>')) return `final from ${['old finding', 'new finding'].filter((f) => prompt.includes(f)).join(' and ')}`
  return prompt.includes('the new-step') ? 'new finding' : 'old finding'
}

export const states = (view: { nodes: Array<{ nodeId: string; state: string }> }) => Object.fromEntries(view.nodes.map((n) => [n.nodeId, n.state]))
