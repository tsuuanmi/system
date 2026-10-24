// The Codex app server's account rate limits as an account's usage report (ADR-0059): its
// JSON-RPC exchange against an app-server stand-in, its results against redacted fixtures, read on
// a checked Codex version only. No real Codex runs and no account is read.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Confinement, LimitReport } from '@tsuuanmi/system-agent-runtime-core'
import { afterAll, describe, expect, it } from 'vitest'
import { agentRuntimeLimitsConformance, expectConsistentMetering } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { APP_SERVER_ARGS, CodexRuntime, FEATURES_OFF, limitsFromRateLimits, type SpawnAppServer, VERIFIED_RATE_LIMITS_VERSIONS } from '../src/index.ts'

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/codex-0.164.0-rate-limits.json', import.meta.url), 'utf8')) as {
  observedAt: string; cases: Array<{ case: string; result: unknown; limits?: unknown[]; unreadable?: string }>
}
const GOOD = FIXTURE.cases[0]!.result
const SERVER = fileURLToPath(new URL('./fake-app-server.mjs', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'cx-limits-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const HOME = mkdtempSync(join(root, 'home-'))
let logs = 0

const binds: Array<{ readOnly?: readonly string[]; writable?: readonly string[] }> = []
const confine = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => {
  binds.push(bind)
  return { bwrap: '/usr/bin/bwrap', hide: ['/dsh'], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }
}

/** The app server, played by the stand-in in `mode`; what it was started with and read is in `log`. */
function appServer(mode: string, answer: unknown = GOOD): { spawn: SpawnAppServer; log: string; started: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> }> } {
  const log = join(root, `app-server-${++logs}.log`)
  const started: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> }> = []
  return {
    log, started,
    spawn: (command, args, options) => {
      started.push({ command, args, ...options })
      // The confined command line's own part, after bubblewrap's `--`, is what Codex would be given.
      const own = args.slice(args.indexOf('--') + 2)
      return spawn(process.execPath, [SERVER, ...own], { cwd: options.cwd, env: { ...options.env, FAKE_APP_SERVER_MODE: mode, FAKE_APP_SERVER_ANSWER: JSON.stringify(answer), FAKE_APP_SERVER_LOG: log }, stdio: ['pipe', 'pipe', 'ignore'] })
    },
  }
}
const read = (log: string): unknown[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown) : [])

const runtime = (server: { spawn: SpawnAppServer }, extra: Partial<ConstructorParameters<typeof CodexRuntime>[0]> = {}) => new CodexRuntime({
  executable: '/usr/bin/codex', home: HOME, runDir: join(root, 'run'), version: async () => VERIFIED_RATE_LIMITS_VERSIONS[0]!, mcpServers: async () => [],
  confine, prove: async () => ({ confined: true, detail: 'host state hidden' }), nested: async () => undefined, status: async () => undefined, appServer: server.spawn, ...extra,
})
const signal = () => new AbortController().signal
const why = (report: LimitReport): string => ('unreadable' in report ? report.unreadable : '')

agentRuntimeLimitsConformance('codex-sdk', {
  readable: () => runtime(appServer('answer')),
  garbled: () => runtime(appServer('answer', { rateLimits: { primary: { usedPercent: '42%' } } })),
  unchecked: () => runtime(appServer('answer'), { version: async () => '0.165.0' }),
  uncheckedVersion: '0.165.0',
})

describe('codex-sdk: an account\'s usage report from the app server (ADR-0059)', () => {
  it('reads each redacted result as its fixture says: each window named by its length, in the seam\'s units, or none', () => {
    const at = Date.parse(FIXTURE.observedAt)
    for (const c of FIXTURE.cases) {
      const report = limitsFromRateLimits(c.result, at)
      if (c.unreadable !== undefined) {
        expect(why(report), c.case).toContain(c.unreadable)
        continue
      }
      expect(report, c.case).toEqual({ limits: c.limits })
      expectConsistentMetering({ limits: (report as { limits: [] }).limits })
    }
  })

  it('starts the app server confined in the account\'s home with the runtime\'s overrides, asks initialize, then the rate limits, and ends it: no thread, no turn', async () => {
    const server = appServer('answer')
    const before = binds.length
    const report = await runtime(server).limits({}, signal())
    expect(report).toEqual({ limits: (FIXTURE.cases[0]!.limits as Array<Record<string, unknown>>).map((l) => ({ ...l, observedAt: expect.any(String) })) })
    expect(server.started).toHaveLength(1)
    const [start] = server.started
    expect(start!.command).toBe('/usr/bin/bwrap')
    const own = start!.args.slice(start!.args.indexOf('--') + 1)
    expect(own.slice(0, 2)).toEqual(['/usr/bin/codex', ...APP_SERVER_ARGS])
    expect(own).toContain(`features.${FEATURES_OFF[0]}=false`)
    expect(start!.cwd).toBe(HOME)
    expect(start!.env).toMatchObject({ CODEX_HOME: HOME })
    expect(binds.slice(before)).toEqual([{ writable: [HOME] }])
    const lines = read(server.log)
    expect(lines.slice(1)).toEqual([
      { method: 'initialize', id: 1, params: { clientInfo: expect.objectContaining({ name: 'system' }) } },
      { method: 'initialized' },
      { method: 'account/rateLimits/read', id: 2 },
    ])
  })

  it('reads the account in a named home, and nothing of a home that is not one, never making it (ADR-0051)', async () => {
    const named = mkdtempSync(join(root, 'account-'))
    const server = appServer('answer')
    expect(await runtime(server).limits({ home: named }, signal())).toHaveProperty('limits')
    expect(server.started[0]).toMatchObject({ cwd: named, env: expect.objectContaining({ CODEX_HOME: named }) })
    const absent = join(root, 'absent')
    expect(why(await runtime(server).limits({ home: absent }, signal()))).toMatch(/does not exist/)
    expect(existsSync(absent)).toBe(false)
    expect(server.started).toHaveLength(1)
  })

  it('starts nothing on an unchecked version, without confinement, without Codex, or in a home that configures an MCP server (INV-2)', async () => {
    const server = appServer('answer')
    const cases: Array<[Partial<ConstructorParameters<typeof CodexRuntime>[0]>, RegExp]> = [
      [{ version: async () => '0.170.0' }, /Codex 0\.170\.0's app server are not verified/],
      [{ version: async () => { throw new Error('exit 1') } }, /codex --version failed/],
      [{ confine: undefined }, /no read confinement/],
      [{ executable: undefined, findExecutable: () => undefined }, /not installed/],
      [{ mcpServers: async () => ['system'] }, /configures MCP server\(s\) system/],
    ]
    for (const [extra, said] of cases) expect(why(await runtime(server, extra).limits({}, signal()))).toMatch(said)
    expect(server.started).toEqual([])
  })

  it('reads a refusal, an error, a line it cannot read, an early exit, a result it cannot read, and a stopped read as unreadable, never a throw', async () => {
    expect(why(await runtime(appServer('refuse-initialize')).limits({}, signal()))).toMatch(/refused initialize: Invalid request/)
    expect(why(await runtime(appServer('error')).limits({}, signal()))).toMatch(/refused account\/rateLimits\/read: codex account authentication required/)
    expect(why(await runtime(appServer('garbage')).limits({}, signal()))).toMatch(/not JSON/)
    expect(why(await runtime(appServer('exit')).limits({}, signal()))).toMatch(/ended before it answered \(exit 3\)/)
    expect(why(await runtime(appServer('answer', { rateLimits: null })).limits({}, signal()))).toMatch(/no rateLimits object/)
    const stop = new AbortController()
    const hanging = appServer('hang')
    const stopped = runtime(hanging).limits({}, stop.signal)
    await expect.poll(() => read(hanging.log).length).toBe(4)
    stop.abort()
    expect(why(await stopped)).toMatch(/the read was stopped/)
  })
})
