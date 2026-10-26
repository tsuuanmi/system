import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { adviseInShadow, advisorStop, ModelAdvisor } from '../src/advisor.ts'
import type { Engine } from '../src/engine.ts'
import { adviceProblem, type AdvisorCandidate, type AdvisorFeatures, ANSWER_SCHEMA, brierScores, dispatchProblems, dispatchSettings, fitLogistic, LocalAdvisor, modelPrompt, vectorOf } from '../src/index.ts'

// The dispatch advisor's pure parts (PROP-0015 J1): the seam's contract, the local adapter, the
// model adapter's prompt, the settings, and the Brier score. The dispatch pass is in dispatch.spec.ts.

const candidate = (alias: string, headroom: number, counts = { attempts: 0, accepted: 0, limited: 0, operator: 0 }): AdvisorCandidate => ({
  alias, tier: 'standard', tierRank: 1, quotaClass: 'agent-plan', metered: false, free: headroom > 0, load: { running: 0, slots: 1 },
  windows: [{ known: true, seconds: 18_000, used: 80 - headroom, headroom, resetsInMinutes: 120 }], counts,
})
const features = (candidates: AdvisorCandidate[]): AdvisorFeatures => ({ schema: 'dispatch-features@1', questionSet: 'dispatch-advice@1', kind: 'code', template: 'dev', step: 'develop:1', reservePercent: 20, candidates })

describe('the advisor seam\'s contract (PROP-0015 J1)', () => {
  it('takes advice only on exactly the candidates asked, each probability in [0, 1], with a pinned model version', () => {
    const f = features([candidate('A', 60), candidate('B', 10)])
    const good = { status: 'advice', provider: 'x', modelVersion: 'x@1', candidates: [{ alias: 'B', accepted: 0.2, limit: 0.7, needsOperator: 0 }, { alias: 'A', accepted: 1, limit: 0, needsOperator: 0.1 }] }
    expect(adviceProblem(good, f)).toBeUndefined()
    expect(adviceProblem({ status: 'unavailable', provider: 'x', reason: 'insufficient data' }, f)).toBeUndefined()
    expect(adviceProblem({ ...good, candidates: good.candidates.slice(0, 1) }, f)).toBe('it answers B, not exactly A, B')
    expect(adviceProblem({ ...good, candidates: [...good.candidates, { alias: 'C', accepted: 0, limit: 0, needsOperator: 0 }] }, f)).toMatch(/^it answers B, A, C/)
    expect(adviceProblem({ ...good, candidates: [{ ...good.candidates[0], accepted: Number.NaN }, good.candidates[1]] }, f)).toBe('candidate B: every probability must be a number from 0 to 1')
    expect(adviceProblem({ ...good, modelVersion: undefined }, f)).toMatch(/^no model version/)
    expect(adviceProblem({ status: 'maybe' }, f)).toMatch(/neither advice nor unavailable/)
    expect(adviceProblem(null, f)).toBe('the answer is not an object')
    expect(adviceProblem({ ...good, provider: 123 }, f)).toBe('the provider must be a non-empty string, not number')
    expect(adviceProblem({ ...good, provider: '' }, f)).toBe('the provider must be a non-empty string, not string')
    expect(adviceProblem({ ...good, provider: undefined }, f)).toBeUndefined()
  })
})

describe('the local adapter: a regularized logistic regression on recorded outcomes', () => {
  it('fits deterministically, and its probabilities follow what was recorded', () => {
    // Accepted when headroom is high, not when it is low.
    const x = Array.from({ length: 40 }, (_, i) => vectorOf(candidate('A', i < 20 ? 70 : 5)))
    const y = Array.from({ length: 40 }, (_, i) => (i < 20 ? (i % 10 === 0 ? 0 : 1) : (i % 10 === 0 ? 1 : 0)))
    const w = fitLogistic(x, y, 1)
    expect(fitLogistic(x, y, 1)).toEqual(w)
    expect(w).toHaveLength(vectorOf(candidate('A', 1)).length)
    // A larger penalty shrinks the weights (the intercept is not penalized).
    const strong = fitLogistic(x, y, 100)
    expect(Math.hypot(...strong.slice(1))).toBeLessThan(Math.hypot(...w.slice(1)))
  })

  it('says insufficient data until minLabelled attempts exist, then answers every candidate with a model version naming its fit', async () => {
    const examples = (n: number) => Array.from({ length: n }, (_, i) => {
      const high = i % 2 === 0
      return { candidate: candidate('A', high ? 70 : 5), reservePercent: 20, labels: { accepted: high ? 1 : 0, limit: high ? 0 : 1, 'needs-operator': 0 } as const }
    })
    let history = examples(29)
    const local = new LocalAdvisor(() => history, 30, 1)
    const f = features([candidate('A', 70), candidate('B', 5)])
    expect(await local.advise(f)).toEqual({ status: 'unavailable', provider: 'local-logistic', reason: 'insufficient data: 29 of the 30 labelled dispatched attempts it needs (dispatch.advisor.minLabelled)' })
    history = examples(40)
    const advice = await local.advise(f)
    expect(adviceProblem(advice, f)).toBeUndefined()
    if (advice.status !== 'advice') throw new Error('expected advice')
    expect(advice.modelVersion).toMatch(/^logistic-l2@1:n40:[0-9a-f]{16}$/)
    const [a, b] = advice.candidates
    expect(a!.alias).toBe('A')
    expect(a!.accepted).toBeGreaterThan(b!.accepted)
    expect(a!.limit).toBeLessThan(b!.limit)
    // The same history gives the same answer.
    expect(await local.advise(f)).toEqual(advice)
  })
})

describe('the model adapter\'s prompt', () => {
  it('holds the instructions, the JSON schema, and the features: nothing else', () => {
    const f = features([candidate('A', 60)])
    const prompt = modelPrompt(f)
    expect(prompt).toContain(JSON.stringify(ANSWER_SCHEMA))
    expect(prompt.endsWith(JSON.stringify(f))).toBe(true)
  })
})

describe('the model adapter\'s call', () => {
  /** An engine whose model Worker routes after `routeMs`, recording every start and cancel. */
  const engineWith = (routeMs: number, options: { cancel?: (id: string) => unknown; body?: unknown } = {}) => {
    const started: string[] = []
    const cancelled: string[] = []
    let released = 0
    let routed = false
    const completes = 'body' in options
    const source = {
      start: (req: { key: string }) => {
        started.push(req.key)
        return { id: 'exec-1', status: 'running' }
      },
      wait: async (id: string) => new Promise((resolve) => setTimeout(() => resolve(completes ? { id, status: 'completed', result: 'artifact-1' } : { id, status: 'running' }), 20)),
      cancel: (id: string) => {
        cancelled.push(id)
        return options.cancel?.(id)
      },
    }
    const workers = {
      route: async () => {
        await new Promise((resolve) => setTimeout(resolve, routeMs))
        routed = true
        return { source: 'models', worker: { worker: 'model:gemini-api' }, decisions: [], release: () => void (released += 1) }
      },
      source: () => source,
    }
    const engine = { ctx: { workers, egress: { defaultClassification: 'internal' }, artifacts: { get: () => (completes ? { body: options.body } : undefined) } } } as unknown as Engine
    return { engine, started, cancelled, released: () => released, routed: () => routed }
  }

  it('a timeout during routing starts nothing once routing finishes: no metered call outlives the advisor', async () => {
    const e = engineWith(250)
    const shadow = await adviseInShadow(new ModelAdvisor(e.engine, 'model:gemini-api', 256), features([candidate('A', 60)]), 100)
    expect(shadow.advice).toMatchObject({ status: 'unavailable', provider: 'model-worker' })
    expect(shadow.advice.status === 'unavailable' && shadow.advice.reason).toMatch(/^timeout: no answer within 100 ms/)
    await vi.waitFor(() => expect(e.routed()).toBe(true))
    await vi.waitFor(() => expect(e.released()).toBe(1))
    expect(e.started).toEqual([])
    expect(e.cancelled).toEqual([])
  })

  it('a timeout after the call started cancels that execution', async () => {
    const e = engineWith(0)
    const shadow = await adviseInShadow(new ModelAdvisor(e.engine, 'model:gemini-api', 256), features([candidate('A', 60)]), 150)
    expect(shadow.advice.status === 'unavailable' && shadow.advice.reason).toMatch(/^timeout:/)
    expect(e.started).toHaveLength(1)
    await vi.waitFor(() => expect(e.cancelled).toEqual(['exec-1']))
  })

  it.each([
    ['throws', () => { throw new Error('cancel broke') }],
    ['rejects', () => Promise.reject(new Error('cancel broke'))],
  ])('a cancel that %s on timeout is contained: the timeout is recorded, nothing escapes', async (_how, cancel) => {
    const uncaught: unknown[] = []
    const record = (error: unknown): void => void uncaught.push(error)
    process.on('uncaughtException', record)
    process.on('unhandledRejection', record)
    try {
      const e = engineWith(0, { cancel })
      const shadow = await adviseInShadow(new ModelAdvisor(e.engine, 'model:gemini-api', 256), features([candidate('A', 60)]), 150)
      expect(shadow.advice).toMatchObject({ status: 'unavailable', provider: 'model-worker' })
      expect(shadow.advice.status === 'unavailable' && shadow.advice.reason).toMatch(/^timeout:/)
      await vi.waitFor(() => expect(e.cancelled).toEqual(['exec-1']))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', record)
      process.off('unhandledRejection', record)
    }
  })

  const answer = JSON.stringify({ candidates: [{ alias: 'A', accepted: 0.7, limit: 0.1, needsOperator: 0.05 }] })

  it('records the model version the Worker result names', async () => {
    const e = engineWith(0, { body: { model: 'model-economy-001', text: answer } })
    const shadow = await adviseInShadow(new ModelAdvisor(e.engine, 'model:gemini-api', 256), features([candidate('A', 60)]), 2000)
    expect(shadow.advice).toMatchObject({ status: 'advice', provider: 'model-worker', modelVersion: 'model-economy-001' })
  })

  it.each([['no model', { text: answer }], ['an empty model', { model: ' ', text: answer }]])('with %s in the Worker result, the answer is unavailable: the Worker alias is not a model version', async (_how, body) => {
    const e = engineWith(0, { body })
    const shadow = await adviseInShadow(new ModelAdvisor(e.engine, 'model:gemini-api', 256), features([candidate('A', 60)]), 2000)
    expect(shadow.advice).toMatchObject({ status: 'unavailable', provider: 'model-worker' })
    expect(shadow.advice.status === 'unavailable' && shadow.advice.reason).toMatch(/named no model version/)
    expect(JSON.stringify(shadow.advice)).not.toContain('model:gemini-api')
  })
})

describe('stopping an advisor cannot crash the process', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  const advisorPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'advisor.ts')
  /** Run `code` (an ES module, `ADVISOR` the advisor module's path) in a child Node process: how it ended. */
  const child = (code: string) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: root, env: { ...process.env, ADVISOR: advisorPath }, encoding: 'utf8', timeout: 60_000 })
  const LISTENER = 'a stop listener that throws'

  it('calls every stop listener inside a guard: a throw or a rejection is returned by stop, a late listener is called too, and none runs twice', async () => {
    const { signal, stop } = advisorStop()
    const calls: string[] = []
    signal.onAbort(() => {
      calls.push('throws')
      throw new Error('one')
    })
    signal.onAbort(async () => {
      calls.push('rejects')
      throw new Error('two')
    })
    const removed = signal.onAbort(() => void calls.push('removed'))
    removed()
    expect(signal.aborted).toBe(false)
    expect(stop()).toEqual(['one'])
    expect(signal.aborted).toBe(true)
    signal.onAbort(() => {
      calls.push('late')
      throw new Error('three')
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(stop()).toEqual(['one', 'two', 'three'])
    expect(calls).toEqual(['throws', 'rejects', 'late'])
    expect(Object.isFrozen(signal)).toBe(true)
  })

  it('in a child process: an advisor whose stop listener throws on a timeout is recorded unavailable with why, and the process lives on; the same listener on an AbortSignal ends it', () => {
    const advised = child(`
      const { adviseInShadow } = await import(process.env.ADVISOR)
      const features = { schema: 'dispatch-features@1', questionSet: 'dispatch-advice@1', template: 'dev', step: 'develop:1', reservePercent: 20, candidates: [] }
      const advisor = { id: 'faulty', advise: (_f, signal) => new Promise(() => signal.onAbort(() => { throw new Error('${LISTENER}') })) }
      const shadow = await adviseInShadow(advisor, features, 50)
      await new Promise((resolve) => setTimeout(resolve, 100))
      console.log(JSON.stringify(shadow.advice))
    `)
    expect(advised.stderr).not.toContain(LISTENER)
    expect(advised.status).toBe(0)
    expect(JSON.parse(advised.stdout.trim().split('\n').at(-1)!)).toEqual({ status: 'unavailable', provider: 'faulty', reason: `timeout: no answer within 50 ms (dispatch.advisor.timeoutMs); its stop listener failed, ignored: ${LISTENER}` })
    // The control: a try/catch around an AbortController's abort does not contain its listener's throw.
    const control = child(`
      const controller = new AbortController()
      controller.signal.addEventListener('abort', () => { throw new Error('${LISTENER}') })
      try { controller.abort() } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
      console.log('alive')
    `)
    expect(control.stderr).toContain(LISTENER)
    expect(control.status).not.toBe(0)
    expect(control.stdout).not.toContain('alive')
  })
})

describe('the advisor\'s settings (dispatch.advisor)', () => {
  it('defaults to none (off: no advisor, the metered model never asked), and refuses a value out of range with its path', () => {
    expect(dispatchSettings({}).advisor).toEqual({ provider: 'none', timeoutMs: 2000, maxPerHour: 120, minLabelled: 30, l2: 1 })
    expect(dispatchSettings({ dispatch: { advisor: { model: { worker: 'model:gemini-api' } } } }).advisor.provider).toBe('none')
    expect(dispatchSettings({ dispatch: { advisor: { provider: 'model', model: { worker: 'model:gemini-api' } } } }).advisor).toMatchObject({ provider: 'model', model: { worker: 'model:gemini-api', maxTokens: 1024 } })
    expect(dispatchProblems({ dispatch: { advisor: { provider: 'model' } } })).toEqual(['dispatch.advisor.provider model needs dispatch.advisor.model.worker: the model Worker to ask'])
    expect(dispatchProblems({ dispatch: { advisor: { provider: 'jev' as never, timeoutMs: 50, minLabelled: 5, l2: 0 } } })).toHaveLength(4)
    // At most the training examples the local adapter keeps (MAX_TRAINING): a larger minimum could never be met.
    expect(dispatchProblems({ dispatch: { advisor: { minLabelled: 2000 } } })).toEqual([])
    expect(dispatchProblems({ dispatch: { advisor: { minLabelled: 2001 } } })).toEqual(['dispatch.advisor.minLabelled must be a whole number from 10 to 2000, not 2001'])
    expect(dispatchProblems({ dispatch: { advisor: { bogus: 1 } as never } })[0]).toMatch(/^dispatch\.advisor\.bogus is not an option/)
  })
})

describe('calibration', () => {
  it('scores each question by its Brier score, beside always answering the observed rate', () => {
    const scores = brierScores([
      { question: 'accepted', p: 0.9, y: 1 }, { question: 'accepted', p: 0.2, y: 0 }, { question: 'accepted', p: 0.6, y: 0 },
      { question: 'limit', p: 0, y: 0 },
    ])
    expect(scores).toEqual([
      { question: 'accepted', scored: 3, brier: 0.136667, rate: 0.333333, baseline: 0.222222 },
      { question: 'limit', scored: 1, brier: 0, rate: 0, baseline: 0 },
    ])
  })
})
