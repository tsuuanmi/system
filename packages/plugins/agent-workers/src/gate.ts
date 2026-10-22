/**
 * The tool gate of an agent run (docs/design/approvals.md#a-workers-tool-calls): before each tool
 * call runs, it is classified into an action and judged by the autonomy policy (`ctx.approvals`).
 * Code decides, never a model: a call is classified by its tool's name and input only, and a call
 * it cannot classify is denied (INV-2). `forbid` denies; `auto` and `notify` allow once no required
 * check failed; `ask` opens one approval request on the exact call (INV-5) and defers it, and the
 * same exact call in a later run of the same session runs once the operator approved it.
 * @module @tsuuanmi/system-agent-workers/gate
 */
import { resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolCall, ToolGate, ToolVerdict } from '@tsuuanmi/system-agent-runtime-core'
import type { ActionClass, ApprovalRequest, Approvals, ArtifactRef, AutonomyVerdict } from '@tsuuanmi/system-approvals-core'
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
/** The tool that runs a command, and the input fields it may carry; any other field is refused. */
const COMMAND = 'Bash'
const COMMAND_FIELDS = new Set(['command', 'description', 'timeout', 'run_in_background'])

const SUMMARY_MAX = 500
const clamp = (text: string): string => (text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text)
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Whether `path` (relative to the workspace, or absolute) names the workspace or a path inside it, lexically. */
function within(workspace: string, path: string): boolean {
  if (path === '' || path.startsWith('~')) return false
  const root = resolve(workspace)
  const full = resolve(root, path)
  return full === root || full.startsWith(root.endsWith(sep) ? root : root + sep)
}

const ANSWER = 'Approved: the next run of this session makes exactly this call. Rejected, or unanswered when the request expires: the call is denied.'

/**
 * Classify one tool call, conservatively; `{ refused }` for a call the gate does not classify,
 * which is denied without asking anyone:
 * - `Read`, `NotebookRead`, `LS`, `Glob`, `Grep`: `read`, when the path they name is inside the
 *   workspace (absent for `Glob` and `Grep`: the workspace); a `Glob` pattern that is absolute
 *   outside the workspace, or climbs with `..`, is refused;
 * - `Write`, `Edit`, `MultiEdit`, `NotebookEdit`: `workspace-write`, for a file inside the
 *   workspace; outside it is refused (the runtime refuses it too);
 * - `Bash`: `command`, its argv the command split on single spaces, exactly as the policy's
 *   exact-argv rule matches it (a word with a shell metacharacter is the policy's `forbid`);
 *   an input field beyond `command`, `description`, `timeout`, and `run_in_background` (one that
 *   would run it outside its sandbox, say) is refused;
 * - `WebFetch`, `WebSearch`: `external-send`;
 * - any other tool, or an input that is not an object: refused.
 */
export function classify(call: ToolCall, workspace: string): ToolAction | { refused: string } {
  const { tool } = call
  const input = call.input
  if (!isObject(input)) return { refused: `the input of ${tool} is not an object` }
  const read = READS[tool]
  if (read) {
    if (tool === 'Glob') {
      const pattern = input.pattern
      if (typeof pattern !== 'string' || pattern.split(/[\\/]/).includes('..') || (pattern.startsWith('/') && !within(workspace, pattern.split(/[*?[{]/)[0]!))) {
        return { refused: `the Glob pattern ${JSON.stringify(pattern)} reaches outside the workspace` }
      }
    }
    const where = input[read.field]
    if (where === undefined && !read.required) return { class: 'read', summary: clamp(`${tool} in the workspace`), consequences: `Reads inside the run's workspace. ${ANSWER}` }
    if (typeof where !== 'string' || !within(workspace, where)) return { refused: `${tool} reads ${typeof where === 'string' ? where : 'no path'}, which is not inside the workspace` }
    return { class: 'read', summary: clamp(`${tool} ${where}`), consequences: `Reads ${where} inside the run's workspace. ${ANSWER}` }
  }
  const write = WRITES[tool]
  if (write) {
    const file = input[write]
    if (typeof file !== 'string' || !within(workspace, file)) return { refused: `${tool} changes ${typeof file === 'string' ? file : 'no file'}, which is not inside the workspace` }
    return { class: 'workspace-write', summary: clamp(`${tool} ${file}`), consequences: `Changes ${file} inside the run's workspace. ${ANSWER}` }
  }
  if (tool === COMMAND) {
    const command = input.command
    if (typeof command !== 'string' || command === '') return { refused: `${tool} names no command` }
    const extra = Object.keys(input).filter((key) => !COMMAND_FIELDS.has(key))
    if (extra.length) return { refused: `${tool} carries ${extra.join(', ')}, which the gate does not classify` }
    return { class: 'command', command: command.split(' '), summary: clamp(`${tool}: ${command}`), consequences: `Runs this exact command in the run's workspace. ${ANSWER}` }
  }
  const send = SENDS[tool]
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

interface RequestRow { request_id: string; used_at: string | null }

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

const RULE = { type: 'rule', id: 'agent-workers.tool-gate', version: '1' } as const

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

  const event = (kind: 'notified' | 'denied' | 'deferred', call: ToolCall, decision: ArtifactRef | undefined, data: Record<string, unknown> = {}): void => {
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
    const prior = db.prepare('SELECT request_id, used_at FROM agent_tool_requests WHERE scope = ? AND tool = ? AND input_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(scope, call.tool, inputHash) as RequestRow | undefined
    if (prior) {
      const request: ApprovalRequest | undefined = await approvals.get(prior.request_id)
      if (!request) return refuse(call, `approval request ${prior.request_id} for this call cannot be read`, [verdict.decision])
      // INV-5: the request is for exactly this call.
      if (request.subject.version !== inputHash || request.action.class !== action.class) return refuse(call, `approval request ${request.requestId} is for another call than this one`, [verdict.decision])
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
        // A verdict is not yet a permission: the checks its rule requires have not run for this call.
        if (verdict.failedChecks?.length) {
          return denied(call, action, verdict, `this ${action.class} call runs only once ${verdict.failedChecks.join(', ')} pass, and they have not run for it: that is work for the lead, not the operator`)
        }
        if (verdict.mode === 'notify') event('notified', call, verdict.decision, { actionClass: action.class })
        return { decision: 'allow' }
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
