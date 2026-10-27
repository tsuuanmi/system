// The canary's steps (T323): what it asks of the test profile's tools, and when it fails.
import { beforeAll, describe, expect, it } from 'vitest'
import { BOUNDS, type CallTool, canary, GOAL, RUNS } from './canary.ts'

const ok = (structured: Record<string, unknown>) => ({ isError: false, text: '', structured })

interface Script {
  health?: string
  /** How each run ends, by the tool that started it. */
  ends?: Record<string, 'completed' | 'failed'>
  /** The task's state once its run completed. */
  after?: string
  /** A tool that answers an error. */
  refuses?: string
}

/**
 * A test profile as its tools answer: a charter that waits for the operator's approval, a project that
 * is active once approved, a task that is ready once proposed, runs that end as `ends` says; each call
 * is recorded with its arguments.
 */
function profile(script: Script = {}): { call: CallTool; calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = []
  let approved = false
  let ran = false
  const call: CallTool = async (name, args) => {
    calls.push([name, args])
    if (name === script.refuses) return { isError: true, text: `Tool ${name} not found` }
    switch (name) {
      case 'status': return ok({ health: { state: script.health ?? 'ok', checks: [] } })
      case 'board_charter': return ok({ projectId: args.projectId, state: 'proposed', charterVersion: 1, approvalRequest: 'apr-1' })
      case 'approvals_get': return ok({ request: { requestId: args.requestId, subject: { type: 'artifact', ref: 'sha256:charter' } } })
      case 'approvals_decide':
        approved = true
        return ok({ decided: 1 })
      case 'board_brief': return ok({ projectId: args.projectId, state: approved ? 'active' : 'proposed' })
      case 'board_propose': return ok({ taskId: 'task-1', state: 'proposed', revision: 1 })
      case 'board_task': return ok({ task: { taskId: 'task-1', state: ran ? (script.after ?? 'review') : 'ready' } })
      case 'result': return ok({ runId: args.runId, status: 'completed' })
      default: {
        if (name === 'run') ran = true
        const status = script.ends?.[name] ?? 'running'
        return ok({ runId: `run_${name}`, status, ...(status === 'failed' ? { error: { kind: 'no_worker', message: 'no Worker can take this work' } } : {}) })
      }
    }
  }
  return { call, calls }
}

beforeAll(() => {
  BOUNDS.pollMs = 1
})

describe('the canary', () => {
  it('files a board task on a canary project of its own, approves its charter as the operator, and runs its attempt through algorithm-development; then an ask and a research run', async () => {
    const { call, calls } = profile()
    expect(await canary(call, '20261027120000')).toBeUndefined()
    const names = calls.map(([name]) => name)
    expect(names.slice(0, 5)).toEqual(['status', 'board_charter', 'approvals_get', 'approvals_decide', 'board_brief'])
    expect(names).toContain('board_propose')
    expect(calls.find(([name]) => name === 'board_charter')![1]).toMatchObject({ projectId: 'canary-20261027120000', charter: { version: 1 } })
    // The verdict names the exact subject the request holds (INV-5).
    expect(calls.find(([name]) => name === 'approvals_decide')![1]).toEqual({ verdicts: [{ requestId: 'apr-1', subject: { type: 'artifact', ref: 'sha256:charter' }, verdict: 'approved', note: 'the stage canary (T323)' }] })
    expect(calls.find(([name]) => name === 'board_propose')![1]).toMatchObject({ projectId: 'canary-20261027120000', template: 'algorithm-development', goal: GOAL })
    // The attempt is a run for the task: the board-task path (its claim, its dossier's evidence gate, its result).
    expect(calls.find(([name]) => name === 'run')![1]).toEqual({ template: 'algorithm-development', input: GOAL, task: { taskId: 'task-1' }, waitSeconds: 55 })
    expect(names.indexOf('run')).toBeGreaterThan(names.lastIndexOf('board_propose'))
    expect(names.slice(-4)).toEqual(['ask', 'result', 'research', 'result'])
    expect(RUNS.map((r) => r.step)).toEqual(['ask', 'research'])
  })

  it('fails when the task\'s run completes but the task does not hold its result', async () => {
    const { call } = profile({ after: 'waiting-for-input' })
    expect(await canary(call, 's')).toBe('board task: run run_run completed, but task task-1 is waiting-for-input, not in review or done with its result')
  })

  it('fails, naming the step, at the first run that fails, and runs nothing after it', async () => {
    const { call, calls } = profile({ ends: { ask: 'failed' } })
    expect(await canary(call, 's')).toMatch(/^ask: run run_ask failed: no_worker: no Worker can take this work/)
    expect(calls.map(([name]) => name)).not.toContain('research')
  })

  it('fails on a profile that is down, before anything is filed', async () => {
    const { call, calls } = profile({ health: 'down' })
    expect(await canary(call, 's')).toMatch(/^health: down/)
    expect(calls).toHaveLength(1)
  })

  it('fails on a tool that answers an error, naming the step and the tool', async () => {
    const { call } = profile({ refuses: 'board_charter' })
    expect(await canary(call, 's')).toBe('board task: board_charter: Tool board_charter not found')
  })
})
