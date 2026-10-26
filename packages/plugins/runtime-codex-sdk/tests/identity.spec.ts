// Codex's identity reader (ADR-0051), against a redacted `auth.json` shaped as Codex writes it
// (tests/fixtures/auth.json, field names only) and a `codex login status` stand-in. No real home is read.
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { agentRuntimeIdentityConformance } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { type Confinement, HOME_STARTUP_DIRECTORIES, HOME_STATE_DIRECTORIES, WORKSPACE_READS_SCRIPT } from '@tsuuanmi/system-agent-runtime-core'
import { CodexRuntime, IDENTITY_READER, VERIFIED_IDENTITY_VERSIONS } from '../src/index.ts'
import { probeExec, scripted } from './fake-codex.ts'

const HOOK = fileURLToPath(new URL('../src/gate-hook.ts', import.meta.url))
const FIXTURE = readFileSync(new URL('./fixtures/auth.json', import.meta.url), 'utf8')
const root = mkdtempSync(join(tmpdir(), 'cx-id-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const KEY = new Uint8Array(32).fill(3)

/** Signs a home in as `login`: the fixture with an account id that stands for that login's ChatGPT account. */
function signIn(home: string, login: string): void {
  const auth = JSON.parse(FIXTURE) as { tokens: Record<string, string> }
  auth.tokens.account_id = `acct-${createHash('sha256').update(login).digest('hex').slice(0, 24)}`
  writeFileSync(join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
}
const signOut = (home: string): void => rmSync(join(home, 'auth.json'), { force: true })

const statuses: Array<Record<string, string>> = []
/** `codex login status` as Codex 0.164 answers it: signed in when the home holds its auth.json. */
const status = async (_command: unknown, env: Record<string, string>): Promise<string> => {
  statuses.push(env)
  if (!existsSync(join(env.CODEX_HOME!, 'auth.json'))) throw new Error('Not logged in')
  return 'Logged in using ChatGPT\n'
}
const binds: Array<{ readOnly?: readonly string[]; writable?: readonly string[] }> = []
const confine = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => {
  binds.push(bind)
  return { bwrap: '/usr/bin/bwrap', hide: ['/dsh'], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }
}
/** The run directory, outside `root`, which a run here takes for its workspace: a run's private shell home is never in its workspace (T198). */
const RUN_DIR = mkdtempSync(join(tmpdir(), 'cx-id-run-'))
afterAll(() => rmSync(RUN_DIR, { recursive: true, force: true }))
const runtime = (extra: Partial<ConstructorParameters<typeof CodexRuntime>[0]> = {}) => new CodexRuntime({
  executable: '/usr/bin/codex', home: join(root, 'own-home'), runDir: RUN_DIR, hook: HOOK, client: scripted().client, version: async () => '0.164.0',
  mcpServers: async () => [], exec: probeExec(), confine, prove: async () => ({ confined: true, detail: 'host state hidden' }), nested: async () => undefined, status,
  launcher: (c) => `launcher:${[c.command, ...c.args].join(' ')}`, ...extra,
})

agentRuntimeIdentityConformance('codex-sdk', { make: () => runtime(), signIn, signOut })

describe('codex-sdk identity reader (ADR-0051, REQ-ACC-11)', () => {
  let n = 0
  const home = (): string => {
    const dir = join(root, `home-${++n}`)
    mkdirSync(dir, { mode: 0o700 })
    return dir
  }

  it('is pinned to the Codex versions it was checked on; any other is unverified, and nothing in the home is read', async () => {
    expect(VERIFIED_IDENTITY_VERSIONS).toContain('0.164.0')
    const at = home()
    signIn(at, 'alice@example.test')
    const before = statuses.length
    expect(await runtime({ version: async () => '0.200.0' }).identity(at, KEY)).toMatchObject({ status: 'unverified', reader: IDENTITY_READER, runtimeVersion: '0.200.0', reason: expect.stringMatching(/0\.200\.0/) })
    expect(statuses.length).toBe(before)
    expect(await runtime({ findExecutable: () => undefined, executable: undefined }).identity(at, KEY)).toMatchObject({ status: 'unverified' })
  })

  it('checks the sign-in in that home, confined and with none of the operator\'s forwarded variables, before it reads anything', async () => {
    const at = home()
    signIn(at, 'alice@example.test')
    process.env.OPENAI_API_KEY = 'daemon-key'
    try {
      const reading = await runtime({ forwardEnv: ['OPENAI_API_KEY'] }).identity(at, KEY)
      expect(reading).toMatchObject({ status: 'verified', reader: 'codex-auth-json', runtimeVersion: '0.164.0' })
    } finally {
      delete process.env.OPENAI_API_KEY
    }
    expect(statuses.at(-1)).toMatchObject({ CODEX_HOME: at })
    expect(statuses.at(-1)).not.toHaveProperty('OPENAI_API_KEY')
    expect(binds.at(-1)).toEqual({ writable: [at] })
  })

  it('reads an API-key sign-in, or a status it cannot read, as ambiguous: no person is named (open question 4)', async () => {
    const at = home()
    signIn(at, 'alice@example.test')
    expect(await runtime({ status: async () => 'Logged in using an API key - sk-***\n' }).identity(at, KEY)).toMatchObject({ status: 'ambiguous', reason: expect.stringMatching(/API key/) })
    expect(await runtime({ status: async () => undefined }).identity(at, KEY)).toMatchObject({ status: 'ambiguous' })
  })

  it('reads an auth.json without a ChatGPT account id, or one it must not follow, as ambiguous; a home with none as missing', async () => {
    const at = home()
    writeFileSync(join(at, 'auth.json'), JSON.stringify({ tokens: { id_token: 'REDACTED' } }), { mode: 0o600 })
    expect(await runtime().identity(at, KEY)).toMatchObject({ status: 'ambiguous', reason: expect.stringMatching(/tokens\.account_id/) })
    writeFileSync(join(at, 'auth.json'), JSON.stringify({ tokens: { account_id: '' } }), { mode: 0o600 })
    expect(await runtime().identity(at, KEY)).toMatchObject({ status: 'ambiguous' })
    // A run can write its home: a link it planted is never followed.
    const elsewhere = home()
    signIn(elsewhere, 'alice@example.test')
    rmSync(join(at, 'auth.json'))
    symlinkSync(join(elsewhere, 'auth.json'), join(at, 'auth.json'))
    expect(await runtime({ status: async () => 'Logged in using ChatGPT' }).identity(at, KEY)).toMatchObject({ status: 'ambiguous', reason: expect.stringMatching(/symbolic link/) })
    const empty = home()
    expect(await runtime({ status: async () => 'Logged in using ChatGPT' }).identity(empty, KEY)).toMatchObject({ status: 'missing', reason: 'the home holds no auth.json' })
  })

  it('refuses a home that is not owner-only, or not there, as missing, never creating it', async () => {
    const open = home()
    signIn(open, 'alice@example.test')
    chmodSync(open, 0o755)
    expect(await runtime().identity(open, KEY)).toMatchObject({ status: 'missing', reason: expect.stringMatching(/group or others/) })
    expect(await runtime().identity(join(root, 'nowhere'), KEY)).toMatchObject({ status: 'missing' })
    expect(existsSync(join(root, 'nowhere'))).toBe(false)
  })

  it('gives `codex login` for the home, with the home named and no session bus', () => {
    expect(runtime().loginCommand(join(root, 'slot'))).toEqual({ command: '/usr/bin/codex', args: ['login'], env: { CODEX_HOME: join(root, 'slot') } })
  })

  it('runs and probes in a named home: its own home stays the default, and a named one that is not there is refused before anything runs', async () => {
    const s = scripted()
    const at = home()
    signIn(at, 'alice@example.test')
    const r = runtime({ client: s.client })
    await r.run({ prompt: 'x', workspace: root, sandbox: 'read-only', home: at }, new AbortController().signal)
    expect(s.lastClient.env).toMatchObject({ CODEX_HOME: at })
    // The named home bound back writable; the run's private shell home (T198), and the workspace reads server's script and node (T200b), read-only.
    // Its shells' tool-state directories writable over that home, fish's startup directories in them read-only again (T270).
    const inHome = (name: string) => expect.stringMatching(new RegExp(`^${RUN_DIR}/agent-home-[^/]+/${name.replaceAll('.', '\\.')}$`))
    expect(binds.at(-1)).toEqual({
      writable: [at, ...HOME_STATE_DIRECTORIES.map(inHome)],
      readOnly: [root, expect.stringMatching(new RegExp(`^${RUN_DIR}/agent-home-[^/]+$`)), ...HOME_STARTUP_DIRECTORIES.map(inHome), WORKSPACE_READS_SCRIPT, process.execPath],
    })
    await expect(r.run({ prompt: 'x', workspace: root, sandbox: 'read-only', home: join(root, 'nowhere') }, new AbortController().signal)).rejects.toMatchObject({ kind: 'config_error' })
    expect(await r.probe({ home: join(root, 'nowhere') })).toMatchObject({ available: false, homes: true })
    expect(r.home).toBe(join(root, 'own-home'))
  })
})
