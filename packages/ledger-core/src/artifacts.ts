import { type Context, Service } from '@deepseek-ai/cordis'
import type { ContentId } from '@tsuuanmi/system-libs'

declare module '@deepseek-ai/cordis' {
  interface Context {
    artifacts: Artifacts
  }
}

export type ArtifactKind =
  | 'objective' | 'criteria' | 'plan' | 'finding' | 'evidence' | 'assessment' | 'report'
  | 'handoff' | 'delivery' | 'message' | 'decision' | 'receipt' | 'approval'
export type Classification = 'public' | 'operator-shared' | 'local-private'
export interface Producer { type: 'node' | 'worker' | 'policy' | 'operator' | 'system'; ref: string }
export interface Subject { type: 'content' | 'git-head' | 'pull-request' | 'artifact' | 'external'; ref: string; version?: string }

/** The stored envelope (schemas/artifact-envelope.v1.json). */
export interface Envelope {
  schema: 'artifact-envelope@1.0'
  id: ContentId
  kind: ArtifactKind
  bodySchema: string
  body?: unknown
  blob?: { ref: ContentId; bytes: number; mediaType: string }
  classification: Classification
  producer: Producer
  subject?: Subject
  inputs: ContentId[]
  lineage: { supersedes?: ContentId[]; invalidates?: ContentId[] }
  runId?: string
  nodeId?: string
  createdAt: string
}

export type NewArtifact = Omit<Envelope, 'schema' | 'id' | 'createdAt' | 'inputs' | 'lineage'> &
  Partial<Pick<Envelope, 'inputs' | 'lineage'>>

/** Body of a decision artifact (schemas/decision.v1.json). */
export interface Decision {
  /**
   * `@1.1` once it records a team vote or a client's decision; otherwise `@1.0`, so earlier decisions
   * keep their ids. A recorder that uses a later minor's fields names it (`@1.2`: a review's quote checks;
   * `@1.3`: a `retention` decision; `@1.4`: an `autonomy`, `approval`, `board`, or `budget` decision;
   * `@1.5`: a `lifecycle` decision; `@1.6`: a `policy-change` decision; `@1.7`: a `registration` or `verdict` decision;
   * `@1.8`: an `enrollment` decision, or a `recovery` decision whose outcome is `wait`; `@1.9`: a
   * `recovery` decision whose outcome is `resend`; `@1.10`: a project's lead's approval or acceptance, a
   * `client` decider that is no vote, ADR-0076).
   */
  schema: 'decision@1.0' | 'decision@1.1' | 'decision@1.2' | 'decision@1.3' | 'decision@1.4' | 'decision@1.5' | 'decision@1.6' | 'decision@1.7' | 'decision@1.8' | 'decision@1.9' | 'decision@1.10'
  decisionType: string
  question: string
  inputs: ContentId[]
  candidates: { option: string; selected: boolean; reasons: string[] }[]
  decider: { type: 'rule' | 'policy' | 'model' | 'operator' | 'client'; id: string; version: string; hash?: ContentId }
  modelAnswers?: unknown[]
  outcome: { option: string; detail?: Record<string, unknown> }
  deterministic: boolean
  rationale?: string
  /** A team's vote (decision type `vote`; decision@1.1), shaped by the schema. */
  vote?: Record<string, unknown>
}

export interface ExplainNode {
  id: ContentId
  /** `expired`: the artifact was collected by retention; only its id remains (REQ-ART-3). */
  kind: ArtifactKind | 'expired'
  summary: string
  inputs: ExplainNode[]
}

/**
 * An artifact as the operator reads it (`system artifact`): its envelope's header and a window of
 * its body, or why there is none.
 */
export type ArtifactRead =
  | {
    id: ContentId
    state: 'stored'
    kind: ArtifactKind
    bodySchema: string
    classification: Classification
    producer: Producer
    runId?: string
    nodeId?: string
    createdAt: string
    inputs: ContentId[]
    /** What the window is of: the body's `text`, else the body as JSON; `blob` when the body is in a blob store (none is read here). */
    content: 'text' | 'json' | 'blob'
    /** Characters (code points) of the whole content, the window's first one, and whether more follow it. */
    chars: number
    offset: number
    truncated: boolean
    text: string
  }
  | {
    id: ContentId
    /** `expired`: a stored artifact still names it, so it was stored and collected by retention; `unknown`: nothing here names it. */
    state: 'expired' | 'unknown'
    /** A stored artifact that names it, and when that one was recorded (collection records no time of its own). */
    referencedBy?: { id: ContentId; kind: ArtifactKind; createdAt: string }
    note: string
  }

/** Bounds of a read window, in characters (INV-9). */
export const READ_DEFAULT_CHARS = 20_000
export const READ_MAX_CHARS = 200_000

/** What one collection did. */
export interface Collected {
  /** Artifacts deleted. */
  removed: number
  /** Artifacts kept: referenced, inside the grace period, or of a run that still exists. */
  kept: number
}

/** What `list` filters on; every field narrows the artifacts read. */
export interface ArtifactFilter {
  kind?: ArtifactKind
  runId?: string
  nodeId?: string
  decisionType?: string
  outcome?: string
  limit?: number
  newest?: boolean
}

/**
 * `ctx.artifacts`: immutable, content-addressed artifacts, including decision records (INV-13,
 * ADR-0013, docs/design/artifacts.md). Every envelope and body is validated against its schema
 * before it is stored (INV-14). A guarantee seam: a provider passes `conformance/artifacts.ts`
 * (ADR-0036).
 */
export abstract class Artifacts extends Service {
  constructor(ctx: Context) {
    super(ctx, 'artifacts')
  }

  /**
   * Store an artifact and return its envelope. The id is computed here, never trusted from the
   * producer; identical content returns the existing envelope (deduplication). A derived artifact
   * can never be classified below its strictest input.
   */
  abstract put(input: NewArtifact): Envelope

  /**
   * Record one decision (INV-13). Enforces what the schema cannot: the single selected candidate
   * equals the outcome (docs/reference/schemas.md#decision).
   */
  abstract recordDecision(decision: Omit<Decision, 'schema'> & { schema?: Decision['schema'] }, meta: { producer: Producer; runId?: string; nodeId?: string; classification?: Classification }): Envelope

  abstract get(id: string): Envelope | undefined

  /**
   * The artifacts that match `filter`, in the order they were stored (oldest first; `newest`: newest
   * first, contract 1.1), at most `limit` (100 by default, 1 to 1000). `outcome` (contract 1.2) keeps
   * only decisions whose outcome is that option.
   */
  abstract list(filter?: ArtifactFilter): Envelope[]

  /**
   * Read an artifact for the operator: its header, and a window of `max` characters (code points)
   * of its body from `offset`. An id that is not a content id is refused before any lookup.
   */
  abstract read(id: string, window?: { offset?: number; max?: number }): ArtifactRead

  /** Walk an artifact's inputs backwards: the "why" chain (REQ-ART-3), bounded in depth and size (INV-9). */
  abstract explain(id: string): ExplainNode | undefined

  /** Retention (docs/design/artifacts.md#storage): delete the artifacts nothing retained needs. */
  abstract collect(now?: number, hooks?: { afterScan?: () => void }): Promise<Collected>
}
