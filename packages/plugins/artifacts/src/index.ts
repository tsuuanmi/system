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
  /** Maximum distinct artifacts one `explain` visits (default 1000; INV-9). */
  explainBudget?: number
}

export class Artifacts extends Service {
  static inject = ['store']
  static Config: z<Config> = z.object({
    explainDepth: z.natural().min(1).max(64).default(16).description('Maximum depth explain walks'),
    explainBudget: z.natural().min(1).default(1000).description('Maximum distinct artifacts one explain visits'),
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
      {
        // Identical content can be produced by several runs; the id stays content-only.
        version: 2,
        sql: `CREATE TABLE artifact_runs (id TEXT NOT NULL, run_id TEXT NOT NULL, node_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (id, run_id, node_id));
        INSERT OR IGNORE INTO artifact_runs (id, run_id, node_id) SELECT id, run_id, COALESCE(node_id, '') FROM artifacts WHERE run_id IS NOT NULL;`,
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
    const inputs = [...new Set(input.inputs ?? [])].sort()
    const lineage = input.lineage ?? {}
    const id = contentId({
      kind: input.kind, bodySchema: input.bodySchema, body: input.body,
      blob: input.blob && { ref: input.blob.ref, mediaType: input.blob.mediaType },
      inputs, lineage, subject: input.subject,
    })
    return this.ctx.store.transaction((db) => {
      const classification = this.floorClassification(input.classification, [...inputs, ...(lineage.supersedes ?? []), ...(lineage.invalidates ?? [])])
      const existing = this.get(id)
      if (existing) {
        if (CLASSIFICATION_RANK[classification] > CLASSIFICATION_RANK[existing.classification]) {
          throw new TypeError(`artifact ${id} exists as ${existing.classification}; refusing a stricter classification (${classification}) on deduplication`)
        }
        this.linkRun(id, input.runId, input.nodeId)
        return existing
      }
      const envelope: Envelope = { ...input, schema: 'artifact-envelope@1.0', id, classification, inputs, lineage, createdAt: new Date().toISOString() }
      this.schemas.assertRecord(envelope)
      const decisionType = input.kind === 'decision' ? (input.body as Decision).decisionType : null
      db.prepare(
        `INSERT INTO artifacts (id, kind, body_schema, classification, run_id, node_id, subject_ref, decision_type, envelope, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, envelope.kind, envelope.bodySchema, classification, envelope.runId ?? null, envelope.nodeId ?? null,
        envelope.subject?.ref ?? null, decisionType, JSON.stringify(envelope), envelope.createdAt)
      this.linkRun(id, input.runId, input.nodeId)
      return envelope
    })
  }

  /**
   * Record one decision (INV-13). Enforces what the schema cannot: the single selected
   * candidate equals the outcome (docs/reference/schemas.md#decision).
   */
  recordDecision(decision: Omit<Decision, 'schema'>, meta: { producer: Producer; runId?: string; nodeId?: string; classification?: Classification }): Envelope {
    // Decision inputs are a set (uniqueItems): sort them so order never changes the id. Prose
    // (questions, reasons, rationale) can quote model or caller text of any length: it is clamped
    // to the schema's bounds here, once, so a long reason never fails the decision it explains.
    const body: Decision = {
      schema: 'decision@1.0', ...decision, inputs: [...new Set(decision.inputs)].sort(),
      question: clampProse(decision.question, 500),
      candidates: decision.candidates.map((c) => ({ ...c, reasons: c.reasons.map((r) => clampProse(r, 300)) })),
      ...(decision.rationale !== undefined ? { rationale: clampProse(decision.rationale, 1000) } : {}),
    }
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
    for (const [column, value] of [['a.kind', filter.kind], ['a.decision_type', filter.decisionType], ['r.run_id', filter.runId], ['r.node_id', filter.nodeId]] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`)
        params.push(value)
      }
    }
    const join = filter.runId !== undefined || filter.nodeId !== undefined ? 'JOIN artifact_runs r ON r.id = a.id' : ''
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(Math.max(Number.isFinite(filter.limit) ? Math.floor(filter.limit as number) : 100, 1), 1000)
    const rows = this.ctx.store.db.prepare(`SELECT DISTINCT a.envelope, a.created_at, a.id FROM artifacts a ${join} ${where} ORDER BY a.created_at, a.id LIMIT ${limit}`).all(...params) as { envelope: string }[]
    return rows.map((row) => JSON.parse(row.envelope) as Envelope)
  }

  /**
   * Walk an artifact's inputs backwards: the "why" chain (REQ-ART-3). Shared ancestors are
   * visited once and returned as the same node object (a DAG), so diamond-shaped histories
   * stay linear; depth and the total number of artifacts are bounded (INV-9).
   */
  explain(id: string): ExplainNode | undefined {
    const maxDepth = this.config.explainDepth ?? 16
    const budget = this.config.explainBudget ?? 1000
    const memo = new Map<string, ExplainNode>()
    const walk = (current: string, depth: number): ExplainNode | undefined => {
      const cached = memo.get(current)
      if (cached) return cached
      if (memo.size >= budget) return undefined
      const envelope = this.get(current)
      if (!envelope) return undefined
      const summary = envelope.kind === 'decision'
        ? `${(envelope.body as Decision).decisionType}: ${(envelope.body as Decision).outcome.option}`
        : `${envelope.kind} (${envelope.bodySchema})`
      const node: ExplainNode = { id: envelope.id, kind: envelope.kind, summary, inputs: [] }
      memo.set(current, node)
      if (depth < maxDepth) {
        for (const input of envelope.inputs) {
          const child = walk(input, depth + 1)
          if (child) node.inputs.push(child)
        }
      }
      return node
    }
    return walk(id, 0)
  }

  private linkRun(id: string, runId: string | undefined, nodeId: string | undefined): void {
    if (runId === undefined) return
    this.ctx.store.db.prepare('INSERT OR IGNORE INTO artifact_runs (id, run_id, node_id) VALUES (?, ?, ?)').run(id, runId, nodeId ?? '')
  }

  /** The strictest classification among the request and every referenced artifact; unknown references are refused (INV-2). */
  private floorClassification(requested: Classification, refs: readonly string[]): Classification {
    let floor = requested
    for (const ref of refs) {
      const parent = this.get(ref)
      if (!parent) throw new TypeError(`unknown input or lineage artifact ${ref}`)
      if (CLASSIFICATION_RANK[parent.classification] > CLASSIFICATION_RANK[floor]) floor = parent.classification
    }
    return floor
  }
}

/** At most `max` characters (code points, as JSON Schema counts them), cut on a whole character and marked with '…'. */
function clampProse(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`
}

export default Artifacts
