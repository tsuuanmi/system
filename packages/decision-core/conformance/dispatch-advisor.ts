/**
 * Conformance suite for the dispatch advisor seam (`ctx.dispatchAdvisor`, the abstract
 * `DispatchAdvisor`, and the call every provider answers, `Advisor`; PROP-0015 J1,
 * docs/design/workflow-engine.md#the-dispatch-advisor-in-shadow). Every advisor, a fake included,
 * passes it: asked once per dispatch choice with features only (D73), it answers within
 * `dispatch-advice@1` or says why it cannot, it stops when its call is stopped, and what it says is
 * recorded beside dispatch's choice and never changes it.
 *
 * The test supplies the advisor under test and a dispatch harness: a booted dispatch pass (the
 * workflow engine's, over the store-backed board, approval queue, and resource ledger) with no
 * advisor configured (`dispatch.advisor.provider` none), and two free Workers on two accounts, of
 * which dispatch chooses `chosen` for every ready task. The harness puts the advisor in place the way
 * its consumer takes one, and reads back what the pass recorded. How the consumer contains an
 * advisor that fails (a throw, a hang, a malformed answer, a stop listener that throws) is the
 * consumer's own test, not this suite.
 */
import type { Context } from '@deepseek-ai/cordis'
import { expect, vi } from 'vitest'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import { adviceProblem, type Advisor, type AdvisorFeatures, advisorStop, ALIASES, FEATURES_SCHEMA, QUESTION_SET, QUESTIONS } from '../src/index.ts'

/** A decision as the pass records it (`decision@1.x`): the fields the suite reads. */
export interface RecordedDecision {
  decisionType: string
  inputs: string[]
  decider: { type: string; id: string; version?: string }
  candidates: Array<{ option: string; selected: boolean; reasons: string[] }>
  outcome: { option: string; detail?: Record<string, unknown> }
  modelAnswers?: Array<{ provider: string; modelVersion: string; questionSetVersion?: string; questionId: string; type: string; probability?: number }>
  deterministic: boolean
}

/** What one dispatch pass over one new ready task recorded. */
export interface Dispatched {
  /** The board task made ready for the pass. */
  taskId: string
  /** What the pass took: each task and the Worker it chose. */
  took: Array<{ taskId: string; worker: string }>
  /** The Worker the pass's ask about the task names. */
  worker: string
  /** The `dispatch.choice` decision of the ask. */
  choice: RecordedDecision
  /** Every input of the choice decided by the advisor (`advisor.dispatch`): exactly one (INV-13). */
  advice: RecordedDecision[]
  /** The approval request the ask opened, when it opened one: its subject's version. */
  request?: { version?: string }
}

export interface DispatchHarness {
  /** The context an advisor under test advises in. */
  ctx: Context
  /**
   * One pass over one new ready task of the harness's active project, titled `title`, with goal
   * `goal`, with `advisor` in place (or none): put in place as the consumer takes a provider.
   */
  dispatch: (advisor: Advisor | undefined, title: string, goal: string) => Promise<Dispatched>
  /** The status of each advice the consumer announced (`workflow.dispatch.advised`), in order. */
  announced: () => string[]
  /** The Worker dispatch chooses. */
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

/** Features as dispatch gives them: two admitted candidates, A the chosen one. */
export const FEATURES: AdvisorFeatures = {
  schema: FEATURES_SCHEMA, questionSet: QUESTION_SET, kind: 'code', template: 'dev', step: 'develop:1', reservePercent: 20,
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

/** One pass over one ready task, with `advisor` in place (or none): the task taken on the chosen Worker, and the one advice decision its choice names. */
async function dispatchOnce(h: DispatchHarness, advisor: Advisor | undefined, title: string): Promise<Dispatched & { decision: RecordedDecision }> {
  const done = await h.dispatch(advisor, title, `GOAL-${title} a private goal`)
  expect(done.took.map((t) => [t.taskId, t.worker]), 'dispatch takes the task on the Worker it chooses').toEqual([[done.taskId, h.chosen]])
  expect(done.advice, 'the choice names exactly one advice decision as its input (INV-13)').toHaveLength(1)
  return { ...done, decision: done.advice[0]! }
}

const scenario = (id: string, title: string, run: (boot: Boot) => Promise<void>): Scenario<Boot> => ({ id: `dispatchAdvisor.${id}`, since: '1.0', title, run })

export const dispatchAdvisorSuite = defineSuite<Boot>({
  seam: 'dispatchAdvisor',
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
      const { taskId } = await dispatchOnce(h, recording, 'TITLE-7f3a private title')
      expect(seen).toHaveLength(1)
      const features = seen[0]!
      const text = JSON.stringify(features)
      for (const secret of ['TITLE-7f3a', 'GOAL-', taskId, ...h.hidden]) expect(text, secret).not.toContain(secret)
      expect(features).toMatchObject({ schema: FEATURES_SCHEMA, questionSet: QUESTION_SET })
      expect(features.candidates.map((c) => c.alias)).toEqual(ALIASES.slice(0, features.candidates.length).split(''))
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
      expect(advised.worker).toBe(without.worker)
      expect(advised.worker).toBe(h.chosen)
      expect(without.request, 'the ask opened its request').toBeDefined()
      expect(advised.request?.version).toBe(without.request!.version)
      expect(advised.choice.outcome.option).toBe(without.choice.outcome.option)
      expect(advised.choice.candidates).toEqual(without.choice.candidates)
      expect(advised.decision).toMatchObject({ decisionType: 'route', outcome: { detail: { shadow: true, chosen: 'A' } } })
      expect((advised.decision.outcome.detail!['aliases'] as Record<string, string>)['A']).toBe(h.chosen)
    }),

    scenario('answers-in-contract', 'answers within dispatch-advice@1: every candidate asked exactly once, three probabilities in [0, 1] each, under a pinned model version, all recorded as modelAnswers; or unavailable with its own reason, never an error, a timeout, or a malformed answer (INV-13)', async (boot) => {
      const h = await boot.dispatch()
      const { decision: advice } = await dispatchOnce(h, boot.advisor(h.ctx), 'in contract')
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
      expect(h.announced()).toEqual([advice.outcome.option])
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
