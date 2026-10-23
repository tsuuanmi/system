// Claude Code's identity reader (ADR-0051), against a redacted `.claude.json` and `.credentials.json`
// shaped as Claude Code writes them with CLAUDE_CONFIG_DIR set (tests/fixtures, field names only) and
// a `claude auth status` stand-in. No real home is read.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { agentRuntimeIdentityConformance } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import type { Confinement } from '@tsuuanmi/system-agent-runtime-core'
import { ClaudeAgentRuntime, IDENTITY_READER, type QueryFn, type RuntimeOptions, VERIFIED_IDENTITY_VERSIONS } from '../src/index.ts'

const STATE = readFileSync(new URL('./fixtures/claude.json', import.meta.url), 'utf8')
const CREDENTIALS = readFileSync(new URL('./fixtures/credentials.json', import.meta.url), 'utf8')
const root = mkdtempSync(join(tmpdir(), 'claude-id-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const KEY = new Uint8Array(32).fill(5)
const id = (login: string, what: string): string => createHash('sha256').update(`${what}:${login}`).digest('hex').slice(0, 32)

/** Signs a home in as `login` (an email): the fixtures, with ids that stand for that login's account and organization. */
function signIn(home: string, login: string, edit: (account: Record<string, unknown>) => void = () => undefined): void {
  const state = JSON.parse(STATE) as { oauthAccount: Record<string, unknown> }
  Object.assign(state.oauthAccount, { accountUuid: id(login, 'account'), organizationUuid: id(login, 'organization'), emailAddress: login })
  edit(state.oauthAccount)
  writeFileSync(join(home, '.claude.json'), JSON.stringify(state), { mode: 0o600 })
  writeFileSync(join(home, '.credentials.json'), CREDENTIALS, { mode: 0o600 })
}
const signOut = (home: string): void => {
  rmSync(join(home, '.credentials.json'), { force: true })
  rmSync(join(home, '.claude.json'), { force: true })
}

const statuses: Array<Record<string, string>> = []
/** `claude auth status` as Claude Code answers it: logged in when the home holds its credentials. */
const status = async (_command: unknown, env: Record<string, string>): Promise<string> => {
  statuses.push(env)
  return JSON.stringify({ loggedIn: existsSync(join(env.CLAUDE_CONFIG_DIR!, '.credentials.json')), authMethod: 'claude.ai', apiProvider: 'firstParty' })
}
const binds: Array<{ readOnly?: readonly string[]; writable?: readonly string[] }> = []
const confine = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => {
  binds.push(bind)
  return { bwrap: '/usr/bin/bwrap', hide: ['/dsh'], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }
}
const query = ((params: { prompt: string }) => (async function* () {
  yield { type: 'system', subtype: 'init', session_id: 'h-1', model: 'm' }
  yield { type: 'result', subtype: 'success', is_error: false, result: `echo: ${params.prompt}`, session_id: 'h-1', uuid: 'r-1', num_turns: 1 }
})()) as unknown as QueryFn
const runtime = (extra: Partial<RuntimeOptions> = {}) => new ClaudeAgentRuntime({
  query, executable: '/usr/bin/claude', findExecutable: () => undefined, version: async () => '2.1.308', home: join(root, 'own-home'),
  confine, prove: async () => ({ confined: true, detail: 'host state hidden' }), nested: async () => '', status, ...extra,
})

agentRuntimeIdentityConformance('claude-agent-sdk', { make: () => runtime(), signIn: (home, login) => signIn(home, login), signOut })

describe('claude-agent-sdk identity reader (ADR-0051, REQ-ACC-11)', () => {
  let n = 0
  const home = (): string => {
    const dir = join(root, `home-${++n}`)
    mkdirSync(dir, { mode: 0o700 })
    return dir
  }

  it('is pinned to the Claude Code versions it was checked on; any other is unverified, and nothing in the home is read', async () => {
    expect(VERIFIED_IDENTITY_VERSIONS).toContain('2.1.308')
    const at = home()
    signIn(at, 'alice@example.test')
    const before = statuses.length
    expect(await runtime({ version: async () => '2.2.0' }).identity(at, KEY)).toMatchObject({ status: 'unverified', reader: IDENTITY_READER, runtimeVersion: '2.2.0' })
    expect(statuses.length).toBe(before)
  })

  it('reads the account and organization ids, never the email alone, and gives the email only masked (INV-8)', async () => {
    const at = home()
    signIn(at, 'alice@example.test')
    const first = await runtime().identity(at, KEY)
    expect(first).toMatchObject({ status: 'verified', reader: 'claude-state-file', runtimeVersion: '2.1.308', hint: 'a…@example.test' })
    // A changed email on the same account is the same account.
    signIn(at, 'alice@example.test', (a) => { a.emailAddress = 'alice.new@example.test' })
    expect((await runtime().identity(at, KEY) as { hmac: string }).hmac).toBe((first as { hmac: string }).hmac)
    // The same account in another organization is another principal.
    signIn(at, 'alice@example.test', (a) => { a.organizationUuid = 'another-organization' })
    expect((await runtime().identity(at, KEY) as { hmac: string }).hmac).not.toBe((first as { hmac: string }).hmac)
    expect(statuses.at(-1)).toMatchObject({ CLAUDE_CONFIG_DIR: at })
    expect(binds.at(-1)).toEqual({ writable: [at] })
  })

  it('reads a sign-in without both ids, or a state file it must not follow, as ambiguous', async () => {
    const at = home()
    signIn(at, 'alice@example.test', (a) => { delete a.organizationUuid })
    expect(await runtime().identity(at, KEY)).toMatchObject({ status: 'ambiguous', reason: expect.stringMatching(/organization/) })
    signIn(at, 'alice@example.test', (a) => { delete a.accountUuid })
    expect(await runtime().identity(at, KEY)).toMatchObject({ status: 'ambiguous' })
    const elsewhere = home()
    signIn(elsewhere, 'bob@example.test')
    rmSync(join(at, '.claude.json'))
    symlinkSync(join(elsewhere, '.claude.json'), join(at, '.claude.json'))
    expect(await runtime().identity(at, KEY)).toMatchObject({ status: 'ambiguous', reason: expect.stringMatching(/symbolic link/) })
    rmSync(join(at, '.claude.json'))
    expect(await runtime().identity(at, KEY)).toMatchObject({ status: 'ambiguous', reason: expect.stringMatching(/no \.claude\.json/) })
    expect(await runtime({ status: async () => 'Logged in.' }).identity(elsewhere, KEY)).toMatchObject({ status: 'ambiguous', reason: expect.stringMatching(/does not say/) })
  })

  it('reads a sign-in kept outside the home\'s own files (a keyring, an API key) as unverified: it is not this home\'s', async () => {
    const at = home()
    signIn(at, 'alice@example.test')
    rmSync(join(at, '.credentials.json'))
    expect(await runtime({ status: async () => '{"loggedIn": true}' }).identity(at, KEY)).toMatchObject({ status: 'unverified', reason: expect.stringMatching(/\.credentials\.json/) })
  })

  it('reads a home that is signed out, not owner-only, or not there as missing, never creating it', async () => {
    const out = home()
    expect(await runtime().identity(out, KEY)).toMatchObject({ status: 'missing', reason: 'claude auth status: not logged in' })
    expect(await runtime({ status: async () => { throw new Error('exit 1') } }).identity(out, KEY)).toMatchObject({ status: 'missing' })
    const open = home()
    signIn(open, 'alice@example.test')
    chmodSync(open, 0o755)
    expect(await runtime().identity(open, KEY)).toMatchObject({ status: 'missing', reason: expect.stringMatching(/group or others/) })
    expect(await runtime().identity(join(root, 'nowhere'), KEY)).toMatchObject({ status: 'missing' })
    expect(existsSync(join(root, 'nowhere'))).toBe(false)
  })

  it('gives Claude Code in the home to sign in with, the home named and no session bus', () => {
    expect(runtime().loginCommand(join(root, 'slot'))).toEqual({ command: '/usr/bin/claude', args: [], env: { CLAUDE_CONFIG_DIR: join(root, 'slot') } })
  })

  it('runs in a named home, bound back writable in place of its own, and refuses one that is not there before anything runs', async () => {
    const at = home()
    signIn(at, 'alice@example.test')
    const r = runtime()
    const result = await r.run({ prompt: 'x', workspace: root, sandbox: 'read-only', home: at }, new AbortController().signal)
    expect(result.text).toBe('echo: x')
    expect(binds.at(-1)).toEqual({ writable: [at], readOnly: [root] })
    await expect(r.run({ prompt: 'x', workspace: root, sandbox: 'read-only', home: join(root, 'nowhere') }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
    expect(existsSync(join(root, 'nowhere'))).toBe(false)
    expect(r.home).toBe(join(root, 'own-home'))
  })
})
