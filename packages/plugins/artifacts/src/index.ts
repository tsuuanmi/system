/**
 * `ctx.artifacts`: immutable, content-addressed artifacts, including decision records
 * (INV-13, ADR-0013, docs/design/artifacts.md). Every envelope and body is validated
 * against its schema before it is stored (INV-14).
 * @module @tsuuanmi/system-artifacts
 */
import type { DatabaseSync } from 'node:sqlite'
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
  /**
   * `@1.1` once it records a team vote or a client's decision; otherwise `@1.0`, so earlier decisions
   * keep their ids. A recorder that uses a later minor's fields names it (`@1.2`: a review's quote checks;
   * `@1.3`: a `retention` decision; `@1.4`: an `autonomy`, `approval`, `board`, or `budget` decision;
   * `@1.5`: a `lifecycle` decision; `@1.6`: a `policy-change` decision; `@1.7`: a `registration` or `verdict` decision;
   * `@1.8`: an `enrollment` decision, or a `recovery` decision whose outcome is `wait`; `@1.9`: a
   * `recovery` decision whose outcome is `resend`).
   */
  schema: 'decision@1.0' | 'decision@1.1' | 'decision@1.2' | 'decision@1.3' | 'decision@1.4' | 'decision@1.5' | 'decision@1.6' | 'decision@1.7' | 'decision@1.8' | 'decision@1.9'
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

const CLASSIFICATION_RANK: Record<Classification, number> = { public: 0, 'operator-shared': 1, 'local-private': 2 }

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
const CONTENT_ID_EXACT = /^sha256:[0-9a-f]{64}$/

/**
 * The UTF-16 index of the code point `count` code points after `from`, and how many were passed:
 * a window counted this way never splits a surrogate pair.
 */
function advance(text: string, from: number, count: number): { index: number; passed: number } {
  let index = from
  let passed = 0
  while (index < text.length && passed < count) {
    const code = text.charCodeAt(index)
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00 ? 2 : 1
    passed++
  }
  return { index, passed }
}

/** What one collection did. */
export interface Collected {
  /** Artifacts deleted. */
  removed: number
  /** Artifacts kept: referenced, inside the grace period, or of a run that still exists. */
  kept: number
}

/** Tables a collection never reads references from: this plugin's own, and the event log (else events and artifacts would keep each other). */
const NOT_ROOTS = new Set(['artifacts', 'artifact_runs', 'events', 'system_migrations', 'sqlite_sequence'])
const CONTENT_ID = /sha256:[0-9a-f]{64}/g
const PAGE = 1000

const refsOf = (envelope: Envelope): string[] => [...envelope.inputs, ...(envelope.lineage.supersedes ?? []), ...(envelope.lineage.invalidates ?? [])]

/** Everything reachable from `roots` through `edges` (inputs and lineage). */
function mark(roots: Iterable<string>, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const marked = new Set<string>()
  const stack = [...roots].filter((id) => edges.has(id))
  while (stack.length) {
    const id = stack.pop()!
    if (marked.has(id)) continue
    marked.add(id)
    for (const next of edges.get(id) ?? []) if (!marked.has(next)) stack.push(next)
  }
  return marked
}

/**
 * A table's rows a page at a time, by rowid, each page its own statement (a consistent snapshot in
 * WAL), yielding to the event loop between pages: no read holds the connection for long.
 */
async function* pages(db: DatabaseSync, table: string, columns: string): AsyncGenerator<Record<string, unknown>> {
  let after = -Infinity
  for (;;) {
    const rows = db.prepare(`SELECT rowid AS rowid_, ${columns} FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`).all(after === -Infinity ? -9007199254740991 : after) as Array<Record<string, unknown>>
    for (const row of rows) yield row
    if (rows.length < PAGE) return
    after = Number(rows.at(-1)!.rowid_)
    await new Promise((resolve) => setImmediate(resolve))
  }
}

export interface Config {
  /** Maximum depth `explain` walks before truncating (default 16). */
  explainDepth?: number
  /** Maximum distinct artifacts one `explain` visits (default 1000; INV-9). */
  explainBudget?: number
  /** How long a new artifact is kept even when nothing references it yet, in hours (default 24). */
  collectGraceHours?: number
  /** Artifacts deleted per write transaction, so none holds the store's lock for long (default 1000). */
  collectBatch?: number
}

export class Artifacts extends Service {
  static inject = ['store']
  static Config: z<Config> = z.object({
    explainDepth: z.natural().min(1).max(64).default(16).description('Maximum depth explain walks'),
    explainBudget: z.natural().min(1).default(1000).description('Maximum distinct artifacts one explain visits'),
    collectGraceHours: z.natural().min(1).default(24).description('Hours a new artifact is kept before collection may take it, referenced or not'),
    collectBatch: z.natural().min(1).default(1000).description('Artifacts deleted per write transaction (the pass continues in further ones)'),
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
      {
        // Retention re-checks what was written since its scan began.
        version: 3,
        sql: 'CREATE INDEX artifacts_created ON artifacts (created_at);',
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
  recordDecision(decision: Omit<Decision, 'schema'> & { schema?: Decision['schema'] }, meta: { producer: Producer; runId?: string; nodeId?: string; classification?: Classification }): Envelope {
    // Decision inputs are a set (uniqueItems): sort them so order never changes the id. Prose
    // (questions, reasons, rationale) can quote model or caller text of any length: it is clamped
    // to the schema's bounds here, once, so a long reason never fails the decision it explains.
    const v11 = decision.decisionType === 'vote' || decision.vote !== undefined || decision.decider.type === 'client'
    const body: Decision = {
      ...decision, schema: decision.schema ?? (v11 ? 'decision@1.1' : 'decision@1.0'), inputs: [...new Set(decision.inputs)].sort(),
      question: clampProse(decision.question, 500),
      candidates: decision.candidates.map((c) => ({ ...c, reasons: c.reasons.map((r) => clampProse(r, 300)) })),
      ...(decision.rationale !== undefined ? { rationale: clampProse(decision.rationale, 1000) } : {}),
    }
    this.schemas.assert(body.schema, body)
    const selected = body.candidates.filter((candidate) => candidate.selected)
    if (selected.length !== 1 || selected[0]?.option !== body.outcome.option) {
      throw new TypeError('decision: exactly one selected candidate must equal outcome.option')
    }
    // INV-13: every candidate says why, the rejected ones why they lost, not only the winner.
    const unexplained = body.candidates.find((candidate) => !candidate.reasons.some((reason) => reason.trim() !== ''))
    if (unexplained) throw new TypeError(`decision: candidate ${unexplained.option} has no reason; every candidate, selected or rejected, needs one`)
    return this.put({
      kind: 'decision', bodySchema: body.schema, body, inputs: body.inputs,
      classification: meta.classification ?? 'operator-shared', producer: meta.producer,
      ...(meta.runId !== undefined && { runId: meta.runId }), ...(meta.nodeId !== undefined && { nodeId: meta.nodeId }),
    })
  }

  get(id: string): Envelope | undefined {
    const row = this.ctx.store.db.prepare('SELECT envelope FROM artifacts WHERE id = ?').get(id) as { envelope: string } | undefined
    return row ? (JSON.parse(row.envelope) as Envelope) : undefined
  }

  /**
   * The artifacts that match `filter`, in the order they were stored (oldest first; `newest`: newest
   * first, contract 1.1), at most `limit` (100 by default, 1 to 1000).
   */
  list(filter: { kind?: ArtifactKind; runId?: string; nodeId?: string; decisionType?: string; limit?: number; newest?: boolean } = {}): Envelope[] {
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
    const order = filter.newest === true ? 'DESC' : 'ASC'
    const rows = this.ctx.store.db.prepare(`SELECT DISTINCT a.envelope, a.created_at, a.id FROM artifacts a ${join} ${where} ORDER BY a.created_at ${order}, a.id ${order} LIMIT ${limit}`).all(...params) as { envelope: string }[]
    return rows.map((row) => JSON.parse(row.envelope) as Envelope)
  }

  /**
   * Read an artifact for the operator: its header, and a window of `max` characters (code points)
   * of its body from `offset`. The body's `text` when it has one (an answer), else the body as
   * JSON. An id that is not a content id is refused before any lookup. One that is not stored
   * reads as `expired` when a stored artifact still names it, else `unknown`.
   */
  read(id: string, window: { offset?: number; max?: number } = {}): ArtifactRead {
    if (!CONTENT_ID_EXACT.test(id)) throw new TypeError(`not a content id (sha256: and 64 lowercase hex digits): ${id.slice(0, 80)}`)
    const offset = window.offset ?? 0
    const max = window.max ?? READ_DEFAULT_CHARS
    if (!Number.isInteger(offset) || offset < 0) throw new TypeError('offset must be a whole number from 0')
    if (!Number.isInteger(max) || max < 1 || max > READ_MAX_CHARS) throw new TypeError(`max must be a whole number from 1 to ${READ_MAX_CHARS}`)
    const envelope = this.get(id)
    if (!envelope) {
      // The id is plain hex here (checked above), so it holds no LIKE wildcard.
      const row = this.ctx.store.db.prepare('SELECT id, kind, created_at FROM artifacts WHERE envelope LIKE ? LIMIT 1').get(`%"${id}"%`) as { id: ContentId; kind: ArtifactKind; created_at: string } | undefined
      return row
        ? { id: id as ContentId, state: 'expired', referencedBy: { id: row.id, kind: row.kind, createdAt: row.created_at }, note: `expired: collected by retention; its content is gone (still named by ${row.kind} ${row.id}, recorded ${row.created_at})` }
        : { id: id as ContentId, state: 'unknown', note: 'unknown: no artifact here has this id, and none names it (never stored here, or collected with everything that named it)' }
    }
    const body = envelope.body as { text?: unknown } | undefined
    const content = envelope.body === undefined ? 'blob' : typeof body?.text === 'string' ? 'text' : 'json'
    const whole = content === 'blob' ? '' : content === 'text' ? body!.text as string : JSON.stringify(envelope.body, null, 2)
    const start = advance(whole, 0, offset)
    const end = advance(whole, start.index, max)
    const chars = start.passed + end.passed + advance(whole, end.index, Number.POSITIVE_INFINITY).passed
    return {
      id: envelope.id, state: 'stored', kind: envelope.kind, bodySchema: envelope.bodySchema, classification: envelope.classification, producer: envelope.producer,
      ...(envelope.runId !== undefined ? { runId: envelope.runId } : {}), ...(envelope.nodeId !== undefined ? { nodeId: envelope.nodeId } : {}),
      createdAt: envelope.createdAt, inputs: envelope.inputs, content, chars, offset: start.passed, truncated: end.index < whole.length, text: whole.slice(start.index, end.index),
    }
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
      // Collected by retention (or never stored): the reference stays, the content is gone.
      if (!envelope) return depth === 0 ? undefined : { id: current as ContentId, kind: 'expired', summary: 'expired: collected by retention', inputs: [] }
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

  /**
   * Retention (docs/design/artifacts.md#storage): delete the artifacts nothing retained needs.
   * The roots are every content id written in any store table except this plugin's own and the
   * event log, so a plugin that keeps an artifact id in its rows keeps the artifact, with no
   * listener to forget. An artifact younger than the grace period, or linked to a run whose id
   * still appears in any table, is a root too. Marking follows every root's inputs and lineage,
   * transitively, so nothing a kept artifact references is collected; everything unmarked is.
   *
   * The scan reads the store in pages outside any transaction, yielding between pages, so writers
   * and the event loop keep running. Short write transactions of `collectBatch` then re-check
   * what the scan could have missed and delete. Something written meanwhile can name a
   * candidate only through a new artifact's inputs or lineage, or a new run link (a writer gets an
   * old id from a row the scan marked, or from a put, which refuses a missing input), so those are
   * re-checked; a writer that copied a raw id from a row the scan had not yet read, while that
   * row was deleted, is the one case left, and no writer does that today.
   */
  async collect(now: number = Date.now(), hooks: { afterScan?: () => void } = {}): Promise<Collected> {
    const db = this.ctx.store.db
    const cutoff = new Date(now - (this.config.collectGraceHours ?? 24) * 60 * 60_000).toISOString()
    const scanStart = new Date().toISOString()
    const referenced = new Set<string>()
    const values = new Set<string>()
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    for (const { name } of tables) {
      if (NOT_ROOTS.has(name) || name.startsWith('sqlite_')) continue
      for await (const row of pages(db, `"${name.replaceAll('"', '""')}"`, '*')) {
        for (const value of Object.values(row)) {
          if (typeof value !== 'string') continue
          if (value.length <= 200) values.add(value)
          for (const match of value.matchAll(CONTENT_ID)) referenced.add(match[0])
        }
      }
    }
    const edges = new Map<string, string[]>()
    const created = new Map<string, string>()
    for await (const row of pages(db, 'artifacts', 'id, envelope, created_at')) {
      const envelope = JSON.parse(row.envelope as string) as Envelope
      edges.set(row.id as string, refsOf(envelope))
      created.set(row.id as string, row.created_at as string)
    }
    const runsOf = new Map<string, string[]>()
    for await (const row of pages(db, 'artifact_runs', 'id, run_id')) runsOf.set(row.id as string, [...(runsOf.get(row.id as string) ?? []), row.run_id as string])
    // A kept artifact keeps its whole why-chain: one in the grace period, or of a live run, is a root.
    const roots = new Set(referenced)
    for (const [id, at] of created) if (at >= cutoff || (runsOf.get(id) ?? []).some((run) => values.has(run))) roots.add(id)
    const marked = mark(roots, edges)
    const candidates = new Set([...created.keys()].filter((id) => !marked.has(id)))
    if (!candidates.size) return { removed: 0, kept: edges.size }
    // Between the scan and the deletion other work writes; tests use this to write there.
    hooks.afterScan?.()
    // Deleted in short transactions of `collectBatch`, yielding between them, each re-checking
    // what was written since the scan began: no write lock is held for long.
    const batch = this.config.collectBatch ?? 1000
    const queue = [...candidates]
    let removed = 0
    while (queue.length) {
      const chunk = queue.splice(0, batch)
      removed += this.ctx.store.transaction((tx): number => {
        const fresh = new Set<string>()
        for (const row of tx.prepare('SELECT id, envelope FROM artifacts WHERE created_at >= ?').iterate(scanStart) as Iterable<{ id: string; envelope: string }>) {
          const refs = refsOf(JSON.parse(row.envelope) as Envelope)
          edges.set(row.id, refs)
          for (const ref of refs) fresh.add(ref)
        }
        // A new link since the scan (the same content put again for another run) keeps a candidate,
        // and with it everything it references.
        const linksOf = tx.prepare('SELECT run_id FROM artifact_runs WHERE id = ?')
        for (const id of queue.length ? [...chunk, ...queue] : chunk) {
          const known = new Set(runsOf.get(id) ?? [])
          if ((linksOf.all(id) as Array<{ run_id: string }>).some((link) => !known.has(link.run_id))) fresh.add(id)
        }
        const kept = mark(fresh, edges)
        const removeArtifact = tx.prepare('DELETE FROM artifacts WHERE id = ?')
        const removeRuns = tx.prepare('DELETE FROM artifact_runs WHERE id = ?')
        let count = 0
        for (const id of chunk) {
          if (kept.has(id)) continue
          removeArtifact.run(id)
          removeRuns.run(id)
          count++
        }
        return count
      })
      if (queue.length) await new Promise((resolve) => setImmediate(resolve))
    }
    return { removed, kept: edges.size - removed }
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
