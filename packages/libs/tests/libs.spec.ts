import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  MAX_UNKNOWN_REASON, NAMED_UNKNOWN_RUNS, SchemaError, SchemaRegistry, canonicalJson, contentId, countedWhole, countUnknownUsage, dshHome, readOrCreateSecretFile, reconciledBy, unknownUsageOf, USAGE_UNKNOWN_EVENT,
  type UsageUnknown, usageUnknown, usageUnknownOf,
} from '../src/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-libs-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('dshHome', () => {
  /** The CLI and the daemon must agree on the home, so system resolves it exactly as DSH does. */
  it('resolves the harness home by DSH\'s rule: $DSH_HOME made absolute, a blank one ignored, else ~/.dsh', () => {
    const saved = process.env['DSH_HOME']
    try {
      process.env['DSH_HOME'] = '/srv/dsh'
      expect(dshHome()).toBe('/srv/dsh')
      process.env['DSH_HOME'] = 'relative/home'
      expect(dshHome()).toBe(resolve('relative/home'))
      process.env['DSH_HOME'] = '   '
      expect(dshHome()).toBe(join(homedir(), '.dsh'))
      delete process.env['DSH_HOME']
      expect(dshHome()).toBe(join(homedir(), '.dsh'))
    } finally {
      if (saved === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = saved
    }
  })
})

describe('canonicalJson', () => {
  it('sorts keys, drops undefined members, and is stable', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}')
    expect(contentId({ x: 1, y: 2 })).toBe(contentId({ y: 2, x: 1 }))
    expect(contentId({ x: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('rejects values that cannot hash reproducibly', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError)
    expect(() => canonicalJson(new Date())).toThrow(TypeError)
  })
})

describe('SchemaRegistry', () => {
  const registry = new SchemaRegistry()

  it('validates a record by its schema tag (REQ-ART-4)', () => {
    const decision: Record<string, unknown> = {
      schema: 'decision@1.0', decisionType: 'route', question: 'q', inputs: [],
      candidates: [{ option: 'a', selected: true, reasons: [] }],
      decider: { type: 'rule', id: 'r', version: '1' }, outcome: { option: 'a' }, deterministic: true,
    }
    expect(() => registry.assertRecord(decision)).not.toThrow()
    expect(() => registry.assertRecord({ ...decision, candidates: [] } as Record<string, unknown>)).toThrow(SchemaError)
  })

  it('rejects unknown majors and malformed tags (REQ-ART-4, INV-14)', () => {
    expect(() => registry.assert('decision@9.0', {})).toThrow(/unsupported major/)
    expect(() => registry.assert('nope', {})).toThrow(/malformed/)
  })

  it('validates against one definition of a schema, such as an MCP tool\'s input, and refuses one the schema does not have', () => {
    expect(() => registry.assertDef('mcp-board@1.0', 'board-claim-input', { taskId: 'task-1', owner: 'lead' })).not.toThrow()
    expect(() => registry.assertDef('mcp-board@1.0', 'board-claim-input', { taskId: 'task-1' })).toThrow(SchemaError)
    expect(() => registry.assertDef('mcp-board@1.0', 'board-claim-input', { taskId: 'task-1', owner: 'lead', extra: 1 })).toThrow(/board-claim-input/)
    expect(() => registry.assertDef('mcp-board@1.0', 'no-such-tool', {})).toThrow(/no definition/)
    expect(() => registry.assertDef('mcp-board@1.0', '../x', {})).toThrow(/malformed definition/)
    expect(() => registry.assertDef('mcp-board@9.0', 'board-claim-input', {})).toThrow(/unsupported major/)
  })

  it('loads the schema files once per process: every registry shares what is compiled, and each still validates', () => {
    const another = new SchemaRegistry()
    expect(another.schemaOf('decision@1.0')).toBe(registry.schemaOf('decision@1.0'))
    expect(() => another.assert('decision@1.0', {})).toThrow(SchemaError)
  })
})

describe('usage the ledger could not count (usage-unknown@1.0)', () => {
  const fields = { runId: 'arun_1', kind: 'not-reported' as const, account: 'max', pool: 'max.agents', observedAt: '2026-10-23T14:00:00Z', reason: 'its runtime reported neither tokens nor turns' }

  it('builds a valid record, its reason cut to its bound on whole characters, and refuses one that is still invalid', () => {
    expect(USAGE_UNKNOWN_EVENT).toBe('usage.unknown')
    expect(usageUnknown(fields)).toEqual({ schema: 'usage-unknown@1.0', ...fields })
    const long = usageUnknown({ ...fields, reason: '🙂'.repeat(MAX_UNKNOWN_REASON + 10) })
    expect([...long.reason]).toHaveLength(MAX_UNKNOWN_REASON)
    expect(long.reason.endsWith('…')).toBe(true)
    expect(() => usageUnknown({ ...fields, pool: 'not an id' })).toThrow(SchemaError)
    expect(() => usageUnknown({ ...fields, failure: 'invalid' })).toThrow(SchemaError)
  })

  it('reads an entry\'s data back only when it is a valid record, never guessing (INV-14)', () => {
    const record = usageUnknown(fields)
    expect(usageUnknownOf(record)).toEqual(record)
    for (const data of [undefined, {}, { ...record, schema: 'usage-unknown@2.0' }, { ...record, kind: 'estimated' }, { ...record, usage: { inputTokens: 1, outputTokens: 1 } }]) {
      expect(usageUnknownOf(data)).toBeUndefined()
    }
  })

  const PARTIAL = `sha256:${'a'.repeat(64)}` as const
  /** The facts as event log entries, read a page at a time. */
  const log = (facts: Array<Omit<UsageUnknown, 'schema'>>) => {
    const entries = facts.map((f, i) => ({ seq: i + 1, at: '2026-10-23T11:00:00.000Z', data: usageUnknown(f) }))
    return ({ afterSeq, limit }: { afterSeq: number; limit: number }) => entries.filter((e) => e.seq > afterSeq).slice(0, limit)
  }
  const fact = (runId: string, extra: Partial<Omit<UsageUnknown, 'schema'>> = {}): Omit<UsageUnknown, 'schema'> => ({ ...fields, runId, worker: 'agent:reviewer', reason: `why ${runId}`, ...extra })

  it('names the lower bound the ledger counted as 1.1, for a not-reported unit only; that record never reconciles the unit (INV-2)', () => {
    const lower = usageUnknown({ ...fields, partial: PARTIAL })
    expect(lower).toEqual({ schema: 'usage-unknown@1.1', ...fields, partial: PARTIAL })
    expect(usageUnknownOf(lower)).toEqual(lower)
    // Only under 1.1, and only for a unit whose runtime gave no final count.
    expect(usageUnknownOf({ ...lower, schema: 'usage-unknown@1.0' })).toBeUndefined()
    expect(() => usageUnknown({ ...fields, kind: 'interrupted', partial: PARTIAL })).toThrow(SchemaError)
    expect(reconciledBy(lower, true)).toBe(false)
    expect(reconciledBy(usageUnknown(fields), true)).toBe(true)
    expect(reconciledBy(usageUnknown(fields), false)).toBe(false)
  })

  it('reads as counted only a record that is not itself a lower bound (`partial`), so an interrupted fact is never reconciled by one (INV-2)', () => {
    expect(countedWhole([])).toBe(false)
    expect(countedWhole([{ partial: 'stopped before its result' }])).toBe(false)
    expect(countedWhole([{ partial: 'stopped before its result' }, {}])).toBe(true)
    // The restart found the run interrupted; its lower bound, written before the crash, is no count of it.
    expect(reconciledBy(usageUnknown({ ...fields, kind: 'interrupted' }), countedWhole([{ partial: 'stopped before its result' }]))).toBe(false)
  })

  it('counts each open run once per pool, and names the latest with its Worker and its reason; a lower bound counted keeps it open', async () => {
    const count = await countUnknownUsage({
      pools: async () => [{ pool: 'max.agents', windows: [{ seconds: 18_000 }] }],
      entries: log([
        fact('arun_1'), fact('arun_2', { partial: PARTIAL, outcome: 'aborted' }), fact('arun_3'), fact('arun_4'), fact('arun_5'),
        // The same run again (a restart found it interrupted): named once, by its first fact.
        fact('arun_2', { kind: 'interrupted', outcome: 'failed' }),
      ]),
      // The ledger counts a record of arun_2 (its own lower bound) and of arun_5 (reconciled).
      counted: async (runId) => runId === 'arun_2' || runId === 'arun_5',
    }, Date.parse('2026-10-23T12:00:00Z'))
    expect(count.pools).toEqual([{
      pool: 'max.agents', seconds: 18_000, runs: 4, kinds: { 'not-reported': 4 },
      named: [
        { runId: 'arun_4', worker: 'agent:reviewer', kind: 'not-reported', reason: 'why arun_4' },
        { runId: 'arun_3', worker: 'agent:reviewer', kind: 'not-reported', reason: 'why arun_3' },
        { runId: 'arun_2', worker: 'agent:reviewer', kind: 'not-reported', outcome: 'aborted', reason: 'why arun_2', lowerBound: true },
      ],
    }])
    expect(NAMED_UNKNOWN_RUNS).toBe(3)
  })

  it('gives the runs of a task, else a project, whose usage a cap of their pool cannot count: by the fact\'s scope, else the run\'s reservation (INV-2)', () => {
    const entries = log([
      fact('arun_1', { taskId: 't1', projectId: 'p1' }),
      fact('arun_2', { taskId: 't2', projectId: 'p1', partial: PARTIAL }),
      // Its fact names no scope: its reservation's is taken.
      fact('arun_3'),
      fact('arun_4', { taskId: 't1', projectId: 'p1', pool: 'other.pool' }),
      fact('arun_5', { taskId: 't1', projectId: 'p1' }),
    ])
    const counted = (runId: string) => runId === 'arun_2' || runId === 'arun_5'
    const reservedFor = (runId: string) => (runId === 'arun_3' ? { taskId: 't1', projectId: 'p1' } : undefined)
    const pools = new Set(['max.agents'])
    expect(unknownUsageOf({ entries, counted, reservedFor }, { taskId: 't1' }, pools)).toEqual({
      runs: [
        { pool: 'max.agents', runId: 'arun_1', worker: 'agent:reviewer', kind: 'not-reported', reason: 'why arun_1' },
        { pool: 'max.agents', runId: 'arun_3', worker: 'agent:reviewer', kind: 'not-reported', reason: 'why arun_3' },
      ],
      unread: false, unreadable: 0,
    })
    // A project's scope takes every task of it; a lower bound counted keeps its run unknown.
    expect(unknownUsageOf({ entries, counted, reservedFor }, { projectId: 'p1' }, pools).runs.map((r) => [r.runId, r.lowerBound])).toEqual([['arun_1', undefined], ['arun_2', true], ['arun_3', undefined]])
    expect(unknownUsageOf({ entries, counted, reservedFor }, { taskId: 't9' }, pools).runs).toEqual([])
    // No scope: a cap bounds the run's own lines only.
    expect(unknownUsageOf({ entries, counted, reservedFor }, {}, pools).runs).toEqual([])
  })
})

describe('readOrCreateSecretFile', () => {
  it('creates a 0600 secret once and reads it back', () => {
    const path = join(dir, 'secrets', 'key')
    const first = readOrCreateSecretFile(path, 32)
    expect(first).toHaveLength(32)
    expect(readOrCreateSecretFile(path, 32).equals(first)).toBe(true)
  })

  it('refuses a secret with loose permissions (QA-6)', () => {
    const path = join(dir, 'loose')
    writeFileSync(path, Buffer.alloc(32))
    chmodSync(path, 0o644)
    expect(() => readOrCreateSecretFile(path, 32)).toThrow(/owner-only/)
  })
})

describe('review fixes (PR #3 security review)', () => {
  it('serializes sparse arrays as null entries', () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalJson([, 1])).toBe('[null,1]')
  })

  it('creates a secret file atomically when several processes start at once', async () => {
    const path = join(dir, 'race', 'key')
    const { fork } = await import('node:child_process')
    const worker = join(dir, 'race-worker.mjs')
    const files = new URL('../src/files.ts', import.meta.url).pathname
    writeFileSync(worker, `import { readOrCreateSecretFile } from ${JSON.stringify(files)}\nprocess.send(readOrCreateSecretFile(process.argv[2], 32).toString('hex'), () => process.exit(0))\n`)
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolve, reject) => {
      const child = fork(worker, [path], { execArgv: ['--import', 'tsx'] })
      child.on('message', (m) => resolve(String(m)))
      child.on('exit', (code) => code !== 0 && reject(new Error(`worker exited ${code}`)))
    })))
    expect(new Set(results).size).toBe(1)
  }, 30_000)

  it('accepts an owner-only read-only secret (0400)', () => {
    const path = join(dir, 'ro')
    writeFileSync(path, Buffer.alloc(32, 1), { mode: 0o400 })
    expect(readOrCreateSecretFile(path, 32)).toHaveLength(32)
  })
})
