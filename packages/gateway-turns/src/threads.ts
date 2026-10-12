/**
 * Threads: a client conversation bound to one persistent provider conversation. The first
 * request opens it with the whole history; a later request sends only what came after the last
 * assistant turn (tool results, new user turns), because the provider conversation already holds
 * its own replies. It resumes only when the history up to that turn is exactly what the provider
 * conversation saw (a fingerprint stored with the binding): another client with the same opening,
 * or a history edited after the fact, opens a fresh conversation instead. Each exchange is an `ask` run on the workflow engine: routed, egress-checked,
 * receipted, and explainable.
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { sha256 } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import type { RunView } from '@tsuuanmi/system-workflow'
import { claimsNoAccess, estimateTokens, NUDGE, parseToolCalls, renderOpening, renderSuffix, type Tier, type ToolCall, type ToolSpec, type Turn } from './protocol.ts'

export interface ExchangeInput {
  /** The binding key: stable for one client conversation (and its tier). */
  key: string
  tier: Tier
  /** The agent's instructions (system prompt), as text. */
  system: string
  tools: readonly ToolSpec[]
  /** The whole client history, oldest first. */
  turns: readonly Turn[]
  /** True once the client has gone away: the exchange stops waiting. */
  closed: () => boolean
  /** Call ids for new calls (each wire format has its own prefix). */
  newId?: () => string
}

export type Exchange =
  | { kind: 'reply'; runId: string; text: string; calls: ToolCall[]; promptTokens: number }
  | { kind: 'failed'; status: number; error: 'overloaded' | 'invalid' | 'api'; message: string }
  | { kind: 'closed' }

export interface ThreadsOptions {
  /** Which gateway owns these bindings (keys of different wire formats never meet). */
  scope: string
  classification?: 'public' | 'operator-shared' | 'local-private'
  /** Longest an exchange may wait for its turns (default 15 min). */
  timeoutMs?: number
}

interface Row {
  session_id: string
  names: string
  history: string | null
}

/**
 * What a provider conversation has seen, up to and including an assistant turn: user text and
 * tool results, and the assistant's text and call ids (a client echoes a call without its input).
 * Call ids are random per reply, so two clients never share one.
 */
function fingerprint(turns: readonly Turn[]): string {
  return sha256(JSON.stringify(turns.map((turn) => [turn.role, turn.parts.flatMap((part) => {
    if (part.kind === 'call') return [['c', part.id]]
    if (part.kind === 'result') return [['r', part.id, part.text]]
    const text = part.text.replace(/\s+/g, ' ').trim()
    return text ? [['t', text]] : []
  })])))
}

export class Threads {
  constructor(private readonly ctx: Context, private readonly options: ThreadsOptions) {
    ctx.store.migrate('gateway-turns', [{
      version: 1,
      sql: 'CREATE TABLE gateway_threads (scope TEXT NOT NULL, key TEXT NOT NULL, session_id TEXT NOT NULL, names TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope, key));',
    }, {
      // The conversation's fingerprint: a binding is resumed only by the history it came from.
      version: 2,
      sql: 'ALTER TABLE gateway_threads ADD COLUMN history TEXT;',
    }])
  }

  /** One client request: the provider turn (and at most one nudge), then the binding is recorded. */
  async exchange(input: ExchangeInput): Promise<Exchange> {
    const bound = this.ctx.store.db.prepare('SELECT session_id, names, history FROM gateway_threads WHERE scope = ? AND key = ?').get(this.options.scope, input.key) as Row | undefined
    const names = new Map<string, string>(bound ? (JSON.parse(bound.names) as Array<[string, string]>) : [])
    for (const turn of input.turns) for (const part of turn.parts) if (part.kind === 'call') names.set(part.id, part.name)
    const last = input.turns.findLastIndex((t) => t.role === 'assistant')
    const resumed = bound && last >= 0 && last < input.turns.length - 1 && bound.history === fingerprint(input.turns.slice(0, last + 1))
    const prompt = resumed ? renderSuffix(input.turns.slice(last + 1), names) : renderOpening(input.system, input.tools, input.turns, names)
    const deadline = Date.now() + (this.options.timeoutMs ?? 15 * 60_000)

    let outcome = await this.turn(prompt, input.tier, resumed ? bound.session_id : undefined, input.closed, deadline)
    if (!('run' in outcome)) return outcome
    let run = outcome.run
    const offered = new Set(input.tools.map((t) => t.name))
    const newId = input.newId ?? ((): string => `call_${randomBytes(12).toString('hex')}`)
    let parsed = parseToolCalls(run.answer ?? '', offered, newId)
    // A web model sometimes forgets that the agent runs its tools: one nudge, in the same conversation.
    if (offered.size && !parsed.calls.length && claimsNoAccess(parsed.text) && run.sessionId) {
      outcome = await this.turn(NUDGE, input.tier, run.sessionId, input.closed, deadline)
      if (outcome.kind === 'closed') return outcome
      if ('run' in outcome) {
        run = outcome.run
        parsed = parseToolCalls(run.answer ?? '', offered, newId)
      }
    }
    for (const call of parsed.calls) names.set(call.id, call.name)
    // What the provider conversation now holds: the history, then this reply as the client will echo it.
    const reply: Turn = { role: 'assistant', parts: [{ kind: 'text', text: parsed.text }, ...parsed.calls.map((c) => ({ kind: 'call' as const, id: c.id, name: c.name, input: c.input }))] }
    this.ctx.store.db.prepare(`INSERT INTO gateway_threads (scope, key, session_id, names, history, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope, key) DO UPDATE SET session_id = excluded.session_id, names = excluded.names, history = excluded.history, updated_at = excluded.updated_at`)
      .run(this.options.scope, input.key, run.sessionId ?? bound?.session_id ?? '', JSON.stringify([...names].slice(-500)), fingerprint([...input.turns, reply]), new Date().toISOString())
    return { kind: 'reply', runId: run.runId, text: parsed.text, calls: parsed.calls, promptTokens: estimateTokens(prompt) }
  }

  /** One ask run, waited for while the client stays connected. */
  private async turn(prompt: string, tier: Tier, sessionId: string | undefined, closed: () => boolean, deadline: number): Promise<{ kind: 'run'; run: RunView } | Exclude<Exchange, { kind: 'reply' }>> {
    let run: RunView
    try {
      run = this.ctx.workflow.start({
        template: 'ask', input: prompt, tier, classification: this.options.classification ?? 'operator-shared',
        ...(sessionId ? { sessionId } : { persist: true }),
      })
    } catch (e) {
      const overloaded = (e as { kind?: string }).kind === 'overloaded'
      return { kind: 'failed', status: overloaded ? 529 : 400, error: overloaded ? 'overloaded' : 'invalid', message: (e as Error).message }
    }
    while (run.status === 'running' && Date.now() < deadline && !closed()) run = await this.ctx.workflow.wait(run.runId, Math.min(30_000, deadline - Date.now()))
    if (closed()) return { kind: 'closed' }
    if (run.status === 'completed') return { kind: 'run', run }
    const message = run.status === 'running' ? `run ${run.runId} did not finish in time` : `${run.error?.kind ?? 'failed'}: ${run.error?.message ?? ''} (system explain ${run.runId})`
    const backoff = run.error?.disposition === 'BACKOFF'
    return { kind: 'failed', status: backoff ? 529 : 500, error: backoff ? 'overloaded' : 'api', message }
  }
}
