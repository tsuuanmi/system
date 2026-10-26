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
import { type Advisor, MAX_TRAINING } from './advisor.ts'
import { sweepDeferrals } from './continuations.ts'
import { dispatchProblems, type DispatchPass, type DispatchStatus } from './dispatch.ts'
import type { DossierAppendInput, DossierCaller, DossierPage } from './dossiers.ts'
import { checkTemplate, Engine } from './engine.ts'
import { hold, type HoldView, holdView, release } from './hold.ts'
import { MIGRATIONS } from './migrations.ts'
import { approve, continueRun, stop, supersede } from './operator.ts'
import { pollMs } from './queue.ts'
import { deleteRun, purge } from './retention.ts'
import { retryHeldWakes, wake, wakeSafely } from './sessions.ts'
import type { NodeTemplate } from './spec.ts'
import { leftOutOfTeams, teamContracts, vote } from './teams.ts'
import { registerTools } from './tools.ts'
import type { Config, Explanation, NodeRecord, RunStatus, RunView, StartInput, TaskLanding, TaskStartInput, TemplateStep, UsageDraws, UsageFilter } from './types.ts'
import { draws, explain, usage } from './views.ts'

export { compose, DEFAULT_TEMPLATES, preflight, resolve } from './spec.ts'
export type { Instructions, NodeTemplate, ResolvedNode, ResolvedSpec } from './spec.ts'
export { WorkflowFailure } from './types.ts'
export { dispatchProblems, dispatchSettings, MAX_LOOKED } from './dispatch.ts'
export { DOSSIER_FILE, DOSSIER_KINDS, DOSSIER_LIMITS, renderDossier, ROLE_KINDS } from './dossiers.ts'
export type { DossierAppendInput, DossierCaller, DossierEntry, DossierEntryView, DossierKind, DossierPage, DossierView } from './dossiers.ts'
export { adviceProblem, adviseInShadow, advisorStop, ANSWER_SCHEMA, brierScores, featuresOf, fitLogistic, LocalAdvisor, modelPrompt, OUTCOME_EVENT, QUESTION_SET, QUESTIONS, SHADOW_ATTEMPTS, vectorOf } from './advisor.ts'
export type { Advice, AdviceDetail, Advisor, AdvisorCandidate, AdvisorConfig, AdvisorCounts, AdvisorFeatures, AdvisorSettings, AdvisorSignal, CandidateAdvice, OutcomeData, Question, QuestionScore } from './advisor.ts'
export type { HoldView, StepHold, StepInFlight } from './hold.ts'
export type { DispatchPass, DispatchPassView, DispatchPause, DispatchSettings, DispatchStarted, DispatchStatus, DispatchWindow } from './dispatch.ts'
export type { Config, DispatchConfig, ExplainedDecision, Explanation, NodeRecord, NodeState, NodeView, RunStatus, RunView, StartedBy, StartInput, TaskCarry, TaskClaim, TaskDispatch, TaskLanding, TaskOutcome, TaskRebase, TaskStartInput, TaskView, TemplateStep, UsageDraws, UsageFilter, UsageRunView, WorkflowError } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workflow: Workflow
  }
}

/** `teams.excludeWorkers` holds at most this many entries (INV-9). */
const MAX_EXCLUDED = 64
/** An entry of `teams.excludeWorkers`: a Worker id, an account id, or `<group>/<account id>`, as system roster lists them. */
const EXCLUDED_ENTRY = /^\S{1,200}$/

/**
 * What `teams` would be refused for, as the schema would refuse it, and more: an option it does not
 * know (a misspelt `excludeWorkers` would leave nothing out of teams), a list that is not one, an
 * entry the schema refuses, more than {@link MAX_EXCLUDED} entries, an entry listed twice. At most
 * one line per entry it reads, and it reads at most {@link MAX_EXCLUDED} + 1 entries (INV-9).
 */
function checkTeams(teams: unknown): string[] {
  if (teams === undefined) return []
  if (teams === null || typeof teams !== 'object' || Array.isArray(teams)) return ['teams must be an object; it takes excludeWorkers, a list of Worker ids and account ids']
  const problems = Object.keys(teams).filter((key) => key !== 'excludeWorkers').slice(0, 8).map((key) => `teams.${key} is not an option; teams takes excludeWorkers`)
  const entries = (teams as { excludeWorkers?: unknown }).excludeWorkers
  if (entries === undefined) return problems
  if (!Array.isArray(entries)) return [...problems, 'teams.excludeWorkers must be a list of Worker ids and account ids, not a single value']
  if (entries.length > MAX_EXCLUDED) problems.push(`teams.excludeWorkers lists ${entries.length} entries; it takes at most ${MAX_EXCLUDED}`)
  const seen = new Set<string>()
  entries.slice(0, MAX_EXCLUDED + 1).forEach((entry: unknown, i) => {
    if (typeof entry !== 'string' || !EXCLUDED_ENTRY.test(entry)) problems.push(`teams.excludeWorkers[${i}] must be a Worker id or an account id: 1 to 200 characters, no whitespace`)
    else if (seen.has(entry)) problems.push(`teams.excludeWorkers lists ${entry} more than once`)
    else seen.add(entry)
  })
  return problems
}

/**
 * What this code would refuse in a configuration, before a host starts on it (`system check`): each
 * configured template that fails its check, with why, and what `teams` would be refused for (see
 * {@link checkTeams}). Empty when the configuration is fine. Whether an entry of
 * `teams.excludeWorkers` names a Worker or account is known only against the Workers listed when a
 * member routes: one that matches none is recorded there (`workflow.team.unmatched-exclusions`).
 */
export function checkConfig(config: Config = {}): string[] {
  const schemas = new SchemaRegistry()
  const templates = Object.entries(config.templates ?? {}).flatMap(([name, nodes]) => {
    try {
      checkTemplate(name, nodes, schemas)
      return []
    } catch (error) {
      return [`template ${name}: ${(error as Error).message}`]
    }
  })
  return [...templates, ...checkTeams(config.teams), ...dispatchProblems(config)]
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
      kind: z.string().description('The kind of work the step is (ADR-0057), such as code or docs: a Worker the operator gives kinds takes it only when it lists this one; checked by preflight'),
      callerTier: z.boolean(),
      conversation: z.union(['temporary', 'persistent', 'caller', 'own']).required(),
      acceptance: z.string().required(),
      maxEscalations: z.natural().max(3),
      // Not z.object: an omitted object would come back as {} and make every node a planner.
      grows: z.any().description('Planner policy {maxNodes, capabilities, approvalRequired}; checked by preflight'),
      resultSchema: z.string().description('Schema tag the answer\'s JSON must be valid against (REQ-ART-5)'),
      differentFrom: z.array(z.string()).description('Nodes whose Workers this node\'s Worker must differ from in provider family (ADR-0027)'),
      // Not z.array: an omitted array would come back as [], which preflight refuses (a list of 1 to 8).
      prefers: z.any().description('Capabilities the step prefers but does not need, such as [web-search]: an admitted Worker that proves them ranks before one that does not, never a refusal (T262); checked by preflight'),
      diversity: z.union(['required', 'preferred']).description('With differentFrom: required (default) fails closed with no Worker of another family; preferred runs once on their family in a conversation of its own, recorded as a single-family decision its later steps and the answer state (D89)'),
      // Not z.object, for the same reason as grows.
      team: z.any().description('Team policy {kind: brainstorm | review, members, debateRounds}; checked by preflight'),
    }))).default({}).description('Workflow templates by name, added to the built-in ones (a same-named one replaces it)'),
    maxAttempts: z.natural().min(1).max(10).default(3).description('Attempts per node for retryable failures'),
    retryDelayMs: z.natural().default(5000).description('First back-off delay, doubled per attempt'),
    maxActiveRuns: z.natural().min(1).default(16).description('Unfinished runs that execute at once; a run waiting only on an approval or a vote is not one'),
    maxWaitingRuns: z.natural().default(16).description('Runs waiting only on an approval or a vote, beyond maxActiveRuns; with that many, new runs are refused'),
    retainDays: z.natural().min(1).default(30).description('Days a finished run keeps its input text and prompts'),
    allowSameFamily: z.boolean().default(false).description('When no Worker of another provider family (or, for a team member, another account) is admitted, run on the same family instead of failing: a team member first on an account of its own, then sharing one, recorded as a same-family decision; its work is then not judged by another provider (ADR-0029, ADR-0035)'),
    teams: z.object({
      excludeWorkers: z.array(z.string().pattern(EXCLUDED_ENTRY)).max(MAX_EXCLUDED).default([]).description('Worker ids and accounts (as system roster lists them: an account as group/id, or its bare id when only one group has it) that no team member joins on, the first member included: a Worker id leaves out that Worker, an account every Worker naming it, each with every other Worker on its account. They still take every other node. A team they leave fewer provider families than members fails config_error before anything is sent, allowSameFamily or not; a member already in its team\'s conversation in that run keeps it, recorded; an entry that matches nothing is recorded as a workflow.team.unmatched-exclusions event'),
    }).description('Team membership (docs/design/teams.md#workers-left-out-of-teams)'),
    retainRunsDays: z.natural().default(30).description('Days a finished run is kept, then deleted with the artifacts only it needed and the website chats only it used (0: every run is kept); a session\'s latest run always stays'),
    maxLimitWaitHours: z.number().min(0).max(720).default(24).description('Hours a node refused only because the assigned accounts that could take it are at their limit may wait for the earliest reset, in all from its first wait, spending no attempt; past it, or with no known reset, it fails quota_exhausted (ADR-0052, INV-9); 0 never waits'),
    autoApprovePlans: z.boolean().default(false).description('Approve a high-confidence plan by policy instead of waiting for the operator'),
    maxReviewCycles: z.natural().min(1).max(5).default(3).description('Reviews of one change, the first included, before remediation stops'),
    fixSessionWaitMinutes: z.number().min(0).max(1440).default(60).description('Minutes a review\'s fix that continues its author\'s session waits for that session\'s Worker while it cannot take the fix now (out of quota, signed out, not listed), from the fix\'s first wait, spending no attempt; past it, the session is handed off to another Worker with its earlier turns, recorded (INV-9); 0 hands off at once'),
    tieTimeoutHours: z.number().min(0.0001).max(720).default(24).description('Hours a tied team waits for a deciding vote, then completes inconclusive (INV-9)'),
    gateTimeoutHours: z.number().min(0.0001).max(720).default(24).description('Hours a plan\'s gate waits for the operator\'s approval, then closes and fails the run, by rule (INV-9); continue the run to wait again'),
    approvalPollSeconds: z.natural().min(1).max(300).default(15).description('Seconds between the engine\'s reads of the approval queue: a remediation fix\'s request while its run waits on it, and the requests a Worker\'s deferred tool calls wait on (INV-9)'),
    deferredCommandMinutes: z.number().min(0).max(1440).default(10).description('Minutes a board task\'s step waits on the operator for a Worker\'s deferred tool call of class command (from its request\'s creation), then treats that call as denied, for it alone: the request is withdrawn, recorded as a recovery decision deny, and the session continues once, told the call was denied (INV-9); 0 waits until the request expires'),
    maxSessionRuns: z.natural().min(1).max(50).default(5).description('Runs one session may serve when a board task\'s next attempt, or the next task of a chain, resumes the session of the work before it (INV-9); past it, the run starts a fresh session given its brief'),
    tasksFile: z.object({
      maxTasks: z.natural().max(10_000).default(200).description('Tasks it lists at most, open ones first, the rest counted; 0 writes no file'),
      maxChars: z.natural().min(1024).max(1_048_576).default(65_536).description('Characters it holds at most; past it, it is cut at a line with a note'),
    }).description('The board\'s TASKS.md projection a board task\'s run is given in its own worktree (INV-9)'),
    digestsPerHour: z.natural().max(1000).default(6).description('Digests of board task results the engine asks ctx.digests for in any hour, one per attempt, after its result reached the board (INV-9); 0 asks for none. Past it, a result keeps no digest, recorded with why'),
    dispatch: z.object({
      enabled: z.boolean().default(true).description('System asks to start ready board tasks on free Workers chosen by quota (ADR-0064); false: nothing is asked or started'),
      sweepSeconds: z.natural().min(10).max(3600).default(60).description('Seconds between dispatch passes; one runs at start too, after the runs are reconciled'),
      maxPerPass: z.natural().min(1).max(16).default(2).description('Starts and new asks one pass makes at most, approved asks it starts included'),
      maxRunning: z.natural().min(1).max(10_000).description('Dispatched runs not finished, with the asks open or approved, at most (at most maxActiveRuns less leaveRunsFree; default 8, or that when less)'),
      maxRunningPerProject: z.natural().min(1).max(16).default(2).description('The same, per project'),
      maxRunningPerAccount: z.natural().min(1).max(16).default(1).description('The same, per account of the chosen Worker; and the most its account\'s load may be for it to be free'),
      maxRunningPerRepository: z.natural().min(1).max(16).default(4).description('The same, per repository (the chosen writing Worker\'s workspace): tasks without a write subject on one repository run in parallel up to this (D64)'),
      leaveRunsFree: z.natural().max(10_000).description('Active runs dispatch leaves for the lead\'s and your own starts (at most maxActiveRuns less 1; default 4, or that when less)'),
      maxOpenAsks: z.natural().min(1).max(32).default(4).description('Dispatch requests open at once, waiting for your go'),
      approvedHoldMinutes: z.natural().min(1).max(240).default(30).description('Minutes an approved start waits for its Worker to be free; past it the approval is used for nothing and dispatch chooses again'),
      maxPerHour: z.natural().max(120).default(6).description('Starts dispatch makes in any rolling hour, counted from its rows (PROP-0014 D2); 0 starts nothing'),
      maxPerHourPerProject: z.natural().max(120).description('The same, per project (at most maxPerHour; default 3, or maxPerHour when less)'),
      advisor: z.object({
        provider: z.union(['none', 'local', 'model']).default('none').description('Who advises each dispatch choice, in shadow (PROP-0015 J1): none (the default), no advisor; local, a logistic regression fitted on this host\'s own recorded outcomes (no data leaves the host); model, the model Worker named by model.worker (metered; off unless set). The advice is recorded as an input of the choice and never changes it'),
        timeoutMs: z.natural().min(100).max(120_000).default(2000).description('Milliseconds one advice may take; past it, it is recorded unavailable and the choice stands'),
        maxPerHour: z.natural().min(1).max(10_000).default(120).description('Advisor calls in any hour at most (INV-9); past it, unavailable'),
        minLabelled: z.natural().min(10).max(MAX_TRAINING).default(30).description('Labelled dispatched attempts the local adapter needs before it answers (at most the examples it keeps); until then, insufficient data'),
        l2: z.number().min(0.001).max(1000).default(1).description('The local adapter\'s L2 penalty'),
        // Not z.object: an omitted object would come back as {} and read as a model with no Worker.
        model: z.any().description('The model adapter {worker, maxTokens}: worker, the model Worker asked (model:<id> of the models row); maxTokens, its output bound (64 to 8192, default 1024). Features only (no task text) are sent, through the Worker\'s own egress check; checked when the row loads'),
      }).description('The dispatch advisor in shadow (PROP-0015 J1; docs/design/workflow-engine.md#the-dispatch-advisor-in-shadow)'),
    }).description('Dispatch: System starts ready board tasks on free Workers chosen by quota, under the action class dispatch (docs/design/workflow-engine.md#dispatch-starting-ready-work-by-itself)'),
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
    // What a stop or restart left in flight, read before the board's attach or the recovery schedules anything (ADR-0069).
    engine.noteInherited()
    ctx.effect(() => {
      queueMicrotask(() => {
        purge(engine)
        engine.recover()
        void sweepDeferrals(engine)
        void engine.tasks.landings.sweep()
        // A restart is a pass (INV-4): dispatch looks once its runs are reconciled.
        void engine.dispatch.sweep()
      })
      const daily = setInterval(() => purge(engine), 24 * 60 * 60_000)
      daily.unref()
      // Dispatch (ADR-0064): every dispatch.sweepSeconds; with dispatch.enabled false, no timer runs.
      const dispatching = engine.dispatch.settings.enabled ? setInterval(() => void engine.dispatch.sweep(), engine.dispatch.settings.sweepSeconds * 1000) : undefined
      dispatching?.unref()
      // The requests deferred tool calls wait on: an approved one continues its session, once. Then
      // the sessions whose mail waited because they took no input are looked at again, and the
      // landings of accepted results move on (ADR-0060).
      const deferrals = setInterval(() => void sweepDeferrals(engine).finally(() => {
        retryHeldWakes(engine)
        void engine.tasks.landings.sweep()
      }), pollMs(engine))
      deferrals.unref()
      return async () => {
        clearInterval(daily)
        clearInterval(deferrals)
        clearInterval(dispatching)
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
   * Hold steps (the operator's, while a live update waits to stop the host; T257): each running run
   * finishes the step it is in and starts no next one until {@link releaseSteps}, or the next start
   * of the host, which ends a hold left over. Returns the hold and the steps still in flight.
   * Holding a held engine changes nothing; dispatch's pause is a separate thing.
   */
  holdSteps(reason?: string): HoldView {
    return hold(this.engine, reason)
  }

  /** Release the hold between steps: every running run is scheduled again and goes on from its recorded state. */
  releaseSteps(): HoldView {
    return release(this.engine, 'operator')
  }

  /** The hold between steps, if one is set, and the steps in flight. A read only. */
  stepHold(): HoldView {
    return holdView(this.engine)
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
   * What a template runs, step by step, as a surface tells a person before a start: each step's
   * objective and the Worker it needs (its capabilities, least tier, kind of work; a team's kind and
   * members; a source step the engine runs itself; a planner). Undefined for a template not served.
   * A read only: it starts and decides nothing.
   */
  templateSteps(name: string): TemplateStep[] | undefined {
    const nodes = Object.hasOwn(this.engine.templates, name) ? this.engine.templates[name] : undefined
    return nodes?.map((n): TemplateStep => ({
      nodeId: n.nodeId, objective: n.objective, capabilities: [...n.capabilities], tier: n.tier, ...(n.kind ? { kind: n.kind } : {}),
      ...(n.team ? { team: { kind: n.team.kind, members: n.team.members ?? 2 } } : {}), ...(n.snapshot ? { source: true as const } : {}),
      ...(n.grows ? { plans: true as const } : {}),
    }))
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

  /**
   * The landing of a board task run's accepted result (ADR-0060): whether it is committed, asked to
   * merge (its request), merged (the commit), or refused and why; undefined when the run serves no
   * task or its result is on no working tree.
   */
  landing(runId: string): TaskLanding | undefined {
    const row = this.engine.tasks.row(runId)
    return row ? this.engine.tasks.landings.view(row) : undefined
  }

  /**
   * A page of a board task's dossier (ADR-0070), by the task or by a run that serves it: every entry
   * whole, as appended, oldest first from `from`, at most 50; `next` names the next page's `from`.
   */
  dossier(input: { taskId?: string | undefined; runId?: string | undefined; from?: number | undefined; limit?: number | undefined }): DossierPage {
    return this.engine.tasks.dossiers.read(input)
  }

  /**
   * Append a Worker's entry to its task's dossier for the step it runs (ADR-0070): the `dossier_append`
   * a Worker source gives its run, bound to `caller` (the workflow run, step, and execution from the
   * source's own record, never from the agent's input), whose Worker is the entry's author. Refused
   * unless `caller.execution` is the one the step runs now, the kind is one its role writes (never
   * `evidence`), and the text is 1 to 4000 characters. Not a tool of System's own MCP surface: there a
   * caller would name the step. The entry never changes once appended.
   */
  appendToDossier(caller: DossierCaller, input: DossierAppendInput): { id: string; seq: number } {
    return this.engine.tasks.dossiers.appendByWorker(caller, input)
  }

  /** `dossier_read` for a step's Worker, bound to `caller` as {@link appendToDossier} is: a page of its own task's dossier. */
  readDossier(caller: DossierCaller, page: { from?: number | undefined; limit?: number | undefined } = {}): DossierPage {
    return this.engine.tasks.dossiers.readByWorker(caller, page)
  }

  /**
   * Where dispatch stands (ADR-0064; contract 1.9): its settings, the operator's pause, the last pass
   * with its reason for each ready task it looked at, each bound and how much of it is used, and the
   * starts waiting for the operator's go or for their Worker. A read of the engine's rows only.
   */
  dispatchStatus(): DispatchStatus {
    return this.engine.dispatch.status()
  }

  /**
   * The operator pauses dispatch entirely (contract 1.9; INV-6: from the operator's channel only): a
   * `gate` decision (rule `dispatch.pause`) kept on a durable row across restarts. Nothing more is
   * asked or started by dispatch, and a pass, run at once, withdraws its open asks; the lead's and the
   * operator's own starts go on. Pausing a paused dispatch changes nothing. With `projectId` (contract
   * 1.10, PROP-0014 D2), only that project's: its tasks are neither asked about nor started by dispatch.
   */
  pauseDispatch(reason?: string, projectId?: string): DispatchStatus {
    const status = this.engine.dispatch.pause(reason, projectId)
    void this.engine.dispatch.sweep()
    return status
  }

  /** The operator resumes dispatch (contract 1.9), or with `projectId` one project's (1.10): a `gate` decision; the next pass runs at once. */
  resumeDispatch(projectId?: string): DispatchStatus {
    const status = this.engine.dispatch.resume(projectId)
    void this.engine.dispatch.sweep()
    return status
  }

  /**
   * One dispatch pass now (contract 1.9), at `at`: a test seam, as the board's `sweep(at)` is; the
   * engine's own timer passes the wall clock every `dispatch.sweepSeconds`. A pass already running is
   * returned, not doubled.
   */
  sweepDispatch(at?: Date): Promise<DispatchPass> {
    return this.engine.dispatch.sweep(at)
  }

  /**
   * A thin path to the dispatch advisor seam (PROP-0015 J1; the seam is `ctx.dispatchAdvisor`, defined
   * in `@tsuuanmi/system-decision-core`): `advisor` answers every dispatch choice in place of the
   * seam's provider and of the one `dispatch.advisor.provider` names, until set back with undefined.
   * Its advice is recorded in shadow, as an input of the choice, and never changes it; its failures
   * are recorded and ignored.
   */
  setDispatchAdvisor(advisor: Advisor | undefined): void {
    this.engine.dispatch.setAdvisor(advisor)
  }

  /**
   * The Workers the operator keeps out of teams (`teams.excludeWorkers`, D58), as a surface shows
   * them: the entries configured, and every Worker they leave out now, each with its account's
   * other Workers, as a team member's routing leaves them out (`leftOutOfTeams`). A read only: it
   * routes and decides nothing. With no entry, it lists no Worker.
   */
  async teamExclusion(): Promise<{ entries: string[]; workers: string[] }> {
    const entries = [...(this.engine.config.teams?.excludeWorkers ?? [])]
    if (!entries.length) return { entries, workers: [] }
    const workers = this.ctx.workers
    const listed = await workers.list()
    const ids = new Set(listed.map((w) => w.worker))
    // An entry is an id to compare, not a Worker: one that names no Worker listed now is not listed as one.
    return { entries, workers: [...leftOutOfTeams(entries, listed, (w) => workers.siblings(w)).out].filter((w) => ids.has(w) || !entries.includes(w)).sort() }
  }

  /** The durable node records of a run, in dependency order. */
  records(runId: string): NodeRecord[] {
    return this.engine.records(runId)
  }

  /** Wait until the run finishes or `timeoutMs` passes; returns the current view either way. */
  wait(runId: string, timeoutMs: number): Promise<RunView> {
    return this.engine.wait(runId, timeoutMs)
  }

  /**
   * Recent runs and, per node, which Worker, tier, and quota class served it (usage report): the latest
   * started first, at most `limit`. Contract 1.7: with `filter`, by state, whenever they started, and by
   * when their state changed, the latest changed first (./views.ts).
   */
  usage(limit = 50, filter: UsageFilter = {}): RunView[] {
    return usage(this.engine, limit, filter)
  }

  /**
   * What agent runs drew from their accounts' windows, per kind and window and per template step
   * (`quota.draw`, PROP-0015 E2; ./views.ts): the usage report's draws. Undefined when none is recorded.
   */
  draws(): UsageDraws | undefined {
    return draws(this.engine)
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
   * one per (session, last message), so a repeated delivery starts nothing new. This is the
   * caller's own, direct wake; every automated one (a delivery, a settled turn, a restart) first
   * asks whether the session takes input now (`ctx.workers.held`, PROP-0013).
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
