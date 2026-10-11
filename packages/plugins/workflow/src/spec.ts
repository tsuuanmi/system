/**
 * Static workflow specs (MVP subset of docs/design/workflow-engine.md): templates are data,
 * preflight validates a DAG before anything runs, and a resolved spec is hashed so a run
 * binds to exactly what was admitted.
 */
import { contentId, type ContentId } from '@tsuuanmi/system-libs'
import { TIERS, type Tier } from '@tsuuanmi/system-workers-core'

export interface NodeTemplate {
  nodeId: string
  objective: string
  dependsOn?: string[]
  /** `{{input}}` is the caller's text; `{{node:<id>}}` a dependency's result, verbatim. */
  prompt: string
  /** Capabilities the node needs (docs/design/routing.md#capability-vocabulary); routing admits Workers by them. */
  capabilities: string[]
  /** Minimum tier (REQ-WRK-9). */
  tier: Tier
  /** The caller's `tier` replaces this node's (an `ask` asks for a tier; a pipeline's steps keep theirs). */
  callerTier?: boolean
  /** `caller`: the caller's session or `persist`; `persistent`: the caller's session or a new one. */
  conversation: 'temporary' | 'persistent' | 'caller'
  /** Acceptance contract the node's result must pass (REQ-WRK-3). */
  acceptance: string
  /** Times a rejected result is retried at the next tier up (REQ-WRK-9; default 1, at most 3). */
  maxEscalations?: number
  /**
   * A planner: its accepted answer carries a JSON plan of further steps, appended after it
   * (graph growth, REQ-WF-8). Its dependents wait for those steps and read them as `{{grown}}`.
   */
  grows?: GrowthPolicy
}

export interface GrowthPolicy {
  /** At most this many appended steps (default 6). */
  maxNodes?: number
  /** Capabilities a step may require (default reason, web-search, review, local-data). */
  capabilities?: string[]
  /** Capabilities whose steps wait for an operator's approval of the exact plan (default develop; REQ-WF-11). */
  approvalRequired?: string[]
}

export const DEFAULT_GROWTH = { maxNodes: 6, capabilities: ['reason', 'web-search', 'review', 'local-data'], approvalRequired: ['develop'] }

/** One validated step of a plan, its id under the planner's prefix. */
export interface PlannedNode {
  nodeId: string
  objective: string
  prompt: string
  capabilities: string[]
  tier: Tier
  dependsOn: string[]
}

export type ParsedPlan = { ok: true; confidence: 'low' | 'medium' | 'high'; nodes: PlannedNode[] } | { ok: false; reason: string }

export interface CallerOptions {
  tier?: Tier | undefined
  sessionId?: string | undefined
  persist?: boolean | undefined
}

export interface ResolvedNode extends Omit<NodeTemplate, 'callerTier' | 'conversation'> {
  dependsOn: string[]
  /** `caller` when the caller's tier replaced the template's; `decision` for a step a plan added. */
  tierSource: 'caller' | 'profile' | 'decision'
  /** The `graph-growth` decision that set a plan step's tier. */
  tierDecision?: string
  /** `gate` waits for an operator's approval of `plan`; default `worker`. */
  executor?: 'worker' | 'gate'
  /** The plan artifact a gate approves. */
  plan?: string
  /** A plan step's prompt is model text: used as it is, never expanded as a template. */
  literal?: boolean
  session: { sessionId?: string; persist?: boolean }
}

export interface ResolvedSpec {
  template: string
  nodes: ResolvedNode[]
  specHash: ContentId
}

const PLAN_PROMPT = [
  'Plan how to answer the question below in at most 4 independent or chained research steps for another assistant.',
  'Reply with only a JSON object in a ```json block, shaped like:',
  '{"confidence": "high", "nodes": [{"id": "step-1", "objective": "...", "prompt": "the full question for this step", "capabilities": ["reason"], "tier": "economy", "dependsOn": []}]}',
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

export const DEFAULT_TEMPLATES: Record<string, NodeTemplate[]> = {
  ask: [
    { nodeId: 'ask:1', objective: 'Answer the caller\'s prompt', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', callerTier: true, conversation: 'caller', acceptance: 'acceptance.answer' },
  ],
  investigate: [
    {
      nodeId: 'plan:1', objective: 'Plan research steps for the caller\'s question', prompt: PLAN_PROMPT, capabilities: ['reason'],
      tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', grows: { maxNodes: 4 },
    },
    {
      nodeId: 'synthesis:1', objective: 'Answer from the steps\' findings', dependsOn: ['plan:1'], prompt: SYNTHESIS_PROMPT, capabilities: ['reason'],
      tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer',
    },
  ],
  review: [
    {
      nodeId: 'review:1', objective: 'Review the caller\'s subject on this machine and report findings', prompt: '{{input}}',
      capabilities: ['review', 'local-data'], tier: 'standard', callerTier: true, conversation: 'caller', acceptance: 'acceptance.answer',
    },
  ],
  research: [
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
    if (node.grows !== undefined && node.grows !== null) checkGrowth(node.nodeId, node.grows)
    for (const dep of node.dependsOn ?? []) if (!byId.has(dep)) throw new TypeError(`node ${node.nodeId} depends on unknown node ${dep}`)
    for (const [, used] of node.prompt.matchAll(REFERENCE)) {
      if (!(node.dependsOn ?? []).includes(used!)) throw new TypeError(`node ${node.nodeId} uses ${used}, which it does not depend on`)
    }
    if (node.prompt.includes('{{grown}}') && !(node.dependsOn ?? []).some((dep) => byId.get(dep)?.grows)) {
      throw new TypeError(`node ${node.nodeId} uses {{grown}} but depends on no planner`)
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

function checkGrowth(nodeId: string, grows: unknown): void {
  const policy = grows as Record<string, unknown>
  const strings = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
  const maxNodes = policy?.maxNodes
  if (typeof policy !== 'object' || Array.isArray(policy)
    || (maxNodes !== undefined && !(Number.isInteger(maxNodes) && (maxNodes as number) >= 1 && (maxNodes as number) <= 32))
    || !strings(policy.capabilities) || !strings(policy.approvalRequired)) {
    throw new TypeError(`node ${nodeId}: grows must be {maxNodes (1-32), capabilities, approvalRequired}`)
  }
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
    return { ...node, dependsOn: node.dependsOn ?? [], tier: fromCaller ? caller.tier! : node.tier, tierSource: fromCaller ? 'caller' : 'profile', session }
  })
  return { template, nodes: resolved, specHash: contentId({ template, nodes: resolved }) }
}

/** Fill a prompt in one pass, so text from a dependency is never expanded again. */
export function render(prompt: string, input: string, results: Readonly<Record<string, string>>, grown = ''): string {
  return prompt.replace(/\{\{(input|grown|node:[^}]+)\}\}/g, (_, key: string) => (key === 'input' ? input : key === 'grown' ? grown : results[key.slice(5)] ?? ''))
}

const STEP_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

/**
 * Read the plan from a planner's answer: untrusted model output, so every bound is checked
 * here (REQ-WF-10). Steps get ids under the planner's prefix and may depend only on each
 * other; the plan must be acyclic, within `maxNodes`, and use allowed capabilities only.
 */
export function parsePlan(text: string, planner: string, policy: { maxNodes: number; capabilities: string[] }): ParsedPlan {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1]
  const raw = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let value: { confidence?: unknown; nodes?: unknown }
  try {
    value = JSON.parse(raw) as typeof value
  } catch {
    return { ok: false, reason: 'the answer carries no JSON plan' }
  }
  if (!['low', 'medium', 'high'].includes(String(value.confidence))) return { ok: false, reason: 'the plan states no confidence (low, medium, or high)' }
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) return { ok: false, reason: 'the plan has no steps' }
  if (value.nodes.length > policy.maxNodes) return { ok: false, reason: `the plan has ${value.nodes.length} steps; at most ${policy.maxNodes} are allowed` }
  const ids = new Set<string>()
  const nodes: PlannedNode[] = []
  for (const item of value.nodes as Array<Record<string, unknown>>) {
    const id = String(item?.id ?? '')
    if (!STEP_ID.test(id)) return { ok: false, reason: `step id ${JSON.stringify(id)} is not a short lowercase id` }
    if (ids.has(id)) return { ok: false, reason: `duplicate step ${id}` }
    ids.add(id)
    const objective = typeof item.objective === 'string' ? item.objective.trim() : ''
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    if (!objective || objective.length > 4000 || !prompt || prompt.length > 32_000) return { ok: false, reason: `step ${id} needs an objective and a prompt within bounds` }
    const capabilities = Array.isArray(item.capabilities) ? item.capabilities.map(String) : []
    const refused = capabilities.filter((c) => !policy.capabilities.includes(c))
    if (!capabilities.length || refused.length) return { ok: false, reason: `step ${id} requires ${refused.join(', ') || 'no capability'}; allowed: ${policy.capabilities.join(', ')}` }
    if (!TIERS.includes(item.tier as Tier)) return { ok: false, reason: `step ${id} names no known tier` }
    const deps = Array.isArray(item.dependsOn) ? item.dependsOn.map(String) : []
    nodes.push({ nodeId: `${planner}:${id}`, objective, prompt, capabilities: [...new Set(capabilities)], tier: item.tier as Tier, dependsOn: deps })
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) if (!ids.has(dep)) return { ok: false, reason: `step ${node.nodeId} depends on unknown step ${dep}` }
    node.dependsOn = [...new Set(node.dependsOn)].map((dep) => `${planner}:${dep}`)
  }
  // Acyclic: repeatedly take steps whose dependencies are taken.
  const taken = new Set<string>()
  while (taken.size < nodes.length) {
    const ready = nodes.filter((n) => !taken.has(n.nodeId) && n.dependsOn.every((d) => taken.has(d)))
    if (!ready.length) return { ok: false, reason: 'the plan has a cycle' }
    for (const n of ready) taken.add(n.nodeId)
  }
  return { ok: true, confidence: value.confidence as 'low' | 'medium' | 'high', nodes }
}
