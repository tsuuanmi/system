import type { PortableState } from '@tsuuanmi/system-provider-core'
import { describe, expect, it } from 'vitest'
import { fromStorageState, toStorageState } from '../src/state.ts'

const NOW = '2026-10-11T12:00:00.000Z'
const origins = ['https://chatgpt.com']

const raw = {
  cookies: [
    { name: 'session', value: 's', domain: '.chatgpt.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const },
    { name: 'host-only', value: 'h', domain: 'chatgpt.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' as const },
    { name: 'sub', value: 'x', domain: 'ab.chatgpt.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' as const },
    { name: 'tracker', value: 't', domain: '.example.net', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'None' as const },
    { name: 'lookalike', value: 'l', domain: 'evilchatgpt.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' as const },
  ],
  origins: [
    { origin: 'https://chatgpt.com', localStorage: [{ name: 'k', value: 'v' }], indexedDB: [{ name: 'db', version: 1, stores: [] }] },
    { origin: 'https://example.net', localStorage: [{ name: 'other', value: 'x' }] },
  ],
}

describe('portable state ↔ storageState', () => {
  it('keeps only what the allowed origins would send or store', () => {
    const state = fromStorageState(raw, { origins, now: NOW })
    expect(state.cookies.map((c) => c.name)).toEqual(['session', 'host-only'])
    expect(state.localStorage).toEqual([{ origin: 'https://chatgpt.com', localStorage: [{ name: 'k', value: 'v' }] }])
    expect(state.indexedDB).toEqual({ status: 'captured', data: [{ origin: 'https://chatgpt.com', indexedDB: [{ name: 'db', version: 1, stores: [] }] }] })
    expect(state).toMatchObject({ origins, capturedAt: NOW })
  })

  it('keeps the previous IndexedDB when a capture exceeds the size cap', () => {
    const previous: PortableState = {
      origins, cookies: [], capturedAt: '2026-10-10T00:00:00Z',
      indexedDB: { status: 'captured', data: [{ origin: 'https://chatgpt.com', indexedDB: [{ name: 'old' }] }] },
    }
    expect(fromStorageState(raw, { origins, now: NOW, previous, maxIndexedDbBytes: 10 }).indexedDB)
      .toEqual({ status: 'kept-previous', data: [{ origin: 'https://chatgpt.com', indexedDB: [{ name: 'old' }] }] })
    expect(fromStorageState(raw, { origins, now: NOW, maxIndexedDbBytes: 10 }).indexedDB).toEqual({ status: 'absent' })
  })

  it('reports absent IndexedDB when the origins have none', () => {
    const state = fromStorageState({ cookies: [], origins: [{ origin: 'https://chatgpt.com', localStorage: [] }] }, { origins, now: NOW })
    expect(state.indexedDB).toEqual({ status: 'absent' })
  })

  it('builds a storageState from portable state, merging per-origin data', () => {
    const state = fromStorageState(raw, { origins, now: NOW })
    expect(toStorageState(state)).toEqual({
      cookies: state.cookies,
      origins: [{ origin: 'https://chatgpt.com', localStorage: [{ name: 'k', value: 'v' }], indexedDB: [{ name: 'db', version: 1, stores: [] }] }],
    })
    expect(toStorageState(undefined)).toEqual({ cookies: [], origins: [] })
  })
})
