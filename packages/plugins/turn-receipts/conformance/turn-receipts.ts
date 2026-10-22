/**
 * Conformance suite for `ctx.turnReceipts`, the runner's guarantee that a provider turn is
 * reconciled, never replayed (ADR-0036; INV-4; docs/design/provider-turns.md#turn-receipt;
 * schemas/provider-turn-receipt.v1.json). `boot` returns a context that provides
 * `ctx.turnReceipts` with its default config (`maxResubmits` 2, the schema's bound) and the
 * `ctx.store` and `ctx.artifacts` it injects, with no receipt yet.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-artifacts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { type Reconciliation, type TurnReceipt, type TurnSnapshot, responseHash } from '@tsuuanmi/system-provider-core'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../../libs/conformance/runner.ts'
import type { Submission, TurnIdentity } from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

/** The bound every provider under test is configured with: the default, and the schema maximum. */
export const MAX_RESUBMITS = 2

const OUTCOMES: readonly Reconciliation[] = ['WAIT', 'RECOVER', 'RESUBMIT', 'AMBIGUOUS']
const schemas = new SchemaRegistry()

const PREVIOUS = 'the answer before this turn'
const PROMPT = 'Compare the two transports: when should each be used?'
const id: TurnIdentity = { account: 'acct-main', sessionId: 'session-a', requestId: 'call-42' }
const submission: Submission = {
  ...id, prompt: PROMPT, previousResponse: PREVIOUS,
  conversation: { provider: 'site-a', binding: 'https://site-a.example/c/1' },
  mode: { verified: true, tier: 'frontier', feature: 'chat' },
}
const fresh: Submission = { ...submission, requestId: 'call-new', previousResponse: null, conversation: { provider: 'site-a', binding: '' } }

const failed = (fn: () => unknown): boolean => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}
const valid = (receipt: TurnReceipt | undefined): TurnReceipt => {
  expect(receipt, 'a receipt').toBeDefined()
  schemas.assertRecord(receipt!)
  return receipt!
}

type Decision = {
  schema: string; decisionType: string; deterministic: boolean; decider: { type: string; id: string; version: string }
  candidates: Array<{ option: string; selected: boolean; reasons: string[] }>; outcome: { option: string }
}
const decisionOf = (ctx: Context, ref: string): Decision => {
  const envelope = ctx.artifacts.get(ref)
  expect(envelope?.kind, `${ref} is a decision`).toBe('decision')
  const body = envelope!.body as Decision
  schemas.assertRecord(body as unknown as { schema: string })
  return body
}

const scenario = (id: string, title: string, run: (ctx: Context) => Promise<void>): Scenario<Boot> => ({
  id: `turnReceipts.${id}`, since: '1.0', title,
  run: async (boot) => {
    const { ctx, dispose } = await boot()
    try {
      await run(ctx)
    } finally {
      await dispose()
    }
  },
})

export const turnReceiptsSuite = defineSuite<Boot>({
  seam: 'turnReceipts',
  contract: '1.0',
  scenarios: [
    scenario('persisted-before-submission', 'persists a SUBMITTED, schema-valid receipt binding the account, conversation, request, prompt, and response boundary before anything is sent (INV-4, INV-14)', async (ctx) => {
      const submitted = valid(ctx.turnReceipts.submit(submission))
      expect(submitted).toMatchObject({
        schema: 'provider-turn-receipt@1.0', account: id.account, requestId: id.requestId, conversation: submission.conversation,
        mode: submission.mode, status: 'SUBMITTED', resubmits: 0, previousResponseHash: responseHash(PREVIOUS),
      })
      expect(submitted.promptHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(valid(ctx.turnReceipts.read(id))).toEqual(submitted)
      // A new conversation has no boundary.
      expect(valid(ctx.turnReceipts.submit(fresh)).previousResponseHash).toBeNull()
      expect(ctx.turnReceipts.read({ ...id, requestId: 'never-submitted' })).toBeUndefined()
    }),
    scenario('identity', 'keys a receipt by account, owning session, and request id, and refuses an empty part of that identity (INV-4, INV-2)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      const otherSession = valid(ctx.turnReceipts.submit({ ...submission, sessionId: 'session-b', prompt: 'another prompt' }))
      const otherAccount = valid(ctx.turnReceipts.submit({ ...submission, account: 'acct-2', prompt: 'a third prompt' }))
      expect([otherSession.resubmits, otherAccount.resubmits]).toEqual([0, 0])
      expect(ctx.turnReceipts.read(id)?.resubmits).toBe(0)
      expect(ctx.turnReceipts.read({ ...id, sessionId: 'session-b' })).toEqual(otherSession)
      for (const empty of [{ account: '' }, { sessionId: ' ' }, { requestId: '' }]) {
        expect(failed(() => ctx.turnReceipts.submit({ ...submission, requestId: 'call-empty', ...empty })), JSON.stringify(empty)).toBe(true)
      }
      expect(ctx.turnReceipts.read({ ...id, requestId: 'call-empty' })).toBeUndefined()
    }),
    scenario('drift-refused', 'refuses a request id reused with another prompt or another response boundary, and leaves the receipt as it was (INV-4, INV-2)', async (ctx) => {
      const submitted = ctx.turnReceipts.submit(submission)
      expect(failed(() => ctx.turnReceipts.submit({ ...submission, prompt: 'a different prompt' }))).toBe(true)
      expect(failed(() => ctx.turnReceipts.submit({ ...submission, previousResponse: 'the conversation moved on' }))).toBe(true)
      expect(failed(() => ctx.turnReceipts.submit({ ...submission, previousResponse: null }))).toBe(true)
      expect(ctx.turnReceipts.read(id)).toEqual(submitted)
    }),
    scenario('resubmits-bounded', 'allows at most maxResubmits (2) resubmissions of one request, refuses the next, and then never answers RESUBMIT (INV-9, QA-8)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      const nothingNew: TurnSnapshot = { text: PREVIOUS, running: false }
      for (let n = 1; n <= MAX_RESUBMITS; n++) {
        expect(ctx.turnReceipts.reconcile(id, nothingNew).outcome).toBe('RESUBMIT')
        expect(valid(ctx.turnReceipts.submit(submission)).resubmits).toBe(n)
      }
      expect(failed(() => ctx.turnReceipts.submit(submission))).toBe(true)
      expect(valid(ctx.turnReceipts.read(id)).resubmits).toBe(MAX_RESUBMITS)
      expect(ctx.turnReceipts.reconcile(id, nothingNew).outcome).toBe('AMBIGUOUS')
    }),
    scenario('bind-once', 'binds a receipt to its canonical conversation once, idempotently, and never rebinds it to another (INV-4)', async (ctx) => {
      ctx.turnReceipts.submit(fresh)
      const bound = valid(ctx.turnReceipts.bindConversation(fresh, 'https://site-a.example/c/7'))
      expect(bound.conversation).toEqual({ provider: 'site-a', binding: 'https://site-a.example/c/7' })
      expect(ctx.turnReceipts.bindConversation(fresh, 'https://site-a.example/c/7')).toEqual(bound)
      expect(failed(() => ctx.turnReceipts.bindConversation(fresh, 'https://site-a.example/c/8'))).toBe(true)
      ctx.turnReceipts.submit(submission)
      expect(failed(() => ctx.turnReceipts.bindConversation(id, 'https://site-a.example/c/other'))).toBe(true)
      expect(failed(() => ctx.turnReceipts.bindConversation({ ...id, requestId: 'missing' }, 'https://site-a.example/c/9'))).toBe(true)
      expect(ctx.turnReceipts.read(fresh)?.conversation.binding).toBe('https://site-a.example/c/7')
      expect(ctx.turnReceipts.read(id)?.conversation.binding).toBe(submission.conversation.binding)
    }),
    scenario('complete-once', 'completes a receipt once with its response hash and provider turn id, repeats idempotently for the same response, and refuses conflicting content (INV-4, INV-2)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      const completed = valid(ctx.turnReceipts.complete(id, { response: 'the late answer', providerTurnId: 'turn-1' }))
      expect(completed).toMatchObject({ status: 'COMPLETED', responseHash: responseHash('the late answer'), providerTurnId: 'turn-1' })
      // Responses compare by their trimmed text.
      expect(ctx.turnReceipts.complete(id, { response: '  the late answer\n', providerTurnId: 'turn-1' })).toEqual(completed)
      expect(failed(() => ctx.turnReceipts.complete(id, { response: 'other content', providerTurnId: 'turn-1' }))).toBe(true)
      expect(failed(() => ctx.turnReceipts.complete({ ...id, requestId: 'missing' }, { response: 'x', providerTurnId: 't' }))).toBe(true)
      expect(ctx.turnReceipts.read(id)).toEqual(completed)
    }),
    scenario('reconcile-records-decision', 'records every reconciliation as a deterministic reconciliation decision naming all four outcomes, with the snapshot hash, and appends its ref to the receipt (INV-13)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      const snapshots: Array<[TurnSnapshot, Reconciliation]> = [
        [{ text: PREVIOUS, running: false }, 'RESUBMIT'],
        [{ text: PREVIOUS, running: true }, 'WAIT'],
        [{ text: 'the late answer', running: false }, 'RECOVER'],
      ]
      const refs: string[] = []
      for (const [snapshot, expected] of snapshots) {
        const { outcome, decision } = ctx.turnReceipts.reconcile(id, snapshot)
        expect(outcome).toBe(expected)
        const body = decisionOf(ctx, decision)
        expect(body).toMatchObject({ decisionType: 'reconciliation', deterministic: true, outcome: { option: outcome } })
        expect(body.decider.id.length).toBeGreaterThan(0)
        expect(body.candidates.map((c) => c.option).sort()).toEqual([...OUTCOMES].sort())
        expect(body.candidates.filter((c) => c.selected)).toEqual([expect.objectContaining({ option: outcome, reasons: expect.arrayContaining([expect.any(String)]) })])
        expect(JSON.stringify(body), 'the decision carries the snapshot hash').toContain(responseHash(snapshot.text))
        refs.push(decision)
        expect(valid(ctx.turnReceipts.read(id)).reconciliations).toEqual(refs)
      }
      expect(failed(() => ctx.turnReceipts.reconcile({ ...id, requestId: 'missing' }, { text: '', running: false }))).toBe(true)
    }),
    scenario('reconcile-rejected-reasons', 'records why each rejected outcome of a reconciliation was not chosen, not only the winner (INV-13)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      const { decision } = ctx.turnReceipts.reconcile(id, { text: 'the late answer', running: false })
      for (const candidate of decisionOf(ctx, decision).candidates) expect(candidate.reasons.length, candidate.option).toBeGreaterThan(0)
    }),
    scenario('reconcile-wait-once', 'waits while the provider still generates the turn, recording consecutive WAITs as one decision and any change of outcome anew (INV-9, INV-13)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      const running: TurnSnapshot = { text: 'partial', running: true }
      const first = ctx.turnReceipts.reconcile(id, running)
      const again = ctx.turnReceipts.reconcile(id, { text: 'more partial text', running: true })
      expect([first.outcome, again.outcome]).toEqual(['WAIT', 'WAIT'])
      expect(again.decision).toBe(first.decision)
      expect(ctx.turnReceipts.read(id)?.reconciliations).toEqual([first.decision])
      const stopped = ctx.turnReceipts.reconcile(id, { text: PREVIOUS, running: false })
      expect(stopped.outcome).toBe('RESUBMIT')
      const later = ctx.turnReceipts.reconcile(id, running)
      expect(later.outcome).toBe('WAIT')
      const refs = ctx.turnReceipts.read(id)?.reconciliations ?? []
      expect(refs).toHaveLength(3)
      expect(refs.slice(0, 2)).toEqual([first.decision, stopped.decision])
      expect(decisionOf(ctx, refs[2]!).outcome.option).toBe('WAIT')
    }),
    scenario('reconcile-recover', 'adopts a new completed response after the boundary instead of resending, any response for a new conversation, and a completed turn the page still shows (REQ-PRV-2, INV-4)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      expect(ctx.turnReceipts.reconcile(id, { text: 'the late answer', running: false, lastPrompt: PROMPT }, { prompt: PROMPT }).outcome).toBe('RECOVER')
      ctx.turnReceipts.submit(fresh)
      expect(ctx.turnReceipts.reconcile(fresh, { text: 'an answer', running: false }).outcome).toBe('RECOVER')
      ctx.turnReceipts.complete(id, { response: 'the late answer', providerTurnId: 'turn-1' })
      expect(ctx.turnReceipts.reconcile(id, { text: ' the late answer ', running: false }).outcome).toBe('RECOVER')
    }),
    scenario('reconcile-never-duplicates', 'resubmits only when nothing new follows the boundary and the page does not show the prompt; a prompt the page shows is never resent (INV-4, QA-1)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      const options = { prompt: PROMPT }
      expect(ctx.turnReceipts.reconcile(id, { text: PREVIOUS, running: false, lastPrompt: 'an older question' }, options).outcome).toBe('RESUBMIT')
      // The page shows the prompt (with other spacing, after a tool chip's label): the provider has it.
      const shown = `Web search ${PROMPT.replace(': ', ':\n  ')}`
      expect(ctx.turnReceipts.reconcile(id, { text: PREVIOUS, running: false, lastPrompt: shown }, options).outcome).toBe('AMBIGUOUS')
      ctx.turnReceipts.submit(fresh)
      expect(ctx.turnReceipts.reconcile(fresh, { text: '', running: false, lastPrompt: PROMPT }, options).outcome).toBe('AMBIGUOUS')
      expect(ctx.turnReceipts.reconcile(fresh, { text: '', running: false }).outcome).toBe('RESUBMIT')
    }),
    scenario('reconcile-fails-closed', 'answers AMBIGUOUS for a conversation it cannot observe, and for a completed turn the page contradicts (INV-2, INV-4)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      expect(ctx.turnReceipts.reconcile(id, { text: '', running: false, observable: false }).outcome).toBe('AMBIGUOUS')
      expect(ctx.turnReceipts.reconcile(id, { text: 'the late answer', running: false, observable: false }).outcome).toBe('AMBIGUOUS')
      ctx.turnReceipts.complete(id, { response: 'the late answer', providerTurnId: 'turn-1' })
      expect(ctx.turnReceipts.reconcile(id, { text: 'a different answer', running: false }).outcome).toBe('AMBIGUOUS')
      expect(ctx.turnReceipts.reconcile(id, { text: 'the late answer', running: true }).outcome).toBe('AMBIGUOUS')
      expect(ctx.turnReceipts.reconcile(id, { text: '', running: false }).outcome).toBe('AMBIGUOUS')
    }),
    scenario('reconcile-boundary-missing', 'answers AMBIGUOUS, never RESUBMIT, when an observed page no longer shows the response boundary the receipt recorded (INV-2, INV-4)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      // The receipt recorded a response before this turn; the page shows no response at all.
      expect(ctx.turnReceipts.reconcile(id, { text: '', running: false, lastPrompt: 'an older question' }, { prompt: PROMPT }).outcome).toBe('AMBIGUOUS')
    }),
    scenario('delete-one', 'deletes exactly one turn\'s receipt when its turn is forgotten, and none of the session\'s others (INV-9)', async (ctx) => {
      ctx.turnReceipts.submit(submission)
      ctx.turnReceipts.submit({ ...submission, requestId: 'call-43' })
      ctx.turnReceipts.submit({ ...submission, account: 'acct-2' })
      expect(ctx.turnReceipts.delete(id)).toBe(true)
      expect(ctx.turnReceipts.delete(id)).toBe(false)
      expect(ctx.turnReceipts.read(id)).toBeUndefined()
      expect(ctx.turnReceipts.read({ ...id, requestId: 'call-43' })).toBeDefined()
      expect(ctx.turnReceipts.read({ ...id, account: 'acct-2' })).toBeDefined()
      // A forgotten request starts again from a fresh receipt.
      expect(ctx.turnReceipts.submit({ ...submission, prompt: 'a new prompt' }).resubmits).toBe(0)
    }),
  ],
})
