/**
 * `ctx.artifacts`: immutable, content-addressed artifacts, including decision records
 * (INV-13, ADR-0013, docs/design/artifacts.md). Every envelope and body is validated
 * against its schema before it is stored (INV-14).
 * @module @tsuuanmi/system-artifacts
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type ContentId, SchemaRegistry, contentId } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'

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
  schema: 'decision@1.0'
  decisionType: string
  question: string
  inputs: ContentId[]
  candidates: { option: string; selected: boolean; reasons: string[] }[]
  decider: { type: 'rule' | 'policy' | 'model' | 'operator'; id: string; version: string; hash?: ContentId }
  modelAnswers?: unknown[]
  outcome: { option: string; detail?: Record<string, unknown> }
  deterministic: boolean
  rationale?: string
}

const CLASSIFICATION_RANK: Record<Classification, number> = { public: 0, 'operator-shared': 1, 'local-private': 2 }

export interface ExplainNode {
  id: ContentId
  kind: ArtifactKind
  summary: string
  inputs: ExplainNode[]
}

export interface Config {
  /** Maximum depth `explain` walks before truncating (default 16). */
  explainDepth?: number
}

export class Artifacts extends Service {
  static inject = ['store']
  static Config: z<Config> = z.object({
    explainDepth: z.natural().min(1).max(64).default(16).description('Maximum depth explain walks'),
  })

  private readonly schemas = new SchemaRegistry()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'artifacts')
    ctx.store.migrate('artifacts', [
      {
        version: 1,
        sql: `CREATE TABLE artifacts (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, body_schema TEXT NOT NULL,
          classification TEXT NOT NULL, run_id TEXT, node_id TEXT, subject_ref TEXT,
          decision_type TEXT, envelope TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE INDEX artifacts_run ON artifacts (run_id, node_id);
        CREATE INDEX artifacts_kind ON artifacts (kind, decision_type);`,
      },
    ])
  }

  /**
   * Store an artifact and return its envelope. The id is computed here, never trusted
   * from the producer; identical content returns the existing envelope (deduplication).
   * A derived artifact can never be classified below its strictest input.
   */
  put(input: NewArtifact): Envelope {
    if ((input.body === undefined) === (input.blob === undefined)) throw new TypeError('an artifact has exactly one of body or blob')
    if (input.body !== undefined) this.schemas.assert(input.bodySchema, input.body)
    const inputs = [...new Set(input.inputs ?? [])]
    const lineage = input.lineage ?? {}
    const id = contentId({ kind: input.kind, body: input.body, blob: input.blob?.ref, inputs, lineage, subject: input.subject })
    return this.ctx.store.transaction((db) => {
      const existing = this.get(id)
      if (existing) return existing
      const classification = this.floorClassification(input.classification, inputs)
      const envelope: Envelope = { ...input, schema: 'artifact-envelope@1.0', id, classification, inputs, lineage, createdAt: new Date().toISOString() }
      this.schemas.assertRecord(envelope)
      const decisionType = input.kind === 'decision' ? (input.body as Decision).decisionType : null
      db.prepare(
        `INSERT INTO artifacts (id, kind, body_schema, classification, run_id, node_id, subject_ref, decision_type, envelope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, envelope.kind, envelope.bodySchema, classification, envelope.runId ?? null, envelope.nodeId ?? null,
        envelope.subject?.ref ?? null, decisionType, JSON.stringify(envelope), envelope.createdAt)
      return envelope
    })
  }

  /**
   * Record one decision (INV-13). Enforces what the schema cannot: the single selected
   * candidate equals the outcome (docs/reference/schemas.md#decision).
   */
  recordDecision(decision: Omit<Decision, 'schema'>, meta: { producer: Producer; runId?: string; nodeId?: string; classification?: Classification }): Envelope {
    const body: Decision = { schema: 'decision@1.0', ...decision }
    this.schemas.assert(body.schema, body)
    const selected = body.candidates.filter((candidate) => candidate.selected)
    if (selected.length !== 1 || selected[0]?.option !== body.outcome.option) {
      throw new TypeError('decision: exactly one selected candidate must equal outcome.option')
    }
    return this.put({
      kind: 'decision', bodySchema: 'decision@1.0', body, inputs: body.inputs,
      classification: meta.classification ?? 'operator-shared', producer: meta.producer,
      ...(meta.runId !== undefined && { runId: meta.runId }), ...(meta.nodeId !== undefined && { nodeId: meta.nodeId }),
    })
  }

  get(id: string): Envelope | undefined {
    const row = this.ctx.store.db.prepare('SELECT envelope FROM artifacts WHERE id = ?').get(id) as { envelope: string } | undefined
    return row ? (JSON.parse(row.envelope) as Envelope) : undefined
  }

  list(filter: { kind?: ArtifactKind; runId?: string; nodeId?: string; decisionType?: string; limit?: number } = {}): Envelope[] {
    const clauses: string[] = []
    const params: string[] = []
    for (const [column, value] of [['kind', filter.kind], ['run_id', filter.runId], ['node_id', filter.nodeId], ['decision_type', filter.decisionType]] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`)
        params.push(value)
      }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000)
    const rows = this.ctx.store.db.prepare(`SELECT envelope FROM artifacts ${where} ORDER BY created_at, id LIMIT ${limit}`).all(...params) as { envelope: string }[]
    return rows.map((row) => JSON.parse(row.envelope) as Envelope)
  }

  /** Walk an artifact's inputs backwards: the "why" chain (REQ-ART-3). Bounded by `explainDepth`. */
  explain(id: string): ExplainNode | undefined {
    const walk = (current: string, depth: number, seen: Set<string>): ExplainNode | undefined => {
      const envelope = this.get(current)
      if (!envelope) return undefined
      const summary = envelope.kind === 'decision'
        ? `${(envelope.body as Decision).decisionType}: ${(envelope.body as Decision).outcome.option}`
        : `${envelope.kind} (${envelope.bodySchema})`
      const inputs = depth >= (this.config.explainDepth ?? 16) || seen.has(current)
        ? []
        : envelope.inputs.map((input) => walk(input, depth + 1, new Set([...seen, current]))).filter((node): node is ExplainNode => node !== undefined)
      return { id: envelope.id, kind: envelope.kind, summary, inputs }
    }
    return walk(id, 0, new Set())
  }

  private floorClassification(requested: Classification, inputs: readonly string[]): Classification {
    let floor = requested
    for (const input of inputs) {
      const parent = this.get(input)
      if (parent && CLASSIFICATION_RANK[parent.classification] > CLASSIFICATION_RANK[floor]) floor = parent.classification
    }
    return floor
  }
}

export default Artifacts
