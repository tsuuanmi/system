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
 * of that name. The reviews name none, and no configuration gives them one; the author's self-review
 * (`selfreview:1`) runs on the author's account, in its read-only role. The template had a `validate`
 * step until T267 folded it into the author's own checks and self-review.
 */
export interface StepKinds {
  develop: string
  docs: string
  tests: string
}

/** The kinds the profile ships: three writing kinds. */
export const DEFAULT_KINDS: Readonly<StepKinds> = { develop: 'code', docs: 'docs', tests: 'tests' }

const STEPS = Object.keys(DEFAULT_KINDS) as Array<keyof StepKinds>

/** A step the template no longer has: a configuration that still names it is accepted and ignored (T267), so an update never stops a row from loading. */
const RETIRED = ['validate'] as const

export interface Config {
  /** The kind each step names, by step; an unset step names its shipped kind ({@link DEFAULT_KINDS}). */
  kinds?: Partial<StepKinds> & { validate?: string }
}

export const Config: z<Config> = z.object({
  kinds: z.object({
    develop: z.string().pattern(WORK_KIND).default(DEFAULT_KINDS.develop).description('The kind of work develop:1 is, and the fix a review grows from it (default code)'),
    docs: z.string().pattern(WORK_KIND).default(DEFAULT_KINDS.docs).description('The kind of work develop:1 is in the docs variant (default docs)'),
    tests: z.string().pattern(WORK_KIND).default(DEFAULT_KINDS.tests).description('The kind of work develop:1 is in the tests variant (default tests)'),
    validate: z.string().pattern(WORK_KIND).description('Retired (T267): the template has no validate step any more, so this is ignored; remove it'),
  }).description('The kind of work (ADR-0057) each algorithm-development step names, by step, so which Worker takes which step is the Workers\' kinds: a Worker given kinds takes a step only when it lists that step\'s kind. The reviews name none'),
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
  return Object.entries(kinds).flatMap(([step, kind]) => !STEPS.includes(step as keyof StepKinds) && !(RETIRED as readonly string[]).includes(step) ? [`kinds.${step} is not a step; kinds takes ${STEPS.join(', ')}`]
    : typeof kind !== 'string' || !WORK_KIND.test(kind) ? [`kinds.${step}: ${JSON.stringify(kind)} is not a kind of work (${WORK_KIND})`] : [])
}

/** A review on this machine by a local agent Worker, which alone proves `review` and `local-data`. */
export const AGENT_REVIEW: NodeTemplate[] = [
  {
    nodeId: 'review:1', objective: 'Review the caller\'s subject on this machine and report findings', prompt: '{{input}}',
    capabilities: ['review', 'local-data'], tier: 'standard', callerTier: true, conversation: 'caller', acceptance: 'acceptance.answer',
  },
]

/**
 * What every writing step ends with (T267): the author verifies before anyone reviews. It runs the
 * checks the task requires and pastes their real output into the task's dossier as an `evidence`
 * entry, which the engine requires at the step's end. A fresh session of the author then reviews the
 * diff (`selfreview:1`) and the author answers its findings; only then does the independent review start.
 */
const VERIFY = 'Before you end, verify your change: run the checks the task requires (its acceptance criteria name them), then append their real output, verbatim, to the task\'s dossier as an evidence entry (dossier_append, kind evidence: each command, its exit code, and the lines that hold the result). The step is refused at its end without that entry, or with one that shows no command, exit code, or output. Never write output you did not get from running the command.'

const DEVELOP_PROMPT = [
  '{{input}}',
  '',
  'Work toward the task above in this run\'s own git worktree, one hypothesis per attempt:',
  '1. State the hypothesis this attempt tests, and why you expect it to help. On a later attempt, start from what the previous attempt measured and why it was not accepted.',
  '2. Change the code to test it, and only what it needs. Never weaken, skip, or loosen a test or a benchmark to make it pass.',
  '3. Commands run confined to this worktree, with no network.',
  `4. ${VERIFY}`,
  'End with the hypothesis, the files you changed, and which acceptance criteria the change should now meet.',
].join('\n')

/**
 * The reviewer reads the task, its criteria, and the exact change only (PROP-0008: a reviewer gets
 * the diff and the criteria, never the maker's context), so this text points at no step's result.
 * The engine appends the exact subject, the request, and the assessment it asks for; a remediation
 * cycle's re-review is given this text composed as the review's is.
 *
 * The reviewer reads and judges; it never runs the project's tests or builds. The author ran the
 * required checks and showed their output in the dossier before the review, and the run's required
 * checks run again at acceptance (ADR-0063). A reviewer runs read-only, so a command it could not run
 * is an environment limit, not a finding about the change: at most a `nit`, never an important finding
 * that would grow a remediation cycle no fix can satisfy. The review guides of the areas the change
 * touches (docs/design/handbook.md#review-guides-reviewmd) are in its brief, and it follows them.
 *
 * Severity (ADR-0075): a defect of this change is `important`, with its file, line, and evidence; style
 * and wording are `nit`s; a defect the change did not introduce is `pre-existing`. The engine has a
 * second reviewer verify each important finding, and only a confirmed one grows a fix.
 */
const REVIEW_PROMPT = [
  'Review this change as an independent reviewer: you see the task, its acceptance criteria, and the exact change, never its developer\'s conversation.',
  'Judge whether the change does what the task asks, correctly, and nothing beyond it. A defect, a change the task does not need, or a test or benchmark weakened, skipped, or made unreliable is an important finding, with its file, line, and evidence of what fails; style, naming, and wording are nits; a defect the change did not introduce is pre-existing.',
  'You read and judge the change; you never run the project\'s tests or builds: its author ran the required checks and showed their output in the task\'s dossier, and the run\'s required checks run again at acceptance. A command you could not run is not a finding about the change; an environment limit is at most a nit.',
  'Where review guides are given for the areas this change touches, follow them: what failure looks like there, what to check first, what to skip, the cap on nits, the evidence a finding needs (a file and line), and how your summary opens (with a count).',
].join('\n')

/**
 * The author's own review (T267): a new session on the author's account, which never saw the
 * author's conversation. It is given the task's goal and criteria, the exact diff, and the review
 * guides only: the engine gives it no dossier, no earlier results, and none of the author's orders
 * (`selfReview`, workflow `briefs.ts` and `dossiers.ts`). Its important findings are verified as any
 * review's are (ADR-0075), and the author answers the confirmed ones before the independent review
 * starts. It is never an independent review: it counts for no tier, family, or acceptance.
 */
const SELFREVIEW_PROMPT = [
  'You wrote this change in an earlier session you cannot see. Review it now as a stranger would, from the task, its acceptance criteria, and the exact change only.',
  'Look for what its author is blind to: a defect, a change the task does not need, a test or benchmark weakened, skipped, or made unreliable, a document that no longer matches the code, a file that should not be in the change. Each is an important finding, with its file, line, and evidence of what fails; style, naming, and wording are nits; a defect the change did not introduce is pre-existing.',
  'You read and judge the change; you never run the project\'s tests or builds: the author ran them before you, and the run\'s required checks run again at acceptance. A command you could not run is not a finding about the change; an environment limit is at most a nit.',
  'Where review guides are given for the areas this change touches, follow them.',
].join('\n')

/** The `docs` variant's develop step: the attempt changes the documentation the task names, never the code it documents. */
const DOCS_PROMPT = [
  '{{input}}',
  '',
  'Work toward the task above in this run\'s own git worktree, by changing documentation only:',
  '1. State what the documentation should say once this attempt is done, and why. On a later attempt, start from what the previous attempt measured and why it was not accepted.',
  '2. Change the documents the task needs, and only those: no source code and no test. Every statement you write must be true of the code as it is in this worktree.',
  '3. Commands run confined to this worktree, with no network.',
  `4. ${VERIFY}`,
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
  `4. ${VERIFY}`,
  'End with what the tests now check, the files you changed, and which acceptance criteria the change should now meet.',
].join('\n')

/**
 * One attempt of an algorithm-development board task (PROP-0010 B8; PROP-0008's loop: hypothesis,
 * change, review). The project's charter and milestones are the board's; a task's run is this graph
 * (template version 2, T267):
 *
 * - `develop:1` states one hypothesis and changes the code in the run's own worktree, in the run's
 *   session, which the task's next attempt resumes. It ends with the output of the checks the author
 *   ran, appended to the task's dossier as an `evidence` entry (`showsEvidence`): without one, the step is
 *   refused at its end;
 * - `selfreview:1` is the author's own review (T267): a new session on `develop:1`'s account (its
 *   read-only role) that never saw its conversation, given only the task, the exact diff, and the
 *   review guides. Its important findings are verified as a review's are, and the confirmed ones grow
 *   a fix that continues `develop:1`'s session, answered before `review:1` starts, with no approval
 *   gate (the author answering itself); it is never an independent review;
 * - `review:1` reviews that exact change on a read-only Worker, reading and judging it and running
 *   no test or build; its important findings are verified by a second reviewer (`review:1:verify`,
 *   another family where one is free), and only confirmed ones grow a fix and a re-review, the fix
 *   waiting on the approval queue (engine remediation, ADR-0075); a re-review reads only the change
 *   since the last reviewed tree and the open findings. The fix continues `develop:1`'s session on its Worker, the findings
 *   its next message (one task, one author session); the re-review stays in a session of its own;
 *   each fix is its own commit of the run's review history, the worktree's HEAD left where the task
 *   binds its result (docs/design/workflow-engine.md#review-cycles). It is the final step, so the
 *   run's result is its review: what the task keeps, its digest summarizes, and the next attempt
 *   reads. The template had a `validate:1` step until T267; the author's checks and self-review
 *   replace it, and the run's required checks run again on the exact result at acceptance (ADR-0063).
 *
 * Process tiered by risk (ADR-0071), when the task's project policy has a path map: a heavy change
 * gets a second review by a Worker of another provider family after `review:1` approves it (the
 * engine grows it).
 *
 * Which inputs reach which step is in docs/reference/workflow-templates.md#algorithm-development.
 *
 * The author's pasted checks are the author's report, not a check the engine reports: under a
 * policy that requires tests, the board holds the result for the operator.
 *
 * `develop:1` names its kind of work (ADR-0057), as the row's `kinds` configure it
 * ({@link DEFAULT_KINDS}): `code` work, or `docs` or `tests` work in the variant of that name. A
 * Worker the operator gives kinds takes only steps of those kinds; one given none takes them all, as
 * before. The two reviews name no kind, so any reviewer the operator gives none takes them; the
 * self-review runs on the author's account (its read-only role: a writer never proves `review`).
 */
export function algorithmDevelopment(configured: Partial<StepKinds> = {}): NodeTemplate[] {
  const kinds: StepKinds = { ...DEFAULT_KINDS, ...Object.fromEntries(Object.entries(configured).filter(([key, kind]) => kind !== undefined && key in DEFAULT_KINDS)) }
  return [
    {
      nodeId: 'develop:1', objective: 'Test one hypothesis toward the task: state it, and change the code to try it', prompt: DEVELOP_PROMPT,
      capabilities: ['develop', 'local-data'], tier: 'standard', kind: kinds.develop, conversation: 'persistent', acceptance: 'acceptance.answer', showsEvidence: true,
      variants: {
        docs: { kind: kinds.docs, objective: 'Change the documentation toward the task: state what it should say, and write it', prompt: DOCS_PROMPT },
        tests: { kind: kinds.tests, objective: 'Change the tests toward the task: state what they should check, and write them', prompt: TESTS_PROMPT },
      },
    },
    {
      nodeId: 'selfreview:1', objective: 'Review your own change in a new session, as a stranger would: the task, the exact diff, and the review guides only', dependsOn: ['develop:1'], prompt: SELFREVIEW_PROMPT,
      capabilities: ['review', 'local-data'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', selfReview: 'develop:1',
    },
    {
      // The self-review first, so the change's workspace is read from `develop:1`'s result (the last of its dependencies).
      nodeId: 'review:1', objective: 'Review the exact change against the task, independently of its developer', dependsOn: ['selfreview:1', 'develop:1'], prompt: REVIEW_PROMPT,
      capabilities: ['review', 'local-data'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer',
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
