import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { startPrompt } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter, { type WorkerExecution } from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as Science from '../src/index.ts'

// Each test boots the whole engine with a research profile: quick alone, past vitest's 5 s default
// on a host running several full suites at once (as the other integration specs, 120 s).
vi.setConfig({ testTimeout: 120_000 })

async function boot(workflow: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'system-science-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 100, ...workflow }),
  ]
  await Promise.all(fibers)
  onTestFinished(async () => { for (const f of [...fibers].reverse()) await f.dispose() })
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return ctx
}

const json = (value: unknown) => '```json\n' + JSON.stringify(value) + '\n```'
const HYPOTHESES = { question: 'Does X lower Y?', hypotheses: [{ id: 'H1', statement: 'X lowers Y.' }, { id: 'H2', statement: 'The effect is from Z.' }] }
const EVIDENCE = { evidence: [{ id: 'E1', claim: 'A trial found X lowered Y.', source: 'https://example.org/trial', bears: [{ hypothesis: 'H1', direction: 'supports' }], strength: 'moderate' }] }

const AT = '2026-10-12T00:00:00Z'

/** How a scripted execution fails: sent or not, and its error. */
type Failure = Pick<WorkerExecution, 'submitted'> & { error: NonNullable<WorkerExecution['error']> }

/** A failure before anything was sent, on the infrastructure: retryable, so the usual recovery would wait and try again. */
const NETWORK: Failure = { submitted: false, error: { kind: 'network', disposition: 'BACKOFF', message: 'the connection dropped before the prompt was sent' } }

/** The site answered the sent prompt with its own error (ADR-0062: Gemini's "Sorry, something went wrong"), retryable. */
const SITE: Failure = { submitted: true, error: { kind: 'overloaded', disposition: 'BACKOFF', message: 'Sorry, something went wrong', siteError: true } }

/**
 * Scripted chat Workers that answer each study step and record the prompts: `chat:a` proves web
 * search, `chat:b` only reasons, each of its own provider family unless `families` says otherwise.
 * `frontier` adds `chat:c`, a frontier Worker of chat:a's family, so a rejected result can escalate on it.
 */
function scholar(ctx: Context, families: [string, string] = ['fam-a', 'fam-b'], options: { refuseFirstReview?: boolean; deep?: boolean; unavailable?: boolean; stallReview?: boolean; stallFallback?: boolean; reviewFailure?: Failure; fallbackFailure?: Failure; frontier?: boolean; uncitedFallback?: boolean; researcher?: 'ready' | 'unavailable' } = {}): string[] & { sessions: Array<string | undefined>; workers: string[] } {
  const prompts = Object.assign([] as string[], { sessions: [] as Array<string | undefined>, workers: [] as string[] })
  const executions = new Map<string, WorkerExecution>()
  const sessions = new Map<string, string>()
  let refused = false
  const descriptor = (id: string, family: string, web: boolean) => ({
    schema: 'capability-descriptor@1.1' as const, worker: id, provider: 'test', family, tier: (options.deep || id === 'chat:c' ? 'frontier' : 'standard') as 'frontier' | 'standard', quotaClass: 'subscription-chat' as const, locality: 'remote' as const,
    // Website Workers keep conversations: the synthesis thread needs it.
    capabilities: ['reason', 'persistent-conversation', ...(web ? ['web-search'] : []), ...(options.deep ? ['deep-research'] : [])].map((capability) => ({ capability, evidence: { kind: 'probe' as const, at: AT } })),
    // `unavailable`: the second family's Worker (chat:b) is signed out or down, as Gemini web often is (D89).
    state: (options.unavailable && id === 'chat:b' ? 'unavailable' : 'ready') as 'ready' | 'unavailable', observedAt: AT,
  })
  // `researcher`: a read-only research Worker on an agent runtime (T262, ADR-0074) of a third family: agent-plan
  // quota, local, research work only; it proves reason and web-search and keeps no conversation.
  const researcher = () => ({
    schema: 'capability-descriptor@1.6' as const, worker: 'agent:research', provider: 'test', family: 'fam-c', tier: 'standard' as const, quotaClass: 'agent-plan' as const, locality: 'local' as const,
    kinds: ['research'], capabilities: ['reason', 'web-search'].map((capability) => ({ capability, evidence: { kind: 'probe' as const, at: AT } })),
    state: options.researcher!, observedAt: AT,
  })
  ctx.workers.register({
    name: 'chat',
    describe: async () => [descriptor('chat:a', families[0], true), descriptor('chat:b', families[1], false), ...(options.frontier ? [descriptor('chat:c', families[0], true)] : []), ...(options.researcher ? [researcher()] : [])],
    affinity: (sessionId) => (sessions.has(sessionId) ? [sessions.get(sessionId)!] : undefined),
    start: (request) => {
      // What a text-prompted source sends: the brief rendered, its pointers resolved at start.
      const p = startPrompt(request, (ref) => ctx.artifacts.get(ref)).prompt
      prompts.push(p)
      prompts.sessions.push(request.sessionId)
      prompts.workers.push(request.worker)
      if (request.sessionId && !sessions.has(request.sessionId)) sessions.set(request.sessionId, request.worker)
      // `stallReview`: chat:b takes the review's prompt, then never answers (T229: Gemini stalled after the prompt).
      // `stallFallback`: the first family (chat:a, or chat:c) stalls on any review after its first (review B's fallback).
      // `reviewFailure`, `fallbackFailure`: the same, failing as given (an unsent infrastructure failure, say).
      // `uncitedFallback`: that fallback answers, citing no source, so acceptance.cited rejects it.
      const review = p.includes('Review the published evidence')
      const first = (worker: string | undefined): boolean => worker === 'chat:a' || worker === 'chat:c'
      const fallback = review && first(request.worker) && prompts.filter((q, i) => first(prompts.workers[i]) && q.includes('Review the published evidence')).length > 1
      const stall = { submitted: true, error: { kind: 'provider_stalled' as const, disposition: 'RECREATE_SESSION' as const, message: 'no answer after the prompt' } }
      const failure = request.worker === 'chat:b' && review ? options.reviewFailure ?? (options.stallReview ? stall : undefined)
        : fallback ? options.fallbackFailure ?? (options.stallFallback ? stall : undefined) : undefined
      if (failure) {
        const execution: WorkerExecution = { id: `chat-failed-${prompts.length}`, status: 'failed', ...failure, decisions: [] }
        executions.set(execution.id, execution)
        return execution
      }
      // chat:a refuses the first review unsent, so review A backs off and is routed again (a busy
      // Worker no longer backs off at admission: it stays admissible, ADR-0033).
      if (options.refuseFirstReview && !refused && request.worker === 'chat:a' && p.includes('Review the published evidence')) {
        refused = true
        const execution: WorkerExecution = { id: `chat-refused`, status: 'failed', submitted: false, error: { kind: 'overloaded', disposition: 'BACKOFF', message: 'the account is busy' }, decisions: [] }
        executions.set(execution.id, execution)
        return execution
      }
      const text = p.includes('Frame the research question') ? json(HYPOTHESES)
        : review && fallback && options.uncitedFallback ? `One trial found X lowered Y, as I recall (${request.worker})`
        : review ? `One trial (n=120) found X lowered Y: https://example.org/trial (${request.worker})`
          : p.includes('Extract one evidence table') ? json(EVIDENCE)
            : p.includes('independent critic') ? 'E1 is a single trial; its strength is at most moderate.'
              : `H1 is supported with moderate confidence [${p.includes('"E2"') ? 'E2' : 'E1'}]. H2 is insufficient.`
      const result = ctx.artifacts.put({ kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'operator-shared', producer: { type: 'worker', ref: request.worker },
        body: { schema: 'provider-answer@1.0', provider: 'test', account: 'a', turnId: `t-${prompts.length}`, conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text } }).id
      const execution: WorkerExecution = { id: `chat-${prompts.length}`, status: 'completed', submitted: true, result: result as `sha256:${string}`, decisions: [] }
      executions.set(execution.id, execution)
      return execution
    },
    get: (id) => executions.get(id),
    wait: async (id) => executions.get(id)!,
  })
  return prompts
}

const { profileConformance } = await import('../../workflow/conformance/profiles.ts')
profileConformance('scientific-research', async () => ({ ctx: await boot(), dispose: async () => undefined }), Science, { research: Science.RESEARCH })

describe('the scientific-research profile, on the unchanged engine (REQ-WF-9)', () => {
  it('runs the deep variant\'s literature review with Deep research, and refuses a variant it does not have (PROP-0004)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    const deep = ctx.workflow.start({ template: 'research', input: 'Does X lower Y?', variant: 'deep' })
    const plain = ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' })
    expect(deep.nodes.find((n) => n.nodeId === 'literature:1')).toMatchObject({ minTier: 'frontier' })
    expect(plain.nodes.find((n) => n.nodeId === 'literature:1')).toMatchObject({ minTier: 'standard' })
    expect(deep.specHash).not.toBe(plain.specHash)
    expect(() => ctx.workflow.start({ template: 'research', input: 'q', variant: 'fast' })).toThrow('template research has no variant fast (it has: deep)')
    expect(() => ctx.workflow.start({ template: 'research-deep', input: 'q' })).toThrow('unknown workflow template research-deep')
  })

  it('runs research: hypotheses, two cited reviews on two provider families, one evidence table, a critique on another family, conclusions citing evidence (PROP-0004)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    const prompts = scholar(ctx)
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done).toMatchObject({ status: 'completed', answer: 'H1 is supported with moderate confidence [E1]. H2 is insufficient.' })
    // Review A proves web search; review B, and the critique of the evidence, run on the other family.
    expect(done.nodes.map((n) => [n.nodeId, n.worker])).toEqual([
      ['frame:1', 'chat:a'], ['literature:1', 'chat:a'], ['literature:2', 'chat:b'], ['evidence:1', 'chat:a'], ['critique:1', 'chat:b'], ['conclusion:1', 'chat:a'],
    ])
    // Four conversations, not six: the synthesis thread (frame, evidence, conclusion) is the run's one
    // conversation; each review and the critique has its own, so neither sees the thread it feeds or judges.
    const sessionOf = (marker: string) => prompts.sessions[prompts.findIndex((p) => p.includes(marker))]
    const thread = sessionOf('Frame the research question')
    expect(thread).toBe(done.sessionId)
    expect(thread).toMatch(/^ses_/)
    expect([sessionOf('Extract one evidence table'), sessionOf('Conclude the study')]).toEqual([thread, thread])
    expect(prompts.filter((p) => p.includes('Review the published evidence')).map((p) => prompts.sessions[prompts.indexOf(p)])).toEqual([undefined, undefined])
    expect(sessionOf('independent critic')).toBeUndefined()
    // A structured step is given its schema verbatim, and its result is checked against it (REQ-ART-5).
    expect(prompts[0]).toContain('"$id":"urn:tsuuanmi:system:schema:hypothesis-set:v1"')
    expect(ctx.artifacts.get(ctx.workflow.records(done.runId)[0]!.outputReceipt!.acceptance)!.body).toMatchObject({ candidates: [{ option: 'accept', reasons: ['a valid hypothesis-set@1.0', expect.any(String)] }, expect.anything()] })
    // The evidence step reads both reviews, labelled A and B.
    const evidence = prompts.find((p) => p.includes('Extract one evidence table'))!
    expect(evidence).toMatch(/<review id="A">\n[^<]*\(chat:a\)[\s\S]*<review id="B">\n[^<]*\(chat:b\)/)
    // The critic sees the hypotheses and the evidence, never the reviews they came from.
    const critique = prompts.find((p) => p.includes('independent critic'))!
    expect(critique).toContain('"E1"')
    expect(critique).not.toContain('n=120')
    // Both families answered: nothing is single-family, and no step is told otherwise (D89).
    expect(prompts.some((p) => p.includes('Single family'))).toBe(false)
    expect(ctx.workflow.explain(done.runId)!.nodes.flatMap((n) => n.decisions).some((d) => d.outcome === 'single-family')).toBe(false)
    // The route decision says why the other family was taken, and never names a family.
    const route = ctx.artifacts.get(ctx.workflow.records(done.runId).find((r) => r.nodeId === 'literature:2')!.execution!.route)!.body as { candidates: Array<{ option: string; reasons: string[] }> }
    expect(route.candidates.find((c) => c.option === 'chat:a')!.reasons).toContain('same provider family (differs from node literature:1)')
    expect(JSON.stringify(route)).not.toMatch(/fam-[ab]/)
    // Typed artifacts, derived from the accepted results.
    const criteria = ctx.artifacts.list({ kind: 'criteria', runId: done.runId })
    expect(criteria).toHaveLength(1)
    expect(criteria[0]).toMatchObject({ bodySchema: 'hypothesis-set@1.0', body: { schema: 'hypothesis-set@1.0', hypotheses: [{ id: 'H1' }, { id: 'H2' }] } })
    expect(ctx.artifacts.list({ kind: 'evidence', runId: done.runId })[0]).toMatchObject({ bodySchema: 'evidence-table@1.1', inputs: [ctx.workflow.records(done.runId)[3]!.outputReceipt!.result] })
  })

  it('routes review B to a research Worker of another family that searches, then to one that only reasons, and to the single-family fallback last (T262, D91)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    scholar(ctx, ['fam-a', 'fam-b'], { researcher: 'ready' })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done.status).toBe('completed')
    // Review A on the website Worker that searches; review B prefers a Worker that searches too, of another family; the rest never reach the research Worker.
    expect(done.nodes.map((n) => [n.nodeId, n.worker])).toEqual([
      ['frame:1', 'chat:a'], ['literature:1', 'chat:a'], ['literature:2', 'agent:research'], ['evidence:1', 'chat:a'], ['critique:1', 'chat:b'], ['conclusion:1', 'chat:a'],
    ])
    const routeOf = (runId: string, nodeId: string, c: Context = ctx) => c.artifacts.get(c.workflow.records(runId).find((r) => r.nodeId === nodeId)!.execution!.route)!.body as { candidates: Array<{ option: string; selected: boolean; reasons: string[] }> }
    const route = routeOf(done.runId, 'literature:2')
    expect(route.candidates.find((c) => c.selected)!.reasons).toContain('proves web-search, which the work prefers')
    expect(route.candidates.find((c) => c.option === 'chat:b')!.reasons).toEqual(['admitted; agent:research proves web-search, which the work prefers, and this one does not'])
    expect(JSON.stringify(route)).not.toMatch(/fam-[abc]/)
    // The research Worker takes research work only: the frame, an ordinary step, was never its.
    expect(routeOf(done.runId, 'frame:1').candidates.find((c) => c.option === 'agent:research')!.reasons).toContain('takes research work only; this work names no kind')

    // The research Worker unavailable: review B goes to the Worker of another family that only reasons, as before.
    const other = await boot()
    await other.plugin(Science)
    scholar(other, ['fam-a', 'fam-b'], { researcher: 'unavailable' })
    const reasons = await other.workflow.wait(other.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(reasons.status).toBe('completed')
    expect(reasons.nodes.filter((n) => n.nodeId.startsWith('literature')).map((n) => [n.nodeId, n.worker])).toEqual([['literature:1', 'chat:a'], ['literature:2', 'chat:b']])

    // Neither of another family can take it: T260's single-family fallback, last, marked so.
    const last = await boot()
    await last.plugin(Science)
    scholar(last, ['fam-a', 'fam-b'], { researcher: 'unavailable', unavailable: true })
    const single = await last.workflow.wait(last.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(single.status).toBe('completed')
    expect(single.nodes.find((n) => n.nodeId === 'literature:2')!.worker).toBe('chat:a')
    expect(last.workflow.explain(single.runId)!.nodes.find((n) => n.nodeId === 'literature:2')!.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'admission', outcome: 'single-family' })]))

    // The template's steps: both reviews are research work, and review B prefers web-search.
    expect(Science.RESEARCH.filter((n) => n.nodeId.startsWith('literature')).map((n) => [n.nodeId, n.kind, n.prefers ?? []])).toEqual([['literature:1', 'research', []], ['literature:2', 'research', ['web-search']]])
  })

  it('routes review B after review A backs off and is routed again: no deadlock (ADR-0027)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    scholar(ctx, ['fam-a', 'fam-b'], { refuseFirstReview: true })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 20_000)
    expect(done.status).toBe('completed')
    expect(done.nodes.filter((n) => n.nodeId.startsWith('literature')).map((n) => [n.nodeId, n.worker])).toEqual([['literature:1', 'chat:a'], ['literature:2', 'chat:b']])
  }, 30_000)

  it('runs the deep variant\'s two reviews in conversations of their own, on two families', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    scholar(ctx, ['fam-a', 'fam-b'], { deep: true })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?', variant: 'deep' }).runId, 20_000)
    expect(done.status).toBe('completed')
    expect(done.nodes.filter((n) => n.nodeId.startsWith('literature')).map((n) => [n.nodeId, n.worker])).toEqual([['literature:1', 'chat:a'], ['literature:2', 'chat:b']])
  }, 30_000)

  it('runs the second review on the first family in a fresh conversation when the second family is unavailable, marked single-family (D89)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    const prompts = scholar(ctx, ['fam-a', 'fam-b'], { unavailable: true })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    // The run neither fails nor waits for the second family: both reviews and the critique run on chat:a.
    expect(done.status).toBe('completed')
    expect(done.nodes.map((n) => [n.nodeId, n.worker])).toEqual([
      ['frame:1', 'chat:a'], ['literature:1', 'chat:a'], ['literature:2', 'chat:a'], ['evidence:1', 'chat:a'], ['critique:1', 'chat:a'], ['conclusion:1', 'chat:a'],
    ])
    // Review B is a conversation of its own, which never sees review A.
    const reviews = prompts.flatMap((p, i) => (p.includes('Review the published evidence') ? [{ p, session: prompts.sessions[i] }] : []))
    expect(reviews.map((r) => r.session)).toEqual([undefined, undefined])
    expect(reviews.every((r) => !r.p.includes('n=120'))).toBe(true)
    // Recorded as a single-family decision naming why the second family could not take it.
    const explained = ctx.workflow.explain(done.runId)!.nodes
    const second = explained.find((n) => n.nodeId === 'literature:2')!.decisions.find((d) => d.type === 'admission' && d.outcome === 'single-family')!
    expect(second.reasons[0]).toMatch(/^no Worker of another provider family than literature:1's is admitted: .*chat:b/)
    expect(explained.find((n) => n.nodeId === 'critique:1')!.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'admission', outcome: 'single-family' })]))
    expect(explained.flatMap((n) => n.decisions).some((d) => d.outcome === 'same-family')).toBe(false)
    // The evidence, critique, and conclusion steps are told the two reviews share one family.
    for (const marker of ['Extract one evidence table', 'independent critic', 'Conclude the study']) {
      const brief = prompts.find((p) => p.includes(marker))!
      expect(brief, marker).toContain('Single family: the steps below ran on one provider family, not two')
      expect(brief, marker).toContain('- literature:2 ran on the provider family of literature:1, in a conversation of its own')
    }
    expect(prompts.find((p) => p.includes('Conclude the study'))).toContain('- critique:1 ran on the provider family of evidence:1')
    // The answer's header says so first.
    expect(done.answer).toMatch(/^Single family: literature:2 on the family of literature:1; critique:1 on the family of evidence:1, each in a conversation of its own/)
    expect(done.answer).toContain('H1 is supported with moderate confidence [E1].')
  })

  it('runs the second review on the first family once its Worker stalls after the prompt, never resending to it, marked single-family (D89)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    const prompts = scholar(ctx, ['fam-a', 'fam-b'], { stallReview: true })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done.status).toBe('completed')
    const reviews = prompts.flatMap((p, i) => (p.includes('Review the published evidence') ? [{ worker: prompts.workers[i], session: prompts.sessions[i], p }] : []))
    // Sent to chat:b once, never again; then to chat:a in a fresh conversation, which never sees review A.
    expect(reviews.map((r) => r.worker).sort()).toEqual(['chat:a', 'chat:a', 'chat:b'])
    expect(reviews.map((r) => r.session)).toEqual([undefined, undefined, undefined])
    expect(reviews.every((r) => !r.p.includes('n=120'))).toBe(true)
    expect(done.nodes.find((n) => n.nodeId === 'literature:2')!.worker).toBe('chat:a')
    // The critique still runs on the second family, which can take it.
    expect(done.nodes.find((n) => n.nodeId === 'critique:1')!.worker).toBe('chat:b')
    const decisions = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === 'literature:2')!.decisions
    const recovery = decisions.find((d) => d.type === 'recovery')!
    expect(recovery.outcome).toBe('single-family')
    expect(recovery.reasons[0]).toMatch(/^provider_stalled on chat:b after the prompt was sent/)
    const admission = decisions.find((d) => d.type === 'admission' && d.outcome === 'single-family')!
    expect(admission.reasons[0]).toMatch(/^provider_stalled on chat:b after the prompt was sent .*; no Worker of another family is admitted now$/)
    // The critique's brief names single family, and the answer's header says so.
    expect(prompts.find((p) => p.includes('independent critic'))).toContain('- literature:2 ran on the provider family of literature:1')
    expect(done.answer).toMatch(/^Single family: literature:2 on the family of literature:1, each in a conversation of its own/)
  })

  it('falls back once per step: a second failure of the fallback fails the step as before (D89)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    // Review B stalls on chat:b, then its fallback on chat:a stalls too.
    const prompts = scholar(ctx, ['fam-a', 'fam-b'], { stallReview: true, stallFallback: true })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done.status).toBe('failed')
    expect(prompts.filter((p) => p.includes('Review the published evidence'))).toHaveLength(3)
  })

  it('falls back at once when the second family fails on the infrastructure before the send, never retrying or waiting for it (D89)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    const prompts = scholar(ctx, ['fam-a', 'fam-b'], { reviewFailure: NETWORK })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done.status).toBe('completed')
    const reviews = prompts.flatMap((p, i) => (p.includes('Review the published evidence') ? [prompts.workers[i]] : []))
    // chat:b had the review once; the usual network back-off would have tried it again up to maxAttempts.
    expect(reviews.sort()).toEqual(['chat:a', 'chat:a', 'chat:b'])
    const decisions = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === 'literature:2')!.decisions
    expect(decisions.filter((d) => d.type === 'recovery').map((d) => d.outcome)).toEqual(['single-family'])
    expect(decisions.find((d) => d.type === 'recovery')!.reasons[0]).toMatch(/^network on chat:b before anything was sent/)
    expect(decisions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'admission', outcome: 'single-family' })]))
    expect(done.answer).toMatch(/^Single family: literature:2 on the family of literature:1/)
  })

  it('falls back once per step when the fallback fails before the send too: no second fallback, no retry (D89)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    // Review B stalls on chat:b; its fallback on chat:a then fails unsent, retryable.
    const prompts = scholar(ctx, ['fam-a', 'fam-b'], { stallReview: true, fallbackFailure: NETWORK })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done.status).toBe('failed')
    expect(prompts.filter((p) => p.includes('Review the published evidence'))).toHaveLength(3)
    const decisions = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === 'literature:2')!.decisions
    expect(decisions.filter((d) => d.type === 'admission' && d.outcome === 'single-family')).toHaveLength(1)
    const last = decisions.filter((d) => d.type === 'recovery').at(-1)!
    expect(last).toMatchObject({ outcome: 'fail', reasons: [expect.stringContaining('one single-family fallback'), expect.anything()] })
  })

  it('falls back once per step across escalations: a rejected fallback escalates only onto another family, never into a second fallback (D89)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    // The second family is unavailable; the fallback answers without a source, so acceptance.cited
    // rejects it and it escalates to frontier, which chat:c of the first family serves.
    const prompts = scholar(ctx, ['fam-a', 'fam-b'], { unavailable: true, frontier: true, uncitedFallback: true })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done.status).toBe('failed')
    // Review A, then review B's one fallback: never a second on the first family at the higher tier.
    expect(prompts.filter((p) => p.includes('Review the published evidence'))).toHaveLength(2)
    const decisions = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === 'literature:2')!.decisions
    expect(decisions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'escalation', outcome: 'escalate' })]))
    expect(decisions.filter((d) => d.type === 'admission' && d.outcome === 'single-family')).toHaveLength(1)
  })

  it('falls back when the second family answers with the site\'s own error, never resending there; and never resends a fallback that does (D89, ADR-0062)', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    const prompts = scholar(ctx, ['fam-a', 'fam-b'], { reviewFailure: SITE })
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done.status).toBe('completed')
    expect(prompts.flatMap((p, i) => (p.includes('Review the published evidence') ? [prompts.workers[i]] : [])).sort()).toEqual(['chat:a', 'chat:a', 'chat:b'])
    const decisions = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === 'literature:2')!.decisions
    expect(decisions.filter((d) => d.type === 'recovery').map((d) => d.outcome)).toEqual(['single-family'])
    expect(done.answer).toMatch(/^Single family: literature:2 on the family of literature:1/)

    // The fallback itself answered with the site's error: the step fails, never resent.
    const again = await boot()
    await again.plugin(Science)
    const asked = scholar(again, ['fam-a', 'fam-b'], { stallReview: true, fallbackFailure: SITE })
    const failed = await again.workflow.wait(again.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(failed.status).toBe('failed')
    expect(asked.filter((p) => p.includes('Review the published evidence'))).toHaveLength(3)
    const last = again.workflow.explain(failed.runId)!.nodes.find((n) => n.nodeId === 'literature:2')!.decisions.filter((d) => d.type === 'recovery').at(-1)!
    expect(last).toMatchObject({ outcome: 'fail', reasons: [expect.stringContaining('one single-family fallback'), expect.anything()] })
  })

  it('keeps the template\'s single-family fallback with allowSameFamily on: recorded single-family, never same-family (D89, ADR-0029)', async () => {
    const ctx = await boot({ allowSameFamily: true })
    await ctx.plugin(Science)
    scholar(ctx, ['fam-a', 'fam-a'])
    const done = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    expect(done.status).toBe('completed')
    const second = ctx.workflow.explain(done.runId)!.nodes.find((n) => n.nodeId === 'literature:2')!
    expect(second.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'admission', outcome: 'single-family' })]))
    expect(second.decisions.some((d) => d.outcome === 'same-family')).toBe(false)
    expect(done.answer).toMatch(/^Single family: literature:2 on the family of literature:1/)
  })

  it('keeps an old run\'s typed evidence on the version its step asked for, and supersedes it when the step reruns', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    scholar(ctx)
    // A run started before PROP-0004: its evidence step asked for evidence-table@1.0.
    ctx.workflow.template('research-deep', Science.RESEARCH.map((n) => (n.nodeId === 'evidence:1' ? { ...n, resultSchema: 'evidence-table@1.0' } : n)))
    const run = await ctx.workflow.wait(ctx.workflow.start({ template: 'research-deep', input: 'Does X lower Y?' }).runId, 30_000)
    await ctx.workflow.supersede(run.runId, 'evidence:1', { text: json(EVIDENCE), note: 'rerun' })
    await ctx.workflow.wait(run.runId, 30_000)
    const tables = ctx.artifacts.list({ kind: 'evidence', runId: run.runId })
    expect(tables.map((t) => t.bodySchema)).toEqual(['evidence-table@1.0', 'evidence-table@1.0'])
    expect(tables[1]!.lineage).toEqual({ supersedes: [tables[0]!.id] })
  }, 60_000)

  it('refuses a step result that is not its typed body, before anything downstream runs', () => {
    expect(Science.typedBody(json({ question: 'q', hypotheses: [{ id: 'X1', statement: 's' }] }), 'hypothesis-set@1.0')).toMatchObject({ ok: false })
    expect(Science.typedBody('no json here', 'evidence-table@1.0')).toMatchObject({ ok: false, reason: expect.stringMatching(/no evidence-table/) })
    expect(Science.typedBody(json(EVIDENCE), 'evidence-table@1.0')).toMatchObject({ ok: true })
  })

  it('invalidates on a superseded evidence table: the critique and conclusion run again, and the typed artifact is superseded', async () => {
    const ctx = await boot()
    await ctx.plugin(Science)
    scholar(ctx)
    const run = await ctx.workflow.wait(ctx.workflow.start({ template: 'research', input: 'Does X lower Y?' }).runId, 30_000)
    const corrected = { evidence: [...EVIDENCE.evidence, { id: 'E2', claim: 'A larger trial found no effect.', source: 'https://example.org/big', bears: [{ hypothesis: 'H1', direction: 'refutes' }], strength: 'strong' }] }
    await ctx.workflow.supersede(run.runId, 'evidence:1', { text: json(corrected), note: 'a missed trial' })
    const again = await ctx.workflow.wait(run.runId, 30_000)
    expect(again).toMatchObject({ status: 'completed', answer: 'H1 is supported with moderate confidence [E2]. H2 is insufficient.' })
    const tables = ctx.artifacts.list({ kind: 'evidence', runId: run.runId })
    expect(tables).toHaveLength(2)
    expect(tables[1]!.lineage).toEqual({ supersedes: [tables[0]!.id] })
    expect((tables[1]!.body as { evidence: unknown[] }).evidence).toHaveLength(2)
  })
})
