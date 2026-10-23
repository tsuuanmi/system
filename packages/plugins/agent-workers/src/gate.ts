/**
 * The tool gate of an agent run (docs/design/approvals.md#a-workers-tool-calls): before each tool
 * call runs, it is classified into an action and judged by the autonomy policy (`ctx.approvals`).
 * Code decides, never a model: a call is classified by its tool's name and input only, and a call
 * it cannot classify is denied (INV-2). `forbid` denies; `auto` and `notify` allow, their rule's
 * required checks still pending (they bind when the result is accepted, not per call); `ask` opens
 * one approval request on the exact call (INV-5) and defers it, and the same exact call in a later
 * run of the same session runs once the operator approved it.
 * @module @tsuuanmi/system-agent-workers/gate
 */
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCall, ToolGate, ToolVerdict } from '@tsuuanmi/system-agent-runtime-core'
import { type ActionClass, type ApprovalRequest, type Approvals, type ArtifactRef, type AutonomyVerdict, type Check, SHELL_METACHARACTER } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-artifacts'
import type {} from '@tsuuanmi/system-event-log'
import { contentId } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'

/** A tool call as an action the policy judges: its class, a command's argv, and what the operator is shown. */
export interface ToolAction {
  class: ActionClass
  /** For `command`: the argv, the command split on single spaces (never parsed by a shell). */
  command?: string[]
  summary: string
  consequences: string
}

/** Tools that only read, and the input field that names where; a field that may be absent reads the workspace. */
const READS: Record<string, { field: string; required: boolean }> = {
  Read: { field: 'file_path', required: true },
  NotebookRead: { field: 'notebook_path', required: true },
  LS: { field: 'path', required: true },
  Glob: { field: 'path', required: false },
  Grep: { field: 'path', required: false },
}
/** Tools that change one file, and the input field that names it. */
const WRITES: Record<string, string> = { Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' }
/** Tools that send data out of this machine, and the input field the operator is shown. */
const SENDS: Record<string, string> = { WebFetch: 'url', WebSearch: 'query' }
/** The tool that runs a command. */
const COMMAND = 'Bash'

/** The type an input field must have: `edits` is `MultiEdit`'s list of `{ old_string, new_string, replace_all? }`. */
type FieldType = 'string' | 'number' | 'boolean' | 'strings' | 'edits'
/**
 * Every input field each classified tool may carry, and its type, from the Claude Agent SDK's tool
 * input types (`sdk-tools.d.ts`; `MultiEdit`, `NotebookRead`, and `LS`, which it no longer
 * declares, from their last published shapes). A field not listed (Bash's
 * `dangerouslyDisableSandbox`, say, which would run it outside its sandbox), or a listed one of
 * another type, refuses the call: the gate classifies only an input it knows whole.
 */
const FIELDS: Record<string, Record<string, FieldType>> = {
  Read: { file_path: 'string', offset: 'number', limit: 'number', pages: 'string', allow_large: 'boolean' },
  NotebookRead: { notebook_path: 'string', cell_id: 'string' },
  LS: { path: 'string', ignore: 'strings' },
  Glob: { pattern: 'string', path: 'string' },
  Grep: {
    'pattern': 'string', 'path': 'string', 'glob': 'string', 'output_mode': 'string', '-B': 'number', '-A': 'number', '-C': 'number', 'context': 'number',
    '-n': 'boolean', '-i': 'boolean', '-o': 'boolean', 'type': 'string', 'head_limit': 'number', 'offset': 'number', 'multiline': 'boolean',
  },
  Write: { file_path: 'string', content: 'string' },
  Edit: { file_path: 'string', old_string: 'string', new_string: 'string', replace_all: 'boolean' },
  MultiEdit: { file_path: 'string', edits: 'edits' },
  NotebookEdit: { notebook_path: 'string', cell_id: 'string', new_source: 'string', cell_type: 'string', edit_mode: 'string' },
  Bash: { command: 'string', description: 'string', timeout: 'number', run_in_background: 'boolean' },
  WebFetch: { url: 'string', prompt: 'string', offset: 'number' },
  WebSearch: { query: 'string', allowed_domains: 'strings', blocked_domains: 'strings' },
}
const EDIT_FIELDS: Record<string, FieldType> = { old_string: 'string', new_string: 'string', replace_all: 'boolean' }

const SUMMARY_MAX = 500
const clamp = (text: string): string => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text)
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether `value` has type `type`. */
function typed(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'boolean': return typeof value === 'boolean'
    case 'strings': return Array.isArray(value) && value.every((v) => typeof v === 'string')
    case 'edits': return Array.isArray(value) && value.every((edit) => isObject(edit) && unknownField(edit, EDIT_FIELDS) === undefined)
  }
}

/** The first field of `input` that `fields` does not list, or lists with another type, and why; undefined when there is none. */
function unknownField(input: Record<string, unknown>, fields: Record<string, FieldType>): string | undefined {
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(fields, key)) return `carries ${JSON.stringify(key.slice(0, 100))}, a field the gate does not classify`
    if (!typed(value, fields[key]!)) return `carries ${JSON.stringify(key)} that is not a ${fields[key] === 'strings' ? 'list of strings' : fields[key] === 'edits' ? 'list of edits' : fields[key]}`
  }
  return undefined
}

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
const code = (error: unknown): unknown => (error as NodeJS.ErrnoException | undefined)?.code

/**
 * Where `path` (absolute) is on disk, every symlink followed, `..` resolved physically: an existing
 * path's real path; for one that does not exist yet (a write target), its deepest existing
 * ancestor's real path and the rest appended, which must hold no `..`. Undefined when it cannot be
 * resolved (a dangling symlink, a loop, a permission error, a `..` in the rest): such a path is
 * outside every workspace.
 */
function realLocation(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if (code(error) !== 'ENOENT') return undefined
  }
  const segments = path.split(sep).filter((s) => s !== '' && s !== '.')
  for (let i = segments.length; i >= 0; i -= 1) {
    const ancestor = sep + segments.slice(0, i).join(sep)
    try {
      lstatSync(ancestor)
    } catch (error) {
      if (code(error) === 'ENOENT') continue
      return undefined
    }
    const rest = segments.slice(i)
    if (rest.includes('..')) return undefined
    try {
      // The deepest entry that exists: a symlink there that does not resolve (dangling) refuses.
      return join(realpathSync.native(ancestor), ...rest)
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Whether `path` (relative to the workspace, or absolute) names the workspace or a path inside it,
 * both as written (lexically) and on disk: its real location (every symlink followed) is inside
 * the workspace's real path. A path that cannot be resolved is not inside. A symlink created after
 * this check is bounded by the runtime's own confinement, which the gate does not replace.
 */
function within(workspace: string, path: string): boolean {
  if (path === '' || path.startsWith('~') || path.includes('\0')) return false
  const root = resolve(workspace)
  if (!inside(root, resolve(root, path))) return false
  let realRoot: string
  try {
    realRoot = realpathSync.native(root)
  } catch {
    return false
  }
  const real = realLocation(isAbsolute(path) ? path : `${root}${sep}${path}`)
  return real !== undefined && inside(realRoot, real)
}

const ANSWER = 'Approved: the next run of this session makes exactly this call. Rejected, or unanswered when the request expires: the call is denied.'

/**
 * Classify one tool call, conservatively; `{ refused }` for a call the gate does not classify,
 * which is denied without asking anyone. Every classified tool's input may carry only the fields
 * its SDK type declares, each of its type (an unknown field, or a wrong type, is refused), and a
 * path is inside the workspace only where it really is, every symlink followed:
 * - `Read`, `NotebookRead`, `LS`, `Glob`, `Grep`: `read`, when the path they name is inside the
 *   workspace (absent for `Glob` and `Grep`: the workspace); a `Glob` pattern whose literal
 *   leading directory is outside it, or that climbs with `..`, is refused;
 * - `Write`, `Edit`, `MultiEdit`, `NotebookEdit`: `workspace-write`, for a file inside the
 *   workspace; outside it is refused (the runtime refuses it too);
 * - `Bash`: `command`, its argv the command split on single spaces, exactly as the policy's
 *   exact-argv rule matches it; an empty word (a doubled, leading, or trailing space) or a word
 *   with a shell metacharacter is refused here, before the policy is asked (which forbids the
 *   latter too);
 * - `WebFetch`, `WebSearch`: `external-send`;
 * - any other tool, or an input that is not an object: refused.
 */
export function classify(call: ToolCall, workspace: string): ToolAction | { refused: string } {
  const { tool } = call
  const input = call.input
  if (!isObject(input)) return { refused: `the input of ${tool} is not an object` }
  const fields = Object.hasOwn(FIELDS, tool) ? FIELDS[tool] : undefined
  if (!fields) return { refused: `${tool} is not a tool the gate classifies` }
  const unknown = unknownField(input, fields)
  if (unknown) return { refused: `${tool} ${unknown}` }
  const read = Object.hasOwn(READS, tool) ? READS[tool] : undefined
  if (read) {
    if (tool === 'Glob') {
      const pattern = input.pattern
      const base = typeof input.path === 'string' ? input.path : undefined
      const literal = typeof pattern === 'string' ? pattern.split(/[*?[{]/)[0]! : ''
      const dir = pattern === undefined || isAbsolute(literal) ? literal : base === undefined ? literal || '.' : `${base}${sep}${literal}`
      if (typeof pattern !== 'string' || pattern.split(/[\\/]/).includes('..') || !within(workspace, dir)) {
        return { refused: `the Glob pattern ${JSON.stringify(pattern)} reaches outside the workspace` }
      }
    }
    const where = input[read.field]
    if (where === undefined && !read.required) return { class: 'read', summary: clamp(`${tool} in the workspace`), consequences: `Reads inside the run's workspace. ${ANSWER}` }
    if (typeof where !== 'string' || !within(workspace, where)) return { refused: `${tool} reads ${typeof where === 'string' ? where : 'no path'}, which is not inside the workspace` }
    return { class: 'read', summary: clamp(`${tool} ${where}`), consequences: `Reads ${where} inside the run's workspace. ${ANSWER}` }
  }
  const write = Object.hasOwn(WRITES, tool) ? WRITES[tool] : undefined
  if (write) {
    const file = input[write]
    if (typeof file !== 'string' || !within(workspace, file)) return { refused: `${tool} changes ${typeof file === 'string' ? file : 'no file'}, which is not inside the workspace` }
    return { class: 'workspace-write', summary: clamp(`${tool} ${file}`), consequences: `Changes ${file} inside the run's workspace. ${ANSWER}` }
  }
  if (tool === COMMAND) {
    const command = input.command
    if (typeof command !== 'string' || command === '') return { refused: `${tool} names no command` }
    const argv = command.split(' ')
    // Defence in depth: the policy forbids a metacharacter word too, but the gate never asks it about one.
    const empty = argv.indexOf('')
    if (empty >= 0) return { refused: `${tool}: argv word ${empty + 1} is empty (a doubled, leading, or trailing space); a command is words split on single spaces` }
    const unsafe = argv.findIndex((word) => SHELL_METACHARACTER.test(word))
    if (unsafe >= 0) return { refused: `${tool}: argv word ${unsafe + 1} holds a shell metacharacter; a command is never parsed by a shell` }
    return { class: 'command', command: argv, summary: clamp(`${tool}: ${command}`), consequences: `Runs this exact command in the run's workspace. ${ANSWER}` }
  }
  const send = Object.hasOwn(SENDS, tool) ? SENDS[tool] : undefined
  if (send) {
    const what = input[send]
    if (typeof what !== 'string' || what === '') return { refused: `${tool} names no ${send}` }
    return { class: 'external-send', summary: clamp(`${tool}: ${what}`), consequences: `Sends this request out of this machine. ${ANSWER}` }
  }
  return { refused: `${tool} is not a tool the gate classifies` }
}

/** The run a gate is for: where it works, who asked, and the classification of what it shows. */
export interface GateRun {
  /** The agent run (`arun_…`). */
  runId: string
  worker: string
  workspace: string
  /** The run's session: an approved call runs in a later run of it. */
  sessionId?: string | undefined
  /** The workflow run the agent run belongs to, for the decisions' and events' lineage. */
  workflowRunId?: string | undefined
  classification: 'public' | 'operator-shared' | 'local-private'
}

/** The call a run's gate deferred: the run stops there and does not complete. */
export interface Deferral {
  tool: string
  requestId: string
  reason: string
}

export interface RunGate {
  gate: ToolGate
  /** The call the gate deferred, once it deferred one. */
  deferral(): Deferral | undefined
}

interface RequestRow { request_id: string; run_id: string; used_at: string | null }

/**
 * The table of requests a gate opened, one row per request: the session and exact call it is for
 * (tool and the content id of its input), and when an approved one was used. An approval covers
 * one call: once used, the same call asks again.
 */
export const GATE_MIGRATION = {
  version: 5,
  sql: `CREATE TABLE agent_tool_requests (
    request_id TEXT PRIMARY KEY, scope TEXT NOT NULL, tool TEXT NOT NULL, input_hash TEXT NOT NULL, run_id TEXT NOT NULL,
    created_at TEXT NOT NULL, used_at TEXT, used_by TEXT
  );
  CREATE INDEX agent_tool_requests_call ON agent_tool_requests (scope, tool, input_hash, created_at);`,
}

/**
 * The first part of a stored request that is not the call the gate's row says it is for: its
 * subject (`content`, the ref naming the run that opened it and the tool, the input's content id),
 * its action class, and its requester (`worker`, that run, this session). Undefined when it is.
 */
function mismatch(request: ApprovalRequest, call: { ref: string; version: string; actionClass: ActionClass; runId: string; sessionId: string }): string | undefined {
  if (request.subject.type !== 'content') return 'subject type'
  if (request.subject.ref !== call.ref) return 'subject ref'
  if (request.subject.version !== call.version) return 'subject version'
  if (request.action.class !== call.actionClass) return 'action class'
  if (request.requester.component !== 'worker') return 'requester component'
  if (request.requester.runId !== call.runId) return 'requester run'
  if (request.requester.sessionId !== call.sessionId) return 'requester session'
  return undefined
}

const RULE = { type: 'rule', id: 'agent-workers.tool-gate', version: '1' } as const
/** The checks a policy rule can require (`autonomy-policy@1.0`): the only ones a verdict may leave pending. */
const CHECKS: readonly Check[] = ['tests', 'typecheck', 'lint', 'schema', 'quote-check', 'review']

/**
 * The gate of one run. `ctx.approvals` is read when a call comes (optional: none, and every call is
 * denied, fail-closed rule 5). A call is judged under the studio policy: no trusted envelope names
 * the project of an agent run yet. Every outcome is a recorded decision: the `autonomy` decision
 * `check` records, the queue's own `approval` decision for a request it resolved, or, where the gate
 * decided without the policy (no queue, a call it does not classify, a run that already stopped, an
 * ask with no session to continue), a `gate` decision of rule `agent-workers.tool-gate`.
 */
export function runGate(ctx: Context, run: GateRun): RunGate {
  let deferred: Deferral | undefined
  /** The action classes this run already showed pending checks for: one event per class and run. */
  const pendingShown = new Set<ActionClass>()

  const event = (kind: 'notified' | 'checks-pending' | 'denied' | 'deferred', call: ToolCall, decision: ArtifactRef | undefined, data: Record<string, unknown> = {}): void => {
    try {
      ctx.get('eventLog')?.append({
        type: `agent-workers.tool.${kind}`, ...(run.workflowRunId ? { runId: run.workflowRunId } : {}), ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(decision ? { decision } : {}), data: { agentRun: run.runId, worker: run.worker, tool: call.tool.slice(0, 100), ...data },
      })
    } catch (error) {
      ctx.logger.warn(`agent Workers: the ${kind} event of a ${call.tool} call in ${run.runId} was not appended: ${(error as Error).message}`)
    }
  }

  /** Deny by the gate's own rule, recorded as a `gate` decision (INV-13). */
  const refuse = (call: ToolCall, why: string, inputs: ArtifactRef[] = []): ToolVerdict => {
    const decision = ctx.artifacts.recordDecision({
      decisionType: 'gate', question: `May ${run.worker} make the ${call.tool} call it asked for in run ${run.runId}?`, inputs,
      candidates: [
        { option: 'allow', selected: false, reasons: [`not allow: ${why}`] },
        { option: 'deny', selected: true, reasons: [why] },
        { option: 'defer', selected: false, reasons: ['not defer: nothing an operator answers would let this call run'] },
      ],
      decider: RULE, outcome: { option: 'deny', detail: { agentRun: run.runId, tool: call.tool.slice(0, 100) } }, deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, ...(run.workflowRunId ? { runId: run.workflowRunId } : {}), classification: run.classification })
    event('denied', call, decision.id as ArtifactRef)
    return { decision: 'deny', reason: `${why} (decision ${decision.id})` }
  }

  /** Deny on the policy's own decision: it is the record. */
  const denied = (call: ToolCall, action: ToolAction, verdict: AutonomyVerdict, why: string): ToolVerdict => {
    event('denied', call, verdict.decision, { actionClass: action.class })
    return { decision: 'deny', reason: `${why} (decision ${verdict.decision})` }
  }

  /** Why the policy forbids it, from the decision it recorded. */
  const forbidden = (action: ToolAction, verdict: AutonomyVerdict): string => {
    const body = ctx.artifacts.get(verdict.decision)?.body as { candidates?: Array<{ selected?: boolean; reasons?: string[] }> } | undefined
    const reason = body?.candidates?.find((c) => c.selected)?.reasons?.[0]
    return `the autonomy policy forbids this ${action.class} call${reason ? `: ${reason}` : ''}`
  }

  const defer = (call: ToolCall, action: ToolAction, verdict: AutonomyVerdict, requestId: string): ToolVerdict => {
    const reason = `${action.summary}: waits for the operator's approval (request ${requestId}); the run stops here, and a later run of session ${run.sessionId} makes exactly this call once it is approved`
    deferred = { tool: call.tool, requestId, reason }
    event('deferred', call, verdict.decision, { actionClass: action.class, requestId })
    return { decision: 'defer', reason, requestId }
  }

  /** An `ask`: the request already opened for this exact call in this session, or a new one. */
  const ask = async (approvals: Approvals, call: ToolCall, action: ToolAction, verdict: AutonomyVerdict): Promise<ToolVerdict> => {
    if (!run.sessionId) return refuse(call, `the policy asks the operator about this ${action.class} call, and run ${run.runId} has no session a later run could continue once approved, so it cannot wait`, [verdict.decision])
    const scope = `session:${run.sessionId}`
    const inputHash = contentId(call.input)
    const db = ctx.store.db
    const prior = db.prepare('SELECT request_id, run_id, used_at FROM agent_tool_requests WHERE scope = ? AND tool = ? AND input_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(scope, call.tool, inputHash) as RequestRow | undefined
    if (prior) {
      const request: ApprovalRequest | undefined = await approvals.get(prior.request_id)
      if (!request) return refuse(call, `approval request ${prior.request_id} for this call cannot be read`, [verdict.decision])
      // INV-5: the request is for exactly this call, asked by this session's Worker, as the row records it.
      const other = mismatch(request, { ref: `agent-tool-call:${prior.run_id}:${call.tool}`, version: inputHash, actionClass: action.class, runId: prior.run_id, sessionId: run.sessionId })
      if (other) return refuse(call, `approval request ${request.requestId} is for another call than this one (its ${other} differs), so its verdict is not used`, [verdict.decision])
      if (request.state === 'rejected') {
        const how = request.resolution?.cause === 'verdict' ? 'rejected by the operator' : request.resolution?.cause === 'expired' ? 'unanswered when it expired' : 'withdrawn'
        event('denied', call, request.resolution?.decision, { actionClass: action.class, requestId: request.requestId })
        return { decision: 'deny', reason: `approval request ${request.requestId} for exactly this call was ${how}, so it does not run` }
      }
      if (request.state !== 'approved') return defer(call, action, verdict, request.requestId)
      if (prior.used_at === null) {
        // One approval, one call: taken once, under the store's write lock.
        const taken = ctx.store.transaction((tx) => Number(tx.prepare('UPDATE agent_tool_requests SET used_at = ?, used_by = ? WHERE request_id = ? AND used_at IS NULL')
          .run(new Date().toISOString(), run.runId, request.requestId).changes) === 1)
        if (taken) return { decision: 'allow' }
      }
      // Its approval was used: the same call asks again.
    }
    const created = await approvals.request({
      subject: { type: 'content', ref: `agent-tool-call:${run.runId}:${call.tool}`, version: inputHash },
      action: { class: action.class, summary: action.summary, consequences: action.consequences },
      requester: {
        component: 'worker', runId: run.runId, sessionId: run.sessionId,
        ...(call.callId && call.callId.length <= 128 ? { toolUseId: call.callId } : {}),
      },
      verdict, ...(action.command ? { command: action.command } : {}), classification: run.classification,
    })
    ctx.store.transaction((tx) => {
      tx.prepare('INSERT INTO agent_tool_requests (request_id, scope, tool, input_hash, run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(created.requestId, scope, call.tool, inputHash, run.runId, created.createdAt)
    })
    return defer(call, action, verdict, created.requestId)
  }

  const judge = async (call: ToolCall): Promise<ToolVerdict> => {
    if (deferred) return refuse(call, `the run stopped at its ${deferred.tool} call, which waits for approval request ${deferred.requestId}; no further call runs`)
    const approvals = ctx.get('approvals')
    if (!approvals) return refuse(call, 'no approval queue (ctx.approvals) is loaded, and no tool call runs without its autonomy decision')
    const action = classify(call, run.workspace)
    if ('refused' in action) return refuse(call, action.refused)
    const verdict = await approvals.check({ class: action.class, ...(action.command ? { command: action.command } : {}) })
    switch (verdict.mode) {
      case 'forbid':
        return denied(call, action, verdict, forbidden(action, verdict))
      case 'auto':
      case 'notify':
      {
        // A rule's required checks are checks the result must pass before it is accepted, never
        // preconditions of one tool call, which cannot carry them: they stay pending, named in the
        // autonomy decision (`failedChecks`) and the run's events, and bind at acceptance
        // (docs/design/approvals.md#a-verdict-is-not-yet-a-permission). Only a check a rule can
        // require may be pending; anything else is not a verdict this gate knows.
        const pending = verdict.failedChecks ?? []
        if (pending.some((c) => !CHECKS.includes(c))) return refuse(call, `the autonomy policy left checks pending that no rule can require (${pending.join(', ')})`, [verdict.decision])
        const shown = pending.length ? { pendingChecks: pending } : {}
        if (verdict.mode === 'notify') event('notified', call, verdict.decision, { actionClass: action.class, ...shown })
        else if (pending.length && !pendingShown.has(action.class)) event('checks-pending', call, verdict.decision, { actionClass: action.class, ...shown })
        if (pending.length) pendingShown.add(action.class)
        return { decision: 'allow' }
      }
      case 'ask':
        return ask(approvals, call, action, verdict)
      default:
        return refuse(call, `the autonomy policy gave a mode the gate does not know (${String(verdict.mode)})`, [verdict.decision])
    }
  }

  return {
    gate: async (call) => {
      try {
        return await judge(call)
      } catch (error) {
        ctx.logger.warn(`agent Workers: the gate of ${run.runId} failed on a ${call.tool} call, which is denied: ${(error as Error).message}`)
        try {
          return refuse(call, `the gate could not judge this call: ${(error as Error).message.slice(0, 200)}`)
        } catch {
          return { decision: 'deny', reason: 'the gate could not judge this call, nor record why' }
        }
      }
    },
    deferral: () => deferred,
  }
}
