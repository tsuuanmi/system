import { type Context, Service } from '@deepseek-ai/cordis'

/** A stored entry (schemas/event.v1.json). */
export interface SystemEvent {
  schema: 'event@1.0'
  seq: number
  at: string
  type: string
  runId?: string
  nodeId?: string
  sessionId?: string
  turnId?: string
  decision?: string
  data?: Record<string, unknown>
}

export type NewEvent = Omit<SystemEvent, 'schema' | 'seq' | 'at'>

/** What `query` filters on; every field narrows the entries read. */
export interface EventQuery {
  afterSeq?: number
  beforeSeq?: number
  order?: 'asc' | 'desc'
  type?: string
  runId?: string
  nodeId?: string
  sessionId?: string
  turnId?: string
  since?: string
  limit?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    eventLog: EventLog
  }
  interface Events {
    /**
     * An entry was committed to the event log. Listeners observe; they cannot veto.
     * @mode emit
     */
    'system/event'(event: SystemEvent): void
  }
}

/**
 * `ctx.eventLog`: the append-only observability trail (QA-7). Named `eventLog` because Cordis
 * itself owns `ctx.events`. Entries are validated against `event@1.0`, carry references instead of
 * private content, and are announced live as `system/event`. A guarantee seam: a provider passes
 * `conformance/event-log.ts` (ADR-0036).
 */
export abstract class EventLog extends Service {
  constructor(ctx: Context) {
    super(ctx, 'eventLog')
  }

  /** Delete entries older than the provider's retention before `now`; the count deleted. */
  abstract trim(now?: number, batch?: number): number

  /** Validate and append one entry; the log assigns `seq` and `at`. */
  abstract append(input: NewEvent): SystemEvent

  /**
   * Read entries after `afterSeq` in order, optionally filtered; at most 1000 per call. Contract 1.1:
   * only entries before `beforeSeq` too, and with `order: 'desc'` the newest first. A value it cannot
   * honour is refused, never ignored (INV-2).
   */
  abstract query(filter?: EventQuery): SystemEvent[]
}
