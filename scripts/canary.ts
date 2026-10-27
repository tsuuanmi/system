// The canary of a live update's stage (T323, docs/operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release):
// what scripts/live-stage.sh runs on the `system-test` profile, with the target's built CLI, before
// the live profile is touched.
//
//   canary.ts patch <packages/cli/lib/index.js> <dsh home> <live patch> <out>
//       the test profile's patch: the live patch's rows the test profile keeps, then its own;
//   canary.ts run <packages/cli/lib/index.js> <dsh home>
//       the canary on the running test profile: health; a board task, on a canary project of its own,
//       through algorithm-development (its attempt, its dossier's evidence gate, its result on the
//       board); an ask; and a research run; on the fake Workers. Exit 0 when every step completes, 1 at
//       the first that does not (named, with why).
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

interface Outcome { isError: boolean; text: string; structured?: Record<string, unknown> }
export type CallTool = (name: string, args: Record<string, unknown>, home?: string) => Promise<Outcome>
interface Cli { callTool: CallTool; useProfile: (name: string) => void; stagedTestPatch: (state: string, liveText: string) => string; TEST_PROFILE: string }

/** The free runs after the board task: what each asks of the test profile, and the tool that starts it. */
export const RUNS: ReadonlyArray<{ step: string; tool: string; args: Record<string, unknown> }> = [
  { step: 'ask', tool: 'ask', args: { prompt: 'Canary: answer with one word.', waitSeconds: 55 } },
  { step: 'research', tool: 'research', args: { question: 'Canary: what is two plus two?', waitSeconds: 55 } },
]

/** The board task's goal: what its algorithm-development attempt is asked. */
export const GOAL = 'Canary: carry one attempt of this task through algorithm-development on the fake Workers, its dossier included.'

/** Each wait's bound (INV-9): a run to its end, and a project or task to the state it is waiting for. */
export const BOUNDS = { runMs: 5 * 60_000, stateMs: 60_000, pollMs: 1000 }

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** A refusal from a step: thrown inside it, returned by {@link canary} as its problem. */
class StepFailed extends Error {}

/** A tool's structured answer, or the step's failure with what the tool said. */
async function answer(call: CallTool, step: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await call(tool, args)
  if (outcome.isError) throw new StepFailed(`${step}: ${tool}: ${outcome.text.slice(0, 300)}`)
  return outcome.structured ?? {}
}

/** Follow a run to its end: `completed` within the bound; anything else is the step's failure. */
async function waitRun(call: CallTool, step: string, first: Record<string, unknown>): Promise<string> {
  const until = Date.now() + BOUNDS.runMs
  let run = first as { runId?: string; status?: string; error?: { kind?: string; message?: string } }
  for (;;) {
    if (run.status === 'completed' && run.runId) return run.runId
    if (run.status === 'failed') throw new StepFailed(`${step}: run ${run.runId} failed: ${run.error?.kind}: ${run.error?.message}`)
    if (!run.runId) throw new StepFailed(`${step}: no run came back`)
    if (Date.now() > until) throw new StepFailed(`${step}: run ${run.runId} did not finish within ${Math.round(BOUNDS.runMs / 1000)} s`)
    await sleep(BOUNDS.pollMs)
    run = await answer(call, step, 'result', { runId: run.runId, waitSeconds: 20 }) as typeof run
  }
}

/** Read with `read` until `done` says so, within the state bound; the last answer. */
async function until<T>(step: string, what: string, read: () => Promise<T>, done: (value: T) => boolean, said: (value: T) => string): Promise<T> {
  const end = Date.now() + BOUNDS.stateMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > end) throw new StepFailed(`${step}: ${what} within ${Math.round(BOUNDS.stateMs / 1000)} s (it is ${said(value)})`)
    await sleep(BOUNDS.pollMs)
  }
}

/** Approve an open approval request as the operator, on the exact subject it names (INV-5). */
async function approve(call: CallTool, step: string, requestId: string): Promise<void> {
  const { request } = await answer(call, step, 'approvals_get', { requestId }) as { request?: { subject?: unknown } }
  if (!request?.subject) throw new StepFailed(`${step}: approval request ${requestId} names no subject`)
  await answer(call, step, 'approvals_decide', { verdicts: [{ requestId, subject: request.subject, verdict: 'approved', note: 'the stage canary (T323)' }] })
}

/**
 * The board task through algorithm-development: a canary project of its own (its charter approved
 * by the operator, which the CLI acts as), one task on it, and one attempt of that task, as a lead
 * starts it: a run of the template for the task, which claims it, keeps its lease, passes its steps'
 * gates (the dossier's evidence at the end of develop), and submits its result to the board. It
 * passes when the run completes and the task holds its result (in review, or done).
 */
export async function boardTask(call: CallTool, stamp: string): Promise<void> {
  const step = 'board task'
  const projectId = `canary-${stamp}`
  const chartered = await answer(call, step, 'board_charter', {
    projectId, title: `Stage canary ${stamp}`, clientRequestId: `${projectId}-charter`,
    charter: {
      version: 1, intent: 'The stage canary: one board task through algorithm-development on the fake Workers, before a live update (T323).',
      criteria: [{ id: 'canary', statement: 'The canary task\'s attempt ends with its result on the board', measure: { kind: 'accepted-results', target: 1, comparison: 'at-least' } }],
      constraints: {}, stopRules: [{ id: 'canary-once', condition: 'The canary task ends', action: 'stop' }], budget: { pools: [{ pool: 'canary', unit: 'runs', amount: 10 }] },
    },
  }) as { approvalRequest?: string; state?: string }
  if (chartered.approvalRequest) await approve(call, step, chartered.approvalRequest)
  await until(step, `project ${projectId} did not become active`, () => answer(call, step, 'board_brief', { projectId }) as Promise<{ state?: string }>,
    (p) => p.state === 'active', (p) => String(p.state))
  const proposed = await answer(call, step, 'board_propose', {
    projectId, title: 'Canary attempt', goal: GOAL, template: 'algorithm-development', actionClass: 'read', maxAttempts: 1, clientRequestId: `${projectId}-task`,
    acceptance: [{ id: 'carried', statement: 'The attempt ends with its result on the board' }],
  }) as { taskId?: string }
  const taskId = proposed.taskId
  if (!taskId) throw new StepFailed(`${step}: board_propose gave no task`)
  await until(step, `task ${taskId} did not become ready`, () => answer(call, step, 'board_task', { taskId }) as Promise<{ task?: { state?: string; approvalRequest?: string } }>,
    (t) => t.task?.state === 'ready', (t) => String(t.task?.state))
  const runId = await waitRun(call, step, await answer(call, step, 'run', { template: 'algorithm-development', input: GOAL, task: { taskId }, waitSeconds: 55 }))
  const { task } = await answer(call, step, 'board_task', { taskId }) as { task?: { state?: string; run?: { runId?: string } } }
  if (task?.state !== 'review' && task?.state !== 'done') throw new StepFailed(`${step}: run ${runId} completed, but task ${taskId} is ${String(task?.state)}, not in review or done with its result`)
}

/** The canary: health first, then the board task, then each free run; the first problem, or undefined. */
export async function canary(call: CallTool, stamp: string = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)): Promise<string | undefined> {
  const health = await call('status', { checks: true })
  const state = (health.structured?.health as { state?: string } | undefined)?.state
  if (health.isError || state === undefined || state === 'down') return `health: ${state ?? 'no health report'}: ${health.text.slice(0, 300)}`
  try {
    await boardTask(call, stamp)
    for (const run of RUNS) await waitRun(call, run.step, await answer(call, run.step, run.tool, run.args))
  } catch (error) {
    if (error instanceof StepFailed) return error.message
    throw error
  }
  return undefined
}

async function cliOf(path: string): Promise<Cli> {
  return (await import(pathToFileURL(resolve(path)).href)) as Cli
}

async function main(args: string[]): Promise<number> {
  const [command, lib, home, ...rest] = args
  if (!lib || !home) throw new Error('usage: canary.ts patch|run <lib/index.js> <dsh home> ...')
  const cli = await cliOf(lib)
  if (command === 'patch') {
    const [livePatch, out] = rest
    if (!livePatch || !out) throw new Error('usage: canary.ts patch <lib/index.js> <dsh home> <live patch> <out>')
    writeFileSync(out, cli.stagedTestPatch(join(home, cli.TEST_PROFILE), readFileSync(livePatch, 'utf8')))
    return 0
  }
  if (command === 'run') {
    cli.useProfile(cli.TEST_PROFILE)
    const problem = await canary((name, a) => cli.callTool(name, a, home))
    if (problem) {
      console.error(`canary failed: ${problem}`)
      return 1
    }
    console.log('canary ok: health, a board task through algorithm-development, ask, research')
    return 0
  }
  throw new Error(`unknown command ${command}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  })
}
