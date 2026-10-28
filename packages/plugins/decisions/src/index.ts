/**
 * The operator's decisions as records in System (docs/proposals/0019-lead-logic-in-system.md section
 * 2.7, D109): `operator-decision@1.0`, a question recorded and later answered. The studio's next number
 * (`D<n>`) is taken by the store, in the transaction that writes the record, from one sequence for the
 * whole studio, so two writers never share one and a number is never reused (INV-15). A record is never
 * deleted, and an answered one never changes: a correction is a new record that `supersedes` the old.
 * The operator's token acts on every record; a project's lead token asks and, on the operator's word,
 * records an answer for its own project only, and reads its project's and the studio-wide ones. What a
 * record holds is evidence of what the operator said, never an authority (INV-6).
 *
 * A surface with no seam of its own (as `report`): it provides no `ctx` service, and what it offers is
 * its MCP tools, whose every input and output is `mcp-decisions@1.0` (INV-14, ADR-0037). Every read and
 * write is bounded (INV-9), and the records are validated before every write and after every read.
 * @module @tsuuanmi/system-decisions
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { leadId, LEAD_PROJECT, reply, type ToolContext, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import type {} from '@tsuuanmi/system-ledger-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { z as zod } from 'zod'
import { MAX_ENTRIES, readRegistry } from './registry.ts'

export const name = 'decisions'
export const inject = ['store']

/** Who wrote a record: the operator, a project's lead, or the one-time import. */
export type Writer = 'operator' | 'import' | `lead:${string}`

/** `operator-decision@1.0`; the schema in `schemas/` is canonical. */
export interface OperatorDecision {
  schema: 'operator-decision@1.0'
  id: string
  projectId?: string
  state: 'asked' | 'answered'
  question: string
  options?: string[]
  recommendation?: string
  links?: string[]
  askedAt: string
  askedBy: Writer
  answeredAt?: string
  answer?: string
  answeredBy?: Writer
  source?: string
  supersedes?: string
  importedFrom?: string
  revision: number
}

/** Who calls: the operator's token, or a project's lead token (ADR-0076). */
export type Actor = { kind: 'operator' } | { kind: 'lead'; project: string }

export type DecisionsErrorCode = 'invalid' | 'forbidden' | 'not-found' | 'conflict'

/** A refusal, typed: the caller reads `code`, a person reads the message. */
export class DecisionsError extends Error {
  constructor(readonly code: DecisionsErrorCode, message: string) {
    super(message)
    this.name = 'DecisionsError'
  }
}

export interface Config {
  /** Records one list call returns at most (1 to 200, default 50). */
  pageSize?: number
}

export const Config: z<Config> = z.object({
  pageSize: z.natural().min(1).max(200).default(50).description('Records one decisions_list call returns, at most: a cursor (`after`) reads the next page'),
}) as unknown as z<Config>

/** The tools' contract (`schemas/mcp-decisions.v1.json`). */
export const MCP_DECISIONS = 'mcp-decisions@1.0'
const MAX_PAGE = 200
/** The later decisions `show` names that supersede one, at most (INV-9). */
const MAX_SUPERSEDED = 100
const ID = /^D[1-9][0-9]{0,8}$/

const MIGRATIONS = [{
  version: 1,
  sql: `CREATE TABLE operator_decisions (
    n INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, project_id TEXT, state TEXT NOT NULL, supersedes TEXT, asked_ms INTEGER NOT NULL, record TEXT NOT NULL,
    CHECK (state IN ('asked', 'answered'))
  );
  CREATE INDEX operator_decisions_project ON operator_decisions (project_id, state, n);
  CREATE INDEX operator_decisions_supersedes ON operator_decisions (supersedes) WHERE supersedes IS NOT NULL;
  CREATE TABLE operator_decision_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), last INTEGER NOT NULL);
  INSERT INTO operator_decision_sequence (id, last) VALUES (1, 0);
  CREATE TRIGGER operator_decisions_no_delete BEFORE DELETE ON operator_decisions BEGIN SELECT RAISE(ABORT, 'a decision is never deleted: a correction is a new record that supersedes it'); END;
  CREATE TRIGGER operator_decisions_keep_answered BEFORE UPDATE ON operator_decisions WHEN OLD.state = 'answered' BEGIN SELECT RAISE(ABORT, 'an answered decision never changes: a correction is a new record that supersedes it'); END;`,
}]

const schemas = new SchemaRegistry()

const writerOf = (actor: Actor): Writer => actor.kind === 'operator' ? 'operator' : leadId(actor.project) as Writer
const refuse = (code: DecisionsErrorCode, message: string): never => { throw new DecisionsError(code, message) }

/** The record, or the reason it fails its schema (INV-14). */
function problemOf(record: OperatorDecision): string | undefined {
  try {
    schemas.assertRecord(record)
    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

/** What a caller says when it asks a question. */
export interface AskInput {
  question: string
  projectId?: string
  options?: string[]
  recommendation?: string
  links?: string[]
  supersedes?: string
}

/** What a caller says when it records an answer. */
export interface AnswerInput {
  id: string
  answer: string
  /** Where the operator said it: required when a lead records the answer. */
  source?: string
}

export interface ListFilter {
  state?: 'asked' | 'answered'
  projectId?: string
  /** Only the studio-wide records. */
  studio?: boolean
  /** The cursor: the number of the last record of the previous page. */
  after?: number
  limit?: number
}

export interface ImportResult { imported: number; unchanged: number; highest: number }

/**
 * A check a write runs on the output it would give, inside its transaction, before it commits: one that
 * throws writes nothing.
 */
export type OutputCheck = (output: object) => void

/** Make the row's tables (the store's migration, recorded once). */
export function migrate(ctx: Context): void {
  ctx.store.migrate('decisions', MIGRATIONS)
}

/** The decision log over the store: every read and write of the row; the tools call nothing else. */
export class DecisionLog {
  private readonly ctx: Context
  private readonly pageSize: number

  constructor(ctx: Context, pageSize = 50) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE) throw new Error(`decisions: pageSize must be a whole number from 1 to ${MAX_PAGE}, not ${String(pageSize)}`)
    this.ctx = ctx
    this.pageSize = pageSize
  }

  // --- writing ---

  /**
   * Record a question: the next number of the studio's one sequence, taken in the transaction that
   * writes it. A lead asks for its own project only (its token's project; a studio-wide question and
   * another project's are the operator's), and corrects only a record of its own project.
   */
  ask(input: AskInput, actor: Actor, at: Date = new Date(), check?: OutputCheck): OperatorDecision {
    if (typeof input?.question !== 'string') return refuse('invalid', 'a question is text')
    if (actor.kind === 'lead' && input.projectId !== undefined && input.projectId !== actor.project) {
      return refuse('forbidden', `${leadId(actor.project)} asks only about project ${actor.project}; ${input.projectId} is another project's, so the operator asks it`)
    }
    const projectId = actor.kind === 'lead' ? actor.project : input.projectId
    if (projectId !== undefined && (typeof projectId !== 'string' || !LEAD_PROJECT.test(projectId))) return refuse('invalid', 'projectId is not a project id')
    if (input.supersedes !== undefined && (typeof input.supersedes !== 'string' || !ID.test(input.supersedes))) return refuse('invalid', 'supersedes is a decision number, D<n>')
    return this.ctx.store.transaction((db) => {
      if (input.supersedes !== undefined) {
        const old = this.row(input.supersedes)
        if (!old) return refuse('not-found', `there is no decision ${input.supersedes} to supersede`)
        if (actor.kind === 'lead' && old.projectId !== actor.project) {
          return refuse('forbidden', `${leadId(actor.project)} corrects only a decision of project ${actor.project}; ${old.id} is ${old.projectId === undefined ? 'studio-wide' : `project ${old.projectId}'s`}, so the operator corrects it`)
        }
      }
      const n = this.next(db)
      const record: OperatorDecision = {
        schema: 'operator-decision@1.0', id: `D${n}`, ...(projectId !== undefined ? { projectId } : {}), state: 'asked', question: input.question,
        ...(input.options?.length ? { options: [...input.options] } : {}), ...(input.recommendation !== undefined ? { recommendation: input.recommendation } : {}),
        ...(input.links?.length ? { links: [...input.links] } : {}), askedAt: at.toISOString(), askedBy: writerOf(actor),
        ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}), revision: 0,
      }
      this.valid(record)
      db.prepare('INSERT INTO operator_decisions (n, id, project_id, state, supersedes, asked_ms, record) VALUES (?, ?, ?, \'asked\', ?, ?, ?)')
        .run(n, record.id, projectId ?? null, input.supersedes ?? null, at.getTime(), JSON.stringify(record))
      check?.({ decision: record })
      return structuredClone(record)
    })
  }

  /**
   * Record an answer to a question that waits. The operator's token records the operator's own answer.
   * A lead's token records it only on the operator's word, naming where it was said (`source`), only for
   * a question of its own project; it never answers a studio-wide question or another project's, and what
   * it records says it was written by the lead, never by the operator (INV-6).
   */
  answer(input: AnswerInput, actor: Actor, at: Date = new Date(), check?: OutputCheck): OperatorDecision {
    if (typeof input?.id !== 'string' || !ID.test(input.id)) return refuse('invalid', 'id is a decision number, D<n>')
    if (typeof input.answer !== 'string') return refuse('invalid', 'an answer is text')
    if (input.source !== undefined && typeof input.source !== 'string') return refuse('invalid', 'source is text')
    if (actor.kind === 'lead' && (input.source === undefined || input.source.trim() === '')) {
      return refuse('forbidden', `${leadId(actor.project)} records an answer only on the operator's word: name where the operator said it (source), or ask the operator to answer`)
    }
    return this.ctx.store.transaction((db) => {
      const old = this.row(input.id)
      if (!old) return refuse('not-found', `there is no decision ${input.id}`)
      if (actor.kind === 'lead' && old.projectId !== actor.project) {
        return refuse('forbidden', `${leadId(actor.project)} records answers only for project ${actor.project}; ${old.id} is ${old.projectId === undefined ? 'studio-wide' : `project ${old.projectId}'s`}, so only the operator answers it`)
      }
      if (old.state === 'answered') return refuse('conflict', `${old.id} is answered already, and an answered decision never changes: record a correction as a new decision that supersedes it`)
      const record: OperatorDecision = {
        ...old, state: 'answered', answeredAt: at.toISOString(), answer: input.answer, answeredBy: writerOf(actor),
        ...(input.source !== undefined ? { source: input.source } : {}), revision: 1,
      }
      this.valid(record)
      db.prepare('UPDATE operator_decisions SET state = \'answered\', record = ? WHERE n = ? AND state = \'asked\'').run(JSON.stringify(record), Number(old.id.slice(1)))
      check?.({ decision: record })
      return structuredClone(record)
    })
  }

  /**
   * Import the lead's registry, once (`system decisions import`): the operator's only. The file's
   * numbers must be exactly D1 to Dn, none twice and none skipped, at most {@link MAX_ENTRIES} of them,
   * or nothing is written. Into an empty log it writes every record and carries the sequence on past the
   * highest; into a log that holds them already it changes nothing (a second run, or a record answered
   * here since), and a record that differs is refused, so a log is never made of two histories. Its work
   * is bounded by the file's entries: each is looked up by its number, never the whole log read.
   */
  import(registry: unknown, file: string, actor: Actor, check?: OutputCheck): ImportResult {
    if (actor.kind !== 'operator') return refuse('forbidden', `${leadId(actor.project)} may not import a registry: only the operator does, once`)
    if (typeof file !== 'string' || !file.trim() || file.length > 200) return refuse('invalid', 'file names the registry the import reads, at most 200 characters')
    const read = readRegistry(registry, file, problemOf)
    if ('problems' in read) return refuse('invalid', `the registry is refused, and nothing was imported: ${read.problems.join('; ')}`)
    return this.ctx.store.transaction((db) => {
      const stored = Number((db.prepare('SELECT COUNT(*) AS n FROM operator_decisions').get() as { n: number }).n)
      const conflicts: string[] = []
      let present = 0
      for (const record of read.records) {
        const old = this.row(record.id)
        if (!old) continue
        present++
        if (!sameImport(old, record) && conflicts.length < 20) conflicts.push(`${record.id} differs from the one stored`)
      }
      if (stored && present < read.records.length) {
        conflicts.push(`the log holds ${stored} decision(s) but not all of this registry's: an import is for an empty log, or a second run of the whole registry`)
      }
      if (conflicts.length) return refuse('conflict', `the registry is refused, and nothing was imported: ${conflicts.join('; ')}`)
      let imported = 0
      if (!stored) {
        for (const record of read.records) {
          db.prepare('INSERT INTO operator_decisions (n, id, project_id, state, supersedes, asked_ms, record) VALUES (?, ?, ?, ?, NULL, ?, ?)')
            .run(Number(record.id.slice(1)), record.id, record.projectId ?? null, record.state, Date.parse(record.askedAt), JSON.stringify(record))
          imported++
        }
      }
      const highest = Number(read.records.at(-1)!.id.slice(1))
      const last = (db.prepare('SELECT last FROM operator_decision_sequence WHERE id = 1').get() as { last: number }).last
      if (highest > last) db.prepare('UPDATE operator_decision_sequence SET last = ? WHERE id = 1').run(highest)
      const result: ImportResult = { imported, unchanged: read.records.length - imported, highest }
      check?.(result)
      return result
    })
  }

  // --- reading ---

  /**
   * One record, as the caller may read it, with the decisions that supersede it (at most
   * {@link MAX_SUPERSEDED}); undefined when there is none, or the caller may not read it (a lead reads
   * its project's and the studio-wide ones).
   */
  show(id: string, actor: Actor): { decision: OperatorDecision; supersededBy: string[] } | undefined {
    if (typeof id !== 'string' || !ID.test(id)) return refuse('invalid', 'id is a decision number, D<n>')
    const decision = this.row(id)
    if (!decision || !mayRead(actor, decision.projectId)) return undefined
    const later = this.ctx.store.db.prepare('SELECT id FROM operator_decisions WHERE supersedes = ? ORDER BY n LIMIT ?').all(id, MAX_SUPERSEDED) as Array<{ id: string }>
    return { decision, supersededBy: later.map((r) => r.id) }
  }

  /** A page of records in number order, as the caller may read them. */
  list(filter: ListFilter, actor: Actor): { decisions: OperatorDecision[]; next?: number } {
    const limit = filter.limit ?? this.pageSize
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return refuse('invalid', `limit is a whole number from 1 to ${MAX_PAGE}`)
    if (filter.after !== undefined && (!Number.isInteger(filter.after) || filter.after < 0)) return refuse('invalid', 'after is a decision number')
    if (filter.state !== undefined && filter.state !== 'asked' && filter.state !== 'answered') return refuse('invalid', 'state is asked or answered')
    if (actor.kind === 'lead' && filter.projectId !== undefined && filter.projectId !== actor.project) {
      return refuse('forbidden', `${leadId(actor.project)} reads project ${actor.project}'s decisions and the studio-wide ones; ${filter.projectId} is another project's, so nothing was read`)
    }
    const where: string[] = ['n > ?']
    const params: Array<string | number> = [filter.after ?? 0]
    if (filter.state) { where.push('state = ?'); params.push(filter.state) }
    if (filter.studio) where.push('project_id IS NULL')
    else if (filter.projectId !== undefined) { where.push('project_id = ?'); params.push(filter.projectId) }
    else if (actor.kind === 'lead') { where.push('(project_id IS NULL OR project_id = ?)'); params.push(actor.project) }
    const rows = this.ctx.store.db.prepare(`SELECT n, id, record FROM operator_decisions WHERE ${where.join(' AND ')} ORDER BY n LIMIT ?`).all(...params, limit + 1) as Array<{ n: number; id: string; record: string }>
    const shown = rows.slice(0, limit)
    return { decisions: shown.map((r) => this.load(r.id, r.record)), ...(rows.length > limit ? { next: Number(shown.at(-1)!.n) } : {}) }
  }

  // --- the store ---

  /** The next number: the sequence, advanced inside the caller's write transaction (BEGIN IMMEDIATE), so no two writers take the same one. */
  private next(db: DatabaseSync): number {
    const last = (db.prepare('SELECT last FROM operator_decision_sequence WHERE id = 1').get() as { last: number }).last
    const n = Number(last) + 1
    db.prepare('UPDATE operator_decision_sequence SET last = ? WHERE id = 1').run(n)
    return n
  }

  private row(id: string): OperatorDecision | undefined {
    const row = this.ctx.store.db.prepare('SELECT record FROM operator_decisions WHERE id = ?').get(id) as { record: string } | undefined
    return row ? this.load(id, row.record) : undefined
  }

  /** A stored record, read again against its schema: one that fails is a defect, never served (INV-14). */
  private load(id: string, text: string): OperatorDecision {
    const record = JSON.parse(text) as OperatorDecision
    const bad = problemOf(record)
    if (bad) throw new DecisionsError('invalid', `the stored decision ${id} is not a valid operator-decision@1.0: ${bad}`)
    return record
  }

  private valid(record: OperatorDecision): void {
    const bad = problemOf(record)
    if (bad) refuse('invalid', bad)
  }
}

/** Whether the caller reads a record of `projectId`: the operator every one, a lead its project's and the studio-wide ones. */
const mayRead = (actor: Actor, projectId: string | undefined): boolean => actor.kind === 'operator' || projectId === undefined || projectId === actor.project

/** A stored record is the imported one when equal, or when the imported question was answered here since. */
function sameImport(stored: OperatorDecision, imported: OperatorDecision): boolean {
  if (JSON.stringify(stored) === JSON.stringify(imported)) return true
  return stored.importedFrom !== undefined && stored.state === 'answered' && imported.state === 'asked'
    && stored.question === imported.question && stored.askedAt === imported.askedAt && stored.projectId === imported.projectId
}

// --- MCP ---

type DecisionsTool = 'decisions_ask' | 'decisions_answer' | 'decisions_list' | 'decisions_show' | 'decisions_import'
/** A tool's `$defs` name in `mcp-decisions@1.0`: underscores written as hyphens. */
const defOf = (tool: DecisionsTool, part: 'input' | 'output'): string => `${tool.replaceAll('_', '-')}-${part}`

/** The caller of a tool: the operator, or a project's lead; undefined for anyone else (fail closed, INV-2). */
function actorOf(context: ToolContext): Actor | undefined {
  if (context.lead !== undefined) return { kind: 'lead', project: context.lead }
  return context.scope === 'operator' ? { kind: 'operator' } : undefined
}

const fail = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

/** An output its contract refuses, found before a write commits: the write is undone. */
class RefusedOutput extends Error {}

/**
 * Wrap a tool at its boundary (ADR-0037): the caller is the operator or a lead, or nothing is done; the
 * input is checked against `<tool>-input` first; a write checks the output it would give against
 * `<tool>-output` before it commits, and every output is checked once more as it returns. A refusal is
 * the tool's error with its reason, never a throw.
 */
function tool(name: DecisionsTool, run: (args: Record<string, unknown>, actor: Actor, check: OutputCheck) => object | undefined, summary: (output: object) => string): ToolHandler {
  return async (args, context) => {
    const actor = actorOf(context)
    if (!actor) return fail('the decisions are the operator\'s, and a project\'s lead reads and records its own: this token is neither')
    try {
      schemas.assertDef(MCP_DECISIONS, defOf(name, 'input'), args)
    } catch (error) {
      return fail(`invalid input, nothing done: ${(error as Error).message}`)
    }
    const check: OutputCheck = (output) => {
      try {
        schemas.assertDef(MCP_DECISIONS, defOf(name, 'output'), output)
      } catch (error) {
        throw new RefusedOutput((error as Error).message)
      }
    }
    let output: object | undefined
    try {
      output = run(args, actor, check)
    } catch (error) {
      if (error instanceof RefusedOutput) return fail(`decisions: ${name} would make an output its schema refuses (a defect), so nothing changed: ${error.message}`)
      if (error instanceof DecisionsError) return fail(`${error.code}: ${error.message}`)
      throw error
    }
    if (output === undefined) return fail(`not-found: there is no decision ${String(args['id'])} that this token reads`)
    try {
      check(output)
    } catch (error) {
      return fail(`decisions: ${name} made an output its schema refuses (a defect): ${(error as Error).message}`)
    }
    return reply(output, summary(output))
  }
}

const line = (d: OperatorDecision): string => `${d.id}  ${d.state}  ${d.projectId ?? 'studio'}  ${d.question.slice(0, 120)}${d.answer !== undefined ? `\n  → ${d.answer.slice(0, 200)}` : ''}`

const text = (max: number) => zod.string().min(1).max(max)

const ASK: ToolSpec = {
  scope: 'operator', lead: true,
  description: 'Record a question to the operator as an operator-decision@1.0 record: the studio\'s next number D<n> is taken by the store, so two writers never share one. `projectId` absent is a studio-wide decision (the operator\'s to ask; a lead token asks about its own project only). `supersedes` names the decision this one corrects: an answered record never changes and is never deleted. Input and output: mcp-decisions@1.0.',
  inputSchema: {
    question: text(4000).describe('The question'),
    projectId: zod.string().min(1).max(100).optional().describe('The board project; absent: studio-wide (the operator\'s token only)'),
    options: zod.array(text(500)).max(20).optional().describe('The choices'),
    recommendation: text(1000).optional().describe('What you recommend, and why'),
    links: zod.array(text(300)).max(20).optional().describe('An ADR, a task id, a commit, a document path'),
    supersedes: zod.string().regex(/^D[1-9][0-9]{0,8}$/).optional().describe('The decision this one corrects, D<n>'),
  },
}

const ANSWER: ToolSpec = {
  scope: 'operator', lead: true,
  description: 'Record the answer to a question that waits. The operator\'s token records the operator\'s own answer. A lead token records it only on the operator\'s word, naming where the operator said it (`source`), only for a question of its own project, and the record says the lead wrote it; a studio-wide question is answered by the operator. Input and output: mcp-decisions@1.0.',
  inputSchema: {
    id: zod.string().regex(/^D[1-9][0-9]{0,8}$/).describe('The decision, D<n>'),
    answer: text(8000).describe('The answer, in the operator\'s words as far as they are known'),
    source: text(500).optional().describe('Where the operator said it (a message, /ui, a review): required for a lead token'),
  },
}

const LIST: ToolSpec = {
  scope: 'operator', lead: true,
  description: 'The decisions in number order, a page at a time (`after` is the cursor). The operator reads every one; a lead token reads its own project\'s and the studio-wide ones. `state: asked` is what waits for the operator. Input and output: mcp-decisions@1.0.',
  inputSchema: {
    state: zod.enum(['asked', 'answered']).optional().describe('Only the questions that wait, or only the answered'),
    projectId: zod.string().min(1).max(100).optional().describe('Only this project\'s'),
    studio: zod.boolean().optional().describe('Only the studio-wide ones'),
    after: zod.number().int().min(0).optional().describe('The number of the last record of the previous page'),
    limit: zod.number().int().min(1).max(MAX_PAGE).optional().describe('Records at most (default: the row\'s pageSize)'),
  },
}

const SHOW: ToolSpec = {
  scope: 'operator', lead: true,
  description: 'One decision by its number, with the decisions that supersede it (at most 100). A lead token reads its own project\'s and the studio-wide ones. Input and output: mcp-decisions@1.0.',
  inputSchema: { id: zod.string().regex(/^D[1-9][0-9]{0,8}$/).describe('The decision, D<n>') },
}

const IMPORT: ToolSpec = {
  scope: 'operator',
  description: `Import the lead's decisions.json, once (the operator's only; \`system decisions import <file>\` reads the file and calls it). The numbers must be exactly D1 to Dn, none twice and none skipped, at most ${MAX_ENTRIES} of them, or nothing is written; a second run changes nothing. Input and output: mcp-decisions@1.0.`,
  inputSchema: {
    registry: zod.union([zod.array(zod.unknown()), zod.record(zod.string(), zod.unknown())]).describe('The parsed decisions.json'),
    file: text(200).describe('The file\'s name, kept on each imported record'),
  },
}

function registerTools(c: Context, log: DecisionLog): void {
  c.mcp.tool('decisions_ask', ASK, tool('decisions_ask', (args, actor, check) => ({ decision: log.ask(args as unknown as AskInput, actor, new Date(), check) }),
    (o) => { const d = (o as { decision: OperatorDecision }).decision; return `recorded ${d.id}: ${d.question.slice(0, 120)}` }))
  c.mcp.tool('decisions_answer', ANSWER, tool('decisions_answer', (args, actor, check) => ({ decision: log.answer(args as unknown as AnswerInput, actor, new Date(), check) }),
    (o) => { const d = (o as { decision: OperatorDecision }).decision; return `recorded the answer to ${d.id}, by ${d.answeredBy}` }))
  c.mcp.tool('decisions_list', LIST, tool('decisions_list', (args, actor) => log.list(args as ListFilter, actor),
    (o) => { const page = o as { decisions: OperatorDecision[]; next?: number }; return page.decisions.length ? `${page.decisions.map(line).join('\n')}${page.next !== undefined ? `\nmore: after ${page.next}` : ''}` : 'no decision' }))
  c.mcp.tool('decisions_show', SHOW, tool('decisions_show', (args, actor) => log.show(String(args['id']), actor),
    (o) => { const found = o as { decision: OperatorDecision; supersededBy: string[] }; return `${line(found.decision)}${found.supersededBy.length ? `\n  superseded by ${found.supersededBy.join(', ')}` : ''}` }))
  c.mcp.tool('decisions_import', IMPORT, tool('decisions_import', (args, actor, check) => log.import(args['registry'], String(args['file']), actor, check),
    (o) => { const done = o as ImportResult; return `imported ${done.imported} decision(s), ${done.unchanged} already there; the next number is D${done.highest + 1} or later` }))
}

/** The row: its tables, and its tools on the MCP endpoint while that is mounted. */
export function apply(ctx: Context, config: Config = {}): void {
  const log = new DecisionLog(ctx, config.pageSize ?? 50)
  migrate(ctx)
  ctx.inject(['mcp'], (c) => registerTools(c, log))
}
