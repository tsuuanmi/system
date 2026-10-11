import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { guardRequest, hostName, tokenMatches } from '../src/guard.ts'

const req = (headers: Record<string, string>): IncomingMessage => ({ headers } as unknown as IncomingMessage)
const options = { token: 'secret', allowedHosts: ['127.0.0.1', 'localhost', '[::1]'] }

describe('request guard', () => {
  it('parses host names with ports and IPv6 literals', () => {
    expect(hostName('127.0.0.1:47317')).toBe('127.0.0.1')
    expect(hostName('[::1]:80')).toBe('[::1]')
    expect(hostName(undefined)).toBe('')
  })

  it('compares tokens exactly and never accepts an empty bearer', () => {
    expect(tokenMatches('Bearer secret', 'secret')).toBe(true)
    expect(tokenMatches('Bearer secre', 'secret')).toBe(false)
    expect(tokenMatches('Bearer ', '')).toBe(false)
    expect(tokenMatches(undefined, 'secret')).toBe(false)
  })

  it('checks host, then origin, then token', () => {
    expect(guardRequest(req({ host: 'evil:1', authorization: 'Bearer secret' }), options)).toMatchObject({ status: 421 })
    expect(guardRequest(req({ host: 'localhost:1', origin: 'http://x', authorization: 'Bearer secret' }), options)).toMatchObject({ status: 403 })
    expect(guardRequest(req({ host: 'localhost:1' }), options)).toMatchObject({ status: 401 })
    expect(guardRequest(req({ host: 'localhost:1', authorization: 'Bearer secret' }), options)).toEqual({ ok: true })
  })
})
