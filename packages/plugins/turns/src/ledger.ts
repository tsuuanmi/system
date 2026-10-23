/**
 * The conversation ledger (PROP-0004 Phase 5, docs/design/provider-turns.md#conversation-ledger):
 * every website conversation `system` creates, recorded when it is bound and kept after the turn
 * records and receipts expire. When the session that owns a conversation is released (its run
 * deleted or expired), the conversation is deleted on its site: one recorded conversation at a
 * time, from its own menu, on the account's scheduler with the page held exclusively. A
 * deletion is irreversible and chosen by rule, so each release is a `retention` decision
 * (INV-13); a deletion that may have happened is checked on the site before it is tried again
 * (reconcile-before-repeat, INV-4). A chat the operator started by hand is never touched.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '@tsuuanmi/system-leases'
import type { ContentId } from '@tsuuanmi/system-libs'
import { type BrowserTurn, type ConversationMode, type ProviderDriver, ProviderError, type ProviderFeature, type ProviderScheduler, toProviderError } from '@tsuuanmi/system-provider-core'

export type LedgerState = 'live' | 'due' | 'deleted' | 'kept' | 'failed'

/** What callers see of one recorded conversation. */
export interface ConversationView {
  schema: 'conversation@1.0'
  account: string
  binding: string
  sessionId?: string
  /** The turn that opened it. */
  turnId: string
  feature: ProviderFeature
  mode: ConversationMode
  state: LedgerState
  /** Why it is kept, or what the last failed deletion said. */
  reason?: string
  attempts: number
  createdAt: string
  releasedAt?: string
  deletedAt?: string
  /** The `retention` decision that released it. */
  decision?: ContentId
}

interface LedgerRow {
  account: string
  binding: string
  session_id: string | null
  turn_id: string
  feature: string
  mode: string
  state: LedgerState
  reason: string | null
  attempts: number
  decision: string | null
  /** When a deletion's irreversible confirm was about to be clicked: from then on it is only checked, never clicked again. */
  confirmed_at: string | null
  created_at: string
  released_at: string | null
  deleted_at: string | null
  updated_at: string
}

/** Attempts before a deletion is reported as failed (in health). */
export const MAX_DELETE_ATTEMPTS = 3
const LEASE_TTL_MS = 60_000

/**
 * The ledger table, backfilled from the turns that still hold a binding (at most the turns'
 * retention old): older conversations were never recorded and are not deleted.
 */
export const LEDGER_MIGRATION = {
  version: 7,
  sql: `CREATE TABLE turn_conversations (
    account TEXT NOT NULL, binding TEXT NOT NULL, session_id TEXT, turn_id TEXT NOT NULL,
    feature TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, reason TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, decision TEXT, confirmed_at TEXT,
    created_at TEXT NOT NULL, released_at TEXT, deleted_at TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (account, binding)
  );
  CREATE INDEX turn_conversations_state ON turn_conversations (state);
  CREATE INDEX turn_conversations_session ON turn_conversations (session_id);
  INSERT OR IGNORE INTO turn_conversations (account, binding, session_id, turn_id, feature, mode, state, reason, created_at, updated_at)
    SELECT account, binding, session_id, turn_id, feature, mode,
      CASE WHEN mode = 'temporary' THEN 'kept' ELSE 'live' END, CASE WHEN mode = 'temporary' THEN 'temporary' END, created_at, created_at
    FROM turns WHERE account IS NOT NULL AND binding IS NOT NULL ORDER BY created_at;`,
}

const now = (): string => new Date().toISOString()

/** What the ledger needs of the turn runtime. */
export interface LedgerHost {
  ctx: Context
  scheduler(account: string): ProviderScheduler
  stopping(): boolean
  /** The page an operation on the account runs in (its login profile when session-bound, ADR-0030). */
  openPage(account: string, driver: ProviderDriver, signal?: AbortSignal): Promise<BrowserTurn>
}

/**
 * Record a conversation when it is bound, inside the turn's fenced transaction, so no binding
 * exists without its row. A temporary chat leaves the history on its own and is kept.
 */
export function recordConversation(db: DatabaseSync, row: { account: string; binding: string; sessionId: string | null; turnId: string; feature: string; mode: string }): void {
  const temporary = row.mode === 'temporary'
  // A due conversation that a turn uses again is live again: never deleted under it (unless its
  // deletion was already confirmed, which nothing can take back).
  db.prepare(`INSERT INTO turn_conversations (account, binding, session_id, turn_id, feature, mode, state, reason, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account, binding) DO UPDATE SET state = 'live', released_at = NULL, decision = NULL, reason = NULL,
      session_id = excluded.session_id, turn_id = excluded.turn_id, updated_at = excluded.updated_at
    WHERE turn_conversations.state = 'due' AND turn_conversations.confirmed_at IS NULL`)
    .run(row.account, row.binding, row.sessionId, row.turnId, row.feature, row.mode, temporary ? 'kept' : 'live', temporary ? 'temporary' : null, now(), now())
}

const view = (r: LedgerRow): ConversationView => ({
  schema: 'conversation@1.0', account: r.account, binding: r.binding, ...(r.session_id ? { sessionId: r.session_id } : {}), turnId: r.turn_id,
  feature: r.feature as ProviderFeature, mode: r.mode as ConversationMode, state: r.state, ...(r.reason ? { reason: r.reason } : {}),
  attempts: r.attempts, createdAt: r.created_at, ...(r.released_at ? { releasedAt: r.released_at } : {}),
  ...(r.deleted_at ? { deletedAt: r.deleted_at } : {}), ...(r.decision ? { decision: r.decision as ContentId } : {}),
})

/**
 * Whether a session's conversation was released (its run deleted or expired) and none of its
 * conversations is live: continuing it would silently start a new conversation without its context.
 */
export function sessionReleased(db: DatabaseSync, sessionId: string): boolean {
  const states = (db.prepare("SELECT state FROM turn_conversations WHERE session_id = ? AND mode != 'temporary'").all(sessionId) as Array<{ state: LedgerState }>).map((r) => r.state)
  return states.length > 0 && !states.includes('live') && states.some((s) => s === 'due' || s === 'deleted' || s === 'failed')
}

export function listConversations(db: DatabaseSync, filter: { state?: LedgerState; sessionId?: string } = {}): ConversationView[] {
  const rows = db.prepare(`SELECT * FROM turn_conversations WHERE (? IS NULL OR state = ?) AND (? IS NULL OR session_id = ?) ORDER BY created_at, binding`)
    .all(filter.state ?? null, filter.state ?? null, filter.sessionId ?? null, filter.sessionId ?? null) as unknown as LedgerRow[]
  return rows.map(view)
}

/**
 * Release sessions: their live conversations become due for deletion, by the rule
 * `turns.conversation-retention`, recorded as one `retention` decision for the batch (INV-13).
 * Called by the session's owner, inside its own transaction when it has one.
 */
export function releaseSessions(host: LedgerHost, sessionIds: readonly string[], reason: string): { due: number; decision?: ContentId } {
  const sessions = [...new Set(sessionIds)].sort()
  if (!sessions.length) return { due: 0 }
  return host.ctx.store.transaction((db) => {
    const marks = sessions.map(() => '?').join(', ')
    const rows = db.prepare(`SELECT * FROM turn_conversations WHERE state = 'live' AND session_id IN (${marks}) ORDER BY account, binding`).all(...sessions) as unknown as LedgerRow[]
    if (!rows.length) return { due: 0 }
    const decision = host.ctx.artifacts.recordDecision({
      schema: 'decision@1.3', decisionType: 'retention', question: `Are the website conversations of ${sessions.length} released session(s) deleted?`, inputs: [],
      candidates: [{ option: 'delete', selected: true, reasons: [`${reason}: a released session's recorded conversations are deleted on their sites`] }, { option: 'keep', selected: false, reasons: [`not keep: the session(s) are released (${reason}), and the rule keeps only a live session's conversations`] }],
      decider: { type: 'rule', id: 'turns.conversation-retention', version: '1' },
      outcome: { option: 'delete', detail: { reason, sessions, conversations: rows.map((r) => ({ account: r.account, binding: r.binding })) } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'turns' } }).id
    const at = now()
    for (const r of rows) {
      db.prepare("UPDATE turn_conversations SET state = 'due', released_at = ?, decision = ?, updated_at = ? WHERE account = ? AND binding = ? AND state = 'live'").run(at, decision, at, r.account, r.binding)
    }
    // A later turn of a released session never reopens the conversation being deleted; it fails
    // as conversation_lost rather than start over without its context.
    db.prepare(`UPDATE turn_sessions SET binding = NULL WHERE session_id IN (${marks})`).run(...sessions)
    host.ctx.get('eventLog')?.append({ type: 'conversation.released', data: { reason, sessions: sessions.length, conversations: rows.length, decision } })
    return { due: rows.length, decision }
  })
}

/**
 * Delete every due conversation that can be deleted now, one account slot at a time. A
 * conversation of a feature its driver cannot delete yet, or of a site with no deletion, is kept
 * and says why. A signed-out or stopped account leaves it due for the next pass.
 */
export async function deleteDue(host: LedgerHost): Promise<{ deleted: number; failed: number; retryInMs?: number }> {
  const { ctx } = host
  const due = ctx.store.db.prepare("SELECT * FROM turn_conversations WHERE state = 'due' ORDER BY released_at, account, binding").all() as unknown as LedgerRow[]
  let deleted = 0
  let failed = 0
  // A deletion another process holds (or held, before it crashed) is looked at again once its lease expires.
  let retryInMs: number | undefined
  for (const row of due) {
    if (host.stopping()) break
    const outcome = await ctx.leases.hold(`conversation:${row.account}:${row.binding}`, LEASE_TTL_MS, async ({ lease, lost }) => deleteOne(host, row, lease, lost))
      .catch((error: unknown) => {
        ctx.logger.warn(`turns: deleting conversation ${row.binding} of ${row.account} failed unexpectedly: ${(error as Error).message}`)
        return undefined
      })
    if (outcome && !outcome.held) retryInMs = Math.max(retryInMs ?? 0, outcome.retryInMs)
    if (outcome?.held && outcome.value === 'deleted') deleted++
    if (outcome?.held && outcome.value === 'failed') failed++
  }
  return { deleted, failed, ...(retryInMs !== undefined ? { retryInMs } : {}) }
}

type Outcome = 'deleted' | 'kept' | 'failed' | 'retry' | 'waiting'

async function deleteOne(host: LedgerHost, row: LedgerRow, lease: () => Lease, lost: AbortSignal): Promise<Outcome> {
  const { ctx } = host
  const current = ctx.store.db.prepare('SELECT * FROM turn_conversations WHERE account = ? AND binding = ?').get(row.account, row.binding) as unknown as LedgerRow | undefined
  if (current?.state !== 'due') return 'waiting'
  const attempts = current.attempts + 1
  const set = (fields: Partial<Pick<LedgerRow, 'state' | 'reason' | 'attempts' | 'deleted_at' | 'confirmed_at'>>): void => {
    ctx.store.transaction((db) => {
      ctx.leases.fence(lease())
      const entries = Object.entries(fields)
      db.prepare(`UPDATE turn_conversations SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE account = ? AND binding = ?`)
        .run(...entries.map(([, v]) => v as string | number | null), now(), row.account, row.binding)
    })
  }
  let account: Awaited<ReturnType<typeof ctx.accounts.get>>
  try {
    account = await ctx.accounts.get(row.account)
  } catch (error) {
    // Only an account the catalog no longer has is removed; one that cannot be read now (its
    // record unreadable, say) is unknown, and the conversation stays due for the next pass.
    if (error instanceof ProviderError && error.kind === 'invalid_input') {
      set({ state: 'kept', reason: 'the account was removed' })
      return 'kept'
    }
    set({ reason: `the account cannot be read: ${(error as Error).message.slice(0, 200)}` })
    return 'waiting'
  }
  const driver = ctx.providers.list().includes(account.provider) ? ctx.providers.get(account.provider) : undefined
  if (!driver?.deleteConversation) {
    set({ state: 'kept', reason: `${account.provider} cannot delete a conversation` })
    return 'kept'
  }
  if (!(driver.deletes ?? []).includes(row.feature as ProviderFeature)) {
    set({ state: 'kept', reason: `a ${row.feature} conversation is not deleted until a live check shows the deletion works for it` })
    return 'kept'
  }
  // A delete flow guessed from documentation is never clicked: the conversation waits, due, until
  // the live check marks every entry it uses verified.
  // A driver that does not say its flow is checked is taken as unchecked: fail closed.
  const unverified = driver.deletionUnverified ? driver.deletionUnverified() : ['(the driver does not report its delete flow as checked)']
  if (unverified.length) {
    if (current.reason !== `unverified-map: ${unverified.join(', ')}`) set({ reason: `unverified-map: ${unverified.join(', ')}` })
    return 'waiting'
  }
  // A signed-out account cannot delete: the conversation stays due until it is signed in again.
  if (account.status !== 'ready') return 'waiting'
  try {
    // The page is the account's alone while the deletion runs: never beside a turn.
    const result = await host.scheduler(row.account).runExclusive(async () => {
      // Read again in the slot: a turn that used it meanwhile made it live again.
      const now_ = ctx.store.db.prepare('SELECT * FROM turn_conversations WHERE account = ? AND binding = ?').get(row.account, row.binding) as unknown as LedgerRow | undefined
      if (now_?.state !== 'due') return 'skipped' as const
      const turn = await host.openPage(row.account, driver, lost)
      try {
        return await driver.deleteConversation!(turn.page, row.binding, {
          // Recorded before the irreversible click: from then on it is only ever checked.
          beforeConfirm: () => set({ confirmed_at: now() }),
          confirmed: now_.confirmed_at !== null,
        })
      } finally {
        await turn.close()
      }
    }, lost)
    if (result === 'skipped') return 'waiting'
    set({ state: 'deleted', deleted_at: now(), reason: result === 'gone' ? 'already gone from the site' : null, attempts })
    ctx.get('eventLog')?.append({ type: 'conversation.deleted', data: { account: row.account, binding: row.binding, found: result } })
    return 'deleted'
  } catch (error) {
    const failure = toProviderError(error)
    // Not an attempt: the account must sign in again (the site showed it signed out, so health
    // shows it too), or the runtime is stopping.
    if (failure.kind === 'reauth_required') await ctx.accounts.markSignedOut(row.account, 'login-surface', account.revision).catch(() => undefined)
    if (failure.kind === 'reauth_required' || failure.kind === 'aborted' || lost.aborted) return 'waiting'
    // Once a confirm was clicked, a failure is never retried: another click could reach another chat.
    const confirmed = (ctx.store.db.prepare('SELECT confirmed_at FROM turn_conversations WHERE account = ? AND binding = ?').get(row.account, row.binding) as { confirmed_at: string | null } | undefined)?.confirmed_at
    const exhausted = attempts >= MAX_DELETE_ATTEMPTS || !!confirmed
    set({ state: exhausted ? 'failed' : 'due', reason: `${failure.kind}: ${failure.message.slice(0, 300)}`, attempts })
    ctx.get('eventLog')?.append({ type: exhausted ? 'conversation.delete-failed' : 'conversation.delete-retried', data: { account: row.account, binding: row.binding, attempts, kind: failure.kind } })
    return exhausted ? 'failed' : 'retry'
  }
}

