/**
 * The software-development profile (docs/architecture/plugin-model.md, REQ-WF-9): templates for
 * local agent Workers, contributed to the workflow engine through `ctx.workflow.template`, with no
 * engine code of its own. `agent-review` is a review on this machine; `algorithm-development` is
 * one attempt of a board task that tests one hypothesis (PROP-0010 B8). Its row is off in the
 * default composition (PROP-0004), though the agent Worker rows it needs are on.
 * @module @tsuuanmi/system-profile-software-development
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { NodeTemplate } from '@tsuuanmi/system-workflow'
import { WORK_KIND } from '@tsuuanmi/system-workers-core'

export const name = 'profile-software-development'
export const inject = ['workflow']

/**
 * The kind of work (ADR-0057) each step of `algorithm-development` names, by step: `develop` is
 * `develop:1` (and the fix a review grows from it), `docs` and `tests` are `develop:1` in the variant
 * of that name, and `validate` is `validate:1`, which runs the checks and tests and changes nothing.
 * The review names none, and no configuration gives it one.
 */
export interface StepKinds {
  develop: string
  docs: string
  tests: string
  validate: string
}

/** The kinds the profile ships: three writing kinds, and `validation` for the step that only runs checks. */
export const DEFAULT_KINDS: Readonly<StepKinds> = { develop: 'code', docs: 'docs', tests: 'tests', validate: 'validation' }

const STEPS = Object.keys(DEFAULT_KINDS) as Array<keyof StepKinds>

export interface Config {
  /** The kind each step names, by step; an unset step names its shipped kind ({@link DEFAULT_KINDS}). */
  kinds?: Partial<StepKinds>
}

export const Config: z<Config> = z.object({
  kinds: z.object({
    develop: z.string().pattern(WORK_KIND).default(DEFAULT_KINDS.develop).description('The kind of work develop:1 is, and the fix a review grows from it (default code)'),
    docs: z.string().pattern(WORK_KIND).default(DEFAULT_KINDS.docs).description('The kind of work develop:1 is in the docs variant (default docs)'),
    tests: z.string().pattern(WORK_KIND).default(DEFAULT_KINDS.tests).description('The kind of work develop:1 is in the tests variant (default tests)'),
    validate: z.string().pattern(WORK_KIND).default(DEFAULT_KINDS.validate).description('The kind of work validate:1 is: it runs the checks and tests and changes nothing (default validation). A Worker given kinds takes it only when it lists this one, so a writer given tests does not run it'),
  }).description('The kind of work (ADR-0057) each algorithm-development step names, by step, so which Worker takes which step is the Workers\' kinds: a Worker given kinds takes a step only when it lists that step\'s kind. The review names none'),
}) as unknown as z<Config>

/**
 * What this code would refuse in the row's configuration (`system check`, and at load, INV-2): a
 * `kinds` key that is not a step, and a kind that is not a kind of work (empty, or not matching
 * `WORK_KIND`). Empty when the configuration is fine.
 */
export function checkConfig(config: Partial<Config> = {}): string[] {
  const kinds: unknown = config.kinds
  if (kinds === undefined) return []
  if (typeof kinds !== 'object' || kinds === null || Array.isArray(kinds)) return [`kinds must be an object of steps (${STEPS.join(', ')}), each naming a kind of work`]
  return Object.entries(kinds).flatMap(([step, kind]) => !STEPS.includes(step as keyof StepKinds) ? [`kinds.${step} is not a step; kinds takes ${STEPS.join(', ')}`]
    : typeof kind !== 'string' || !WORK_KIND.test(kind) ? [`kinds.${step}: ${JSON.stringify(kind)} is not a kind of work (${WORK_KIND})`] : [])
}

/** A review on this machine by a local agent Worker, which alone proves `review` and `local-data`. */
export const AGENT_REVIEW: NodeTemplate[] = [
  {
    nodeId: 'review:1', objective: 'Review the caller\'s subject on this machine and report findings', prompt: '{{input}}',
    capabilities: ['review', 'local-data'], tier: 'standard', callerTier: true, conversation: 'caller', acceptance: 'acceptance.answer',
  },
]

const DEVELOP_PROMPT = [
  '{{input}}',
  '',
  'Work toward the task above in this run\'s own git worktree, one hypothesis per attempt:',
  '1. State the hypothesis this attempt tests, and why you expect it to help. On a later attempt, start from what the previous attempt measured and why it was not accepted.',
  '2. Change the code to test it, and only what it needs. Never weaken, skip, or loosen a test or a benchmark to make it pass.',
  '3. Commands run confined to this worktree, with no network.',
  'End with the hypothesis, the files you changed, and which acceptance criteria the change should now meet.',
].join('\n')

/**
 * The reviewer reads the task, its criteria, and the exact change only (PROP-0008: a reviewer gets
 * the diff and the criteria, never the maker's context), so this text points at no step's result.
 * The engine appends the exact subject, the request, and the assessment it asks for; a remediation
 * cycle's re-review is given this text composed as the review's is.
 *
 * The reviewer reads and judges; it never runs the project's tests or builds. `validate:1` runs them,
 * and the run's required checks at acceptance (ADR-0063). A reviewer runs read-only, so a command it
 * could not run is an environment limit, not a finding about the change: at most `info`, never a
 * blocking finding that would grow a remediation cycle no fix can satisfy.
 */
const REVIEW_PROMPT = [
  'Review this change as an independent reviewer: you see the task, its acceptance criteria, and the exact change, never its developer\'s conversation.',
  'Judge whether the change does what the task asks, correctly, and nothing beyond it. A defect, a change the task does not need, or a test or benchmark weakened, skipped, or made unreliable is a blocking finding.',
  'You read and judge the change; you never run the project\'s tests or builds: the validation step after you runs them, and so do the run\'s required checks. A command you could not run is not a finding about the change; an environment limit is at most an info finding.',
].join('\n')

/** The `docs` variant's develop step: the attempt changes the documentation the task names, never the code it documents. */
const DOCS_PROMPT = [
  '{{input}}',
  '',
  'Work toward the task above in this run\'s own git worktree, by changing documentation only:',
  '1. State what the documentation should say once this attempt is done, and why. On a later attempt, start from what the previous attempt measured and why it was not accepted.',
  '2. Change the documents the task needs, and only those: no source code and no test. Every statement you write must be true of the code as it is in this worktree.',
  '3. Commands run confined to this worktree, with no network.',
  'End with what the documentation now says, the files you changed, and which acceptance criteria the change should now meet.',
].join('\n')

/** The `tests` variant's develop step: the attempt adds or changes tests, never the code under test. */
const TESTS_PROMPT = [
  '{{input}}',
  '',
  'Work toward the task above in this run\'s own git worktree, by changing tests only:',
  '1. State what the tests should check once this attempt is done, and why. On a later attempt, start from what the previous attempt measured and why it was not accepted.',
  '2. Add or change the tests the task needs, and only those: no code under test. Never weaken, skip, or loosen a test or a benchmark, and never make one pass by what it no longer checks.',
  '3. Commands run confined to this worktree, with no network.',
  'End with what the tests now check, the files you changed, and which acceptance criteria the change should now meet.',
].join('\n')

/**
 * The validator reads the board task's goal and acceptance criteria, each with what checks it, from
 * its brief, and measures the change in the run's worktree: nothing else. It is given no caller's
 * input and no step's answer, so another step's orders never become its own (T99 D4), and nothing
 * it measures leans on what the developer said it did.
 */
const VALIDATE_PROMPT = [
  'Validate the change in this worktree against the board task above. Run each test, benchmark, and check that its acceptance criteria name, exactly as they write it, from the worktree\'s top level; a criterion\'s check says what kind of check it is.',
  'Change no file: you measure the change, you do not fix it. With no acceptance criteria above, run nothing, and report that none was named to measure.',
  '',
  'Report, for each command: the command, its exit code, and the lines of its output that hold the result (tests passed and failed, measurements), verbatim.',
  'Then list each acceptance criterion as met, not met, or not measured, with the command that shows it. A command that could not run, or was denied, is reported as not run, with why, rather than asked about; nothing is estimated.',
].join('\n')

/**
 * One attempt of an algorithm-development board task (PROP-0010 B8; PROP-0008's loop: hypothesis,
 * change, review, measurement). The project's charter and milestones are the board's; a task's
 * run is this graph:
 *
 * - `develop:1` states one hypothesis and changes the code in the run's own worktree, in the run's
 *   session, which the task's next attempt resumes;
 * - `review:1` reviews that exact change on a read-only Worker, reading and judging it and running
 *   no test or build; blocking findings grow a fix and a re-review, the fix waiting on the approval
 *   queue (engine remediation). The fix continues `develop:1`'s session on its Worker, the findings
 *   its next message (one task, one author session); the re-review stays in a session of its own;
 *   each fix is its own commit of the run's review history, the worktree's HEAD left where the task
 *   binds its result (docs/design/workflow-engine.md#review-cycles);
 * - `validate:1` runs the task's tests and benchmarks on the reviewed change, confined to the
 *   worktree, on a Worker that proves `validate` (its commands proven confined). It reads the task's
 *   criteria and their checks from its brief, never the caller's input (the develop step's orders)
 *   nor any step's answer. It comes last, so its report measures the exact subject the task leaves,
 *   after any fix, and is the run's result: what the task keeps, its digest summarizes, and the next
 *   attempt reads.
 *
 * Which inputs reach which step is in docs/reference/workflow-templates.md#algorithm-development.
 *
 * Its measurements are evidence, not a check the engine reports: under a policy that requires tests,
 * the board holds the result for the operator.
 *
 * Each step but the review names its kind of work (ADR-0057), as the row's `kinds` configure it
 * ({@link DEFAULT_KINDS}): `develop:1` is `code` work, or `docs` or `tests` work in the variant of
 * that name, and `validate:1` is `validation` work, so a writer is never given the validation by
 * taking test writing. A Worker the operator gives kinds takes only steps of those kinds; one given
 * none takes them all, as before. The review names no kind, so any reviewer the operator gives none
 * takes it.
 */
export function algorithmDevelopment(configured: Partial<StepKinds> = {}): NodeTemplate[] {
  const kinds: StepKinds = { ...DEFAULT_KINDS, ...Object.fromEntries(Object.entries(configured).filter(([, kind]) => kind !== undefined)) }
  return [
    {
      nodeId: 'develop:1', objective: 'Test one hypothesis toward the task: state it, and change the code to try it', prompt: DEVELOP_PROMPT,
      capabilities: ['develop', 'local-data'], tier: 'standard', kind: kinds.develop, conversation: 'persistent', acceptance: 'acceptance.answer',
      variants: {
        docs: { kind: kinds.docs, objective: 'Change the documentation toward the task: state what it should say, and write it', prompt: DOCS_PROMPT },
        tests: { kind: kinds.tests, objective: 'Change the tests toward the task: state what they should check, and write them', prompt: TESTS_PROMPT },
      },
    },
    {
      nodeId: 'review:1', objective: 'Review the exact change against the task, independently of its developer', dependsOn: ['develop:1'], prompt: REVIEW_PROMPT,
      capabilities: ['review', 'local-data'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer',
    },
    {
      nodeId: 'validate:1', objective: 'Run the task\'s tests and benchmarks on the reviewed change, and report what they measured', dependsOn: ['review:1'], prompt: VALIDATE_PROMPT,
      capabilities: ['validate', 'local-data'], tier: 'economy', kind: kinds.validate, conversation: 'temporary', acceptance: 'acceptance.answer',
    },
  ]
}

/** `algorithm-development` with the shipped kinds. */
export const ALGORITHM_DEVELOPMENT: NodeTemplate[] = algorithmDevelopment()

export function apply(ctx: Context, config: Config = {}): void {
  const problems = checkConfig(config)
  if (problems.length) throw new Error(`profile-software-development: ${problems.join('; ')}`)
  ctx.effect(() => ctx.workflow.template('agent-review', AGENT_REVIEW))
  ctx.effect(() => ctx.workflow.template('algorithm-development', algorithmDevelopment(config.kinds)))
}
