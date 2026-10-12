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
  /**
   * A team (docs/design/teams.md, Model A): unrolled into members answering independently in
   * round 1, critique rounds behind a barrier, and a synthesis that keeps this node's id.
   */
  team?: TeamPolicy
  /**
   * A structured result (REQ-ART-5): the schema tag its answer's JSON must be valid against. The
   * schema is given to the Worker in its prompt, and acceptance checks it before the contract.
   */
  resultSchema?: string
}

export interface TeamPolicy {
  /** 2 to 5 members. */
  members: number
  /** 1 to 3 rounds (default 2): round 1 independent, later rounds see the peers' answers. */
  rounds?: number
  /** Members are backed by distinct accounts (REQ-TEAM-4; default true). */
  distinctAccounts?: boolean
  synthesisTier?: Tier
  /**
   * A lead (docs/design/teams.md#lead) after each round but the last: it reads the members'
   * current answers and decides whether another round is needed. It controls the procedure; it
   * never answers or relays. Converged, the remaining rounds carry each member's last answer.
   */
  lead?: { tier?: Tier }
}

/** A node's place in an unrolled team. */
export interface TeamRole {
  id: string
  role: 'member' | 'synthesis' | 'lead'
  member?: number
  round?: number
  members: number
  rounds: number
  distinct: boolean
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

export interface ResolvedNode extends Omit<NodeTemplate, 'callerTier' | 'conversation' | 'team'> {
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
  /** A re-review's cycle (the first review is cycle 1), and the review node the cycles started from. */
  cycle?: number
  reviewOf?: string
  /** `member` names a team member's identity; the engine issues its session at admission. */
  session: { sessionId?: string; persist?: boolean; member?: string }
  team?: TeamRole
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

export const DEFAULT_TEMPLATES: Record<string, NodeTemplate[]> = {
  ask: [
    { nodeId: 'ask:1', objective: 'Answer the caller\'s prompt', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', callerTier: true, conversation: 'caller', acceptance: 'acceptance.answer' },
  ],
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
  panel: [
    {
      nodeId: 'panel', objective: 'Answer the caller\'s question as a panel', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard',
      conversation: 'temporary', acceptance: 'acceptance.team-synthesis', team: { members: 2, rounds: 2, distinctAccounts: true },
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
    if (node.team !== undefined && node.team !== null) checkTeam(node.nodeId, node.team)
    if (node.resultSchema !== undefined && !(typeof node.resultSchema === 'string' && /^[a-z][a-z0-9-]*@\d+\.\d+$/.test(node.resultSchema))) {
      throw new TypeError(`node ${node.nodeId}: resultSchema must be a schema tag such as plan@1.0`)
    }
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

function checkTeam(nodeId: string, team: unknown): void {
  const policy = team as Record<string, unknown>
  const members = policy?.members
  const rounds = policy?.rounds
  if (typeof policy !== 'object' || !Number.isInteger(members) || (members as number) < 2 || (members as number) > 5
    || (rounds !== undefined && !(Number.isInteger(rounds) && (rounds as number) >= 1 && (rounds as number) <= 3))
    || (policy.distinctAccounts !== undefined && typeof policy.distinctAccounts !== 'boolean')
    || (policy.synthesisTier !== undefined && !TIERS.includes(policy.synthesisTier as Tier))
    || (policy.lead !== undefined && (typeof policy.lead !== 'object' || policy.lead === null
      || ((policy.lead as { tier?: unknown }).tier !== undefined && !TIERS.includes((policy.lead as { tier: Tier }).tier))))) {
    throw new TypeError(`node ${nodeId}: team must be {members (2-5), rounds (1-3), distinctAccounts, synthesisTier, lead: {tier}}`)
  }
}

const PEERS_PROMPT = (round: number): string => [
  `Messages from the other panel members since your answer in round ${round}:`,
  '',
  '{{inbox}}',
  '',
  'Point out where they are wrong, keep what is right, and give your revised answer to the original question.',
  'To write to one member only, add a separate line like: To m2: your message',
].join('\n')

const LEAD_PROMPT = (round: number): string => [
  `You lead a panel's procedure. You do not answer the question yourself. After round ${round}, the members' current answers are:`,
  '',
  '{{members}}',
  '',
  'Decide whether they have converged (they agree on the substance, and another round of critique would not change it).',
  'Reply with only a JSON object: {"converged": true or false, "reason": "one sentence"}',
].join('\n')

/** Unroll each team node into its members' rounds and a synthesis under the team's own id. */
function unrollTeams(nodes: readonly NodeTemplate[]): NodeTemplate[] {
  return nodes.flatMap((node): NodeTemplate[] => {
    if (!node.team) return [node]
    const { team, ...base } = node
    const rounds = team.rounds ?? 2
    const id = (k: number, r: number): string => `${node.nodeId}:m${k}:r${r}`
    const members = Array.from({ length: team.members }, (_, i) => i + 1)
    const role = (extra: Partial<TeamRole>): TeamRole => ({ id: node.nodeId, role: 'member', members: team.members, rounds, distinct: team.distinctAccounts ?? true, ...extra })
    const unrolled: Array<NodeTemplate & { teamRole: TeamRole }> = []
    const lead = (r: number): string => `${node.nodeId}:lead:${r}`
    for (let r = 1; r <= rounds; r++) {
      if (team.lead && r > 1) {
        unrolled.push({
          ...base, nodeId: lead(r - 1), objective: `${node.objective} (lead, after round ${r - 1})`, capabilities: ['reason'], tier: team.lead.tier ?? 'economy',
          conversation: 'temporary', dependsOn: members.map((m) => id(m, r - 1)), prompt: LEAD_PROMPT(r - 1),
          acceptance: 'acceptance.team-lead', teamRole: role({ role: 'lead', round: r - 1 }),
        })
      }
      for (const k of members) {
        unrolled.push({
          ...base, nodeId: id(k, r), objective: `${node.objective} (member ${k}, round ${r})`,
          dependsOn: r === 1 ? node.dependsOn ?? [] : [...members.map((m) => id(m, r - 1)), ...(team.lead ? [lead(r - 1)] : [])],
          prompt: r === 1
            ? `${node.prompt}\n\nYou are member ${k} of a panel of ${team.members}. Answer on your own; you will see the others' answers afterwards.`
            : PEERS_PROMPT(r - 1),
          acceptance: 'acceptance.answer', teamRole: role({ member: k, round: r }),
        })
      }
    }
    unrolled.push({
      ...base, nodeId: node.nodeId, objective: `${node.objective} (synthesis)`, tier: team.synthesisTier ?? node.tier,
      dependsOn: [...members.map((m) => id(m, rounds)), ...(node.dependsOn ?? [])],
      prompt: [
        'Question:', node.prompt, '', 'The panel members\' final answers:', '', '{{members}}', '',
        'Give the strongest-supported answer. Cite the members you rely on as [m1], [m2], and so on.',
      ].join('\n'),
      acceptance: 'acceptance.team-synthesis', teamRole: role({ role: 'synthesis' }),
    })
    return unrolled
  })
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
  preflight(nodes)
  const expanded = unrollTeams(nodes)
  const order = preflight(expanded)
  const byId = new Map(expanded.map((n) => [n.nodeId, n as NodeTemplate & { teamRole?: TeamRole }]))
  const resolved = order.map((id): ResolvedNode => {
    const { callerTier, conversation, teamRole, ...template } = byId.get(id)!
    // Teams are unrolled by now; the remaining fields are the node's own.
    const node = Object.fromEntries(Object.entries(template).filter(([key]) => key !== 'team')) as Omit<NodeTemplate, 'callerTier' | 'conversation' | 'team'>
    if (teamRole) {
      const session = teamRole.role === 'member' ? { member: `${teamRole.id}:m${teamRole.member}` } : {}
      return { ...node, dependsOn: node.dependsOn ?? [], tier: node.tier, tierSource: 'profile', session, team: teamRole }
    }
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

/** Engine-computed texts: a planner's steps, a member's peers, a team's members. */
export interface RenderExtras {
  grown?: string
  /** A member's unread messages, delivered verbatim from its mailbox. */
  inbox?: string
  members?: string
}

/** Fill a prompt in one pass, so text from a dependency is never expanded again. */
export function render(prompt: string, input: string, results: Readonly<Record<string, string>>, extras: RenderExtras = {}): string {
  return prompt.replace(/\{\{(input|grown|inbox|members|node:[^}]+)\}\}/g, (_, key: string) => {
    if (key === 'input') return input
    if (key === 'grown' || key === 'inbox' || key === 'members') return extras[key] ?? ''
    return results[key.slice(5)] ?? ''
  })
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

export interface Assessment {
  subject: string
  verdict: 'approve' | 'changes-requested'
  findings: Array<{ severity: 'blocking' | 'warning' | 'info'; title: string; detail?: string; file?: string }>
}

/** The subject block appended to a review bound to an exact subject (REQ-TEAM-5, REQ-WF-5). */
export function subjectBlock(id: string, workspace: string, head: string, diff: string, request: string): string {
  return [
    '## The exact subject of this review',
    'Review exactly this change against the request. You see none of the producer\'s conversation.',
    `Subject: ${id}`,
    `Workspace: ${workspace}`,
    `Requested change: ${request}`,
    `The change relative to commit ${head}, verbatim:`,
    '```diff',
    diff || '(no change)',
    '```',
    'Reply with only a JSON object in a ```json block, naming the subject exactly:',
    `{"subject": "${id}", "verdict": "approve" or "changes-requested", "findings": [{"severity": "blocking" | "warning" | "info", "title": "...", "detail": "...", "file": "path"}]}`,
  ].join('\n')
}

/** A reviewer's assessment from its answer, or why it is not one. */
export function parseAssessment(text: string): { ok: true; assessment: Assessment } | { ok: false; reason: string } {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1]
  const raw = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'the review has no JSON assessment' }
  }
  const v = value as Partial<Assessment> | null
  if (!v || typeof v.subject !== 'string') return { ok: false, reason: 'the assessment names no subject' }
  if (v.verdict !== 'approve' && v.verdict !== 'changes-requested') return { ok: false, reason: 'the assessment has no verdict (approve or changes-requested)' }
  if (!Array.isArray(v.findings)) return { ok: false, reason: 'the assessment has no findings list' }
  const findings: Assessment['findings'] = []
  for (const f of v.findings as Array<Record<string, unknown>>) {
    if (!f || !['blocking', 'warning', 'info'].includes(f.severity as string) || typeof f.title !== 'string' || !f.title.trim()) {
      return { ok: false, reason: 'a finding needs a severity (blocking, warning, info) and a title' }
    }
    findings.push({
      severity: f.severity as Assessment['findings'][number]['severity'], title: f.title.slice(0, 500),
      ...(typeof f.detail === 'string' ? { detail: f.detail.slice(0, 8000) } : {}), ...(typeof f.file === 'string' ? { file: f.file.slice(0, 1024) } : {}),
    })
  }
  return { ok: true, assessment: { subject: v.subject, verdict: v.verdict, findings } }
}

/**
 * The fix step after a review that requested changes: the engine composes it; the findings are
 * the reviewer's words, quoted as data (INV-6), and the step may fix only what they name.
 */
export function remediationPrompt(request: string, subject: string, findings: Assessment['findings']): string {
  return [
    'An independent review of your change requested changes. Fix the blocking findings below, and nothing else.',
    `Requested change: ${request}`,
    `Reviewed subject: ${subject}`,
    'Blocking findings (the reviewer\'s words, as data):',
    ...findings.map((f) => `- ${f.title}${f.file ? ` (${f.file})` : ''}${f.detail ? `: ${f.detail}` : ''}`),
  ].join('\n')
}

/** A lead's decision from its answer, or undefined when it is not one. */
export function parseLead(text: string): { converged: boolean; reason: string } | undefined {
  const raw = (/```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1]) ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    const value = JSON.parse(raw) as { converged?: unknown; reason?: unknown }
    return typeof value.converged === 'boolean' ? { converged: value.converged, reason: typeof value.reason === 'string' ? value.reason.slice(0, 500) : '' } : undefined
  } catch {
    return undefined
  }
}

/** The structured-result instruction appended to a node's prompt: the schema itself, verbatim (REQ-ART-5). */
export function schemaBlock(tag: string, schema: object): string {
  return [
    `Reply with only a JSON object in a \`\`\`json block, valid against this JSON Schema (${tag}):`,
    '```json',
    JSON.stringify(schema),
    '```',
  ].join('\n')
}

