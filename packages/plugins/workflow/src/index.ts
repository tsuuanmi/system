/**
 * `ctx.workflow`: the single workflow engine (ADR-0004, ADR-0012, INV-1), MVP subset:
 * static DAGs from templates, durable `workflow-node@1.0` records, input-hash receipts,
 * acceptance through `ctx.workers` (REQ-WRK-3), bounded retries by disposition (REQ-WF-6),
 * and recovery on restart (REQ-WF-4). Every call, `ask` included, is a DAG on this engine.
 * A `worker` node runs as a turn on the website Worker runtime (`ctx.turns`), keyed by run,
 * node, attempt, and input hash, so a restart re-attaches to the same turn and never resends.
 *
 * This file is the service facade; the engine's modules are listed in the package README.
 * @module @tsuuanmi/system-workflow
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-board-core'
import type {} from '@tsuuanmi/system-egress'
import type {} from '@tsuuanmi/system-event-log'
import type {} from '@tsuuanmi/system-gateway-core'
import type {} from '@tsuuanmi/system-store'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { sweepDeferrals } from './continuations.ts'
import { checkTemplate, Engine } from './engine.ts'
import { MIGRATIONS } from './migrations.ts'
import { approve, continueRun, stop, supersede } from './operator.ts'
import { pollMs } from './queue.ts'
import { deleteRun, purge } from './retention.ts'
import { wake, wakeSafely } from './sessions.ts'
import type { NodeTemplate } from './spec.ts'
import { teamContracts, vote } from './teams.ts'
import { registerTools } from './tools.ts'
import type { Config, Explanation, NodeRecord, RunStatus, RunView, StartInput, TaskStartInput } from './types.ts'
import { explain, usage } from './views.ts'

export { compose, DEFAULT_TEMPLATES, preflight, resolve } from './spec.ts'
export type { Instructions, NodeTemplate, ResolvedNode, ResolvedSpec } from './spec.ts'
export { WorkflowFailure } from './types.ts'
export type { Config, ExplainedDecision, Explanation, NodeRecord, NodeState, NodeView, RunStatus, RunView, StartInput, TaskClaim, TaskOutcome, TaskStartInput, TaskView, WorkflowError } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflow: Workflow
  }
}

/**
 * What this code would refuse in a configuration, before a host starts on it (`system check`): each
 * configured template that fails its check, with why. Empty when the configuration is fine.
 */
export function checkConfig(config: Config = {}): string[] {
  const schemas = new SchemaRegistry()
  return Object.entries(config.templates ?? {}).flatMap(([name, nodes]) => {
    try {
      checkTemplate(name, nodes, schemas)
      return []
    } catch (error) {
      return [`template ${name}: ${(error as Error).message}`]
    }
  })
}

export class Workflow extends Service {
  static inject = ['store', 'artifacts', 'eventLog', 'leases', 'egress', 'workers', 'workerSessions']

  static Config: z<Config> = z.object({
    templates: z.dict(z.array(z.object({
      nodeId: z.string().required(),
      objective: z.string().required(),
      dependsOn: z.array(z.string()),
      prompt: z.string().required(),
      capabilities: z.array(z.string()).required(),
      tier: z.union(['economy', 'standard', 'frontier']).required(),
      callerTier: z.boolean(),
      conversation: z.union(['temporary', 'persistent', 'caller', 'own']).required(),
      acceptance: z.string().required(),
      maxEscalations: z.natural().max(3),
      // Not z.object: an omitted object would come back as {} and make every node a planner.
      grows: z.any().description('Planner policy {maxNodes, capabilities, approvalRequired}; checked by preflight'),
      resultSchema: z.string().description('Schema tag the answer\'s JSON must be valid against (REQ-ART-5)'),
      differentFrom: z.array(z.string()).description('Nodes whose Workers this node\'s Worker must differ from in provider family (ADR-0027)'),
      // Not z.object, for the same reason as grows.
      team: z.any().description('Team policy {kind: brainstorm | review, members, debateRounds}; checked by preflight'),
    }))).default({}).description('Workflow templates by name, added to the built-in ones (a same-named one replaces it)'),
    maxAttempts: z.natural().min(1).max(10).default(3).description('Attempts per node for retryable failures'),
    retryDelayMs: z.natural().default(5000).description('First back-off delay, doubled per attempt'),
    maxActiveRuns: z.natural().min(1).default(16).description('Unfinished runs that execute at once; a run waiting only on an approval or a vote is not one'),
    maxWaitingRuns: z.natural().default(16).description('Runs waiting only on an approval or a vote, beyond maxActiveRuns; with that many, new runs are refused'),
    retainDays: z.natural().min(1).default(30).description('Days a finished run keeps its input text and prompts'),
    allowSameFamily: z.boolean().default(false).description('When no Worker of another provider family (or, for a team member, another account) is admitted, run on the same family instead of failing: a team member first on an account of its own, then sharing one, recorded as a same-family decision; its work is then not judged by another provider (ADR-0029, ADR-0035)'),
    retainRunsDays: z.natural().default(30).description('Days a finished run is kept, then deleted with the artifacts only it needed and the website chats only it used (0: every run is kept); a session\'s latest run always stays'),
    autoApprovePlans: z.boolean().default(false).description('Approve a high-confidence plan by policy instead of waiting for the operator'),
    maxReviewCycles: z.natural().min(1).max(5).default(3).description('Reviews of one change, the first included, before remediation stops'),
    tieTimeoutHours: z.number().min(0.0001).max(720).default(24).description('Hours a tied team waits for a deciding vote, then completes inconclusive (INV-9)'),
    gateTimeoutHours: z.number().min(0.0001).max(720).default(24).description('Hours a plan\'s gate waits for the operator\'s approval, then closes and fails the run, by rule (INV-9); continue the run to wait again'),
    approvalPollSeconds: z.natural().min(1).max(300).default(15).description('Seconds between the engine\'s reads of the approval queue: a remediation fix\'s request while its run waits on it, and the requests a Worker\'s deferred tool calls wait on (INV-9)'),
    maxSessionRuns: z.natural().min(1).max(50).default(5).description('Runs one session may serve when a board task\'s next attempt, or the next task of a chain, resumes the session of the work before it (INV-9); past it, the run starts a fresh session given its brief'),
    tasksFile: z.object({
      maxTasks: z.natural().max(10_000).default(200).description('Tasks it lists at most, open ones first, the rest counted; 0 writes no file'),
      maxChars: z.natural().min(1024).max(1_048_576).default(65_536).description('Characters it holds at most; past it, it is cut at a line with a note'),
    }).description('The board\'s TASKS.md projection a board task\'s run is given in its own worktree (INV-9)'),
    digestsPerHour: z.natural().max(1000).default(6).description('Digests of board task results the engine asks ctx.digests for in any hour, one per attempt, after its result reached the board (INV-9); 0 asks for none. Past it, a result keeps no digest, recorded with why'),
    repositories: z.object({
      hosts: z.array(z.string()).default(['github.com']).description('Hosts a review may read a public repository from'),
      maxFiles: z.natural().min(1).max(200).description('Files a review reads from a repository (default 40)'),
      maxBytes: z.natural().min(1000).max(2_000_000).description('Bytes of text it reads in all (default 300 KB)'),
      maxFileBytes: z.natural().min(1000).max(500_000).description('A larger file is listed as unread (default 48 KB)'),
      maxSourceChars: z.natural().min(2000).max(2_000_000).default(24_000).description('Characters of source a member reads, as shown (line-numbered files and the list of files not shown): files past it are not shown; caller text past it is refused (default 24,000, so a review prompt fits a 30,000-character member input)'),
    }).description('A review\'s repository reads: allowed hosts and bounds (INV-9)'),
  }) as unknown as z<Config>

  private readonly engine: Engine

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workflow')
    const engine = new Engine(ctx, config)
    this.engine = engine
    ctx.store.migrate('workflow', MIGRATIONS)
    ctx.effect(() => {
      queueMicrotask(() => {
        purge(engine)
        engine.recover()
        void sweepDeferrals(engine)
      })
      const daily = setInterval(() => purge(engine), 24 * 60 * 60_000)
      daily.unref()
      // The requests deferred tool calls wait on: an approved one continues its session, once.
      const deferrals = setInterval(() => void sweepDeferrals(engine), pollMs(engine))
      deferrals.unref()
      return async () => {
        clearInterval(daily)
        clearInterval(deferrals)
        await engine.close()
      }
    })
    ctx.inject(['mcp'], (c) => registerTools(c, this, ctx))
    // The board is optional (docs/design/board.md): a run for a board task needs it, every other run does not.
    ctx.inject(['board'], (c) => {
      const board = c.board
      engine.tasks.attach(board)
      c.effect(() => () => engine.tasks.detach(board))
    })
    ctx.on('worker-sessions/delivered', (sessionIds) => {
      for (const id of sessionIds) wakeSafely(engine, id)
    })
    teamContracts(ctx)
  }

  /**
   * Drain (REQ-HOST-1): admit no new run from now on, and report the runs still executing in
   * this process. Idempotent; the caller polls it until nothing is active or its deadline.
   */
  drain(): { draining: boolean; active: string[] } {
    this.engine.draining = true
    return { draining: true, active: [...this.engine.running.keys()] }
  }

  /** Admit new runs again after a drain. */
  resume(): { draining: boolean; active: string[] } {
    this.engine.draining = false
    return { draining: false, active: [...this.engine.running.keys()] }
  }

  /**
   * A profile contributes a procedure (REQ-WF-9; the `profiles` seam in
   * docs/architecture/plugin-model.md). The template is checked like a configured one (preflight)
   * and served until the returned disposer runs; admitted runs keep their resolved spec, so
   * withdrawing a template never touches them. Its acceptance contracts come from `ctx.workers`.
   */
  template(name: string, nodes: NodeTemplate[]): () => void {
    const templates = this.engine.templates
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new TypeError(`template name ${name} must be lowercase letters, digits, and hyphens`)
    if (templates[name]) throw new Error(`template ${name} already exists`)
    this.engine.check(name, nodes)
    templates[name] = nodes
    return () => {
      if (templates[name] === nodes) delete templates[name]
    }
  }

  /** Configured templates refused at load, with why: health reports them, and starting one says why. */
  refusedTemplates(): Array<{ name: string; reason: string }> {
    return [...this.engine.refused].map(([name, reason]) => ({ name, reason }))
  }

  /** The templates served now: built-in, configured, and contributed by profiles. */
  templateNames(): string[] {
    return Object.keys(this.engine.templates).sort()
  }

  /**
   * Admit a run: validated, hashed, and durable at once; it runs in the background. A run for a
   * board task (`task`) is admitted once the engine took the task (adopting the caller's live
   * claim, or claiming the ready task) and the board recorded the run, so it is asynchronous; a
   * task not ready, or a stale claim, refuses it before anything runs (docs/design/board.md).
   */
  start(input: TaskStartInput): Promise<RunView>
  start(input: StartInput): RunView
  start(input: StartInput | TaskStartInput): RunView | Promise<RunView> {
    if ('task' in input && input.task !== undefined) return this.engine.tasks.start(input)
    return this.engine.start(input)
  }

  get(runId: string): RunView | undefined {
    return this.engine.get(runId)
  }

  /** The durable node records of a run, in dependency order. */
  records(runId: string): NodeRecord[] {
    return this.engine.records(runId)
  }

  /** Wait until the run finishes or `timeoutMs` passes; returns the current view either way. */
  wait(runId: string, timeoutMs: number): Promise<RunView> {
    return this.engine.wait(runId, timeoutMs)
  }

  /** Recent runs and, per node, which Worker, tier, and quota class served it (usage report). */
  usage(limit = 50): RunView[] {
    return usage(this.engine, limit)
  }

  /** The decision chain of a run, per node: egress, tier, route (or admission), acceptance (REQ-ART-3). */
  explain(runId: string): Explanation | undefined {
    return explain(this.engine, runId)
  }

  /**
   * Wake-on-message (docs/design/sessions-and-messaging.md): an idle session with unread messages
   * takes one turn on them, on its own session and Worker (Model A), as an `ask` run. Its reply
   * goes back to the peers who wrote; the operator reads it as the run's answer. A session in a
   * running team is not woken: its rounds read the inbox. One wake per session at a time, and
   * one per (session, last message), so a repeated delivery starts nothing new.
   */
  wake(sessionId: string): RunView | undefined {
    return wake(this.engine, sessionId)
  }

  /**
   * The operator stops a run (REQ-WF-7): its advance halts, running executions are cancelled
   * through their sources, and every unfinished node fails as `stopped`, recorded as the
   * operator's decision. Nothing is resent, and finished work stays.
   */
  stop(runId: string, reason?: string): Promise<RunView> {
    return stop(this.engine, runId, reason)
  }

  /**
   * The operator continues a failed run (REQ-WF-7): exactly one failed node (or, for a stopped
   * run, the nodes the stop failed) is reopened as a new attempt, recorded as the operator's
   * decision. A node whose work was sent may send again: that is the operator's call.
   */
  continue(runId: string, nodeId?: string): RunView {
    return continueRun(this.engine, runId, nodeId)
  }

  /**
   * Delete a finished run (REQ-WF-7; workflow-engine.md#retention): without `updatedAt` it only
   * previews; with it, it deletes when the run is unchanged since that preview. Artifacts stay.
   */
  delete(runId: string, updatedAt?: string): { deleted: boolean; runId: string; template: string; status: RunStatus; updatedAt: string; nodes: number } {
    return deleteRun(this.engine, runId, updatedAt)
  }

  /**
   * Lineage invalidation (docs/design/artifacts.md#lineage-and-invalidation): the operator
   * replaces a completed node's result. The replacement supersedes the old artifact and is
   * checked against the node's contract; every node downstream, directly or transitively, is
   * fenced and re-runs, its `recovery` decision pointing at both artifacts. New inputs mean new
   * input hashes, so nothing stale is reused.
   */
  supersede(runId: string, nodeId: string, replacement: { text: string; note?: string }): Promise<RunView> {
    return supersede(this.engine, runId, nodeId, replacement)
  }

  /**
   * The operator's verdict on a run's waiting plan, through a trusted channel (MCP or CLI,
   * never model text; INV-6): an `approval` artifact bound to the exact plan (INV-5), then a
   * `gate` decision. Approved, the steps run; rejected, the run fails. `plan` names the plan the
   * operator read; without it the run must be waiting on exactly one plan, so a plan that arrived
   * later is never approved unseen.
   */
  approve(runId: string, input: { verdict: 'approved' | 'rejected'; note?: string; plan?: string }): RunView {
    return approve(this.engine, runId, input)
  }

  /**
   * The deciding vote on a team's tie (REQ-TEAM-7), through a trusted channel (INV-6): bound to
   * the exact tie decision the caller read, recorded with the caller (`client`) or the operator
   * as the decider. `inconclusive` ends the team without forcing a choice.
   */
  vote(runId: string, input: { decision: string; option: string; rationale: string; by: 'client' | 'operator' }): RunView {
    return vote(this.engine, runId, input)
  }
}

export default Workflow
