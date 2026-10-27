/**
 * The removability matrix's own checks, cheap enough for every change: every bundle row is classified in
 * docs/architecture/plugin-model.md#required-and-optional-rows exactly once, and the harness boots the
 * bundle as shipped, with the digest row off (the example row of the matrix), and with the profile row off
 * (the template is then absent). The whole matrix is `pnpm test:removability`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Booted, bootBundle, bundleRows, classes, smoke, StepFailure, switches, turnRow } from './matrix.ts'

vi.setConfig({ testTimeout: 180_000 })

const booted: Booted[] = []
afterEach(async () => {
  while (booted.length) await booted.pop()!.dispose()
})

describe('removability matrix harness', () => {
  it('classifies every row of the bundle as required or optional, once', () => {
    const { required, optional } = classes()
    const ids = bundleRows().map((r) => r.id)
    expect([...required, ...optional].sort()).toEqual([...ids].sort())
  })

  it('smokes the bundle as shipped, with the digest row off, and with the profile row off, and names the row and the step of a failure', async () => {
    const on = ['profile-software-development']
    const base = await bootBundle(undefined, on)
    booted.push(base)
    const { tools } = await smoke(base, undefined)
    const system = await bootBundle('digest', on)
    booted.push(system)
    const without = await smoke(system, 'digest', tools)
    expect(without.tools).not.toContain('digests_request')
    // The profile row off: algorithm-development is absent, and the run fails with that reason.
    const profile = await bootBundle('profile-software-development', on)
    booted.push(profile)
    await smoke(profile, 'profile-software-development', tools)
    // A booted bundle with a row that failed to start is reported by the row and the step.
    system.failed.set('digest', 'boom')
    await expect(smoke(system, 'digest', tools)).rejects.toThrow(new StepFailure('digest', 'start', 'rows that failed to start: digest (boom)').message)
  })

  it('the plugin host classifies each row as plugin-model.md does: required rows are never turned off at runtime (T322)', async () => {
    const system = await bootBundle(undefined)
    booted.push(system)
    const { required, optional } = classes()
    const rows = switches(system).rows()
    expect(rows.filter((r) => r.required).map((r) => r.id).sort()).toEqual([...required].sort())
    expect(rows.filter((r) => !r.required).map((r) => r.id).sort()).toEqual([...optional].sort())
  })
})

describe('the runtime switch, on the running bundle (T322, ADR-0078)', () => {
  /** An MCP tool call as the operator makes it. */
  const call = async (system: Booted, name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> }> => {
    const response = await fetch(system.mcp!.url, {
      method: 'POST', signal: AbortSignal.timeout(60_000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      headers: { authorization: `Bearer ${system.mcp!.operator}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    })
    const text = await response.text()
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1) ?? text
    return (JSON.parse(data) as { result: Record<string, unknown> }).result as never
  }

  it('turns an optional row off with no restart: System stays healthy, the row\'s seam is absent and the row says why; on again restores it, with no restart (T322)', async () => {
    const on = ['profile-software-development']
    const system = await bootBundle(undefined, on)
    booted.push(system)
    const { tools } = await smoke(system, undefined)
    expect(tools).toContain('digests_request')
    // Off through the operator's MCP tool, with a reason.
    const off = await call(system, 'plugin', { action: 'off', row: 'digest', reason: 'its digests are wrong today' })
    expect(off.isError).toBeFalsy()
    expect(system.ctx.get('digests' as never)).toBeUndefined()
    const without = await smoke(system, 'digest', tools)
    expect(without.tools).not.toContain('digests_request')
    const listed = (await call(system, 'plugin', {})).structuredContent as { rows: Array<{ id: string; on: boolean; turned?: { reason?: string } }> }
    expect(listed.rows.find((r) => r.id === 'digest')).toMatchObject({ on: false, turned: { on: false, reason: 'its digests are wrong today' } })
    // On again, in the same process: the seam and its tools are back.
    const back = await turnRow(system, 'digest', true)
    expect(system.ctx.get('digests' as never)).toBeDefined()
    const restored = await smoke(back, undefined, tools)
    expect(restored.tools).toEqual(tools)
  })

  it('refuses to turn off a required row, saying why, through the host and through the operator\'s MCP tool; the row keeps running (T322)', async () => {
    const system = await bootBundle(undefined)
    booted.push(system)
    await expect(switches(system).turn('workflow', false)).rejects.toMatchObject({ failure: 'required' })
    const refused = await call(system, 'plugin', { action: 'off', row: 'workflow' })
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^required: row workflow is required/) }] })
    expect(system.ctx.get('workflow' as never)).toBeDefined()
    expect(switches(system).rows().find((r) => r.id === 'workflow')).toMatchObject({ on: true, required: true })
  })

  it('refuses to turn off mcp-server, the surface the switches are served on, through the operator\'s MCP tool: the endpoint still answers, and turns rows on again (T322)', async () => {
    const system = await bootBundle(undefined)
    booted.push(system)
    const refused = await call(system, 'plugin', { action: 'off', row: 'mcp-server', reason: 'try' })
    expect(refused).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^control: row mcp-server is never turned off at runtime/) }] })
    expect(system.ctx.get('mcp' as never)).toBeDefined()
    expect(switches(system).rows().find((r) => r.id === 'mcp-server')).toMatchObject({ on: true })
    // The surface still serves the switch both ways.
    expect((await call(system, 'plugin', { action: 'off', row: 'report' })).isError).toBeFalsy()
    expect((await call(system, 'plugin', { action: 'on', row: 'report' })).isError).toBeFalsy()
    expect(switches(system).rows().find((r) => r.id === 'report')).toMatchObject({ on: true })
  })

  it('moves an enforce switch from on to warn through the operator\'s MCP tool, live, and the engine reads it (T322)', async () => {
    const system = await bootBundle(undefined)
    booted.push(system)
    const modes = async (): Promise<Record<string, string>> => Object.fromEntries(((await call(system, 'enforce', {})).structuredContent as { mechanisms: Array<{ mechanism: string; mode: string }> }).mechanisms.map((m) => [m.mechanism, m.mode]))
    expect((await modes())['evidence-gate']).toBe('on')
    const set = await call(system, 'enforce', { mechanism: 'evidence-gate', mode: 'warn', reason: 'refusing good steps' })
    expect(set).toMatchObject({ structuredContent: { mechanism: 'evidence-gate', mode: 'warn', override: { reason: 'refusing good steps' } } })
    expect((await modes())['evidence-gate']).toBe('warn')
    expect((system.ctx as unknown as { pluginHost: { enforced(m: string): string | undefined } }).pluginHost.enforced('evidence-gate')).toBe('warn')
    expect(await call(system, 'enforce', { mechanism: 'lead-rights', mode: 'off' })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^unsupported:/) }] })
  })
})
