/**
 * The task dossier (docs/design/task-dossier.md, ADR-0070): the one append-only record the Workers of
 * a board task's attempts coordinate through, when they cannot share a session or message each other.
 *
 * - **Entries.** Each is a content-hashed `task-dossier-entry@1.0` artifact of one kind (`plan`,
 *   `progress`, `review`, `response`, `evidence`), numbered per task from 1 (`seq`) and naming the
 *   entry before it (`prev`): a hash chain. The engine's table (`workflow_dossiers`) lists them in
 *   order and is append-only (a trigger refuses an update); an entry, being content-addressed, never
 *   changes. The dossier is the task's, so it is carried across its attempts and runs.
 * - **Who writes.** The engine writes `evidence` (acceptance and its checks, the report to the board,
 *   the landing) and, for a step that appended nothing itself, the step's entry when it settles: a
 *   website or model Worker's answer as it is; an agent Worker's answer linked, never copied; a
 *   review's verdict and findings from its assessment, its result linked. A Worker appends its own
 *   through a narrow, gated tool (`dossier_append`, {@link TaskDossiers.appendByWorker}) its source
 *   gives its run, bound to its step and execution (an agent Worker's host tool, ADR-0070; never a
 *   tool of System's own surface, where a caller could name a step): only while that execution is
 *   the one its step runs, only the kinds its step's role may write, bounded text; never `evidence`.
 * - **Who reads.** Every step's brief points at a slice: a summary and the latest entries within
 *   {@link DOSSIER_LIMITS}`.sliceChars` (progressive disclosure), and a source with a workspace of
 *   the run's own writes the whole dossier there as `.system/DOSSIER.md`, within its own bound; the
 *   MCP tool `dossier_read` pages through every entry. A reviewer reads the dossier, never its
 *   author's conversation: the dossier holds no transcript, only what was appended to it.
 */
import type { Classification, Subject } from '@tsuuanmi/system-board-core'
import { bodyText, type BriefCheck, type BriefFile, type BriefPointer } from '@tsuuanmi/system-libs'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import type { Engine } from './engine.ts'
import { writes } from './review.ts'
import { blocks, bySeverity, clampText, countOf, type Finding, findingLine, type ResolvedNode } from './spec.ts'
import { type NodeRow, now, type RunRow, WorkflowFailure } from './types.ts'

export type DossierKind = 'plan' | 'progress' | 'review' | 'response' | 'evidence'
export const DOSSIER_KINDS: readonly DossierKind[] = ['plan', 'progress', 'review', 'response', 'evidence']

/** The dossier's bounds (INV-9); the schema holds the same. */
export const DOSSIER_LIMITS = {
  /** Characters of one entry's text. */
  text: 4000,
  /** Artifacts one entry links, and commits it names. */
  refs: 16,
  commits: 16,
  /** Characters of a response's `finding`. */
  finding: 200,
  /** Entries one task's dossier holds. */
  entries: 10_000,
  /** Characters of the slice every step's brief points at: a summary and the latest entries. */
  sliceChars: 6000,
  /** Characters of the whole dossier a run's workspace is given (`.system/DOSSIER.md`). */
  fileChars: 200_000,
  /** Entries one `dossier_read` returns, by default and at most. */
  page: 20,
  pageMax: 50,
} as const

/** Where a run's workspace holds the whole dossier (brief@1.2 `files`): under `.system/`, which its source makes git ignore. */
export const DOSSIER_FILE = '.system/DOSSIER.md'

/** The characters of the slice's and the file's header (the summary), at most. */
const HEADER_CHARS = 700
/** The fewest characters of an entry's text worth showing after the first. */
const MIN_TEXT = 80
/** Entries a view reads, newest first, at most: what the file's bound could show. */
const VIEW_ROWS = 2000

/** The artifact kind of an entry of each kind. */
const ARTIFACT_KIND = { plan: 'plan', progress: 'report', review: 'finding', response: 'report', evidence: 'evidence' } as const

/**
 * What each step's role may append itself: a reviewer reviews; an author plans, reports progress,
 * answers findings, and pastes the output of the checks it ran as `evidence` (T267: its author is the
 * Worker, so a reader tells it from the System's own evidence, which is checked; this is reported).
 */
export const ROLE_KINDS: Readonly<Record<StepRole, readonly DossierKind[]>> = {
  author: ['plan', 'progress', 'response', 'evidence'],
  review: ['review'],
  other: ['progress'],
}

export type StepRole = 'author' | 'review' | 'other'

/** `task-dossier-entry@1.0`. */
export interface DossierEntry {
  schema: 'task-dossier-entry@1.0'
  projectId: string
  taskId: string
  seq: number
  prev?: ArtifactRef
  attempt: number
  kind: DossierKind
  author: { type: 'worker' | 'system'; ref: string; runId?: string; nodeId?: string; execution?: string }
  text: string
  refs?: ArtifactRef[]
  subject?: Subject
  commits?: string[]
  finding?: string
  inReplyTo?: ArtifactRef
}

/** An entry to append: everything but its place, which the engine gives it. */
export type NewEntry = Omit<DossierEntry, 'schema' | 'seq' | 'prev'>

/** `task-dossier@1.0`: the dossier as one reader is given it. */
export interface DossierView {
  schema: 'task-dossier@1.0'
  projectId: string
  taskId: string
  entries: number
  head: ArtifactRef
  shown: ArtifactRef[]
  maxChars: number
  text: string
}

/** One entry as `dossier_read` returns it. */
export interface DossierEntryView extends Omit<DossierEntry, 'schema' | 'projectId' | 'taskId'> {
  id: ArtifactRef
  createdAt: string
}

/** A page of a task's dossier (`dossier_read`). */
export interface DossierPage {
  projectId: string
  taskId: string
  /** Entries the dossier holds. */
  total: number
  entries: DossierEntryView[]
  /** The `from` of the next page, when there is one. */
  next?: number
}

/**
 * Who appends: the step a Worker source bound its run's `dossier_append` to when it built the run,
 * from its own record (its workflow run, the step it serves, and its execution), never from what the
 * agent names. The engine takes it only while that execution is the one the step runs now.
 */
export interface DossierCaller {
  runId: string
  nodeId: string
  /** The execution the source started for the step (`WorkerExecution.id`). */
  execution: string
}

/** What a Worker appends through `dossier_append`: the kind, its bounded text, and what it links. */
export interface DossierAppendInput {
  kind: DossierKind
  text: string
  refs?: string[]
  commits?: string[]
  finding?: string
  inReplyTo?: string
}

interface DossierRow { task_id: string; seq: number; project_id: string; attempt: number; kind: DossierKind; entry: ArtifactRef; author_type: string; run_id: string | null; node_id: string | null; step: string | null; created_at: string }

const COMMIT = /^[0-9a-f]{7,64}$/
const CONTENT_ID = /^sha256:[0-9a-f]{64}$/
const chars = (text: string): number => [...text].length
const describe = (s: Subject): string => `${s.type} ${s.ref}${s.version ? ` at ${s.version}` : ''}`

/**
 * The capability a Worker offers when its runtime gives its runs the dossier tools (agent Workers:
 * host tools, ADR-0070). A `verifies` step requires it (T267): a Worker that could not show its
 * checks' output is never admitted to a step that must.
 */
export const DOSSIER_CAPABILITY = 'dossier'

/** The checks a task's criteria name that are commands its author runs: their output is what its evidence shows. */
const COMMAND_CHECKS: readonly BriefCheck[] = ['tests', 'typecheck', 'lint']
/** A reported exit code: `exit 0`, `exit code: 1`, `exited 2`, `exit status 0`. */
const EXIT_CODE = /\bexit(?:ed)?(?:\s+(?:code|status))?\s*[:=]?\s*-?\d+\b/gi
/** A command named in prose: `Command: corepack pnpm lint`. */
const COMMAND_LINE = /^command\s*:/i

/**
 * Why the evidence a writing step appended does not show its checks' output (T267), or undefined when
 * it does: some evidence; at least one command it ran (a `$ …` line, a `Command:` line, or a reported
 * exit code); each command check the task's criteria name (`tests`, `typecheck`, `lint`) named, with
 * its output or why it could not run; and output beside the commands (a line that is neither a command
 * nor an exit code). Exit codes are not required: a Worker's shell tool may not print them, and a
 * Worker that says so must not be refused for its honesty. A shape the engine can read, never proof
 * the commands ran: the run's required checks run again on the exact result at acceptance (ADR-0063).
 */
export function evidenceProblem(texts: readonly string[], checks: readonly BriefCheck[]): string | undefined {
  const text = texts.join('\n').trim()
  if (!text) return 'the step\'s dossier holds no evidence entry by its Worker in this attempt'
  const required = COMMAND_CHECKS.filter((c) => checks.includes(c))
  const lines = text.split('\n').map((l) => l.trim())
  const exitCode = new RegExp(EXIT_CODE.source, 'i')
  const commands = lines.filter((l) => l.startsWith('$') || COMMAND_LINE.test(l) || exitCode.test(l)).length
  if (!commands) return 'its evidence shows no command it ran: each command is shown (`$ <command>` or `Command: <command>`), with its output and its exit code when the tool reports one'
  const missing = required.filter((c) => !new RegExp(`\\b${c === 'tests' ? 'tests?' : c}\\b`, 'i').test(text))
  if (missing.length) return `its evidence does not name the check${missing.length > 1 ? 's' : ''} ${missing.join(', ')} the task's criteria require`
  // Output: a line that is no command (`$ …`) and holds more than an exit code.
  // A `Command: <c>` line is a command alone; `Command: <c> -> <output>` holds its output too.
  const output = lines.filter((l) => l && !l.startsWith('$') && !(COMMAND_LINE.test(l) && !l.includes('->')) && l.replace(EXIT_CODE, '').replace(/[\s:,.;()-]/g, '') !== '')
  if (!output.length) return 'its evidence holds no output line beside the commands and their exit codes'
  return undefined
}

/** A step's role in its task's work: a review (bound to a subject, or offering review), a writing step, or another. */
export function roleOf(spec: ResolvedNode, node: Pick<NodeRow, 'subject'>): StepRole {
  if (node.subject || spec.reviewOf !== undefined || (spec.capabilities.includes('review') && !writes(spec))) return 'review'
  return writes(spec) ? 'author' : 'other'
}

/** The step's key an entry a Worker appended is recorded under: the node's attempt and escalation. */
const stepOf = (node: Pick<NodeRow, 'attempt' | 'escalations'>): string => `${node.attempt}:${node.escalations}`

/** The subject a review step is bound to (its exact-subject gate's), when it is bound to one. */
function boundSubject(node: Pick<NodeRow, 'subject'>): Subject | undefined {
  if (!node.subject) return undefined
  try {
    const bound = (JSON.parse(node.subject) as { subject?: { type?: string; ref?: string; version?: string } }).subject
    return bound?.type && bound.ref ? { type: bound.type, ref: bound.ref, ...(bound.version ? { version: bound.version } : {}) } as Subject : undefined
  } catch {
    return undefined
  }
}

/**
 * The dossier as text within `maxChars` characters (code points): a summary (how many entries of
 * each kind, which are left out, and where to read them), then the latest entries, newest last, each
 * with its place, attempt, kind, author, and id, its text cut to what is left, and what it links.
 * `latest` is newest first and contiguous. Deterministic for the same input.
 */
export function renderDossier(
  meta: { projectId: string; taskId: string; total: number; kinds: Partial<Record<DossierKind, number>>; omittedKey?: (before: number) => Array<{ seq: number; kind: DossierKind }> },
  latest: ReadonlyArray<{ seq: number; ref: ArtifactRef; body: DossierEntry | undefined }>,
  maxChars: number,
): { text: string; shown: ArtifactRef[] } {
  let room = maxChars - HEADER_CHARS
  const blocks: Array<{ seq: number; ref: ArtifactRef; text: string }> = []
  for (const entry of latest) {
    const body = entry.body
    const who = !body ? '' : body.author.type === 'system' ? 'System' : `${body.author.ref}${body.author.nodeId ? `, step ${body.author.nodeId}` : ''}`
    const head = body ? `## #${entry.seq} · attempt ${body.attempt} · ${body.kind} · ${who} · ${entry.ref}` : `## #${entry.seq} · ${entry.ref}`
    const linked = body ? clampText([
      ...(body.subject ? [`subject: ${describe(body.subject)}`] : []),
      ...(body.commits?.length ? [`commits: ${body.commits.join(', ')}`] : []),
      ...(body.finding ? [`finding: ${body.finding}`] : []),
      ...(body.inReplyTo ? [`in reply to: ${body.inReplyTo}`] : []),
      ...(body.refs?.length ? [`linked: ${body.refs.join(', ')}`] : []),
    ].join('; '), 1200) : ''
    // The block's own lines and the blank line before it.
    const fixed = chars(head) + 1 + (linked ? chars(linked) + 1 : 0) + 2
    const available = room - fixed
    if (available < (blocks.length ? MIN_TEXT : 1)) break
    const text = body ? clampText(body.text, available) : 'expired: collected by retention; only its id remains'
    const block = [head, text, ...(linked ? [linked] : [])].join('\n')
    room -= chars(block) + 2
    blocks.push({ seq: entry.seq, ref: entry.ref, text: block })
  }
  const oldest = blocks.at(-1)?.seq ?? meta.total + 1
  const kinds = DOSSIER_KINDS.filter((k) => meta.kinds[k]).map((k) => `${meta.kinds[k]} ${k}`).join(', ')
  const left = oldest - 1
  const omitted = left > 0 ? meta.omittedKey?.(oldest) ?? [] : []
  const header = clampText([
    `Dossier of board task ${meta.taskId} (project ${meta.projectId}): ${meta.total} entr${meta.total === 1 ? 'y' : 'ies'}${kinds ? ` (${kinds})` : ''}, newest last. Each entry is appended once and never changed: follow it, and add what you do to it, never rewrite it.`,
    left > 0
      ? `Entries 1 to ${left} are not shown here${omitted.length ? ` (among them ${omitted.map((o) => `${o.kind} #${o.seq}`).join(', ')})` : ''}: read them with the MCP tool dossier_read, or in ${DOSSIER_FILE} where your workspace has it.`
      : 'Every entry is shown.',
  ].join('\n'), HEADER_CHARS)
  const text = [header, ...blocks.reverse().map((b) => b.text)].join('\n\n')
  return { text: clampText(text, maxChars), shown: blocks.map((b) => b.ref) }
}

export class TaskDossiers {
  constructor(private readonly e: Engine) {}

  /**
   * Append one entry to its task's dossier, in one transaction: its place is the next after the
   * latest (`seq`), it names that one (`prev`), and it is stored as an artifact before its row. A
   * link (`refs`, `inReplyTo`) to an artifact not stored is refused (INV-2); a full dossier refuses
   * any further entry (INV-9).
   */
  append(input: NewEntry, classification: Classification, step?: string): { ref: ArtifactRef; seq: number } {
    return this.e.ctx.store.transaction((db) => {
      const head = db.prepare('SELECT seq, entry FROM workflow_dossiers WHERE task_id = ? ORDER BY seq DESC LIMIT 1').get(input.taskId) as { seq: number; entry: ArtifactRef } | undefined
      const seq = (head?.seq ?? 0) + 1
      if (seq > DOSSIER_LIMITS.entries) throw new WorkflowFailure('invalid_input', `the dossier of board task ${input.taskId} holds ${DOSSIER_LIMITS.entries} entries, its bound; nothing was appended`)
      const refs = [...new Set(input.refs ?? [])].slice(0, DOSSIER_LIMITS.refs)
      const body: DossierEntry = {
        schema: 'task-dossier-entry@1.0', projectId: input.projectId, taskId: input.taskId, seq, ...(head ? { prev: head.entry } : {}),
        attempt: input.attempt, kind: input.kind, author: input.author, text: clampText(input.text.trim() || '(empty)', DOSSIER_LIMITS.text),
        ...(refs.length ? { refs } : {}), ...(input.subject ? { subject: input.subject } : {}),
        ...(input.commits?.length ? { commits: [...new Set(input.commits)].slice(0, DOSSIER_LIMITS.commits) } : {}),
        ...(input.finding ? { finding: clampText(input.finding, DOSSIER_LIMITS.finding) } : {}), ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
      }
      const { runId, nodeId } = input.author
      const ref = this.e.ctx.artifacts.put({
        kind: ARTIFACT_KIND[input.kind], bodySchema: body.schema, body,
        inputs: [...(head ? [head.entry] : []), ...refs, ...(input.inReplyTo ? [input.inReplyTo] : [])],
        classification, producer: input.author.type === 'system' ? { type: 'system', ref: 'workflow' } : { type: 'worker', ref: input.author.ref },
        ...(input.subject ? { subject: input.subject } : {}), ...(runId ? { runId } : {}), ...(nodeId ? { nodeId } : {}),
      }).id as ArtifactRef
      db.prepare(`INSERT INTO workflow_dossiers (task_id, seq, project_id, attempt, kind, entry, author_type, run_id, node_id, step, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.taskId, seq, input.projectId, input.attempt, input.kind, ref, input.author.type, runId ?? null, nodeId ?? null, step ?? null, now())
      return { ref, seq }
    })
  }

  /** How many entries a task's dossier holds, in all and by kind. */
  count(taskId: string): { total: number; kinds: Partial<Record<DossierKind, number>> } {
    const rows = this.e.ctx.store.db.prepare('SELECT kind, COUNT(*) AS n FROM workflow_dossiers WHERE task_id = ? GROUP BY kind').all(taskId) as Array<{ kind: DossierKind; n: number }>
    return { total: rows.reduce((sum, r) => sum + Number(r.n), 0), kinds: Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)])) }
  }

  /** Entries of a task's dossier from `from` (its place, default 1), at most `limit`, oldest first. */
  entries(taskId: string, from = 1, limit: number = DOSSIER_LIMITS.page): Array<{ seq: number; ref: ArtifactRef; createdAt: string; body: DossierEntry | undefined }> {
    const rows = this.e.ctx.store.db.prepare('SELECT * FROM workflow_dossiers WHERE task_id = ? AND seq >= ? ORDER BY seq LIMIT ?').all(taskId, from, limit) as unknown as DossierRow[]
    return rows.map((r) => ({ seq: r.seq, ref: r.entry, createdAt: r.created_at, body: this.e.ctx.artifacts.get(r.entry)?.body as DossierEntry | undefined }))
  }

  /**
   * The task's dossier as one reader is given it, within `maxChars`, stored as a `task-dossier@1.0`
   * report at least as strict as its entries (its inputs); undefined while it holds no entry.
   */
  view(frame: { projectId: string; taskId: string }, maxChars: number, meta: { classification: Classification; runId?: string; nodeId?: string }): ArtifactRef | undefined {
    const { total, kinds } = this.count(frame.taskId)
    if (!total) return undefined
    const db = this.e.ctx.store.db
    const rows = db.prepare('SELECT seq, entry FROM workflow_dossiers WHERE task_id = ? ORDER BY seq DESC LIMIT ?').all(frame.taskId, VIEW_ROWS) as Array<{ seq: number; entry: ArtifactRef }>
    const latest = rows.map((r) => ({ seq: r.seq, ref: r.entry, body: this.e.ctx.artifacts.get(r.entry)?.body as DossierEntry | undefined }))
    // Left out: the plans, reviews, and responses before the shown ones are named, the latest eight.
    const omittedKey = (before: number): Array<{ seq: number; kind: DossierKind }> => (db.prepare(`SELECT seq, kind FROM workflow_dossiers WHERE task_id = ? AND seq < ? AND kind IN ('plan', 'review', 'response')
      ORDER BY seq DESC LIMIT 8`).all(frame.taskId, before) as Array<{ seq: number; kind: DossierKind }>).reverse()
    const { text, shown } = renderDossier({ ...frame, total, kinds, omittedKey }, latest, maxChars)
    const body: DossierView = { schema: 'task-dossier@1.0', projectId: frame.projectId, taskId: frame.taskId, entries: total, head: rows[0]!.entry, shown, maxChars, text }
    return this.e.ctx.artifacts.put({
      kind: 'report', bodySchema: body.schema, body, inputs: [body.head, ...shown], classification: meta.classification,
      producer: { type: 'system', ref: 'workflow' }, ...(meta.runId ? { runId: meta.runId } : {}), ...(meta.nodeId ? { nodeId: meta.nodeId } : {}),
    }).id as ArtifactRef
  }

  /**
   * What a step's brief adds for a task's run, while its dossier holds an entry: a pointer at the
   * slice (a `context` the brief renders with the rest), and the whole dossier as a file a source
   * with a workspace of the run's own writes there. Nothing for a run that serves no task.
   */
  forBrief(run: RunRow, node: NodeRow): { pointer?: BriefPointer; file?: BriefFile } {
    const frame = this.e.tasks.frame(run.run_id)
    if (!frame) return {}
    // An author's self-review (T267) is given no dossier: only the goal, the diff, and the review guides.
    if ((JSON.parse(node.spec) as ResolvedNode).selfReview !== undefined) return {}
    const meta = { classification: run.classification ?? this.e.ctx.egress.defaultClassification, runId: run.run_id, nodeId: node.node_id }
    const slice = this.view(frame, DOSSIER_LIMITS.sliceChars, meta)
    if (!slice) return {}
    const whole = this.view(frame, DOSSIER_LIMITS.fileChars, meta)!
    const { total } = this.count(frame.taskId)
    return {
      pointer: { ref: slice, role: 'context', note: `the task's dossier (${total} entr${total === 1 ? 'y' : 'ies'}): what the Workers before you planned, did, reviewed, and answered, and the System's evidence; follow it` },
      file: { path: DOSSIER_FILE, ref: whole, note: 'the task\'s whole dossier, every entry within its bound' },
    }
  }

  /**
   * The texts of the `evidence` entries the step's Worker appended in its current attempt: the output
   * of the checks its author ran (T267), oldest first.
   */
  evidenceOf(node: NodeRow): string[] {
    const rows = this.e.ctx.store.db.prepare("SELECT entry FROM workflow_dossiers WHERE run_id = ? AND node_id = ? AND step = ? AND author_type = 'worker' AND kind = 'evidence' ORDER BY seq").all(node.run_id, node.node_id, stepOf(node)) as Array<{ entry: ArtifactRef }>
    return rows.map((r) => (this.e.ctx.artifacts.get(r.entry)?.body as DossierEntry | undefined)?.text ?? '')
  }

  /**
   * The gate at the end of a `verifies` step of a board task's run (T267): it passes (undefined) when
   * the step's author pasted the output of the checks the task requires into the dossier as `evidence`,
   * in the shape {@link evidenceProblem} reads; otherwise the step is refused, with a `gate` decision
   * (INV-13) that says what is missing. A run that serves no board task has no dossier, so it asks
   * nothing. A Worker with no dossier tool never gets here: the step requires the `dossier` capability
   * at admission ({@link DOSSIER_CAPABILITY}).
   */
  evidenceGate(run: RunRow, node: NodeRow): { message: string; decision: ArtifactRef } | undefined {
    const frame = this.e.tasks.frame(run.run_id)
    if (!frame) return undefined
    const checks = [...new Set(frame.acceptance.map((a) => a.check).filter((c): c is BriefCheck => c !== undefined))]
    const why = evidenceProblem(this.evidenceOf(node), checks)
    if (!why) return undefined
    const message = `step ${node.node_id} ended without the output of the checks its author ran in the task's dossier (${why}): run the required checks, append their real output as an evidence entry (dossier_append: each command, the lines that hold the result, and its exit code when the tool reports one; a check that could not run, and why), then finish`
    const decision = this.e.ctx.artifacts.recordDecision({
      decisionType: 'gate',
      question: `May step ${node.node_id} of run ${run.run_id} end, with the output of its author's checks in the task's dossier?`,
      inputs: [],
      candidates: [
        { option: 'refuse', selected: true, reasons: [why] },
        { option: 'end', selected: false, reasons: ['not end: the author shows the checks\' output before anyone reviews its change (T267)'] },
      ],
      decider: { type: 'rule', id: 'workflow.evidence', version: '2' }, outcome: { option: 'refuse', detail: { checks } }, deterministic: true,
    }, { producer: { type: 'system', ref: 'workflow' }, runId: run.run_id, nodeId: node.node_id }).id as ArtifactRef
    return { message, decision }
  }

  /** Whether the step appended an entry of its own in its current attempt (through `dossier_append`). */
  private appendedBy(node: NodeRow): boolean {
    return !!this.e.ctx.store.db.prepare("SELECT 1 FROM workflow_dossiers WHERE run_id = ? AND node_id = ? AND step = ? AND author_type = 'worker' AND kind != 'evidence' LIMIT 1").get(node.run_id, node.node_id, stepOf(node))
  }

  /**
   * A Worker step of a task's run settled with an accepted result: unless it appended an entry of its
   * own, the engine appends its entry. A review's is its verdict and findings, from the assessment its
   * exact-subject gate stored, bound to the subject it reviewed, its result linked; that one is written
   * even after the reviewer appended its own. An agent Worker's
   * answer is linked, never copied (its run has its own tool to write with where its runtime offers
   * host tools); a website or model Worker's
   * answer is the entry, cut to its bound. A fix grown by a review answers it (`response`); any other
   * writing or measuring step reports `progress`.
   */
  stepSettled(run: RunRow, node: NodeRow, spec: ResolvedNode, result: ArtifactRef, gate?: { decision: ArtifactRef }): void {
    const frame = this.e.tasks.frame(run.run_id)
    if (!frame) return
    const role = roleOf(spec, node)
    const assessmentRef = gate ? (this.e.ctx.artifacts.get(gate.decision)?.body as { outcome?: { detail?: { assessment?: ArtifactRef } } } | undefined)?.outcome?.detail?.assessment : undefined
    const assessment = assessmentRef ? this.e.ctx.artifacts.get(assessmentRef) : undefined
    // A review's assessed entry (bound to its subject, its result and assessment linked) is written even
    // when the reviewer appended its own: the reviewer's text adds to the verdict, never replaces it.
    const own = this.appendedBy(node)
    if (own && !(role === 'review' && assessment)) return
    const answer = this.e.ctx.artifacts.get(result)?.body as { schema?: string; text?: unknown; subject?: Subject } | undefined
    const agent = !!answer?.schema?.startsWith('agent-result@')
    const worker = node.worker ?? 'a Worker'
    // A fix answers the review that grew it (remediation); a planner's step is progress like any other.
    const grower = spec.grownBy ? this.e.nodeRow(run.run_id, spec.grownBy.node) : undefined
    const fix = role === 'author' && !!grower && roleOf(JSON.parse(grower.spec) as ResolvedNode, grower) === 'review'
    const kind: DossierKind = role === 'review' ? 'review' : fix ? 'response' : 'progress'
    let text: string
    let subject: Subject | undefined = answer?.subject
    const refs: ArtifactRef[] = [result]
    if (assessment) {
      const body = assessment.body as { verdict: string; findings: Finding[]; summary?: string }
      subject = assessment.subject as Subject | undefined
      const blocking = body.findings.filter(blocks).length
      const what = spec.verifies ? `Verification ${node.node_id} of review ${spec.verifies.review}` : `Review ${node.node_id}`
      text = [
        // The summary opens with the count (ADR-0075): "2 important, 3 nits", or "no issues".
        `${body.summary ?? countOf(body.findings)}`,
        `${what} by ${worker}${subject ? ` of ${describe(subject)}` : ''}: ${body.verdict}, ${body.findings.length} finding${body.findings.length === 1 ? '' : 's'}${blocking ? ` (${blocking} blocking)` : ''}. Its result and assessment are linked.${own ? ' The reviewer\'s own entry precedes this one.' : ''}`,
        // By severity: important (with its vote), then pre-existing, then nits; a repeat says what it repeats.
        ...bySeverity(body.findings).map((f) => `${findingLine(f)}${f.verification ? ` — ${f.verification.vote}${f.verification.reason ? `: ${f.verification.reason}` : ''}` : ''}${f.repeated ? ` (repeats ${f.repeated}; not counted)` : ''}`),
        ...(body.findings.some((f) => f.severity === 'nit' && !f.repeated) ? ['Nits are optional notes: the author may take or leave each, with one response line each; they never start a fix round or hold the result.'] : []),
      ].join('\n')
      refs.push(assessmentRef!, gate!.decision)
    } else if (agent) {
      const what = kind === 'response' ? 'answered the review that grew it' : kind === 'review' ? 'reviewed' : 'completed'
      // The step by its id only: its objective is another step's instructions, never quoted into later briefs.
      text = `Step ${node.node_id} ${what} on ${worker}${subject ? `, leaving ${describe(subject)}` : ''}. Its answer is linked, not copied: it wrote no entry of its own.`
    } else {
      text = bodyText(answer ?? '').trim() || `Step ${node.node_id} answered nothing on ${worker}.`
    }
    this.append({
      projectId: frame.projectId, taskId: frame.taskId, attempt: frame.attempt, kind, text, refs, ...(subject ? { subject } : {}),
      author: { type: 'worker', ref: worker, runId: run.run_id, nodeId: node.node_id, ...(node.execution_id ? { execution: node.execution_id } : {}) },
    }, run.classification ?? this.e.ctx.egress.defaultClassification)
  }

  /** An `evidence` entry by the engine for a task's run (its checks and acceptance, its report, its landing). */
  evidence(runId: string, text: string, refs: ArtifactRef[], subject?: Subject, commits: string[] = []): void {
    const frame = this.e.tasks.frame(runId)
    if (!frame) return
    const run = this.e.runRow(runId)
    this.append({
      projectId: frame.projectId, taskId: frame.taskId, attempt: frame.attempt, kind: 'evidence', text, refs: refs.filter((r) => !!this.e.ctx.artifacts.get(r)),
      author: { type: 'system', ref: 'workflow', runId }, ...(subject ? { subject } : {}), ...(commits.length ? { commits } : {}),
    }, run?.classification ?? this.e.ctx.egress.defaultClassification)
  }

  /** Run `write`, logging a failure: the dossier records the work, and never fails it. */
  safely(what: string, write: () => void): void {
    try {
      write()
    } catch (error) {
      this.e.ctx.logger.warn(`workflow: the dossier did not take ${what}: ${(error as Error)?.message ?? String(error)}`)
    }
  }

  /**
   * The step `caller` names, while `caller.execution` is the execution it runs now; refused otherwise
   * (`what` is refused): the run serves no board task, the step is not running, or it runs another
   * execution (an earlier one ended, or the caller is not the step's Worker).
   */
  private running(caller: DossierCaller, what: string): { frame: NonNullable<ReturnType<Engine['tasks']['frame']>>; node: NodeRow } {
    const refuse = (why: string): never => {
      throw new WorkflowFailure('invalid_input', `${why}; ${what}`)
    }
    const frame = this.e.tasks.frame(caller.runId)
    if (!frame) return refuse(`run ${caller.runId} serves no board task, so it has no dossier`)
    const node = this.e.nodeRow(caller.runId, caller.nodeId)
    if (!node || node.state !== 'RUNNING') return refuse(`step ${caller.nodeId} of run ${caller.runId} is not running: only a running step's Worker uses its dossier tools`)
    if (node.execution_id !== caller.execution) return refuse(`execution ${String(caller.execution).slice(0, 80)} is not the one step ${caller.nodeId} of run ${caller.runId} runs now: only the step's own Worker, while it runs, uses its dossier tools`)
    return { frame, node }
  }

  /**
   * `dossier_append`: a Worker's entry for the step it runs, through the gate. The step and its
   * Worker are `caller`, bound by the Worker's source (never named by the agent); the entry's author
   * is that step's Worker. Refused (nothing appended) unless the run serves a board task and still
   * holds it, the step is running now with `caller.execution`, the kind is one its role writes
   * ({@link ROLE_KINDS}; `evidence` is the engine's alone), the text holds 1 to 4000 characters, every
   * commit is a hex id, and every link names a stored artifact (a reply, an entry of this dossier).
   */
  appendByWorker(caller: DossierCaller, input: DossierAppendInput): { id: ArtifactRef; seq: number } {
    const refuse = (why: string): never => {
      throw new WorkflowFailure('invalid_input', `${why}; nothing was appended`)
    }
    const { frame, node } = this.running(caller, 'nothing was appended')
    if (this.e.tasks.lost(caller.runId)) refuse(`run ${caller.runId} no longer holds its board task`)
    const spec = JSON.parse(node.spec) as ResolvedNode
    const role = roleOf(spec, node)
    if (!DOSSIER_KINDS.includes(input.kind)) refuse(`${String(input.kind).slice(0, 40)} is not a kind of entry (${DOSSIER_KINDS.join(', ')})`)
    if (!ROLE_KINDS[role].includes(input.kind)) {
      refuse(input.kind === 'evidence' ? 'only a writing step reports evidence (the output of the checks it ran); the System\'s own is its checks, acceptance, and landing' : `a ${role === 'other' ? 'step that neither writes nor reviews' : role === 'review' ? 'review' : 'writing step'} appends ${ROLE_KINDS[role].join(', ')}, not ${input.kind}`)
    }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text || chars(text) > DOSSIER_LIMITS.text) refuse(`the text holds ${chars(text)} characters; an entry holds 1 to ${DOSSIER_LIMITS.text}`)
    const commits = input.commits ?? []
    if (commits.length > DOSSIER_LIMITS.commits || commits.some((c) => !COMMIT.test(c))) refuse(`commits are at most ${DOSSIER_LIMITS.commits} hex ids of 7 to 64 lowercase digits`)
    const refs = input.refs ?? []
    if (refs.length > DOSSIER_LIMITS.refs) refuse(`an entry links at most ${DOSSIER_LIMITS.refs} artifacts`)
    for (const ref of [...refs, ...(input.inReplyTo ? [input.inReplyTo] : [])]) {
      if (!CONTENT_ID.test(ref) || !this.e.ctx.artifacts.get(ref)) refuse(`${ref.slice(0, 80)} is not a stored artifact`)
    }
    if (input.inReplyTo && !this.e.ctx.store.db.prepare('SELECT 1 FROM workflow_dossiers WHERE task_id = ? AND entry = ?').get(frame.taskId, input.inReplyTo)) {
      refuse(`${input.inReplyTo} is no entry of the dossier of board task ${frame.taskId}`)
    }
    if (input.finding !== undefined && (!input.finding.trim() || chars(input.finding) > DOSSIER_LIMITS.finding)) refuse(`a finding is named in 1 to ${DOSSIER_LIMITS.finding} characters`)
    const run = this.e.runRow(caller.runId)!
    // A review step's entry is bound to the subject the step reviews, never to one the agent names.
    const subject = role === 'review' ? boundSubject(node) : undefined
    const { ref, seq } = this.append({
      projectId: frame.projectId, taskId: frame.taskId, attempt: frame.attempt, kind: input.kind, text, ...(subject ? { subject } : {}),
      author: { type: 'worker', ref: node.worker ?? 'unknown', runId: caller.runId, nodeId: caller.nodeId, execution: caller.execution },
      ...(refs.length ? { refs: refs as ArtifactRef[] } : {}), ...(commits.length ? { commits } : {}),
      ...(input.finding ? { finding: input.finding.trim() } : {}), ...(input.inReplyTo ? { inReplyTo: input.inReplyTo as ArtifactRef } : {}),
    }, run.classification ?? this.e.ctx.egress.defaultClassification, stepOf(node))
    return { id: ref, seq }
  }

  /**
   * `dossier_read` as a step's Worker uses it: its own task's dossier, while `caller` is the step's
   * running execution ({@link read}). An author's self-review (T267) reads none: it is given only the
   * goal, the diff, and the review guides, never what its author planned, did, or was told.
   */
  readByWorker(caller: DossierCaller, page: { from?: number | undefined; limit?: number | undefined }): DossierPage {
    const { node } = this.running(caller, 'nothing was read')
    if ((JSON.parse(node.spec) as ResolvedNode).selfReview !== undefined) {
      throw new WorkflowFailure('invalid_input', `step ${caller.nodeId} is the author's self-review: it reads only the goal, the diff, and the review guides, never the task's dossier; nothing was read`)
    }
    return this.read({ runId: caller.runId, from: page.from, limit: page.limit })
  }

  /**
   * `dossier_read`: a page of a task's dossier, by the task or by a run that serves it, oldest first
   * from `from` (default 1), at most {@link DOSSIER_LIMITS}`.pageMax` entries; the next page's `from`
   * when there is one. Every entry whole, as appended.
   */
  read(input: { taskId?: string | undefined; runId?: string | undefined; from?: number | undefined; limit?: number | undefined }): DossierPage {
    const byRun = input.runId ? this.e.tasks.frame(input.runId) : undefined
    if (input.runId && !byRun) throw new WorkflowFailure('invalid_input', `run ${input.runId} serves no board task, so it has no dossier`)
    const taskId = byRun?.taskId ?? input.taskId
    if (!taskId) throw new WorkflowFailure('invalid_input', 'name the task (taskId) or a run that serves it (runId)')
    if (byRun && input.taskId && input.taskId !== byRun.taskId) throw new WorkflowFailure('invalid_input', `run ${input.runId} serves board task ${byRun.taskId}, not ${input.taskId}`)
    const from = Math.max(1, Math.floor(input.from ?? 1))
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? DOSSIER_LIMITS.page)), DOSSIER_LIMITS.pageMax)
    const { total } = this.count(taskId)
    const first = this.e.ctx.store.db.prepare('SELECT project_id FROM workflow_dossiers WHERE task_id = ? LIMIT 1').get(taskId) as { project_id: string } | undefined
    const rows = this.entries(taskId, from, limit + 1)
    const page = rows.slice(0, limit).map(({ seq, ref, createdAt, body }): DossierEntryView => {
      if (!body) return { id: ref, seq, attempt: 0, kind: 'evidence', author: { type: 'system', ref: 'workflow' }, text: 'expired: collected by retention; only its id remains', createdAt }
      const { schema: _schema, projectId: _project, taskId: _task, ...rest } = body
      return { id: ref, ...rest, createdAt }
    })
    return { projectId: byRun?.projectId ?? first?.project_id ?? '', taskId, total, entries: page, ...(rows.length > limit ? { next: rows[limit]!.seq } : {}) }
  }
}
