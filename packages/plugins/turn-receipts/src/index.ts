/**
 * `ctx.turnReceipts`: provider turn receipts, persisted **before** submission and
 * reconciled after restarts (docs/design/provider-turns.md, INV-4). Ported from
 * tsuuanmi/internet's ProviderTurnReceiptStore onto `ctx.store`; every reconciliation is
 * recorded as a decision artifact (INV-13).
 * @module @tsuuanmi/system-turn-receipts
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-artifacts'
import { type ContentId, SchemaRegistry, sha256 } from '@tsuuanmi/system-libs'
import { ProviderError, type Reconciliation, type TurnReceipt, type TurnSnapshot, reconcileTurn, responseHash } from '@tsuuanmi/system-provider-core'
import type {} from '@tsuuanmi/system-store'

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
  reconcile(identity: TurnIdentity, snapshot: TurnSnapshot): { outcome: Reconciliation; decision: ContentId } {
    return this.ctx.store.transaction(() => {
      const current = this.require(identity)
      const outcome = reconcileTurn(current, snapshot, { maxResubmits: this.maxResubmits })
      const envelope = this.ctx.artifacts.recordDecision({
        decisionType: 'reconciliation',
        question: `How to continue provider turn ${current.requestId} on ${current.account}?`,
        inputs: [],
        candidates: OUTCOMES.map((option) => ({ option, selected: option === outcome, reasons: option === outcome ? [this.reason(current, snapshot, outcome)] : [] })),
        decider: { type: 'rule', id: 'provider-turns.reconcile', version: '1' },
        outcome: { option: outcome, detail: { receipt: receiptId(identity), snapshotHash: responseHash(snapshot.text), running: snapshot.running, observable: snapshot.observable !== false } },
        deterministic: true,
      }, { producer: { type: 'system', ref: 'turn-receipts' } })
      this.write(identity, { ...current, reconciliations: [...(current.reconciliations ?? []), envelope.id] })
      return { outcome, decision: envelope.id }
    })
  }

  /** Remove every receipt of one owner session. */
  deleteSession(account: string, sessionId: string): number {
    const result = this.ctx.store.transaction((db) =>
      db.prepare('DELETE FROM turn_receipts WHERE account = ? AND session_hash = ?').run(account, sha256(required(sessionId, 'session id'))))
    return Number(result.changes)
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

  private reason(receipt: TurnReceipt, snapshot: TurnSnapshot, outcome: Reconciliation): string {
    switch (outcome) {
      case 'WAIT': return 'provider is still generating the submitted turn'
      case 'RECOVER': return receipt.status === 'COMPLETED' ? 'page shows the recorded response' : 'a new response exists after the boundary'
      case 'RESUBMIT': return `nothing new after the boundary; resubmit ${receipt.resubmits + 1} of ${this.maxResubmits}`
      default:
        if (snapshot.observable === false) return 'the conversation cannot be observed (temporary or never bound); the prompt may have been answered'
        return snapshot.running ? 'generating after completion' : 'state does not match the receipt or the bound is reached'
    }
  }
}

export default TurnReceipts
