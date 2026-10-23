import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MAX_UNKNOWN_REASON, SchemaError, SchemaRegistry, canonicalJson, contentId, dshHome, readOrCreateSecretFile, USAGE_UNKNOWN_EVENT, usageUnknown, usageUnknownOf } from '../src/index.ts'

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
