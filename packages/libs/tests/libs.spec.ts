import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SchemaError, SchemaRegistry, canonicalJson, contentId, readOrCreateSecretFile } from '../src/index.ts'

const dir = mkdtempSync(join(tmpdir(), 'system-libs-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

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

  it('validates a record by its schema tag', () => {
    const decision: Record<string, unknown> = {
      schema: 'decision@1.0', decisionType: 'route', question: 'q', inputs: [],
      candidates: [{ option: 'a', selected: true, reasons: [] }],
      decider: { type: 'rule', id: 'r', version: '1' }, outcome: { option: 'a' }, deterministic: true,
    }
    expect(() => registry.assertRecord(decision)).not.toThrow()
    expect(() => registry.assertRecord({ ...decision, candidates: [] } as Record<string, unknown>)).toThrow(SchemaError)
  })

  it('rejects unknown majors and malformed tags', () => {
    expect(() => registry.assert('decision@9.0', {})).toThrow(/unsupported major/)
    expect(() => registry.assert('nope', {})).toThrow(/malformed/)
  })
})

describe('readOrCreateSecretFile', () => {
  it('creates a 0600 secret once and reads it back', () => {
    const path = join(dir, 'secrets', 'key')
    const first = readOrCreateSecretFile(path, 32)
    expect(first).toHaveLength(32)
    expect(readOrCreateSecretFile(path, 32).equals(first)).toBe(true)
  })

  it('refuses a secret with loose permissions', () => {
    const path = join(dir, 'loose')
    writeFileSync(path, Buffer.alloc(32))
    chmodSync(path, 0o644)
    expect(() => readOrCreateSecretFile(path, 32)).toThrow(/0600/)
  })
})
