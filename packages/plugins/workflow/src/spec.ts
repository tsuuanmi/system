/**
 * Static workflow specs (MVP subset of docs/design/workflow-engine.md): templates are data,
 * preflight validates a DAG before anything runs, and a resolved spec is hashed so a run
 * binds to exactly what was admitted.
 */
import { BRIEF_LIMITS, type BriefPointer, type BriefSegment, contentId, type ContentId, extractJson } from '@tsuuanmi/system-libs'
import type { RiskTier } from '@tsuuanmi/system-approvals-core'
import { type ArtifactRef, TIERS, type Tier, WORK_KIND } from '@tsuuanmi/system-workers-core'

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
  /**
   * Capabilities the node prefers but does not need (T262, `work-requirement@1.3` `prefers`): an
   * admitted Worker that proves them ranks before one that does not, never a refusal. `research`'s
   * second review prefers `web-search`, so a Worker that searches takes it before one that only cites.
   */
  prefers?: string[]
  /** Minimum tier (REQ-WRK-9). */
  tier: Tier
  /**
   * The kind of work this step is (ADR-0057), such as `code` or `docs`: a Worker the operator gives
   * kinds takes it only when it lists this one; a Worker given none takes it as any work. An opaque
   * label, never a tool. Not on a team or a source step.
   */
  kind?: string
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
   * How firmly `differentFrom` holds. `required` (the default): with no Worker of another family the
   * step fails closed (ADR-0027), unless the operator's `allowSameFamily` lets it run on one
   * (ADR-0029). `preferred`: it then runs once on the family of the steps it differs from, in a
   * conversation of its own, recorded as a `single-family` decision that its later steps and the
   * run's answer state; the run never fails or waits for the other family (./single-family.ts, D89).
   */
  diversity?: 'required' | 'preferred'
  /**
   * A source step (PROP-0004 Phase 4), run by the engine and no Worker: the caller's repository at
   * one pinned commit, or else the caller's text, as line-numbered files a review quotes. Its
   * result renders as `{{node:<id>}}`.
   */
  snapshot?: true
  /**
   * The risk tiers (PROP-0016 §4, ADR-0071) at which a board task's run skips this step: once its
   * review approved a change of such a tier and every check the policy requires of it passed on its
   * exact tree, the step is retired before it starts, recorded (`workflow.risk-skip`). Only on the
   * final step, never at `heavy`; with no path map in the policy, it always runs.
   */
  riskSkip?: RiskTier[]
  /**
   * On a writing step of a board task's run (T267): it ends with the output of the checks the author
   * ran, pasted into the task's dossier as an `evidence` entry of its own. A step that completes
   * without one is refused at its end (`evidence_missing`), nothing after it starts.
   */
  showsEvidence?: true
  /**
   * On a review step (T267): the author's own review of the change, by the node named (a writing step
   * it depends on). It runs on that step's account in a conversation of its own, so the author never
   * reviews in its own transcript, and it is never an independent review: it counts for no tier, no
   * provider family, and no acceptance (`approvals`, `lastReview`). Its confirmed important findings grow a fix
   * that continues the author's session, answered before the next review starts.
   */
  selfReview?: string
}

/** What a variant may change of a node: what it needs, what kind of work it is, where it runs, and how it is judged. */
export type NodeVariant = Partial<Pick<NodeTemplate, 'objective' | 'prompt' | 'capabilities' | 'tier' | 'kind' | 'conversation' | 'acceptance'>>

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

const VARIANT_FIELDS = new Set(['objective', 'prompt', 'capabilities', 'tier', 'kind', 'conversation', 'acceptance'])
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
        : key === 'kind' ? typeof value === 'string' && WORK_KIND.test(value)
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
  /**
   * On a remediation fix: the review whose blocking findings it fixes. The engine keeps the tree
   * that review read before the fix runs, and the fix's result after it, each as its own commit of
   * the run's review history, never moving the worktree's HEAD (docs/design/workflow-engine.md#review-cycles).
   */
  fixOf?: string
  /**
   * On a remediation fix that continues its author's session (one task, one author session): the
   * writing step whose session `session.sessionId` is. The fix is that session's next message, on its
   * Worker; when that Worker cannot take it, it waits within `fixSessionWaitMinutes` or is handed off,
   * and which path it took is a `workflow.fix-session` decision (docs/design/sessions-and-messaging.md).
   */
  author?: { node: string; sessionId: string }
  /**
   * On a heavy change's second review (ADR-0071): the approving review it differs from in provider
   * family (`differentFrom` names it), and the `workflow.risk-tier` decision that grew it. It never
   * runs on the same family for want of another (`allowSameFamily` does not apply).
   */
  secondReview?: { of: string; decision: string }
  /**
   * On a verification step (ADR-0075): the review whose important findings it votes on, and the
   * assessment it read them from. It is bound to that review's exact subject, prefers another provider
   * family than the review's (`differentFrom`, `diversity: preferred`), and runs in a session of its own.
   */
  verifies?: { review: string; assessment: string }
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
    // A kind is an opaque label of what the step is (ADR-0057); a team's members and a source step name none.
    if (node.kind !== undefined) {
      if (typeof node.kind !== 'string' || !WORK_KIND.test(node.kind)) throw new TypeError(`node ${node.nodeId}: kind ${JSON.stringify(node.kind)} is not a kind of work (${WORK_KIND})`)
      if (node.team || node.snapshot) throw new TypeError(`node ${node.nodeId}: a ${node.team ? 'team' : 'source step'} has no kind`)
    }
    // What a step prefers is capabilities it does not need (T262): 1 to 8 distinct names, none it needs already.
    if (node.prefers !== undefined) {
      const prefers: unknown = node.prefers
      if (!Array.isArray(prefers) || !prefers.length || prefers.length > 8 || !prefers.every(TEXT) || new Set(prefers).size !== prefers.length) throw new TypeError(`node ${node.nodeId}: prefers is a list of 1 to 8 distinct capabilities`)
      if (prefers.some((c) => node.capabilities.includes(c as string))) throw new TypeError(`node ${node.nodeId}: prefers names a capability it needs already (capabilities)`)
      if (node.team || node.snapshot) throw new TypeError(`node ${node.nodeId}: a ${node.team ? 'team' : 'source step'} prefers nothing`)
    }
    if (node.resultSchema !== undefined && !(typeof node.resultSchema === 'string' && /^[a-z][a-z0-9-]*@\d+\.\d+$/.test(node.resultSchema))) {
      throw new TypeError(`node ${node.nodeId}: resultSchema must be a schema tag such as plan@1.0`)
    }
    if (node.diversity !== undefined && (!['required', 'preferred'].includes(node.diversity) || !node.differentFrom?.length)) {
      throw new TypeError(`node ${node.nodeId}: diversity is required or preferred, on a node with differentFrom`)
    }
    for (const dep of node.dependsOn ?? []) if (!byId.has(dep)) throw new TypeError(`node ${node.nodeId} depends on unknown node ${dep}`)
    if (node.showsEvidence !== undefined && (node.showsEvidence !== true || !node.capabilities.includes('develop') || node.team || node.snapshot)) {
      throw new TypeError(`node ${node.nodeId}: showsEvidence is true, on a writing step (it needs develop)`)
    }
    if (node.selfReview !== undefined) {
      const author = byId.get(node.selfReview)
      if (!author || !author.capabilities.includes('develop') || !(node.dependsOn ?? []).includes(node.selfReview) || !node.capabilities.includes('review') || node.capabilities.includes('develop') || node.team || node.differentFrom?.length) {
        throw new TypeError(`node ${node.nodeId}: selfReview names a writing step it depends on, and a review has no differentFrom (a self-review is the author's own)`)
      }
    }
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
  for (const node of nodes) if (node.riskSkip !== undefined) checkRiskSkip(node, finals[0]!.nodeId)
  return order
}

/**
 * A step skipped at a risk tier (ADR-0071) is the final one, so no step ever waits for one that
 * never runs, and a Worker step that depends on another; it names light or normal, never heavy.
 */
function checkRiskSkip(node: NodeTemplate, final: string): void {
  const tiers: unknown = node.riskSkip
  if (!Array.isArray(tiers) || !tiers.length || new Set(tiers).size !== tiers.length || !tiers.every((t) => t === 'light' || t === 'normal')) {
    throw new TypeError(`node ${node.nodeId}: riskSkip is a list of distinct risk tiers, light or normal (a heavy change never skips a step)`)
  }
  if (node.nodeId !== final || !(node.dependsOn ?? []).length || node.team || node.grows || node.snapshot) {
    throw new TypeError(`node ${node.nodeId}: only the final step, a Worker step that depends on another, may be skipped at a risk tier`)
  }
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

/**
 * A review finding's severity (ADR-0075): `important` is a real defect of this change (wrong behaviour,
 * a broken invariant, a security or data risk, a missing required test or doc); `nit` is style,
 * naming, wording, a small improvement; `pre-existing` is a defect the change did not introduce.
 */
export type Severity = 'important' | 'nit' | 'pre-existing'
export const SEVERITIES: readonly Severity[] = ['important', 'nit', 'pre-existing']

/** The severities of `assessment@1.0`, still read: `blocking` as `important`, `warning` and `info` as `nit`. */
const LEGACY_SEVERITY: Readonly<Record<string, Severity>> = { blocking: 'important', warning: 'nit', info: 'nit' }

/** A verifier's vote on an important finding: `none` when its answer named no vote for it. */
export interface Verification { vote: 'confirm' | 'reject' | 'none'; reason: string; node: string; worker?: string }

export interface Finding {
  /** The finding's id within its review (`f1`, `f2`, …), what a verifier's vote and an author's response name. */
  id?: string
  /** `assessment@1.1` writes `important`, `nit`, `pre-existing`; an `assessment@1.0` read back holds `blocking`, `warning`, `info`. */
  severity: Severity | 'blocking' | 'warning' | 'info'
  title: string
  detail?: string
  file?: string
  line?: number
  /** What fails, and how the file and line show it: an `important` or `pre-existing` finding without file, line, and it is a nit. */
  evidence?: string
  /** The class of defect (a short name), so the author fixes every instance of it. */
  class?: string
  /** Set when the reviewer said `important` or `pre-existing` with no file, line, or evidence: the finding is read as a nit. */
  demoted?: 'no-evidence'
  /** The earlier finding (`<review step>#<id>`) already answered that this one repeats: shown, never counted or sent. */
  repeated?: string
  /** The verifier's vote on an important finding; only a `confirm` makes it block. */
  verification?: Verification
}

export interface Assessment {
  subject: string
  /** `changes-requested` only while a confirmed important finding stands; one waiting for its verification does not request changes. */
  verdict: 'approve' | 'changes-requested'
  findings: Finding[]
  /** The verdict the reviewer wrote, when the engine's reading of the severities changed it. */
  said?: 'approve' | 'changes-requested'
  /** From review cycle 3 on: whether the reviewer thinks the approach should change, and why. */
  approach?: { change: boolean; why: string }
}

/** Whether a finding blocks: an `important` one a verifier confirmed, or an `assessment@1.0`'s `blocking` one (never verified). */
export const blocks = (f: Pick<Finding, 'severity' | 'verification' | 'repeated'>): boolean =>
  !f.repeated && (f.severity === 'blocking' || (f.severity === 'important' && f.verification?.vote === 'confirm'))

/** Whether an important finding still waits for its verification: counted, not yet blocking. */
export const pendingImportant = (f: Finding): boolean => f.severity === 'important' && !f.repeated && !f.verification

/**
 * The count a review's summary opens with: `2 important, 3 nits, 1 pre-existing`, or `no issues`. An
 * important finding a verifier voted on says how many were confirmed; a repeated finding is not counted.
 */
export function countOf(findings: readonly Finding[]): string {
  const live = findings.filter((f) => !f.repeated)
  const important = live.filter((f) => f.severity === 'important' || f.severity === 'blocking')
  const nits = live.filter((f) => f.severity === 'nit' || f.severity === 'warning' || f.severity === 'info').length
  const pre = live.filter((f) => f.severity === 'pre-existing').length
  const voted = important.filter((f) => f.verification)
  const confirmed = important.filter((f) => blocks(f)).length
  const parts = [
    ...(important.length ? [`${important.length} important${voted.length ? ` (${confirmed} confirmed, ${important.length - confirmed} not)` : ''}`] : []),
    ...(nits ? [`${nits} nit${nits === 1 ? '' : 's'}`] : []),
    ...(pre ? [`${pre} pre-existing`] : []),
  ]
  return parts.length ? parts.join(', ') : 'no issues'
}

/** A review's summary: its count first, then what it means for the work. */
export function summaryOf(assessment: Pick<Assessment, 'findings' | 'verdict' | 'approach'>): string {
  const repeated = assessment.findings.filter((f) => f.repeated).length
  const pending = assessment.findings.filter(pendingImportant).length
  const blocking = assessment.findings.filter(blocks).length
  const then = blocking ? `${blocking} confirmed important finding${blocking === 1 ? '' : 's'} block${blocking === 1 ? 's' : ''}: the author fixes ${blocking === 1 ? 'it' : 'them'}`
    : pending ? `${pending} important finding${pending === 1 ? '' : 's'} wait${pending === 1 ? 's' : ''} for verification by a second reviewer`
      : 'nothing blocks'
  return clampText([
    `${countOf(assessment.findings)}; ${then}.`,
    ...(repeated ? [`${repeated} finding${repeated === 1 ? '' : 's'} repeated one already answered, not counted.`] : []),
    ...(assessment.approach ? [`Approach: ${assessment.approach.change ? 'should change' : 'should stay'}${assessment.approach.why ? ` (${assessment.approach.why})` : ''}.`] : []),
  ].join(' '), 2000)
}

const RANK: Readonly<Record<string, number>> = { important: 0, blocking: 0, 'pre-existing': 1, nit: 2, warning: 2, info: 2 }

/** Findings by severity, as a reader is shown them: important first (confirmed before the rest), then pre-existing, then nits; repeats last. */
export const bySeverity = <F extends Finding>(findings: readonly F[]): F[] => findings
  .map((f, i) => ({ f, i }))
  .sort((a, b) => Number(!!a.f.repeated) - Number(!!b.f.repeated) || (RANK[a.f.severity] ?? 3) - (RANK[b.f.severity] ?? 3) || Number(!blocks(a.f)) - Number(!blocks(b.f)) || a.i - b.i)
  .map(({ f }) => f)

/** The key two findings share when one repeats the other: its file and its title, lowercased and squeezed. */
export const findingKey = (f: Pick<Finding, 'title' | 'file'>): string => `${(f.file ?? '').trim()}\0${f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`

/** An earlier finding a re-review is shown: open (sent to the fix) or answered (it must not raise again). */
export interface PriorFinding { review: string; finding: Finding; state: 'open' | 'answered' }

/**
 * What every review bound to an exact subject is told about commands: it reads and judges the change,
 * and never runs the project's tests or builds, which the run's required checks at acceptance run
 * (ADR-0063), and a writer's own, shown in the task's dossier, before it (T267). A reviewer often runs
 * read-only, so a command it could not run says nothing about the change: such an environment limit is
 * at most a `nit`, never an important finding that would grow a remediation cycle no fix can satisfy.
 */
export const REVIEW_RUNS_NOTHING = 'Read and judge the change: never run the project\'s tests or builds, which the run\'s required checks run. A command you could not run is no finding about the change; an environment limit (a read-only sandbox, a denied or failing command) is at most a "nit", never an "important" finding.'

/**
 * How a reviewer grades a finding (ADR-0075): the three severities, the evidence an important or
 * pre-existing finding needs, that only a confirmed important finding asks for a fix, and the class.
 */
export const SEVERITY_RULES = [
  'Grade each finding. "important": a real defect this change introduces (wrong behaviour, a broken invariant, a security or data risk, a missing required test or doc). "nit": style, naming, wording, a small improvement. "pre-existing": a defect the change did not introduce (it becomes a follow-up task, never a fix of this change).',
  'An important or pre-existing finding names its file and line and its evidence: what fails, and how that line shows it. One without is read as a nit.',
  'A second reviewer verifies each important finding against the code; only a confirmed one asks the author for a fix. Request changes only for an important finding; nits never hold the change.',
  'Name a finding\'s class (a short name for the kind of defect) when the same defect may occur elsewhere, so the author fixes every instance of it.',
].join('\n')

/**
 * What a re-review is shown of its cycle (docs/design/workflow-engine.md#review-cycles): the subject
 * the last review read, the change since then (relative to the commit that holds that subject, when
 * one does), the findings still open and those already answered; the whole change relative to the
 * commit the first review's change started from only when the change since cannot be shown apart.
 */
export interface ReviewCycle {
  cycle: number
  previous: { review: string; subject: string }
  since?: { commit: string; diff: string }
  whole: { commit: string; diff: string }
  /** The findings of the earlier reviews of this change: open (sent to the last fix) or answered. */
  prior?: PriorFinding[]
}

const diffBlock = (diff: string): string[] => ['```diff', diff || '(no change)', '```']

/** One finding as a line a reviewer, verifier, or author reads: its id, severity, title, place, class, and evidence. */
export function findingLine(f: Finding, review?: string): string {
  const place = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''
  return `- ${review ? `${review}#` : ''}${f.id ? `${f.id} ` : ''}${f.severity}: ${f.title}${place}${f.class ? ` [class: ${f.class}]` : ''}${f.evidence ? `; evidence: ${f.evidence}` : ''}`
}

/** The cycle at which a re-review is asked whether the approach should change (after the third round). */
export const APPROACH_CYCLE = 3

/** The subject block appended to a review bound to an exact subject (REQ-TEAM-5, REQ-WF-5); a re-review's shows its cycle. */
export function subjectBlock(id: string, workspace: string, head: string, diff: string, request: string, cycle?: ReviewCycle): string {
  const open = cycle?.prior?.filter((p) => p.state === 'open') ?? []
  const answered = cycle?.prior?.filter((p) => p.state === 'answered') ?? []
  const change = !cycle
    ? [`The change relative to commit ${head}, verbatim:`, ...diffBlock(diff)]
    : [
      `This is review cycle ${cycle.cycle}. The last review (${cycle.previous.review}) read subject ${cycle.previous.subject}, and its blocking findings were fixed since. Review only what changed since then, and whether each open finding below is fixed: the rest of the change was reviewed already.`,
      ...(open.length ? ['Open findings (sent to the fix; say whether each is fixed, and raise it again only if it is not):', ...open.map((p) => findingLine(p.finding, p.review))] : []),
      ...(answered.length ? ['Findings already answered (verified and rejected, nits, pre-existing, or fixed and re-reviewed): never raise them again; one you raise again is not counted:', ...answered.slice(0, 50).map((p) => findingLine(p.finding, p.review))] : []),
      ...(cycle.since
        ? [`The change since the subject the last review read (relative to commit ${cycle.since.commit}, which holds it), verbatim:`, ...diffBlock(cycle.since.diff)]
        : [
          'The change since the subject the last review read cannot be shown apart: no commit holds that subject.',
          `The whole change relative to commit ${cycle.whole.commit}, where it started, verbatim:`,
          ...diffBlock(cycle.whole.diff),
        ]),
      ...(cycle.cycle >= APPROACH_CYCLE ? [`This change has been through ${cycle.cycle - 1} rounds of fixes. Say in "approach" whether the approach should change rather than be fixed again, and why.`] : []),
    ]
  const approach = cycle && cycle.cycle >= APPROACH_CYCLE ? ', "approach": {"change": true or false, "why": "..."}' : ''
  return [
    '## The exact subject of this review',
    'Review exactly this change against the request. You see none of the producer\'s conversation.',
    REVIEW_RUNS_NOTHING,
    SEVERITY_RULES,
    `Subject: ${id}`,
    `Workspace: ${workspace}`,
    `Requested change: ${request}`,
    ...change,
    'Reply with only a JSON object in a ```json block, naming the subject exactly:',
    `{"subject": "${id}", "verdict": "approve" or "changes-requested", "findings": [{"severity": "important" | "nit" | "pre-existing", "title": "...", "file": "path", "line": 12, "evidence": "what fails, and how that line shows it", "class": "the kind of defect", "detail": "..."}]${approach}}`,
  ].join('\n')
}

const text = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

/**
 * A reviewer's assessment from its answer, or why it is not one. Each finding gets its id and the
 * engine's reading of its severity (ADR-0075): an `assessment@1.0` severity is read as its new one; an
 * important or pre-existing finding without a file, a line, and evidence is a nit (`demoted`); one that
 * repeats a finding already `answered` is marked `repeated`. The verdict is `changes-requested` only
 * for a finding that already blocks (none, until a verifier confirms one), whatever the reviewer
 * wrote (`said` keeps that when it differs).
 */
export function parseAssessment(answer: string, answered: readonly PriorFinding[] = []): { ok: true; assessment: Assessment } | { ok: false; reason: string } {
  const v = extractJson(answer) as (Partial<Assessment> & { approach?: unknown }) | undefined
  if (!v) return { ok: false, reason: 'the review has no JSON assessment' }
  if (typeof v.subject !== 'string') return { ok: false, reason: 'the assessment names no subject' }
  if (v.verdict !== 'approve' && v.verdict !== 'changes-requested') return { ok: false, reason: 'the assessment has no verdict (approve or changes-requested)' }
  if (!Array.isArray(v.findings)) return { ok: false, reason: 'the assessment has no findings list' }
  const earlier = new Map(answered.map((p) => [findingKey(p.finding), `${p.review}#${p.finding.id ?? '?'}`]))
  const findings: Finding[] = []
  for (const f of (v.findings as unknown as Array<Record<string, unknown>>).slice(0, 200)) {
    const said = f?.severity as string
    const severity = SEVERITIES.includes(said as Severity) ? said as Severity : LEGACY_SEVERITY[said]
    if (!f || !severity || typeof f.title !== 'string' || !f.title.trim()) {
      return { ok: false, reason: 'a finding needs a severity (important, nit, pre-existing) and a title' }
    }
    const file = text(f.file, 1024)
    const evidence = text(f.evidence, 2000)
    const line = Number.isInteger(f.line) && (f.line as number) >= 1 ? f.line as number : undefined
    const cls = text(f.class, 100)
    // A finding without evidence is a nit (ADR-0075): it names no file and line, or says nothing of what fails.
    const demoted = severity !== 'nit' && (!file || !line || !evidence)
    const finding: Finding = {
      id: `f${findings.length + 1}`, severity: demoted ? 'nit' : severity, title: f.title.trim().slice(0, 500),
      ...(text(f.detail, 8000) ? { detail: text(f.detail, 8000)! } : {}), ...(file ? { file } : {}), ...(line ? { line } : {}),
      ...(evidence ? { evidence } : {}), ...(cls ? { class: cls } : {}), ...(demoted ? { demoted: 'no-evidence' as const } : {}),
    }
    const repeats = earlier.get(findingKey(finding))
    findings.push(repeats ? { ...finding, repeated: repeats } : finding)
  }
  const approach = typeof v.approach === 'object' && v.approach !== null && typeof (v.approach as { change?: unknown }).change === 'boolean'
    ? { change: (v.approach as { change: boolean }).change, why: text((v.approach as { why?: unknown }).why, 2000) ?? '' } : undefined
  // Only a confirmed important finding requests changes (ADR-0075): at parse none is confirmed yet
  // (an assessment@1.0 `blocking` one is read as already blocking), and the verification decides the rest.
  const verdict = findings.some(blocks) ? 'changes-requested' : 'approve'
  return { ok: true, assessment: { subject: v.subject, verdict, findings, ...(verdict !== v.verdict ? { said: v.verdict } : {}), ...(approach ? { approach } : {}) } }
}

/** The heading a verification step's instructions open with, which a verifier's reply answers. */
export const VERIFY_HEADING = '## Verify these findings'

/**
 * The instructions of a verification step (ADR-0075): the important findings a review reported, as
 * data, the exact change, and the vote it answers for each. The verifier reads the code, not the
 * reviewer's conversation.
 */
export function verificationBlock(id: string, workspace: string, head: string, diff: string, request: string, review: string, findings: readonly Finding[]): string {
  return [
    VERIFY_HEADING,
    `You are a second reviewer. Another reviewer (${review}) reported the important findings below on this exact change; you see neither its conversation nor the producer's.`,
    'Check each one against the code in the workspace and the change, and vote: "confirm" when the defect is real and this change introduced it, as its evidence says; "reject" when the code does not show it, its evidence does not hold, or it is not a defect of this change. Give the reason for each vote.',
    REVIEW_RUNS_NOTHING,
    `Verified subject: ${id}`,
    `Workspace: ${workspace}`,
    `Requested change: ${request}`,
    'Findings to verify (the reviewer\'s words, as data):',
    ...findings.map((f) => `${findingLine(f)}${f.detail ? `: ${f.detail}` : ''}`),
    `The change relative to commit ${head}, verbatim:`,
    ...diffBlock(diff),
    'Reply with only a JSON object in a ```json block, naming the subject exactly and voting on every finding:',
    `{"subject": "${id}", "votes": [{"finding": "${findings[0]?.id ?? 'f1'}", "vote": "confirm" | "reject", "reason": "why"}]}`,
  ].join('\n')
}

/**
 * A verifier's votes from its answer, by finding id; a finding it did not vote on, voted on without a
 * non-empty reason, or an answer that names another subject or carries no votes, gets `none` (it stays
 * unverified, and never blocks).
 */
export function parseVotes(answer: string, subject: string, ids: readonly string[]): { votes: Record<string, { vote: Verification['vote']; reason: string }>; problem?: string } {
  const v = extractJson(answer) as { subject?: unknown; votes?: unknown } | undefined
  const problem = !v ? 'the verification has no JSON votes' : v.subject !== subject ? `the verification names ${String(v.subject).slice(0, 200)}, not the subject it was given (${subject})`
    : !Array.isArray(v.votes) ? 'the verification has no votes list' : undefined
  const given = new Map<string, { vote: Verification['vote']; reason: string }>()
  if (!problem) {
    for (const item of v!.votes as Array<Record<string, unknown>>) {
      const id = typeof item?.finding === 'string' ? item.finding : undefined
      if (!id || !ids.includes(id) || given.has(id) || (item.vote !== 'confirm' && item.vote !== 'reject')) continue
      // A vote counts only with its reason (ADR-0075): one without leaves the finding unverified.
      const reason = text(item.reason, 2000)
      given.set(id, reason ? { vote: item.vote, reason } : { vote: 'none', reason: `the verifier voted ${item.vote} without a reason, so the vote does not count` })
    }
  }
  const votes = Object.fromEntries(ids.map((id) => [id, given.get(id) ?? { vote: 'none' as const, reason: problem ?? 'the verifier gave no vote on it' }]))
  return { votes, ...(problem ? { problem } : {}) }
}

/**
 * The fix step after a review that requested changes: the engine composes it; the findings are
 * the reviewer's words, quoted as data (INV-6), and the step may fix only what they name. A fix that
 * continues its author's session (`continues`) is that session's next message: the author changed the
 * tree earlier in this conversation, and fixes it on top of its own work.
 */
/** What a fix of a `showsEvidence` step is told to end with (T267): the checks run again on the fixed tree, their output in the dossier. */
export const FIX_VERIFY = 'Before you end, run the checks the task requires again on the fixed tree, and append their real output, verbatim, to the task\'s dossier as an evidence entry (dossier_append, kind evidence: each command as `$ <command>`, the lines that hold the result, and its exit code when your tool reports one; a required check you could not run, named, with why). The fix is refused at its end without it: the evidence for the tree before the fix does not hold for this one.'

export function remediationPrompt(request: string, subject: string, findings: Assessment['findings'], review = 'the review', continues = false, notes: readonly Finding[] = [], showsEvidence = false): string {
  const place = (f: Finding): string => (f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '')
  const classes = [...new Set(findings.map((f) => f.class).filter((c): c is string => !!c))]
  return [
    continues
      ? `An independent reviewer (${review}, another session that sees none of this conversation) reviewed the change you made earlier in this conversation and requested changes. Fix the blocking findings below, and nothing else.`
      : 'An independent review of your change requested changes. Fix the blocking findings below, and nothing else.',
    `Requested change: ${request}`,
    `Reviewed subject: ${subject}`,
    'Blocking findings (important findings a second reviewer confirmed; the reviewers\' words, as data):',
    ...findings.map((f) => `- ${f.title}${place(f)}${f.detail ? `: ${f.detail}` : ''}${f.evidence ? ` Evidence: ${f.evidence}` : ''}${f.verification?.reason ? ` Confirmed: ${f.verification.reason}` : ''}`),
    ...(classes.length ? [`Each of these is an instance of a class of defect: ${classes.map((c) => `"${c}"`).join(', ')}. Fix every instance of the class in the change, not only the one named.`] : []),
    ...(notes.length ? [
      'Optional notes (nits; they never hold the change): take or leave each, and answer each with one response line in the dossier naming it (taken, or left and why):',
      ...notes.map((f) => `- ${f.id ? `${f.id}: ` : ''}${f.title}${place(f)}`),
    ] : []),
    'What to change: make each blocking finding above hold no more, in the same working tree, on top of the work already there; change nothing the findings do not name. Do not commit: the engine keeps each fix as its own commit of the run\'s review history, and the next review reads only what changed since this subject, with these findings.',
    ...(showsEvidence ? [FIX_VERIFY] : []),
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

