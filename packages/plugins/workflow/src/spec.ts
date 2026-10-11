/**
 * Static workflow specs (MVP subset of docs/design/workflow-engine.md): templates are data,
 * preflight validates a DAG before anything runs, and a resolved spec is hashed so a run
 * binds to exactly what was admitted.
 */
import { contentId, type ContentId } from '@tsuuanmi/system-libs'
import type { Tier } from '@tsuuanmi/system-workers-core'

export type Feature = 'chat' | 'deep-research'

export interface NodeTemplate {
  nodeId: string
  objective: string
  dependsOn?: string[]
  /** `{{input}}` is the caller's text; `{{node:<id>}}` a dependency's result, verbatim. */
  prompt: string
  feature?: Feature
  /** Minimum tier (REQ-WRK-9). */
  tier: Tier
  /** The caller's `tier` replaces this node's (an `ask` asks for a tier; a pipeline's steps keep theirs). */
  callerTier?: boolean
  /** `caller`: the caller's session or `persist`; `persistent`: the caller's session or a new one. */
  conversation: 'temporary' | 'persistent' | 'caller'
  /** Acceptance contract the node's result must pass (REQ-WRK-3). */
  acceptance: string
}

export interface CallerOptions {
  tier?: Tier | undefined
  sessionId?: string | undefined
  persist?: boolean | undefined
}

export interface ResolvedNode extends Omit<NodeTemplate, 'callerTier' | 'conversation'> {
  dependsOn: string[]
  /** `caller` when the caller's tier replaced the template's (`work-requirement` tier source). */
  tierSource: 'caller' | 'profile'
  feature: Feature
  session: { sessionId?: string; persist?: boolean }
}

export interface ResolvedSpec {
  template: string
  nodes: ResolvedNode[]
  specHash: ContentId
}

const COMPACT_PROMPT = [
  'Compact the research report below into a synthesis for another AI agent that will act on it.',
  'Keep every key finding, number, recommendation, and caveat. Keep each claim\'s source link inline as a full URL.',
  'Use short sections and bullets. Add nothing that the report does not say.',
  '',
  '<report>',
  '{{node:research:1}}',
  '</report>',
].join('\n')

export const DEFAULT_TEMPLATES: Record<string, NodeTemplate[]> = {
  ask: [
    { nodeId: 'ask:1', objective: 'Answer the caller\'s prompt', prompt: '{{input}}', tier: 'standard', callerTier: true, conversation: 'caller', acceptance: 'acceptance.answer' },
  ],
  research: [
    {
      nodeId: 'research:1', objective: 'Write a cited Deep research report on the caller\'s question', prompt: '{{input}}',
      feature: 'deep-research', tier: 'frontier', conversation: 'persistent', acceptance: 'acceptance.answer',
    },
    {
      nodeId: 'compact:1', objective: 'Compact the report into a cited synthesis', dependsOn: ['research:1'], prompt: COMPACT_PROMPT,
      tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.answer',
    },
  ],
}

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
const REFERENCE = /\{\{node:([^}]+)\}\}/g

/** Validate a template; returns node ids in a dependency order. Throws on any defect. */
export function preflight(nodes: readonly NodeTemplate[]): string[] {
  if (!nodes.length) throw new TypeError('the workflow has no nodes')
  const byId = new Map<string, NodeTemplate>()
  for (const node of nodes) {
    if (!NODE_ID.test(node.nodeId)) throw new TypeError(`node id ${JSON.stringify(node.nodeId)} is not a valid id`)
    if (byId.has(node.nodeId)) throw new TypeError(`duplicate node ${node.nodeId}`)
    byId.set(node.nodeId, node)
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) if (!byId.has(dep)) throw new TypeError(`node ${node.nodeId} depends on unknown node ${dep}`)
    for (const [, used] of node.prompt.matchAll(REFERENCE)) {
      if (!(node.dependsOn ?? []).includes(used!)) throw new TypeError(`node ${node.nodeId} uses ${used}, which it does not depend on`)
    }
  }
  const order: string[] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') throw new TypeError(`the workflow has a cycle through ${id}`)
    state.set(id, 'visiting')
    for (const dep of byId.get(id)!.dependsOn ?? []) visit(dep)
    state.set(id, 'done')
    order.push(id)
  }
  for (const node of nodes) visit(node.nodeId)
  const used = new Set(nodes.flatMap((n) => n.dependsOn ?? []))
  const finals = nodes.filter((n) => !used.has(n.nodeId))
  if (finals.length !== 1) throw new TypeError(`a workflow needs exactly one final node, whose result is the run's; found ${finals.map((n) => n.nodeId).join(', ')}`)
  return order
}

/** Apply the caller's options to a validated template, in dependency order, and hash the result. */
export function resolve(template: string, nodes: readonly NodeTemplate[], caller: CallerOptions): ResolvedSpec {
  const order = preflight(nodes)
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const resolved = order.map((id): ResolvedNode => {
    const { callerTier, conversation, ...node } = byId.get(id)!
    const session = conversation === 'temporary'
      ? {}
      : caller.sessionId
        ? { sessionId: caller.sessionId }
        : conversation === 'persistent' || caller.persist ? { persist: true } : {}
    const fromCaller = !!(callerTier && caller.tier)
    return { ...node, dependsOn: node.dependsOn ?? [], feature: node.feature ?? 'chat', tier: fromCaller ? caller.tier! : node.tier, tierSource: fromCaller ? 'caller' : 'profile', session }
  })
  return { template, nodes: resolved, specHash: contentId({ template, nodes: resolved }) }
}

/** Fill a prompt in one pass, so text from a dependency is never expanded again. */
export function render(prompt: string, input: string, results: Readonly<Record<string, string>>): string {
  return prompt.replace(/\{\{(input|node:[^}]+)\}\}/g, (_, key: string) => (key === 'input' ? input : results[key.slice(5)] ?? ''))
}
