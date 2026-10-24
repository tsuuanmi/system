// Claude Code's usage report (ADR-0059): the SDK's get_usage control request, in a session sent no
// message, read on a checked Claude Code version only, against redacted get_usage answers
// (tests/fixtures) and a scripted SDK. No real home is read and no Claude Code runs.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Confinement, LimitReport } from '@tsuuanmi/system-agent-runtime-core'
import { afterAll, describe, expect, it } from 'vitest'
import { agentRuntimeLimitsConformance, expectConsistentMetering } from '../../../agent-runtime-core/conformance/agent-runtimes.ts'
import { ClaudeAgentRuntime, limitsFromUsage, type QueryFn, type RuntimeOptions, type SpawnConfined, VERIFIED_LIMIT_VERSIONS } from '../src/index.ts'

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/claude-get-usage.json', import.meta.url), 'utf8')) as {
  observedAt: string; cases: Array<{ case: string; answer: unknown; limits?: unknown[]; unreadable?: string }>
}
const GOOD = FIXTURE.cases[0]!.answer
const HOME = mkdtempSync(join(tmpdir(), 'system-claude-limits-'))
afterAll(() => rmSync(HOME, { recursive: true, force: true }))
const CHECKED = VERIFIED_LIMIT_VERSIONS[0]!

/** What a scripted session was asked: the query's options, whether its input sent anything, the get_usage options, and whether it was closed. */
interface Session { options: Record<string, unknown>; sent: unknown[]; usage: unknown[]; closed: boolean }

/** A scripted SDK whose session answers get_usage with `answer` (a value, or an Error it rejects with, or a promise that never settles). */
function usageQuery(answer: unknown, sessions: Session[] = []): QueryFn {
  return ((params: { prompt: AsyncIterable<unknown>; options?: Record<string, unknown> }) => {
    const session: Session = { options: params.options ?? {}, sent: [], usage: [], closed: false }
    sessions.push(session)
    // Whatever the input sends is recorded: a usage read sends nothing.
    void (async () => {
      for await (const message of params.prompt) session.sent.push(message)
    })()
    const signal = (params.options?.abortController as AbortController | undefined)?.signal
    return {
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options: unknown) {
        session.usage.push(options)
        if (answer === 'hang') return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('Control request aborted'))))
        if (answer instanceof Error) throw answer
        return answer
      },
      close() {
        session.closed = true
      },
    }
  }) as unknown as QueryFn
}

const binds: Array<{ readOnly?: readonly string[]; writable?: readonly string[] }> = []
const confine = (bind: { readOnly?: readonly string[]; writable?: readonly string[] }): Confinement => {
  binds.push(bind)
  return { bwrap: '/usr/bin/bwrap', hide: ['/dsh'], readOnly: [...(bind.readOnly ?? [])], writable: [...(bind.writable ?? [])] }
}
const runtime = (query: QueryFn, extra: Partial<RuntimeOptions> = {}) => new ClaudeAgentRuntime({
  query, executable: '/usr/bin/claude', findExecutable: () => undefined, version: async () => CHECKED, home: HOME,
  confine, prove: async () => ({ confined: true, detail: 'host state hidden' }), nested: async () => '', status: async () => '{"loggedIn": true}', ...extra,
})
const signal = () => new AbortController().signal

agentRuntimeLimitsConformance('claude-agent-sdk', {
  readable: () => runtime(usageQuery(GOOD)),
  garbled: () => runtime(usageQuery({ rate_limits_available: true, rate_limits: { five_hour: { utilization: '42%', resets_at: null } } })),
  unchecked: () => runtime(usageQuery(GOOD), { version: async () => '2.2.0' }),
  uncheckedVersion: '2.2.0',
})

describe('claude-agent-sdk: an account\'s usage report from get_usage (ADR-0059)', () => {
  it('reads each redacted answer as its fixture says: the windows with a share, in the seam\'s units, or none', () => {
    const at = Date.parse(FIXTURE.observedAt)
    for (const c of FIXTURE.cases) {
      const read = limitsFromUsage(c.answer, at)
      if (c.unreadable !== undefined) {
        expect('unreadable' in read && read.unreadable, c.case).toContain(c.unreadable)
        continue
      }
      expect(read, c.case).toEqual({ limits: c.limits })
      expectConsistentMetering({ limits: (read as { limits: [] }).limits })
    }
  })

  it('asks get_usage in a session sent no message, with no tool, settings, MCP server, or session kept, under the confinement in the account\'s home, then closes it', async () => {
    const sessions: Session[] = []
    const spawned: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = []
    const spawn: SpawnConfined = (command, args, options) => {
      spawned.push({ command, args, env: options.env })
      return { pid: 7 } as never
    }
    const before = binds.length
    const report = await runtime(usageQuery(GOOD, sessions), { spawn }).limits({}, signal())
    expect(report).toEqual({ limits: (FIXTURE.cases[0]!.limits as Array<Record<string, unknown>>).map((l) => ({ ...l, observedAt: expect.any(String) })) })
    expect(sessions).toHaveLength(1)
    const [session] = sessions
    expect(session!.options).toMatchObject({
      cwd: HOME, tools: [], allowedTools: [], permissionMode: 'dontAsk', permissionPrompts: 'none', settingSources: [], mcpServers: {}, strictMcpConfig: true,
      persistSession: false, pathToClaudeCodeExecutable: '/usr/bin/claude', env: expect.objectContaining({ CLAUDE_CONFIG_DIR: HOME }),
    })
    expect(session!.options).not.toHaveProperty('hooks')
    expect(session!.options).not.toHaveProperty('model')
    expect(session!.usage).toEqual([{ skipBehaviors: true }])
    expect(session!.closed).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(session!.sent).toEqual([])
    // Its home bound back writable, as a probe's; Claude Code itself started under the confinement.
    expect(binds.slice(before)).toEqual([{ writable: [HOME] }])
    const spawnClaudeCodeProcess = session!.options.spawnClaudeCodeProcess as (o: { command: string; args: string[]; cwd?: string; env: Record<string, string>; signal: AbortSignal }) => unknown
    spawnClaudeCodeProcess({ command: '/usr/bin/claude', args: ['--input-format', 'stream-json'], env: { CLAUDE_CONFIG_DIR: HOME }, signal: signal() })
    expect(spawned[0]!.command).toBe('/usr/bin/bwrap')
    expect(spawned[0]!.args.slice(-3)).toEqual(['/usr/bin/claude', '--input-format', 'stream-json'])
  })

  it('reads the account in a named home, and nothing of a home that is not one, never making it (ADR-0051)', async () => {
    const sessions: Session[] = []
    const named = mkdtempSync(join(tmpdir(), 'system-claude-account-'))
    try {
      expect(await runtime(usageQuery(GOOD, sessions)).limits({ home: named }, signal())).toHaveProperty('limits')
      expect(sessions[0]!.options).toMatchObject({ cwd: named, env: expect.objectContaining({ CLAUDE_CONFIG_DIR: named }) })
    } finally {
      rmSync(named, { recursive: true, force: true })
    }
    const absent = join(HOME, 'absent')
    expect(await runtime(usageQuery(GOOD, sessions)).limits({ home: absent }, signal())).toEqual({ unreadable: expect.stringMatching(/does not exist/) })
    expect(existsSync(absent)).toBe(false)
    expect(sessions).toHaveLength(1)
  })

  it('reads nothing on an unchecked version, without confinement, or without Claude Code, and starts no session for it (INV-2)', async () => {
    const sessions: Session[] = []
    const cases: Array<[Partial<RuntimeOptions>, RegExp]> = [
      [{ version: async () => '2.1.400' }, /usage report of Claude Code 2\.1\.400 is not verified/],
      [{ version: async () => { throw new Error('exit 1') } }, /claude --version failed/],
      [{ confine: undefined }, /no read confinement/],
      [{ executable: undefined }, /not installed/],
    ]
    for (const [extra, why] of cases) expect(await runtime(usageQuery(GOOD, sessions), extra).limits({}, signal())).toEqual({ unreadable: expect.stringMatching(why) })
    expect(sessions).toEqual([])
  })

  it('reads an answer it cannot read, a failed request, and a stopped read as unreadable, never a throw, and always closes the session', async () => {
    const sessions: Session[] = []
    const unreadable = (report: LimitReport) => ('unreadable' in report ? report.unreadable : '')
    expect(unreadable(await runtime(usageQuery({ rate_limits_available: false, rate_limits: null }, sessions)).limits({}, signal()))).toMatch(/no plan limits/)
    expect(unreadable(await runtime(usageQuery(new Error('Claude Code returned an error result: not logged in'), sessions)).limits({}, signal()))).toMatch(/get_usage failed: Claude Code returned an error result/)
    const stop = new AbortController()
    const stopped = runtime(usageQuery('hang', sessions)).limits({}, stop.signal)
    await new Promise((resolve) => setTimeout(resolve, 0))
    stop.abort()
    expect(unreadable(await stopped)).toMatch(/the read was stopped/)
    expect(sessions.map((s) => s.closed)).toEqual([true, true, true])
  })
})
