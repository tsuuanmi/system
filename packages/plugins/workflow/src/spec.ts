/**
 * Static workflow specs (MVP subset of docs/design/workflow-engine.md): templates are data,
 * preflight validates a DAG before anything runs, and a resolved spec is hashed so a run
 * binds to exactly what was admitted.
 */
import { BRIEF_LIMITS, type BriefPointer, type BriefSegment, contentId, type ContentId, extractJson } from '@tsuuanmi/system-libs'
import { type ArtifactRef, TIERS, type Tier } from '@tsuuanmi/system-workers-core'

export interface NodeTemplate {
  nodeId: string
  objective: string
  dependsOn?: string[]
  /**
   * `{{input}}` is the caller's text; `{{node:<id>}}` a dependency's result, verbatim; `{{grown}}`
   * a planner's steps. Any other `{{` is refused at preflight: the engine fills every placeholder.
   */
  prompt: string
  /** Capabilities the node needs (docs/design/routing.md#capability-vocabulary); routing admits Workers by them. */
  capabilities: string[]
  /** Minimum tier (REQ-WRK-9). */
  tier: Tier
  /** The caller's `tier` replaces this node's (an `ask` asks for a tier; a pipeline's steps keep theirs). */
  callerTier?: boolean
  /**
   * `caller`: the caller's session or `persist`; `persistent`: the caller's session or a new one;
   * `own`: a new persistent conversation of this node alone, for steps that run in parallel.
   */
  conversation: 'temporary' | 'persistent' | 'caller' | 'own'
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
   * A team (docs/design/teams.md, Model A): unrolled into members proposing independently, sealed
   * ballots, a deterministic tally, a debate only on disagreement, and a decision that keeps this
   * node's id.
   */
  team?: TeamPolicy
  /**
   * A structured result (REQ-ART-5): the schema tag its answer's JSON must be valid against. The
   * schema is given to the Worker in its prompt, and acceptance checks it before the contract.
   */
  resultSchema?: string
  /**
   * Named variants of this node (`research`'s `deep`): fields that replace the node's own when the
   * caller starts the run with that variant. The chosen fields are part of the run's spec hash.
   */
  variants?: Record<string, NodeVariant>
  /**
   * Nodes whose Workers this node's Worker must differ from in provider family (ADR-0027): routing
   * excludes their families, and the node routes only once those nodes have a Worker.
   */
  differentFrom?: string[]
  /**
   * A source step (PROP-0004 Phase 4), run by the engine and no Worker: the caller's repository at
   * one pinned commit, or else the caller's text, as line-numbered files a review quotes. Its
   * result renders as `{{node:<id>}}`.
   */
  snapshot?: true
}

/** What a variant may change of a node: what it needs, where it runs, and how it is judged. */
export type NodeVariant = Partial<Pick<NodeTemplate, 'objective' | 'prompt' | 'capabilities' | 'tier' | 'conversation' | 'acceptance'>>

export interface TeamPolicy {
  /** `brainstorm`: each member's recommendation is an option. `review`: the options are `pass` and `changes`, over the members' findings. */
  kind: TeamKind
  /** 2 to 5 members (default 2), each on a provider family no earlier member has (ADR-0027). */
  members?: number
  /** Debate rounds after a split vote (0 to 2, default 1); each ends in a re-vote. */
  debateRounds?: number
}

export type TeamKind = 'brainstorm' | 'review'

/** The steps of an unrolled team: a member's proposal, ballot, and debate; the tally; the decision. */
export type TeamStep = 'propose' | 'ballot' | 'debate' | 'tally' | 'decide'

/** A node's place in an unrolled team. */
export interface TeamRole {
  id: string
  kind: TeamKind
  role: TeamStep
  member?: number
  /** A ballot's or a tally's voting round; a debate's round is the one it answers. */
  round?: number
  members: number
  debateRounds: number
}

export const TEAM_STEPS: readonly string[] = ['propose', 'ballot', 'debate', 'tally', 'decide']

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
  /** A variant some node of the template defines (NodeTemplate.variants). */
  variant?: string | undefined
  /** A public repository a source step reads at one commit; part of the spec hash. */
  repository?: RepositoryRequest | undefined
}

/** What a source step reads: a public repository, at a ref (default its HEAD), with the paths to read first. */
export interface RepositoryRequest {
  url: string
  ref?: string
  focus?: string[]
}

const VARIANT_FIELDS = new Set(['objective', 'prompt', 'capabilities', 'tier', 'conversation', 'acceptance'])
const TEXT = (v: unknown): boolean => typeof v === 'string' && v.length > 0

/** Variants stay narrow: plain Worker nodes only, only the fields a NodeVariant names, and valid values. */
function checkVariants(node: NodeTemplate): void {
  if (node.team || node.grows) throw new TypeError(`node ${node.nodeId}: a team or a planner has no variants`)
  for (const [name, variant] of Object.entries(node.variants!)) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new TypeError(`node ${node.nodeId}: variant name ${JSON.stringify(name)} is not lowercase letters, digits, and hyphens`)
    const fields = (variant ?? {}) as Record<string, unknown>
    const extra = Object.keys(fields).filter((key) => !VARIANT_FIELDS.has(key))
    if (extra.length) throw new TypeError(`node ${node.nodeId}, variant ${name}: ${extra.join(', ')} cannot vary`)
    const bad = Object.entries(fields).filter(([key, value]) => !(
      key === 'tier' ? ['economy', 'standard', 'frontier'].includes(value as string)
        : key === 'conversation' ? ['temporary', 'persistent', 'caller', 'own'].includes(value as string)
          : key === 'capabilities' ? Array.isArray(value) && value.length > 0 && value.every(TEXT)
            : TEXT(value)))
    if (bad.length) throw new TypeError(`node ${node.nodeId}, variant ${name}: invalid ${bad.map(([key]) => key).join(', ')}`)
  }
}

/** The variants a template defines, sorted. */
export function variantsOf(nodes: readonly NodeTemplate[]): string[] {
  return [...new Set(nodes.flatMap((n) => Object.keys(n.variants ?? {})))].sort()
}

/** Why `variant` cannot be used with this template, or `undefined` when it can (or none is asked). */
export function variantProblem(template: string, nodes: readonly NodeTemplate[], variant: string | undefined): string | undefined {
  if (variant === undefined || variantsOf(nodes).includes(variant)) return undefined
  return `template ${template} has no variant ${variant} (it has: ${variantsOf(nodes).join(', ') || 'none'})`
}

export interface ResolvedNode extends Omit<NodeTemplate, 'callerTier' | 'conversation' | 'team' | 'variants'> {
  dependsOn: string[]
  /** `caller` when the caller's tier replaced the template's; `decision` for a step a plan added. */
  tierSource: 'caller' | 'profile' | 'decision'
  /** The `graph-growth` decision that set a plan step's tier. */
  tierDecision?: string
  /**
   * `gate` waits for an operator's approval of `plan`; `tally` and `decide` are a team's
   * deterministic steps (docs/design/teams.md); `snapshot` reads a review's source; default `worker`.
   */
  executor?: 'worker' | 'gate' | 'tally' | 'decide' | 'snapshot'
  /** A source step's repository, from the caller. */
  repository?: RepositoryRequest
  /** The plan artifact a gate approves. */
  plan?: string
  /**
   * Text used as it is, never expanded as a template: a plan step's prompt (model text), a
   * remediation fix's engine-composed prompt, and a re-review of a plan step. A re-review of a
   * template's review is composed as that review (review.ts `wordingOf`).
   */
  literal?: boolean
  /**
   * On a planner: its next plan's gate needs the operator, never `autoApprovePlans`, because a
   * step of its retired plan that needed approval already started. On a gate: it needs the operator.
   */
  operatorApproval?: true
  /**
   * The node that grew this one (a planner's plan step or gate, a review's remediation step), and
   * that node's generation then: what a re-plan retires, by origin, never by id.
   */
  grownBy?: { node: string; generation: number }
  /** How many times this node's growth was retired and grown again (default 1); later growth gets `:g<n>` ids. */
  generation?: number
  /**
   * On a remediation fix's gate: the exact subject the review that asked for the fix was bound to
   * (`git:<HEAD>:<hash>`). Such a gate puts its plan to the approval queue (`ctx.approvals`, class
   * `remediation`) when one is loaded, and is the operator's plan gate otherwise.
   */
  remediation?: { subject: string }
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

/**
 * Built-in templates (PROP-0004): `ask`, and the teams `brainstorm` and `review`. Profiles add
 * domain procedures (`research`; `agent-review`, for agent Workers).
 */
export const DEFAULT_TEMPLATES: Record<string, NodeTemplate[]> = {
  ask: [
    { nodeId: 'ask:1', objective: 'Answer the caller\'s prompt', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard', callerTier: true, conversation: 'caller', acceptance: 'acceptance.answer' },
  ],
  brainstorm: [
    {
      nodeId: 'brainstorm', objective: 'Decide the caller\'s question as a team', prompt: '{{input}}', capabilities: ['reason'], tier: 'standard',
      conversation: 'temporary', acceptance: 'acceptance.team-proposal', team: { kind: 'brainstorm' },
    },
  ],
  review: [
    {
      nodeId: 'source', objective: 'Read the material under review: the caller\'s repository at one commit, or the caller\'s text', prompt: '',
      capabilities: ['reason'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.answer', snapshot: true,
    },
    {
      nodeId: 'review', objective: 'Review the caller\'s material as a team', prompt: '{{input}}\n\n{{node:source}}', capabilities: ['reason'], tier: 'standard',
      conversation: 'temporary', acceptance: 'acceptance.team-findings', team: { kind: 'review' }, dependsOn: ['source'],
    },
  ],
}

const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/
/** A `{{node:<id>}}` reference: an id as NODE_ID allows, bounded, so a long unclosed run cannot backtrack. */
const REFERENCE = /\{\{node:([A-Za-z0-9._:/-]{1,200})\}\}/g
/** The placeholders the engine fills, matched where a `{{` starts. */
const PLACEHOLDER = /\{\{(input|grown|team|node:[A-Za-z0-9._:/-]{1,200})\}\}/y

/** A `{{` in a template's text: the placeholder it opens (`key`), or none the engine fills (`key` absent). */
interface Placeholder {
  index: number
  end: number
  key?: string
  /** As written, bounded, for a message. */
  text: string
}

/**
 * Every `{{` in a template's text. Each must open a placeholder the engine fills; one that opens
 * none (an unknown name, a different spelling, no closing `}}`) is listed without a key, so it is
 * refused, never passed to a Worker as it is.
 */
function placeholdersIn(prompt: string): Placeholder[] {
  const found: Placeholder[] = []
  for (let at = prompt.indexOf('{{'); at >= 0;) {
    PLACEHOLDER.lastIndex = at
    const match = PLACEHOLDER.exec(prompt)
    if (match) {
      found.push({ index: at, end: at + match[0].length, key: match[1]!, text: match[0] })
      at = prompt.indexOf('{{', at + match[0].length)
      continue
    }
    const close = prompt.indexOf('}}', at + 2)
    found.push({ index: at, end: at + 2, text: close >= 0 && close - at <= 80 ? prompt.slice(at, close + 2) : `${prompt.slice(at, at + 40)}…` })
    at = prompt.indexOf('{{', at + 2)
  }
  return found
}

/** What a node's template text may be filled from: its dependencies' results by id, a planner's steps, a team step's engine-composed prompt. */
export interface PlaceholderScope {
  refs: Readonly<Record<string, unknown>>
  grown: boolean
  team: boolean
}

/**
 * The placeholders in a template's text that the engine cannot fill for a node with this scope,
 * as written: a name it does not define, a dependency it has no result of, `{{grown}}` with no
 * planner, `{{team}}` outside a team's ballot or debate. Text the engine never expands (the
 * caller's input, a dependency's result, a plan step's model text) is never scanned.
 */
export function unfilledPlaceholders(prompt: string, scope: PlaceholderScope): string[] {
  return [...new Set(placeholdersIn(prompt).filter((p) => !(
    p.key === 'input'
    || (p.key === 'grown' && scope.grown)
    || (p.key === 'team' && scope.team)
    || (p.key?.startsWith('node:') && scope.refs[p.key.slice(5)] !== undefined)
  )).map((p) => p.text))]
}

/** A template's text holds placeholders the engine cannot fill: its instructions are never composed, and nothing is sent. */
export class UnfilledPlaceholders extends Error {
  constructor(readonly placeholders: string[]) {
    super(`the template's text holds ${placeholders.join(', ')}, which the engine does not fill`)
  }
}

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
    if (node.team !== undefined && node.team !== null) {
      checkTeam(node.nodeId, node.team)
      // A team's members differ from each other; its steps never plan or carry a result schema.
      if (node.differentFrom?.length || node.grows || node.resultSchema) throw new TypeError(`node ${node.nodeId}: a team has no differentFrom, grows, or resultSchema`)
    }
    if (node.variants !== undefined && node.variants !== null) checkVariants(node)
    if (node.snapshot && (node.team || node.grows || node.variants || node.differentFrom?.length || node.resultSchema)) {
      throw new TypeError(`node ${node.nodeId}: a source step has no team, grows, variants, differentFrom, or resultSchema`)
    }
    if (node.resultSchema !== undefined && !(typeof node.resultSchema === 'string' && /^[a-z][a-z0-9-]*@\d+\.\d+$/.test(node.resultSchema))) {
      throw new TypeError(`node ${node.nodeId}: resultSchema must be a schema tag such as plan@1.0`)
    }
    for (const dep of node.dependsOn ?? []) if (!byId.has(dep)) throw new TypeError(`node ${node.nodeId} depends on unknown node ${dep}`)
    for (const other of node.differentFrom ?? []) {
      if (other === node.nodeId || !byId.has(other)) throw new TypeError(`node ${node.nodeId} differs from ${other === node.nodeId ? 'itself' : `unknown node ${other}`}`)
      if (byId.get(other)!.team) throw new TypeError(`node ${node.nodeId} differs from team ${other}, which has several Workers`)
    }
    for (const [, used] of node.prompt.matchAll(REFERENCE)) {
      if (!(node.dependsOn ?? []).includes(used!)) throw new TypeError(`node ${node.nodeId} uses ${used}, which it does not depend on`)
    }
    if (node.prompt.includes('{{grown}}') && !(node.dependsOn ?? []).some((dep) => byId.get(dep)?.grows)) {
      throw new TypeError(`node ${node.nodeId} uses {{grown}} but depends on no planner`)
    }
    // Only a team's ballot, which the engine words itself, reads `{{team}}` (unrollTeams).
    const ballot = (node as NodeTemplate & { teamRole?: TeamRole }).teamRole?.role === 'ballot'
    const unknown = placeholdersIn(node.prompt).find((p) => !p.key || (p.key === 'team' && !ballot))
    if (unknown) {
      throw new TypeError(`node ${node.nodeId} uses ${unknown.text}, which is not a placeholder the engine fills: a prompt may use {{input}}, {{node:<id>}} of a node it depends on, and {{grown}} after a planner`)
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
  checkDifferentFrom(nodes)
  const used = new Set(nodes.flatMap((n) => n.dependsOn ?? []))
  const finals = nodes.filter((n) => !used.has(n.nodeId))
  if (finals.length !== 1) throw new TypeError(`a workflow needs exactly one final node, whose result is the run's; found ${finals.map((n) => n.nodeId).join(', ')}`)
  return order
}

/** Every node a node waits for, directly or through others. */
function ancestors(nodes: readonly { nodeId: string; dependsOn?: string[] }[]): Map<string, Set<string>> {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const memo = new Map<string, Set<string>>()
  const of = (id: string): Set<string> => {
    const known = memo.get(id)
    if (known) return known
    const all = new Set<string>()
    memo.set(id, all)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      all.add(dep)
      for (const a of of(dep)) all.add(a)
    }
    return all
  }
  for (const n of nodes) of(n.nodeId)
  return memo
}

/** Nodes on the run's one shared conversation must take turns: two that can run at once would interleave in it. */
function sharedSessionsInSequence(nodes: readonly ResolvedNode[]): void {
  const shared = nodes.filter((n) => n.session.persist || n.session.sessionId)
  const before = ancestors(nodes)
  for (const [i, a] of shared.entries()) {
    for (const b of shared.slice(i + 1)) {
      if (!before.get(a.nodeId)!.has(b.nodeId) && !before.get(b.nodeId)!.has(a.nodeId)) {
        throw new TypeError(`nodes ${a.nodeId} and ${b.nodeId} could run at once on the run's one conversation; give one of them conversation: own`)
      }
    }
  }
}

/**
 * A node waits for the nodes it must differ from to be promoted: none of them may wait for it, by
 * dependency or by its own differentFrom, or neither could ever start (ADR-0027).
 */
function checkDifferentFrom(nodes: readonly NodeTemplate[]): void {
  const after = new Map<string, string[]>(nodes.map((n) => [n.nodeId, []]))
  for (const n of nodes) {
    for (const dep of n.dependsOn ?? []) after.get(dep)?.push(n.nodeId)
    for (const peer of n.differentFrom ?? []) after.get(peer)?.push(n.nodeId)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): void => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'visiting') throw new TypeError(`node ${id} would wait for itself through differentFrom: a node cannot differ from one that waits for it`)
    state.set(id, 'visiting')
    for (const next of after.get(id) ?? []) visit(next)
    state.set(id, 'done')
  }
  for (const n of nodes) visit(n.nodeId)
}

function checkTeam(nodeId: string, team: unknown): void {
  const policy = team as Record<string, unknown>
  const members = policy?.members
  const debate = policy?.debateRounds
  const extra = typeof policy === 'object' && policy !== null ? Object.keys(policy).filter((key) => !['kind', 'members', 'debateRounds'].includes(key)) : []
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy) || extra.length || !['brainstorm', 'review'].includes(policy.kind as string)
    || (members !== undefined && !(Number.isInteger(members) && (members as number) >= 2 && (members as number) <= 5))
    || (debate !== undefined && !(Number.isInteger(debate) && (debate as number) >= 0 && (debate as number) <= 2))) {
    throw new TypeError(`node ${nodeId}: team must be {kind: brainstorm | review, members (2-5), debateRounds (0-2)}`)
  }
}

/** A brainstorm member's proposal: its recommendation is its option, verbatim. */
const PROPOSE: Record<TeamKind, string> = {
  brainstorm: [
    'End your answer with one JSON object:',
    '{"recommendation": "your recommendation, at most 2000 characters", "rationale": "why", "risks": ["what could go wrong"]}',
    'The recommendation is quoted verbatim to the other members as your option.',
  ].join('\n'),
  review: [
    'Review the material above against the request. Quote every finding: the file\'s path, the line number shown, and that line\'s text exactly as shown;',
    'a finding whose quote does not match the material is not confirmed. A suggestion without a defect is kind "suggestion".',
    'End your answer with one JSON object listing your findings (an empty list when you find no defect):',
    '{"findings": [{"severity": "blocking" | "warning" | "info", "kind": "defect" | "suggestion", "claim": "the defect", "evidence": "what shows it",',
    ' "quote": {"path": "src/a.ts", "line": 12, "text": "the exact text of that line"}}]}',
  ].join('\n'),
}

/**
 * Unroll each team node: each member proposes on its own (no peer text: the independent-first
 * barrier, made structural), then casts a sealed ballot over every option; a deterministic tally
 * records the vote, and appends a debate and re-vote on a split (growth); a deterministic decision
 * keeps the team node's id. Member k must differ in provider family from members 1..k-1.
 */
function unrollTeams(nodes: readonly NodeTemplate[]): NodeTemplate[] {
  return nodes.flatMap((node): NodeTemplate[] => {
    if (!node.team) return [node]
    const { team, ...base } = node
    const n = team.members ?? 2
    const members = Array.from({ length: n }, (_, i) => i + 1)
    const role = (extra: Pick<TeamRole, 'role'> & Partial<TeamRole>): TeamRole => ({ id: node.nodeId, kind: team.kind, members: n, debateRounds: team.debateRounds ?? 1, ...extra })
    const propose = (k: number): string => `${node.nodeId}:m${k}:propose`
    const ballot = (k: number): string => `${node.nodeId}:m${k}:ballot:1`
    const tally = `${node.nodeId}:tally:1`
    const step = { ...base, capabilities: ['reason'], tier: 'economy' as Tier, conversation: 'temporary' as const, acceptance: 'acceptance.answer' }
    return [
      ...members.map((k): NodeTemplate & { teamRole: TeamRole } => ({
        ...base, nodeId: propose(k), objective: `${node.objective} (member ${k}: proposal)`, dependsOn: node.dependsOn ?? [],
        prompt: `${node.prompt}\n\nYou are member ${k} of a team of ${n}. Answer on your own: the others answer independently, and you will see their proposals afterwards.\n\n${PROPOSE[team.kind]}`,
        acceptance: team.kind === 'review' ? 'acceptance.team-findings' : 'acceptance.team-proposal',
        ...(k > 1 ? { differentFrom: members.slice(0, k - 1).map(propose) } : {}),
        teamRole: role({ role: 'propose', member: k }),
      })),
      ...members.map((k): NodeTemplate & { teamRole: TeamRole } => ({
        ...base, nodeId: ballot(k), objective: `${node.objective} (member ${k}: ballot, round 1)`, dependsOn: members.map(propose),
        prompt: '{{team}}', acceptance: ballotContract(team.kind, n), teamRole: role({ role: 'ballot', member: k, round: 1 }),
      })),
      { ...step, nodeId: tally, objective: `${node.objective} (tally, round 1)`, dependsOn: members.map(ballot), prompt: '', executor: 'tally', teamRole: role({ role: 'tally', round: 1 }) } as NodeTemplate & { teamRole: TeamRole },
      { ...step, nodeId: node.nodeId, objective: `${node.objective} (decision)`, dependsOn: [tally], prompt: '', executor: 'decide', teamRole: role({ role: 'decide' }) } as NodeTemplate & { teamRole: TeamRole },
    ]
  })
}

/** A node's executor as its record names it: a team's tally and decision are the `team` executor. */
export function recordExecutor(node: ResolvedNode): 'worker' | 'gate' | 'team' | 'effect' {
  if (node.executor === 'snapshot') return 'effect'
  return node.executor === 'tally' || node.executor === 'decide' ? 'team' : node.executor ?? 'worker'
}

/** The contract a team's ballots must pass: it knows the options, so a choice outside them is rejected. */
export function ballotContract(kind: TeamKind, members: number): string {
  return kind === 'review' ? 'acceptance.team-ballot-review' : `acceptance.team-ballot-${members}`
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
  const { variant } = caller
  const unknown = variantProblem(template, nodes, variant)
  if (unknown) throw new TypeError(unknown)
  const chosen = nodes.map(({ variants, ...node }) => ({ ...node, ...(variant ? variants?.[variant] : undefined) }))
  const expanded = unrollTeams(chosen)
  const order = preflight(expanded)
  const byId = new Map(expanded.map((n) => [n.nodeId, n as NodeTemplate & { teamRole?: TeamRole }]))
  const resolved = order.map((id): ResolvedNode => {
    const { callerTier, conversation, teamRole, ...template } = byId.get(id)! as NodeTemplate & { teamRole?: TeamRole; executor?: ResolvedNode['executor'] }
    // Teams are unrolled by now; the remaining fields are the node's own.
    const node = Object.fromEntries(Object.entries(template).filter(([key]) => key !== 'team')) as Omit<NodeTemplate, 'callerTier' | 'conversation' | 'team'>
    if (teamRole) {
      // Each member's steps share its one conversation (Model A); the tally and decision run no Worker.
      const session = teamRole.member ? { member: `${teamRole.id}:m${teamRole.member}` } : {}
      return { ...node, dependsOn: node.dependsOn ?? [], tier: node.tier, tierSource: 'profile', session, team: teamRole }
    }
    const session = conversation === 'temporary'
      ? {}
      : conversation === 'own'
        ? { member: `${id}:own` }
        : caller.sessionId
        ? { sessionId: caller.sessionId }
        : conversation === 'persistent' || caller.persist ? { persist: true } : {}
    const fromCaller = !!(callerTier && caller.tier)
    if (node.snapshot) {
      // A source step reads; it runs no Worker and holds no conversation.
      const { snapshot: _snapshot, ...rest } = node
      return { ...rest, dependsOn: node.dependsOn ?? [], tier: node.tier, tierSource: 'profile', session: {}, executor: 'snapshot', ...(caller.repository ? { repository: caller.repository } : {}) }
    }
    return { ...node, dependsOn: node.dependsOn ?? [], tier: fromCaller ? caller.tier! : node.tier, tierSource: fromCaller ? 'caller' : 'profile', session }
  })
  sharedSessionsInSequence(resolved)
  return { template, nodes: resolved, specHash: contentId({ template, nodes: resolved }) }
}

/** Engine-computed parts of a prompt: a planner's steps (each with its result, by id); a team member's ballot or debate prompt, quoting its peers as data. */
export interface ComposeExtras {
  grown?: Array<{ objective: string; result?: ArtifactRef | undefined }>
  team?: string
  /** The node whose result a `{{node:<id>}}` reads instead of `<id>`'s (a re-review's fix, in place of the step that wrote the change), for its pointer's note. */
  readFrom?: Readonly<Record<string, string>>
}

/**
 * A node's instructions as its brief carries them (docs/design/workflow-engine.md#briefs): the
 * template's text and the caller's input as text, and every dependency's result as a pointer by
 * content id, never its content. Filled in one pass, so text from a dependency is never expanded
 * again; rendered, it reads exactly as the template words it.
 */
export interface Instructions {
  segments: BriefSegment[]
  pointers: BriefPointer[]
}

/**
 * Compose a template's prompt into instructions: `{{input}}` the caller's text, `{{node:<id>}}` a
 * pointer to that dependency's result, `{{grown}}` and `{{team}}` what the engine computed. Every
 * placeholder is filled, or nothing is composed: one the engine cannot fill throws
 * {@link UnfilledPlaceholders}, so a Worker never reads a placeholder as it is (INV-2).
 */
export function compose(prompt: string, input: string, results: Readonly<Record<string, ArtifactRef>>, extras: ComposeExtras = {}): Instructions {
  const unfilled = unfilledPlaceholders(prompt, { refs: results, grown: extras.grown !== undefined, team: extras.team !== undefined })
  if (unfilled.length) throw new UnfilledPlaceholders(unfilled)
  const out = instructions()
  let last = 0
  for (const { index, end, key } of placeholdersIn(prompt)) {
    out.text(prompt.slice(last, index))
    last = end
    if (key === 'input') out.text(input)
    else if (key === 'team') out.text(extras.team!)
    else if (key === 'grown') {
      extras.grown!.forEach((step, i) => {
        out.text(`${i ? '\n\n' : ''}### ${step.objective}\n`)
        if (step.result) out.pointer(step.result, 'input', `the result of step ${clampText(step.objective, 200)}`)
      })
    } else out.pointer(results[key!.slice(5)]!, 'input', `the result of node ${extras.readFrom?.[key!.slice(5)] ?? key!.slice(5)}`)
  }
  out.text(prompt.slice(last))
  return out.done()
}

/** Instructions of text only: a plan step's prompt, model text used as it is. */
export function literal(text: string): Instructions {
  const out = instructions()
  out.text(text)
  return out.done()
}

/** Text appended to composed instructions: a result schema, a review's exact subject. */
export function appended(parts: Instructions, text: string): Instructions {
  const out = instructions(parts)
  out.text(text)
  return out.done()
}

/** A builder that merges adjacent text, never stores empty text, and keeps every text within the brief's bound. */
function instructions(from: Instructions = { segments: [], pointers: [] }) {
  const segments: BriefSegment[] = from.segments.map((s) => ({ ...s }))
  const pointers: BriefPointer[] = [...from.pointers]
  let pending = ''
  const flush = (): void => {
    if (!pending) return
    const previous = segments.at(-1)
    let text = previous && 'text' in previous ? (segments.pop() as { text: string }).text + pending : pending
    pending = ''
    // The schema bounds each text by code points: a long text is split on whole characters.
    while ([...text].length > BRIEF_LIMITS.segmentText) {
      const chars = [...text]
      segments.push({ text: chars.slice(0, BRIEF_LIMITS.segmentText).join('') })
      text = chars.slice(BRIEF_LIMITS.segmentText).join('')
    }
    segments.push({ text })
  }
  return {
    text: (text: string): void => {
      pending += text
    },
    pointer: (ref: ArtifactRef, role: BriefPointer['role'], note: string): void => {
      flush()
      let index = pointers.findIndex((p) => p.ref === ref)
      if (index < 0) {
        if (pointers.length >= BRIEF_LIMITS.pointers) throw new TypeError(`a node's instructions point at more than ${BRIEF_LIMITS.pointers} artifacts`)
        index = pointers.push({ ref, role, note: clampText(note, BRIEF_LIMITS.note) }) - 1
      }
      segments.push({ artifact: index })
    },
    done: (): Instructions => {
      flush()
      if (segments.length > BRIEF_LIMITS.segments) throw new TypeError(`a node's instructions have ${segments.length} parts; a brief holds at most ${BRIEF_LIMITS.segments}`)
      return { segments, pointers }
    },
  }
}

/** At most `max` characters (code points), cut on a whole character and marked with '…'. */
export function clampText(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

const STEP_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

/**
 * Read the plan from a planner's answer: untrusted model output, so every bound is checked
 * here (REQ-WF-10). Steps get ids under the planner's prefix and may depend only on each
 * other; the plan must be acyclic, within `maxNodes`, and use allowed capabilities only.
 */
/** The id prefix of what a node grows: its own id, then `<id>:g<n>` once its growth was retired and grown again. */
export const growthPrefix = (nodeId: string, generation = 1): string => (generation > 1 ? `${nodeId}:g${generation}` : nodeId)

export function parsePlan(text: string, planner: string, policy: { maxNodes: number; capabilities: string[] }): ParsedPlan {
  const value = extractJson(text) as { confidence?: unknown; nodes?: unknown } | undefined
  if (!value) return { ok: false, reason: 'the answer carries no JSON plan' }
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
  const v = extractJson(text) as Partial<Assessment> | undefined
  if (!v) return { ok: false, reason: 'the review has no JSON assessment' }
  if (typeof v.subject !== 'string') return { ok: false, reason: 'the assessment names no subject' }
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


/** The structured-result instruction appended to a node's prompt: the schema itself, verbatim (REQ-ART-5). */
export function schemaBlock(tag: string, schema: object): string {
  return [
    `Reply with only a JSON object in a \`\`\`json block, valid against this JSON Schema (${tag}):`,
    '```json',
    JSON.stringify(schema),
    '```',
  ].join('\n')
}

