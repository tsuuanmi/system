import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { agentRuntimeIdentityConformance, agentRuntimeProviderConformance, FakeAgentRuntime } from '../conformance/agent-runtimes.ts'
import { type AgentRuntimeProvider, accountIdOf, homeProblem, identityHmac, MAX_HOME_FILE_BYTES, maskEmail, probeIn, readHomeJson, titleOf } from '../src/index.ts'

// The fake with scripted homes passes the provider suite and the identity suite (ADR-0051).
agentRuntimeProviderConformance('FakeAgentRuntime', () => new FakeAgentRuntime())
agentRuntimeIdentityConformance('FakeAgentRuntime', { make: () => new FakeAgentRuntime(), signIn: FakeAgentRuntime.signIn, signOut: FakeAgentRuntime.signOut })

describe('a runtime\'s title for people (T103)', () => {
  it('is used only when it is plain text on one line of at most 64 characters; otherwise there is none', () => {
    expect(titleOf({ title: 'Claude Code' })).toBe('Claude Code')
    for (const bad of ['', 'two\nlines', 'x'.repeat(65), 42, undefined]) expect(titleOf({ title: bad as string }), String(bad)).toBeUndefined()
    expect(titleOf(undefined)).toBeUndefined()
  })
})

describe('agent account identity (ADR-0051)', () => {
  const key = new Uint8Array(32).fill(1)
  const root = mkdtempSync(join(tmpdir(), 'system-identity-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('hashes the provider and the principal\'s parts in a canonical order, keyed', () => {
    const hmac = identityHmac(key, 'p', { account: 'a1', user: 'u1' })
    expect(hmac).toMatch(/^[0-9a-f]{64}$/)
    expect(identityHmac(key, 'p', { user: 'u1', account: 'a1' })).toBe(hmac)
    // The provider is the namespace: one person through two runtimes is two accounts.
    expect(identityHmac(key, 'q', { account: 'a1', user: 'u1' })).not.toBe(hmac)
    expect(identityHmac(new Uint8Array(32).fill(2), 'p', { account: 'a1', user: 'u1' })).not.toBe(hmac)
    // Parts that only concatenate alike stay apart.
    expect(identityHmac(key, 'p', { account: 'a1u', user: '1' })).not.toBe(identityHmac(key, 'p', { account: 'a1', user: 'u1' }))
  })

  it('refuses to hash a principal read in part, or with a short key: that is ambiguous, never an id', () => {
    expect(() => identityHmac(key, 'p', {})).toThrow(RangeError)
    expect(() => identityHmac(key, 'p', { account: 'a1', user: '' })).toThrow(/user/)
    expect(() => identityHmac(new Uint8Array(8), 'p', { user: 'u' })).toThrow(/16 bytes/)
  })

  it('derives the account id from the hash, never from a name', () => {
    const hmac = identityHmac(key, 'codex-sdk', { user: 'u' })
    expect(accountIdOf('codex-sdk', hmac)).toBe(`codex-sdk:${hmac.slice(0, 16)}`)
    expect(() => accountIdOf('codex-sdk', 'alice')).toThrow(RangeError)
  })

  it('masks an email to its first letter and domain, and nothing else', () => {
    expect(maskEmail('jane.doe@example.com')).toBe('j…@example.com')
    expect(maskEmail('not an email')).toBeUndefined()
    expect(maskEmail('a@b')).toBeUndefined()
  })

  it('masks exactly what the former expression accepted, in linear time (CodeQL js/polynomial-redos)', () => {
    const former = (email: string) => {
      const match = /^([^@\s])[^@\s]*@([^@\s]+\.[^@\s]+)$/.exec(email)
      return match ? `${match[1]}…@${match[2]}` : undefined
    }
    const parts = ['a', 'b', '.', '@', ' ', '\t', 'x.y', '..', 'é']
    let seed = 7
    for (let i = 0; i < 5000; i++) {
      let email = ''
      const length = (seed = (seed * 1103515245 + 12345) % 2147483648) % 9
      for (let j = 0; j < length; j++) email += parts[(seed = (seed * 1103515245 + 12345) % 2147483648) % parts.length]
      expect(maskEmail(email), JSON.stringify(email)).toBe(former(email))
    }
    for (const email of ['.a.b', 'a@.b.c', 'a@b.', 'a@.b', 'a@b..c', 'ab@c.d@e.f']) expect(maskEmail(email), email).toBe(former(email))
    const started = performance.now()
    expect(maskEmail(`!@!.${'!.'.repeat(50_000)}`)).toBe(`!…@!.${'!.'.repeat(50_000)}`)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('never probes a named home on a provider that runs in its own home only (INV-2)', async () => {
    let asked = 0
    const own: AgentRuntimeProvider = {
      kind: 'own-home',
      probe: async (options) => {
        if (options?.home) asked++
        return { available: true, detail: 'ready', sandboxes: ['read-only'], resume: false, executes: false, readsConfined: true, gatesToolCalls: true }
      },
      run: async () => ({ text: '' }),
    }
    const evidence = await probeIn(own, root)
    expect(evidence).toMatchObject({ available: false, detail: expect.stringMatching(/own configured home only/) })
    expect(asked).toBe(0)
  })

  it('reads a home\'s JSON file only when it is a small regular file of this user, never through a link a run planted (INV-2)', () => {
    const dir = mkdtempSync(join(root, 'home-'))
    expect(readHomeJson(join(dir, 'auth.json'))).toEqual({ state: 'absent' })
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { account_id: 'a' } }), { mode: 0o600 })
    expect(readHomeJson(join(dir, 'auth.json'))).toEqual({ state: 'read', value: { tokens: { account_id: 'a' } } })
    symlinkSync(join(dir, 'auth.json'), join(dir, 'link.json'))
    expect(readHomeJson(join(dir, 'link.json'))).toEqual({ state: 'refused', why: 'it is a symbolic link' })
    writeFileSync(join(dir, 'list.json'), '[1]')
    writeFileSync(join(dir, 'text.json'), 'not json')
    writeFileSync(join(dir, 'big.json'), `"${'x'.repeat(MAX_HOME_FILE_BYTES)}"`)
    expect(readHomeJson(join(dir, 'list.json'))).toMatchObject({ state: 'refused', why: 'it is not a JSON object' })
    expect(readHomeJson(join(dir, 'text.json'))).toMatchObject({ state: 'refused', why: 'it is not JSON' })
    expect(readHomeJson(join(dir, 'big.json'))).toMatchObject({ state: 'refused', why: expect.stringMatching(/larger than/) })
    expect(readHomeJson(dir)).toMatchObject({ state: 'refused', why: 'it is not a regular file' })
  })

  it('takes a home only when it is an existing owner-only directory, and never creates one', () => {
    const dir = mkdtempSync(join(root, 'owned-'))
    chmodSync(dir, 0o700)
    expect(homeProblem(dir)).toBeUndefined()
    expect(homeProblem('relative')).toMatch(/absolute/)
    expect(homeProblem(join(root, 'absent'))).toMatch(/does not exist/)
    expect(existsSync(join(root, 'absent'))).toBe(false)
    chmodSync(dir, 0o750)
    expect(homeProblem(dir)).toMatch(/group or others/)
    symlinkSync(root, join(root, 'linked'))
    expect(homeProblem(join(root, 'linked'))).toMatch(/not a directory/)
  })

  it('reads an account as unverified on a runtime version no supervised check verified', async () => {
    FakeAgentRuntime.signIn(root, 'alice@example.test')
    expect(await new FakeAgentRuntime('fake-runtime', '9.9.9').identity(root, key)).toMatchObject({ status: 'unverified', runtimeVersion: '9.9.9' })
    expect(await new FakeAgentRuntime().identity(root, key)).toMatchObject({ status: 'verified', reader: 'fake-login-file', hint: 'a…@example.test' })
  })
})
