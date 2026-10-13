import type { IncomingMessage } from 'node:http'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeBind, endpointUrl, guardRequest, hostName, readJsonBody, scopeTokens, SCOPES, tokenFile, tokenMatches } from '../src/index.ts'

const req = (headers: Record<string, string>): IncomingMessage => ({ headers } as unknown as IncomingMessage)
const options = { tokens: { client: 'secret' }, allowedHosts: ['127.0.0.1', 'localhost', '[::1]'] }

/** One request guard for every client endpoint: MCP and the protocol gateways. */
describe('request guard', () => {
  it('parses host names with ports and IPv6 literals', () => {
    expect(hostName('127.0.0.1:47317')).toBe('127.0.0.1')
    expect(hostName('[::1]:80')).toBe('[::1]')
    expect(hostName(undefined)).toBe('')
  })

  it('compares tokens exactly and never accepts an empty bearer', () => {
    expect(tokenMatches('secret', 'secret')).toBe(true)
    expect(tokenMatches('secre', 'secret')).toBe(false)
    expect(tokenMatches('', '')).toBe(false)
  })

  it('checks host, then origin, then token', () => {
    expect(guardRequest(req({ host: 'evil:1', authorization: 'Bearer secret' }), options)).toMatchObject({ status: 421 })
    expect(guardRequest(req({ host: 'localhost:1', origin: 'http://x', authorization: 'Bearer secret' }), options)).toMatchObject({ status: 403 })
    expect(guardRequest(req({ host: 'localhost:1' }), options)).toMatchObject({ status: 401 })
    expect(guardRequest(req({ host: 'localhost:1', authorization: 'Bearer secret' }), options)).toEqual({ ok: true, scope: 'client' })
  })

  it('takes the token from x-api-key only where the endpoint allows it (Anthropic clients send it there)', () => {
    expect(guardRequest(req({ host: 'localhost:1', 'x-api-key': 'secret' }), options)).toMatchObject({ status: 401 })
    expect(guardRequest(req({ host: 'localhost:1', 'x-api-key': 'secret' }), { ...options, apiKeyHeader: true })).toEqual({ ok: true, scope: 'client' })
    expect(guardRequest(req({ host: 'localhost:1', 'x-api-key': '' }), { ...options, apiKeyHeader: true })).toMatchObject({ status: 401 })
    expect(guardRequest(req({ host: '[::1]:47317', authorization: 'Bearer secret' }), options)).toEqual({ ok: true, scope: 'client' })
  })

  it('accepts the page\'s own origin only where the endpoint serves a page (the web UI)', () => {
    const own = { host: 'localhost:47317', origin: 'http://localhost:47317', authorization: 'Bearer secret' }
    expect(guardRequest(req(own), options)).toMatchObject({ status: 403 })
    expect(guardRequest(req(own), { ...options, sameOrigin: true })).toEqual({ ok: true, scope: 'client' })
    expect(guardRequest(req({ ...own, origin: 'https://evil.example' }), { ...options, sameOrigin: true })).toMatchObject({ status: 403 })
  })
})

/** Scoped control credentials (ADR-0023): the token presented decides what the caller may do. */
describe('scoped tokens', () => {
  const scoped = { tokens: { operator: 'op-secret', client: 'cl-secret' }, allowedHosts: ['localhost'] }

  it('returns the scope of the token presented, and refuses a scope the endpoint does not accept (QA-14)', () => {
    expect(guardRequest(req({ host: 'localhost:1', authorization: 'Bearer op-secret' }), scoped)).toEqual({ ok: true, scope: 'operator' })
    expect(guardRequest(req({ host: 'localhost:1', authorization: 'Bearer cl-secret' }), scoped)).toEqual({ ok: true, scope: 'client' })
    // A model token is not accepted where only operator and client tokens are.
    expect(guardRequest(req({ host: 'localhost:1', authorization: 'Bearer model-secret' }), { ...scoped, tokens: { ...scoped.tokens } })).toMatchObject({ status: 401 })
    expect(guardRequest(req({ host: 'localhost:1', authorization: 'Bearer model-secret' }), { tokens: { model: 'model-secret' }, allowedHosts: ['localhost'] })).toEqual({ ok: true, scope: 'model' })
  })

  it('keeps one owner-only token file per scope, distinct, and stable across reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-scopes-'))
    try {
      const first = scopeTokens(dir)
      expect(Object.keys(first).sort()).toEqual([...SCOPES].sort())
      expect(new Set(Object.values(first)).size).toBe(3)
      for (const scope of SCOPES) {
        expect(statSync(tokenFile(dir, scope)).mode & 0o777).toBe(0o600)
        expect(readFileSync(tokenFile(dir, scope)).toString('base64url')).toBe(first[scope])
      }
      expect(scopeTokens(dir)).toEqual(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses token files that share a value: a copied file would grant one scope another\'s rights (QA-14)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-scopes-'))
    try {
      scopeTokens(dir)
      copyFileSync(tokenFile(dir, 'operator'), tokenFile(dir, 'client'))
      expect(() => scopeTokens(dir)).toThrow(/operator and client share one token/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('request bodies', () => {
  const body = (text: string): IncomingMessage => Readable.from([Buffer.from(text)]) as unknown as IncomingMessage
  it('reads JSON, allows an empty body, and refuses invalid or oversized ones', async () => {
    expect(await readJsonBody(body('{"a":1}'), 100)).toEqual({ a: 1 })
    expect(await readJsonBody(Readable.from([]) as unknown as IncomingMessage, 100)).toBeUndefined()
    await expect(readJsonBody(body('{not json'), 100)).rejects.toMatchObject({ status: 400 })
    await expect(readJsonBody(body('x'.repeat(200)), 100)).rejects.toMatchObject({ status: 413 })
  })
})

describe('review fixes (PR #3 security review)', () => {
  it('accepts the Bearer scheme case-insensitively', () => {
    expect(guardRequest(req({ host: 'localhost:1', authorization: 'bearer secret' }), options)).toEqual({ ok: true, scope: 'client' })
    expect(guardRequest(req({ host: 'localhost:1', authorization: 'BEARER secret' }), options)).toEqual({ ok: true, scope: 'client' })
  })

  it('builds the endpoint URL from the bound protocol and host', () => {
    expect(endpointUrl({ protocol: 'http:', host: '127.0.0.1', port: 5 }, '/mcp')).toBe('http://127.0.0.1:5/mcp')
    expect(endpointUrl({ protocol: 'https:', host: '::1', port: 5 }, '/mcp')).toBe('https://[::1]:5/mcp')
  })

  it('refuses a non-loopback bind unless TLS is on (QA-5)', () => {
    expect(() => assertSafeBind({ protocol: 'http:', host: '192.168.1.5' })).toThrow(/loopback/)
    expect(() => assertSafeBind({ protocol: 'https:', host: '192.168.1.5' })).not.toThrow()
    expect(() => assertSafeBind({ protocol: 'http:', host: '127.0.0.1' })).not.toThrow()
    expect(() => assertSafeBind({ protocol: 'http:', host: '::1' })).not.toThrow()
  })
})
