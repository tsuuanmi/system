/**
 * Conformance suite for `ctx.eventLog`, the append-only observability trail of the ledger of
 * record (ADR-0036; QA-7; schemas/event.v1.json). `boot` returns a context that provides
 * `ctx.eventLog` over the `ctx.store` it injects, configured with {@link RETAIN_DAYS} and the
 * default `maxDataBytes` ({@link MAX_DATA_BYTES}), and with an empty log.
 */
import type { Context } from '@deepseek-ai/cordis'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type {} from '@tsuuanmi/system-store'
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../../libs/conformance/runner.ts'
import type { NewEvent, SystemEvent } from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

/** The `retainDays` every provider under test is configured with. */
export const RETAIN_DAYS = 30
/** The default bound on serialized `data` (docs/reference/configuration.md). */
export const MAX_DATA_BYTES = 16_384

const DAY = 24 * 60 * 60_000
const schemas = new SchemaRegistry()
const DECISION = `sha256:${'a'.repeat(64)}`

const failed = (fn: () => unknown): boolean => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}
const seqs = (events: SystemEvent[]): number[] => events.map((e) => e.seq)
/** The same time, written with a UTC offset of `hours`. */
const withOffset = (ms: number, hours: number): string => {
  const shifted = new Date(ms + hours * 3_600_000).toISOString().slice(0, 19)
  const sign = hours < 0 ? '-' : '+'
  return `${shifted}${sign}${String(Math.abs(hours)).padStart(2, '0')}:00`
}

const scenario = (id: string, title: string, run: (ctx: Context) => Promise<void>, since = '1.0'): Scenario<Boot> => ({
  id: `eventLog.${id}`, since, title,
  run: async (boot) => {
    const { ctx, dispose } = await boot()
    try {
      await run(ctx)
    } finally {
      await dispose()
    }
  },
})

export const eventLogSuite = defineSuite<Boot>({
  seam: 'eventLog',
  // 1.1: a read newest first (`order: 'desc'`) and before a cursor (`beforeSeq`), so a reader takes the
  // latest entries of a run or a type without reading the log forward (T127).
  contract: '1.1',
  scenarios: [
    scenario('append-assigns-seq', 'assigns each entry the next monotonic seq and its UTC time, and stores it as an event@1.0 record read back unchanged (QA-7, INV-14)', async (ctx) => {
      const before = Date.now()
      const appended = [
        ctx.eventLog.append({ type: 'provider.turn.submitted', runId: 'run-1', nodeId: 'node-1', sessionId: 'session-1', turnId: 'turn-1', data: { account: 'acct-1' } }),
        ctx.eventLog.append({ type: 'provider.turn.completed', runId: 'run-1', decision: DECISION }),
        ctx.eventLog.append({ type: 'node.started' }),
      ]
      const after = Date.now()
      expect(seqs(appended)).toEqual([1, 2, 3])
      for (const entry of appended) {
        schemas.assertRecord(entry)
        expect(entry.schema).toBe('event@1.0')
        expect(entry.at).toMatch(/Z$/)
        expect(Date.parse(entry.at)).toBeGreaterThanOrEqual(before - 1)
        expect(Date.parse(entry.at)).toBeLessThanOrEqual(after + 1)
      }
      expect(appended[1]).toMatchObject({ decision: DECISION })
      expect(ctx.eventLog.query()).toEqual(appended)
      // Later appends never change what was already logged.
      ctx.eventLog.append({ type: 'node.completed' })
      expect(ctx.eventLog.query({ limit: 3 })).toEqual(appended)
    }),
    scenario('refuses-invalid', 'refuses an entry that is not a valid event@1.0 record, and stores none of it (INV-14, INV-2)', async (ctx) => {
      const invalid: NewEvent[] = [
        { type: 'NoDots' },
        { type: 'a.b', runId: 'has spaces' },
        { type: 'a.b', decision: 'not-a-ref' },
        { type: 'a.b', data: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])) },
        { type: 'a.b', unknown: true } as NewEvent,
      ]
      for (const entry of invalid) expect(failed(() => ctx.eventLog.append(entry)), JSON.stringify(entry)).toBe(true)
      expect(ctx.eventLog.query()).toEqual([])
      const valid = ctx.eventLog.append({ type: 'a.b' })
      expect(ctx.eventLog.query()).toEqual([valid])
    }),
    scenario('data-bounded', 'accepts data up to maxDataBytes serialized, refuses one byte more, and stores nothing of it (INV-9, QA-8)', async (ctx) => {
      // {"blob":"…"} is the blob's length plus 11 bytes.
      const at = (bytes: number): NewEvent => ({ type: 'a.b', data: { blob: 'x'.repeat(bytes - 11) } })
      expect(Buffer.byteLength(JSON.stringify(at(MAX_DATA_BYTES).data))).toBe(MAX_DATA_BYTES)
      const kept = ctx.eventLog.append(at(MAX_DATA_BYTES))
      expect(failed(() => ctx.eventLog.append(at(MAX_DATA_BYTES + 1)))).toBe(true)
      // Bytes, not characters: two-byte characters count twice.
      expect(failed(() => ctx.eventLog.append({ type: 'a.b', data: { blob: 'é'.repeat(MAX_DATA_BYTES / 2) } }))).toBe(true)
      expect(ctx.eventLog.query()).toEqual([kept])
    }),
    scenario('announces-after-commit', 'announces an entry as system/event only once its outermost transaction commits, and a rolled-back entry never (QA-7)', async (ctx) => {
      const seen: string[] = []
      ctx.on('system/event', (event) => void seen.push(`${event.seq}:${event.type}`))
      ctx.store.transaction(() => {
        ctx.eventLog.append({ type: 'a.inside' })
        expect(seen).toEqual([])
      })
      expect(seen).toEqual(['1:a.inside'])
      expect(() => ctx.store.transaction(() => {
        ctx.eventLog.append({ type: 'a.phantom' })
        throw new Error('rolled back')
      })).toThrow('rolled back')
      const real = ctx.eventLog.append({ type: 'a.real' })
      expect(seen).toEqual(['1:a.inside', `${real.seq}:a.real`])
      expect(ctx.eventLog.query().map((e) => e.type)).toEqual(['a.inside', 'a.real'])
    }),
    scenario('listener-cannot-veto', 'keeps an entry whose listener throws: a listener observes, and can neither veto nor fail the append (QA-7)', async (ctx) => {
      ctx.on('system/event', () => {
        throw new Error('listener failure')
      })
      let entry: SystemEvent | undefined
      expect(() => {
        entry = ctx.eventLog.append({ type: 'a.b' })
      }).not.toThrow()
      expect(ctx.eventLog.query()).toEqual([entry])
    }),
    scenario('query-filters', 'reads entries by type, run, node, session, and turn, each filter narrowing the others, in seq order (QA-7)', async (ctx) => {
      ctx.eventLog.append({ type: 'node.started', runId: 'r1', nodeId: 'n1' })
      ctx.eventLog.append({ type: 'node.started', runId: 'r2', nodeId: 'n1' })
      ctx.eventLog.append({ type: 'turn.submitted', runId: 'r1', nodeId: 'n2', sessionId: 's1', turnId: 't1' })
      ctx.eventLog.append({ type: 'turn.completed', runId: 'r1', nodeId: 'n2', sessionId: 's1', turnId: 't1' })
      ctx.eventLog.append({ type: 'turn.submitted', runId: 'r2', sessionId: 's2', turnId: 't2' })
      ctx.eventLog.append({ type: 'node.completed', runId: 'r1', nodeId: 'n1' })
      expect(seqs(ctx.eventLog.query({ runId: 'r1' }))).toEqual([1, 3, 4, 6])
      expect(seqs(ctx.eventLog.query({ nodeId: 'n1' }))).toEqual([1, 2, 6])
      expect(seqs(ctx.eventLog.query({ sessionId: 's1' }))).toEqual([3, 4])
      expect(seqs(ctx.eventLog.query({ turnId: 't2' }))).toEqual([5])
      expect(seqs(ctx.eventLog.query({ type: 'turn.submitted' }))).toEqual([3, 5])
      expect(seqs(ctx.eventLog.query({ runId: 'r1', nodeId: 'n1' }))).toEqual([1, 6])
      expect(seqs(ctx.eventLog.query({ runId: 'r1', type: 'turn.submitted', afterSeq: 3 }))).toEqual([])
      expect(ctx.eventLog.query({ runId: 'r3' })).toEqual([])
    }),
    scenario('query-pages', 'pages through the log after a cursor in seq order, with no gap or repeat, and never more than 1000 entries a call (QA-7, INV-9)', async (ctx) => {
      ctx.store.transaction(() => {
        for (let i = 0; i < 1001; i++) ctx.eventLog.append({ type: 'a.b', data: { i } })
      })
      const first = ctx.eventLog.query({ limit: 5000 })
      expect(first).toHaveLength(1000)
      expect(ctx.eventLog.query().length).toBeLessThanOrEqual(1000)
      const read: number[] = []
      let cursor = 0
      for (let page = ctx.eventLog.query({ afterSeq: cursor, limit: 300 }); page.length > 0; page = ctx.eventLog.query({ afterSeq: cursor, limit: 300 })) {
        expect(page.length).toBeLessThanOrEqual(300)
        read.push(...seqs(page))
        cursor = page.at(-1)!.seq
      }
      expect(read).toEqual(Array.from({ length: 1001 }, (_, i) => i + 1))
      expect(ctx.eventLog.query({ afterSeq: 1001 })).toEqual([])
    }),
    scenario('query-newest-first', 'reads newest first with order desc, filtered and bounded as in seq order, and pages back before a cursor with no gap or repeat; refuses an order or cursor it cannot honour (QA-7, INV-9, INV-2)', async (ctx) => {
      ctx.store.transaction(() => {
        for (let i = 0; i < 1001; i++) ctx.eventLog.append({ type: i % 2 ? 'a.odd' : 'a.even', runId: i < 10 ? 'r1' : 'r2', data: { i } })
      })
      // The latest entry of a run, of a type, at once.
      expect(seqs(ctx.eventLog.query({ runId: 'r1', order: 'desc', limit: 1 }))).toEqual([10])
      expect(seqs(ctx.eventLog.query({ type: 'a.odd', order: 'desc', limit: 2 }))).toEqual([1000, 998])
      expect(seqs(ctx.eventLog.query({ order: 'asc', limit: 2 }))).toEqual([1, 2])
      expect(ctx.eventLog.query({ order: 'desc', limit: 5000 })).toHaveLength(1000)
      // Paged back by beforeSeq, above afterSeq: every entry once.
      const read: number[] = []
      let before: number | undefined
      for (;;) {
        const page = ctx.eventLog.query({ order: 'desc', afterSeq: 100, limit: 300, ...(before !== undefined ? { beforeSeq: before } : {}) })
        if (!page.length) break
        expect(page.length).toBeLessThanOrEqual(300)
        read.push(...seqs(page))
        before = page.at(-1)!.seq
      }
      expect(read).toEqual(Array.from({ length: 901 }, (_, i) => 1001 - i))
      expect(seqs(ctx.eventLog.query({ beforeSeq: 4 }))).toEqual([1, 2, 3])
      expect(seqs(ctx.eventLog.query({ runId: 'r1', beforeSeq: 4, order: 'desc' }))).toEqual([3, 2, 1])
      for (const filter of [{ order: 'newest' }, { beforeSeq: Number.NaN }, { beforeSeq: 1.5 }]) expect(failed(() => ctx.eventLog.query(filter as never)), JSON.stringify(filter)).toBe(true)
    }, '1.1'),
    scenario('query-since', 'reads what happened since a time given in any UTC offset, and refuses a since that is not a time (QA-7, INV-2)', async (ctx) => {
      const before = Date.now() - 1000
      ctx.eventLog.append({ type: 'a.one' })
      ctx.eventLog.append({ type: 'a.two' })
      expect(seqs(ctx.eventLog.query({ since: withOffset(before, -5) }))).toEqual([1, 2])
      expect(seqs(ctx.eventLog.query({ since: withOffset(before, 9) }))).toEqual([1, 2])
      expect(ctx.eventLog.query({ since: withOffset(Date.now() + 3_600_000, 7) })).toEqual([])
      expect(seqs(ctx.eventLog.query({ since: new Date(before).toISOString(), type: 'a.two' }))).toEqual([2])
      expect(failed(() => ctx.eventLog.query({ since: 'yesterday' }))).toBe(true)
    }),
    scenario('retention-trims', 'trims entries older than retainDays, every one of a backlog larger than a batch, and keeps younger ones (INV-9)', async (ctx) => {
      for (let i = 0; i < 5; i++) ctx.eventLog.append({ type: 'a.b', data: { i } })
      const now = Date.now()
      expect(ctx.eventLog.trim(now + (RETAIN_DAYS - 1) * DAY)).toBe(0)
      expect(ctx.eventLog.query()).toHaveLength(5)
      expect(ctx.eventLog.trim(now + (RETAIN_DAYS + 1) * DAY, 2)).toBe(5)
      expect(ctx.eventLog.query()).toEqual([])
    }),
    scenario('seq-never-reused', 'never reuses a seq after a trim, so a cursor taken before it stays valid (QA-7, INV-9)', async (ctx) => {
      const old = [ctx.eventLog.append({ type: 'a.old' }), ctx.eventLog.append({ type: 'a.old' })]
      const cursor = old.at(-1)!.seq
      expect(ctx.eventLog.trim(Date.now() + (RETAIN_DAYS + 1) * DAY)).toBe(2)
      const next = ctx.eventLog.append({ type: 'a.new' })
      expect(next.seq).toBeGreaterThan(cursor)
      expect(ctx.eventLog.query({ afterSeq: cursor })).toEqual([next])
    }),
  ],
})
