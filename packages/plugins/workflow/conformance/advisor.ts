/**
 * Conformance suite for the dispatch advisor seam (`Advisor`, swapped in through
 * `ctx.workflow.setDispatchAdvisor`; PROP-0015 J1, docs/design/workflow-engine.md#the-dispatch-advisor-in-shadow).
 * Every advisor, a fake included, passes it: asked once per dispatch choice with features only
 * (D73), it answers within `dispatch-advice@1` or says why it cannot, it stops when its call is
 * stopped, and what it says is recorded beside dispatch's choice and never changes it.
 *
 * The test supplies the advisor under test and a dispatch harness: a booted workflow over the
 * store-backed board, approval queue, and resource ledger, with no advisor configured
 * (`dispatch.advisor.provider` none), and two free Workers on two accounts, of which dispatch
 * chooses `chosen` for a task of `ready`. How the engine contains an advisor that fails (a throw,
 * a hang, a malformed answer, a stop listener that throws) is the engine's own test, not this suite.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { BoardTask } from '@tsuuanmi/system-board-core'
import { expect, vi } from 'vitest'
import { defineSuite, type Scenario } from '../../../libs/conformance/runner.ts'
import { adviceProblem, type Advisor, type AdvisorFeatures, advisorStop, QUESTION_SET, QUESTIONS } from '../src/index.ts'

export interface DispatchHarness {
  ctx: Context
  /** A ready board task of the harness's active project, which the next dispatch pass takes. */
  ready: (title: string, goal: string) => Promise<BoardTask>
  /** The Worker dispatch chooses for it. */
  chosen: string
  /** Every Worker id, account, and project id of the harness: none may reach an advisor. */
  hidden: string[]
}

export interface Boot {
  /** A fresh advisor under test, for the context it advises in. */
  advisor: (ctx: Context) => Advisor
  /** A fresh dispatch harness (each call boots its own). */
  dispatch: () => Promise<DispatchHarness>
}

type Decision = {
  decisionType: string
  inputs: string[]
  decider: { type: string; id: string; version?: string }
  candidates: Array<{ option: string; selected: boolean; reasons: string[] }>
  outcome: { option: string; detail?: Record<string, unknown> }
  modelAnswers?: Array<{ provider: string; modelVersion: string; questionSetVersion?: string; questionId: string; type: string; probability?: number }>
  deterministic: boolean
}

/** Features as dispatch gives them: two admitted candidates, A the chosen one. */
export const FEATURES: AdvisorFeatures = {
  schema: 'dispatch-features@1', questionSet: 'dispatch-advice@1', kind: 'code', template: 'dev', step: 'develop:1', reservePercent: 20,
  candidates: ['A', 'B'].map((alias, i) => ({
    alias, tier: 'standard', tierRank: 1, quotaClass: 'agent-plan', metered: false, free: true, load: { running: 0, slots: 1 },
    windows: [{ known: true, seconds: 18_000, used: 10 + 20 * i, headroom: 70 - 20 * i, resetsInMinutes: 40 + 160 * i }], counts: { attempts: 0, accepted: 0, limited: 0, operator: 0 },
  })),
}

/** The keys a features snapshot may hold, at any depth (`dispatch-features@1`). */
const FEATURE_KEYS = new Set(['schema', 'questionSet', 'kind', 'template', 'step', 'reservePercent', 'candidates', 'alias', 'tier', 'tierRank', 'quotaClass', 'metered', 'free', 'load', 'running', 'slots', 'windows', 'seconds', 'known', 'used', 'headroom', 'resetsInMinutes', 'counts', 'attempts', 'accepted', 'limited', 'operator'])
const keysOf = (value: unknown, into = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into)
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) keysOf(v, into.add(k))
  return into
}

const decisionOf = (ctx: Context, id: string | undefined): Decision => {
  const body = ctx.artifacts.get(id as `sha256:${string}`)?.body as Decision | undefined
  expect(body, `decision ${id}`).toBeDefined()
  return body!
}

/** One pass over one ready task, with `advisor` swapped in (or none): the ask, its choice, and the advice decision the choice names. */
async function dispatchOnce(h: DispatchHarness, advisor: Advisor | undefined, title: string) {
  h.ctx.workflow.setDispatchAdvisor(advisor)
  const task = await h.ready(title, `GOAL-${title} a private goal`)
  const pass = await h.ctx.workflow.sweepDispatch()
  expect(pass.took.map((t) => [t.taskId, t.worker]), 'dispatch takes the task on the Worker it chooses').toEqual([[task.taskId, h.chosen]])
  const ask = h.ctx.workflow.dispatchStatus().asks.find((a) => a.taskId === task.taskId)!
  const choice = decisionOf(h.ctx, ask.decisions[1])
  const ids = choice.inputs.filter((id) => (h.ctx.artifacts.get(id as `sha256:${string}`)?.body as Decision | undefined)?.decider?.id === 'advisor.dispatch')
  expect(ids, 'the choice names exactly one advice decision as its input (INV-13)').toHaveLength(1)
  const requests = await h.ctx.approvals.list({ states: ['open', 'batched', 'approved', 'rejected'] })
  return { task, ask, choice, advice: decisionOf(h.ctx, ids[0]), request: requests.find((r) => r.requestId === ask.requestId) }
}

const scenario = (id: string, title: string, run: (boot: Boot) => Promise<void>): Scenario<Boot> => ({ id: `workflow.dispatchAdvisor.${id}`, since: '1.0', title, run })

export const advisorSuite = defineSuite<Boot>({
  seam: 'workflow.dispatchAdvisor',
  // 1.0 (PROP-0015 J1): one call per dispatch choice, given frozen features only and a stop signal
  // that is not an EventTarget; advice on exactly the candidates asked, each probability in [0, 1],
  // a pinned model version, or unavailable with why; recorded in shadow, never changing a choice.
  contract: '1.0',
  scenarios: [
    scenario('features-only', 'is asked once per dispatch choice with features only (D73): no task title, goal, or id, no Worker id, account, or project, only the snapshot\'s own keys, the chosen Worker as alias A, the snapshot frozen (INV-12)', async (boot) => {
      const h = await boot.dispatch()
      const under = boot.advisor(h.ctx)
      const seen: AdvisorFeatures[] = []
      const recording: Advisor = {
        id: under.id,
        advise: (features, signal) => {
          seen.push(features)
          return under.advise(features, signal)
        },
      }
      const { task } = await dispatchOnce(h, recording, 'TITLE-7f3a private title')
      expect(seen).toHaveLength(1)
      const features = seen[0]!
      const text = JSON.stringify(features)
      for (const secret of ['TITLE-7f3a', 'GOAL-', task.taskId, ...h.hidden]) expect(text, secret).not.toContain(secret)
      expect(features).toMatchObject({ schema: 'dispatch-features@1', questionSet: QUESTION_SET })
      expect(features.candidates.map((c) => c.alias)).toEqual('ABCDEFGH'.slice(0, features.candidates.length).split(''))
      expect(features.candidates.length).toBeGreaterThanOrEqual(2)
      expect([...keysOf(features)].filter((k) => !FEATURE_KEYS.has(k))).toEqual([])
      expect(Object.isFrozen(features) && Object.isFrozen(features.candidates[0])).toBe(true)
    }),

    scenario('never-changes-choice', 'never changes the choice: the same Worker, request, and subject version, and the same candidates, as with no advisor; its advice is recorded beside the choice as its input (PROP-0015 J1, INV-13)', async (boot) => {
      // Both dispatches at one frozen instant, so their quota readings, and so the request's version, may be equal.
      vi.useFakeTimers({ toFake: ['Date'] })
      const at = new Date()
      let without: Awaited<ReturnType<typeof dispatchOnce>>
      let advised: typeof without
      let h: DispatchHarness
      try {
        vi.setSystemTime(at)
        without = await dispatchOnce(await boot.dispatch(), undefined, 'same either way')
        vi.setSystemTime(at)
        h = await boot.dispatch()
        advised = await dispatchOnce(h, boot.advisor(h.ctx), 'same either way')
      } finally {
        vi.useRealTimers()
      }
      expect(advised.ask.worker).toBe(without.ask.worker)
      expect(advised.ask.worker).toBe(h.chosen)
      expect(without.request, 'the ask opened its request').toBeDefined()
      expect(advised.request?.subject.version).toBe(without.request!.subject.version)
      expect(advised.choice.outcome.option).toBe(without.choice.outcome.option)
      expect(advised.choice.candidates).toEqual(without.choice.candidates)
      expect(advised.advice).toMatchObject({ decisionType: 'route', outcome: { detail: { shadow: true, chosen: 'A' } } })
      expect((advised.advice.outcome.detail!['aliases'] as Record<string, string>)['A']).toBe(h.chosen)
    }),

    scenario('answers-in-contract', 'answers within dispatch-advice@1: every candidate asked exactly once, three probabilities in [0, 1] each, under a pinned model version, all recorded as modelAnswers; or unavailable with its own reason, never an error, a timeout, or a malformed answer (INV-13)', async (boot) => {
      const h = await boot.dispatch()
      const { advice } = await dispatchOnce(h, boot.advisor(h.ctx), 'in contract')
      const detail = advice.outcome.detail!
      const n = (detail['features'] as AdvisorFeatures).candidates.length
      if (advice.outcome.option === 'advice') {
        expect(advice).toMatchObject({ decider: { type: 'model', id: 'advisor.dispatch' }, deterministic: false })
        expect(advice.decider.version).toBe(detail['modelVersion'])
        expect(advice.modelAnswers).toHaveLength(QUESTIONS.length * n)
        for (const m of advice.modelAnswers!) {
          expect(m).toMatchObject({ questionSetVersion: QUESTION_SET, type: 'yes-no', modelVersion: detail['modelVersion'] })
          expect(m.probability).toBeGreaterThanOrEqual(0)
          expect(m.probability).toBeLessThanOrEqual(1)
        }
        expect(new Set(advice.modelAnswers!.map((m) => m.questionId)).size).toBe(QUESTIONS.length * n)
      } else {
        expect(advice.outcome.option).toBe('unavailable')
        expect(String(detail['reason'])).not.toMatch(/^(error|timeout|malformed answer):/)
        expect(String(detail['reason']).length).toBeGreaterThan(0)
      }
      expect(h.ctx.eventLog.query({ type: 'workflow.dispatch.advised', limit: 10 }).map((e) => e.data?.['status'])).toEqual([advice.outcome.option])
    }),

    scenario('answers-directly', 'answers features it is given directly within dispatch-advice@1 too, every candidate and nothing else, or unavailable with a reason', async (boot) => {
      const h = await boot.dispatch()
      const { signal } = advisorStop()
      const advice = await boot.advisor(h.ctx).advise(FEATURES, signal)
      expect(adviceProblem(advice, FEATURES)).toBeUndefined()
    }),

    scenario('stops', 'settles soon after its call is stopped, and none of its stop listeners throws (INV-9)', async (boot) => {
      const h = await boot.dispatch()
      const { signal, stop } = advisorStop()
      const call = Promise.resolve().then(() => boot.advisor(h.ctx).advise(FEATURES, signal)).then(() => 'settled', () => 'settled')
      // Stopped once it had a moment to start (and register what stops it).
      await new Promise((resolve) => setTimeout(resolve, 10))
      stop()
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('still running 5 s after its stop'), 5000)
      })
      try {
        expect(await Promise.race([call, late])).toBe('settled')
      } finally {
        clearTimeout(timer)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(stop(), 'what its stop listeners threw or rejected with').toEqual([])
    }),
  ],
})
