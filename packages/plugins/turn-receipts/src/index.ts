/**
 * `ctx.turnReceipts`: provider turn receipts, persisted **before** submission and
 * reconciled after restarts (docs/design/provider-turns.md, INV-4). Ported from
 * tsuuanmi/internet's ProviderTurnReceiptStore onto `ctx.store`; every reconciliation is
 * recorded as a decision artifact (INV-13).
 * @module @tsuuanmi/system-turn-receipts
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-ledger-core'
import { type ContentId, SchemaRegistry, sha256 } from '@tsuuanmi/system-libs'
import { boundaryMissing, ProviderError, promptShown, type Reconciliation, type TurnReceipt, type TurnSnapshot, reconcileTurn, responseHash } from '@tsuuanmi/system-provider-core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    turnReceipts: TurnReceipts
  }
}

export interface TurnIdentity {
  account: string
  sessionId: string
  requestId: string
}

export interface Submission extends TurnIdentity {
  prompt: string
  /** The last response before this turn, or null for a new conversation. */
  previousResponse: string | null
  conversation: TurnReceipt['conversation']
  mode: TurnReceipt['mode']
}

const OUTCOMES: readonly Reconciliation[] = ['WAIT', 'RECOVER', 'RESUBMIT', 'AMBIGUOUS']

function required(value: string, name: string): string {
  if (value.trim() === '') throw new ProviderError('invalid_input', `${name} must not be empty`)
  return value
}

/** Receipt identity: hash of account, owning session, and provider request id. */
export function receiptId(identity: TurnIdentity): ContentId {
  return sha256(`${required(identity.account, 'account')}\0${required(identity.sessionId, 'session id')}\0${required(identity.requestId, 'request id')}`)
}

export interface Config {
  /** Bound on resubmissions per receipt (default 2, the schema maximum). */
  maxResubmits?: number
}

export class TurnReceipts extends Service {
  static inject = ['store', 'artifacts']
  static Config: z<Config> = z.object({
    maxResubmits: z.natural().max(2).default(2).description('Bound on resubmissions per receipt'),
  })

  private readonly schemas = new SchemaRegistry()
  private readonly maxResubmits: number

  constructor(ctx: Context, config: Config) {
    super(ctx, 'turnReceipts')
    this.maxResubmits = config.maxResubmits ?? 2
    ctx.store.migrate('turn-receipts', [{
      version: 1,
      sql: `CREATE TABLE turn_receipts (
        id TEXT PRIMARY KEY, account TEXT NOT NULL, session_hash TEXT NOT NULL,
        receipt TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX turn_receipts_session ON turn_receipts (account, session_hash);`,
    }])
  }

  read(identity: TurnIdentity): TurnReceipt | undefined {
    const row = this.ctx.store.db.prepare('SELECT receipt FROM turn_receipts WHERE id = ?').get(receiptId(identity)) as { receipt: string } | undefined
    return row ? (JSON.parse(row.receipt) as TurnReceipt) : undefined
  }

  /**
   * Persist the receipt before the prompt is sent. Re-submitting the same identity is a
   * bounded resubmission and must carry the same prompt and the same response boundary.
   */
  submit(input: Submission): TurnReceipt {
    const promptHash = sha256(input.prompt)
    const previousResponseHash = input.previousResponse === null ? null : responseHash(input.previousResponse)
    return this.ctx.store.transaction(() => {
      const current = this.read(input)
      if (current) {
        if (current.promptHash !== promptHash) throw new ProviderError('invalid_input', 'request id was reused with a different prompt')
        if (current.previousResponseHash !== previousResponseHash) throw new ProviderError('invalid_input', 'resubmission no longer matches its original response boundary')
        if (current.resubmits >= this.maxResubmits) throw new ProviderError('reconciliation_failed', `resubmission bound (${this.maxResubmits}) reached`)
      }
      const next: TurnReceipt = current
        ? { ...current, resubmits: current.resubmits + 1 }
        : {
            schema: 'provider-turn-receipt@1.0', account: input.account, requestId: input.requestId,
            conversation: input.conversation, promptHash, previousResponseHash, mode: input.mode, status: 'SUBMITTED', resubmits: 0,
          }
      return this.write(input, next)
    })
  }

  /** Record the canonical conversation once; a receipt is never rebound to another conversation. */
  bindConversation(identity: TurnIdentity, binding: string): TurnReceipt {
    required(binding, 'conversation binding')
    return this.ctx.store.transaction(() => {
      const current = this.require(identity)
      if (current.conversation.binding === binding) return current
      if (current.conversation.binding !== '') throw new ProviderError('reconciliation_failed', 'receipt cannot be rebound to another conversation')
      return this.write(identity, { ...current, conversation: { ...current.conversation, binding } })
    })
  }

  /** Mark the turn completed; idempotent for the same response, refuses conflicting content. */
  complete(identity: TurnIdentity, result: { response: string; providerTurnId: string }): TurnReceipt {
    required(result.response, 'completion response')
    const hash = responseHash(result.response)
    return this.ctx.store.transaction(() => {
      const current = this.require(identity)
      if (current.status === 'COMPLETED') {
        if (current.responseHash !== hash) throw new ProviderError('reconciliation_failed', 'turn completed with conflicting response content')
        return current
      }
      return this.write(identity, { ...current, status: 'COMPLETED', responseHash: hash, providerTurnId: result.providerTurnId })
    })
  }

  /** Decide WAIT / RECOVER / RESUBMIT / AMBIGUOUS and record the decision (INV-13). */
  /** `prompt`: the turn's prompt, so one the page already shows is never resent (INV-4). */
  reconcile(identity: TurnIdentity, snapshot: TurnSnapshot, options: { prompt?: string } = {}): { outcome: Reconciliation; decision: ContentId } {
    return this.ctx.store.transaction(() => {
      const current = this.require(identity)
      const outcome = reconcileTurn(current, snapshot, { maxResubmits: this.maxResubmits, ...options })
      // Waiting is recorded once: a provider still generating is looked at again and again.
      const last = current.reconciliations?.at(-1)
      if (outcome === 'WAIT' && last && (this.ctx.artifacts.get(last)?.body as { outcome?: { option?: string } } | undefined)?.outcome?.option === 'WAIT') {
        return { outcome, decision: last }
      }
      const envelope = this.ctx.artifacts.recordDecision({
        decisionType: 'reconciliation',
        question: `How to continue provider turn ${current.requestId} on ${current.account}?`,
        inputs: [],
        candidates: OUTCOMES.map((option) => ({ option, selected: option === outcome, reasons: [option === outcome ? this.reason(current, snapshot, outcome, options.prompt) : this.rejected(current, snapshot, option, options.prompt)] })),
        decider: { type: 'rule', id: 'provider-turns.reconcile', version: '1' },
        outcome: { option: outcome, detail: { receipt: receiptId(identity), snapshotHash: responseHash(snapshot.text), running: snapshot.running, observable: snapshot.observable !== false } },
        deterministic: true,
      }, { producer: { type: 'system', ref: 'turn-receipts' } })
      this.write(identity, { ...current, reconciliations: [...(current.reconciliations ?? []), envelope.id] })
      return { outcome, decision: envelope.id }
    })
  }

  /** Remove one turn's receipt, when its turn is forgotten (retention, INV-9). True if one existed. */
  delete(identity: TurnIdentity): boolean {
    return Number(this.ctx.store.db.prepare('DELETE FROM turn_receipts WHERE id = ?').run(receiptId(identity)).changes) > 0
  }

  private require(identity: TurnIdentity): TurnReceipt {
    const receipt = this.read(identity)
    if (!receipt) throw new ProviderError('reconciliation_failed', 'provider turn receipt does not exist')
    return receipt
  }

  private write(identity: TurnIdentity, receipt: TurnReceipt): TurnReceipt {
    this.schemas.assertRecord(receipt)
    this.ctx.store.db.prepare(`INSERT INTO turn_receipts (id, account, session_hash, receipt, revision, updated_at) VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET receipt = excluded.receipt, revision = turn_receipts.revision + 1, updated_at = excluded.updated_at`)
      .run(receiptId(identity), identity.account, sha256(identity.sessionId), JSON.stringify(receipt), new Date().toISOString())
    return receipt
  }

  private reason(receipt: TurnReceipt, snapshot: TurnSnapshot, outcome: Reconciliation, prompt?: string): string {
    switch (outcome) {
      case 'WAIT': return 'provider is still generating the submitted turn'
      case 'RECOVER': return receipt.status === 'COMPLETED' ? 'page shows the recorded response' : 'a new response exists after the boundary'
      case 'RESUBMIT': return `nothing new after the boundary; resubmit ${receipt.resubmits + 1} of ${this.maxResubmits}`
      default:
        if (snapshot.observable === false) return 'the conversation cannot be observed (temporary, never bound, or not rendered); the prompt may have been answered'
        if (prompt !== undefined && promptShown(snapshot.lastPrompt, prompt)) return 'the page shows the prompt as the last user turn, without an answer yet; resending would duplicate it'
        return snapshot.running ? 'generating after completion' : 'state does not match the receipt or the bound is reached'
    }
  }

  /**
   * Why `option` is not the outcome: the first condition `reconcileTurn` holds it to that fails
   * on this receipt and snapshot (INV-13: a rejected candidate carries its reason).
   */
  private rejected(receipt: TurnReceipt, snapshot: TurnSnapshot, option: Reconciliation, prompt?: string): string {
    const text = snapshot.text.trim()
    const unobservable = snapshot.observable === false
    const completed = receipt.status === 'COMPLETED'
    // Whether the page shows what reconcileTurn would adopt: the recorded response, or a new one after the boundary.
    const adoptable = completed ? text !== '' && receipt.responseHash === responseHash(text) : text !== '' && responseHash(text) !== receipt.previousResponseHash
    switch (option) {
      case 'WAIT':
        if (unobservable) return 'not WAIT: the conversation cannot be observed'
        return snapshot.running ? 'not WAIT: the provider is generating although the turn was completed' : 'not WAIT: the provider is not generating'
      case 'RECOVER':
        if (unobservable) return 'not RECOVER: the conversation cannot be observed, so no response can be adopted'
        if (snapshot.running) return 'not RECOVER: the provider is still generating'
        if (completed) return 'not RECOVER: the page does not show the recorded response'
        return text === '' ? 'not RECOVER: the page shows no response' : 'not RECOVER: the page shows only the response this turn followed'
      case 'RESUBMIT':
        if (unobservable) return 'not RESUBMIT: the conversation cannot be observed; the prompt may have been answered'
        if (snapshot.running) return 'not RESUBMIT: the provider is generating'
        if (completed) return 'not RESUBMIT: the turn is completed'
        if (adoptable) return 'not RESUBMIT: a new response follows the boundary'
        if (boundaryMissing(receipt, snapshot)) return 'not RESUBMIT: the page no longer shows the response this turn followed, so whether the prompt was sent cannot be told'
        if (prompt !== undefined && promptShown(snapshot.lastPrompt, prompt)) return 'not RESUBMIT: the page shows the prompt as its last user turn'
        return `not RESUBMIT: the bound of ${this.maxResubmits} resubmits is reached`
      default:
        if (snapshot.running) return 'not AMBIGUOUS: a submitted turn still generating agrees with the receipt'
        if (adoptable) return completed ? 'not AMBIGUOUS: the page shows the recorded response' : 'not AMBIGUOUS: a new response follows the boundary'
        return `not AMBIGUOUS: the page shows the response this turn followed and nothing after it, not the prompt, and ${this.maxResubmits - receipt.resubmits} resubmit(s) remain`
    }
  }
}

export default TurnReceipts
