/**
 * The software-development profile (docs/architecture/plugin-model.md, REQ-WF-9): templates for
 * local agent Workers, contributed to the workflow engine through `ctx.workflow.template`, with no
 * engine code of its own. `agent-review` is a review on this machine; `algorithm-development` is
 * one attempt of a board task that tests one hypothesis (PROP-0010 B8). Its row is off in the
 * default composition (PROP-0004), though the agent Worker rows it needs are on.
 * @module @tsuuanmi/system-profile-software-development
 */
import type { Context } from '@deepseek-ai/cordis'
import type { NodeTemplate } from '@tsuuanmi/system-workflow'

export const name = 'profile-software-development'
export const inject = ['workflow']

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
 * the diff and the criteria, never the maker's context). The engine appends the exact subject and
 * the assessment it asks for; a remediation cycle's re-review reads this text as it is, so it uses
 * no placeholder.
 */
const REVIEW_PROMPT = [
  'Review this change as an independent reviewer: you see the task, its acceptance criteria, and the exact change, never its developer\'s conversation.',
  'Judge whether the change does what the task asks, correctly, and nothing beyond it. A defect, a change the task does not need, or a test or benchmark weakened, skipped, or made unreliable is a blocking finding.',
].join('\n')

const VALIDATE_PROMPT = [
  'Validate the change in this worktree. Run each test, benchmark, and check that the task\'s acceptance criteria name, exactly as they write it, from the worktree\'s top level.',
  'Change no file: you measure the change, you do not fix it.',
  '',
  'The request: {{input}}',
  '',
  'Report, for each command: the command, its exit code, and the lines of its output that hold the result (tests passed and failed, measurements), verbatim.',
  'Then list each acceptance criterion as met, not met, or not measured, with the command that shows it. A command that could not run is reported as not run, with why; nothing is estimated.',
].join('\n')

/**
 * One attempt of an algorithm-development board task (PROP-0010 B8; PROP-0008's loop: hypothesis,
 * change, review, measurement). The project's charter and milestones are the board's; a task's
 * run is this graph:
 *
 * - `develop:1` states one hypothesis and changes the code in the run's own worktree, in the run's
 *   session, which the task's next attempt resumes;
 * - `review:1` reviews that exact change on a read-only Worker; blocking findings grow a fix and a
 *   re-review, the fix waiting on the approval queue (engine remediation);
 * - `validate:1` runs the task's tests and benchmarks on the reviewed change, confined to the
 *   worktree, on a Worker that proves `validate` (its commands proven confined). It comes last, so
 *   its report measures the exact subject the task leaves, after any fix, and is the run's result:
 *   what the task keeps, its digest summarizes, and the next attempt reads.
 *
 * Its measurements are evidence, not a check the engine reports: under a policy that requires tests,
 * the board holds the result for the operator.
 */
export const ALGORITHM_DEVELOPMENT: NodeTemplate[] = [
  {
    nodeId: 'develop:1', objective: 'Test one hypothesis toward the task: state it, and change the code to try it', prompt: DEVELOP_PROMPT,
    capabilities: ['develop', 'local-data'], tier: 'standard', conversation: 'persistent', acceptance: 'acceptance.answer',
  },
  {
    nodeId: 'review:1', objective: 'Review the exact change against the task, independently of its developer', dependsOn: ['develop:1'], prompt: REVIEW_PROMPT,
    capabilities: ['review', 'local-data'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer',
  },
  {
    nodeId: 'validate:1', objective: 'Run the task\'s tests and benchmarks on the reviewed change, and report what they measured', dependsOn: ['review:1'], prompt: VALIDATE_PROMPT,
    capabilities: ['validate', 'local-data'], tier: 'economy', conversation: 'temporary', acceptance: 'acceptance.answer',
  },
]

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.workflow.template('agent-review', AGENT_REVIEW))
  ctx.effect(() => ctx.workflow.template('algorithm-development', ALGORITHM_DEVELOPMENT))
}
