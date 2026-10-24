import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import Store from '@tsuuanmi/system-store'
import { describe, expect, it, onTestFinished } from 'vitest'
import { z as zod } from 'zod'
import { FakePluginHost, manifestText } from '../../../plugin-host-core/conformance/plugin-host.ts'
import { FakeResources } from '../../../resources-core/conformance/resources.ts'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import type { PluginRecord } from '@tsuuanmi/system-plugin-host-core'
import McpEndpoint, { needsLook } from '../src/index.ts'

type Tokens = Record<'operator' | 'client' | 'model', string>

async function boot(): Promise<{ url: string; token: string; tokens: Tokens; dir: string; ctx: Context; stop: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-mcp-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(Store, { path: join(dir, 'system.db') }),
    ctx.plugin(Artifacts, {}),
    ctx.plugin(McpEndpoint, { tokenDir: dir, discoveryFile: join(dir, 'mcp.json') }),
  ]
  await Promise.all(fibers)
  // Unloaded when the test finishes, or before, by a test that looks at what unloading does.
  const stop = async (): Promise<void> => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  }
  onTestFinished(stop)
  const discovery = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFiles: Tokens }
  const tokens = Object.fromEntries(Object.entries(discovery.tokenFiles).map(([scope, file]) => [scope, readFileSync(file).toString('base64url')])) as Tokens
  return { url: discovery.url, token: tokens.operator, tokens, dir, ctx, stop }
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }) as unknown as Transport)
  onTestFinished(() => client.close())
  return client
}

describe('system MCP server on ctx.webServer', () => {
  it('serves tools contributed by plugins, for the contributing plugin\'s lifetime only (REQ-GW-3, INV-10)', async () => {
    const { url, token, ctx } = await boot()
    const fiber = ctx.inject(['mcp'], (c) => {
      c.mcp.tool('echo', { description: 'Echo back', inputSchema: { text: zod.string() } }, async ({ text }) => ({ content: [{ type: 'text' as const, text: String(text) }] }))
    })
    await fiber
    const client = await connect(url, token)
    expect((await client.callTool({ name: 'echo', arguments: { text: 'hi' } })).content).toEqual([{ type: 'text', text: 'hi' }])
    await fiber.dispose()
    const after = await connect(url, token)
    expect((await after.listTools()).tools.map((t) => t.name)).not.toContain('echo')
    expect(() => ctx.mcp.tool('status', { description: 'x', inputSchema: {} }, async () => ({ content: [] }))).toThrow(/already/)
  })

  it('writes a 0600 discovery file and serves the slice 1 tool surface', async () => {
    const { url, token, dir } = await boot()
    expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600)
    const client = await connect(url, token)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['artifact', 'ask', 'events', 'evidence', 'research', 'result', 'roster', 'status'])
    const status = await client.callTool({ name: 'status', arguments: {} })
    expect(status.structuredContent).toMatchObject({ harness: 'system', store: 'ok', artifacts: 0, kernel: ['store', 'artifacts'] })
    // No milestone baked into the code: status reports what is mounted, not a roadmap stage.
    expect(status.structuredContent).not.toHaveProperty('stage')
  })

  it('reports health in status: every check for both scopes, what to do only for the operator (REQ-HOST-6, ADR-0023)', async () => {
    const { url, tokens } = await boot()
    type Health = { state: string; checks: Array<{ name: string; state: string; detail: string }> }
    const health = async (token: string) => ((await (await connect(url, token)).callTool({ name: 'status', arguments: {} })).structuredContent as { health: Health }).health
    const operator = await health(tokens.operator)
    const client = await health(tokens.client)
    expect(operator.checks.map((c) => c.name)).toEqual(['plugins', 'runtime', 'store', 'disk'])
    expect(operator.checks[0]).toMatchObject({ name: 'plugins', state: 'ok' })
    expect(operator.checks.find((c) => c.name === 'store')).toMatchObject({ state: 'ok' })
    expect(client.state).toBe(operator.state)
    // A client sees which checks are ok, never versions, paths, sizes, or names.
    expect(client.checks).toEqual(operator.checks.map(({ name, state }) => ({ name, state })))
  })

  it('is degraded by a run whose usage the ledger could not count in its pool\'s current window, until the ledger counts a record of it (D25)', async () => {
    const { url, tokens, ctx } = await boot()
    const pool = { pool: 'max.agents', account: 'max', kind: 'programmatic' as const, unknown: 'available' as const, windows: [{ id: 'five-hour', kind: 'rolling' as const, seconds: 18_000 }] }
    const fibers = [ctx.plugin(EventLog, {}), ctx.plugin(FakeResources, { pools: [pool] })]
    await Promise.all(fibers)
    onTestFinished(async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    })
    type Check = { name: string; state: string; detail: string }
    const usage = async () => ((await (await connect(url, tokens.operator)).callTool({ name: 'status', arguments: {} })).structuredContent as { health: { checks: Check[] } }).health.checks.find((c) => c.name === 'usage')
    expect(await usage()).toMatchObject({ state: 'ok' })
    const observedAt = new Date().toISOString()
    ctx.eventLog.append({ type: 'usage.unknown', runId: 'run_wf', data: { schema: 'usage-unknown@1.0', runId: 'arun_1', kind: 'not-reported', account: 'max', pool: 'max.agents', observedAt, reason: 'its runtime reported neither tokens nor turns' } })
    expect(await usage()).toMatchObject({ state: 'degraded', detail: expect.stringMatching(/^max\.agents: 1 run\(s\) in its current window \(the last 5h\) whose usage the ledger could not count \(1 not-reported\)\. A cap counts each as 0/) })
    // Reconciled: the ledger now counts a record of the run.
    await ctx.resources.record({ schema: 'usage-record@1.0', requestId: 'transcript:arun_1', source: 'transcript', observedAt, account: 'max', pool: 'max.agents', runId: 'arun_1', turns: 4 })
    expect(await usage()).toMatchObject({ state: 'ok' })
    // Past the event log's 1,000 entries per query, a new run is still read: the check pages. One
    // transaction, not a thousand fsynced commits: those held the event loop for seconds on a loaded
    // host, past the server's keep-alive, and the next call's pooled socket was reset (ECONNRESET).
    ctx.store.transaction(() => {
      for (let i = 0; i < 1000; i += 1) ctx.eventLog.append({ type: 'usage.unknown', runId: 'run_wf', data: { schema: 'usage-unknown@1.0', runId: 'arun_1', kind: 'interrupted', account: 'max', pool: 'max.agents', observedAt, reason: 'the host stopped while it ran, so no result came' } })
      ctx.eventLog.append({ type: 'usage.unknown', runId: 'run_wf', data: { schema: 'usage-unknown@1.0', runId: 'arun_2', kind: 'not-reported', account: 'max', pool: 'max.agents', observedAt, reason: 'its runtime reported neither tokens nor turns' } })
    })
    expect(await usage()).toMatchObject({ state: 'degraded', detail: expect.stringMatching(/^max\.agents: 1 run\(s\) in its current window/) })
  })

  it('serves the roster to the operator and to a client (the lead), the client without account labels, valid against mcp-roster@1.3 (REQ-HOST-8)', async () => {
    const { url, tokens, ctx } = await boot()
    const at = '2026-10-24T09:29:58.000Z'
    const plus = { id: 'plus', group: 'chatgpt-web', mode: 'assigned' as const }
    class Router extends Service {
      constructor(c: Context) {
        super(c, 'workers')
      }
      async list() {
        return [
          { worker: 'worker:plus/standard', provider: 'chatgpt-web', family: 'chatgpt-web', account: plus, load: { running: 1, queued: 0, pending: 0, slots: 2 }, tier: 'standard', quotaClass: 'subscription-chat', locality: 'remote', state: 'ready', observedAt: at },
          { worker: 'worker:plus/frontier', provider: 'chatgpt-web', family: 'chatgpt-web', account: { ...plus, limitUntil: '2026-10-24T11:00:00.000Z' }, tier: 'frontier', quotaClass: 'subscription-chat', locality: 'remote', state: 'quota-exhausted', observedAt: at },
        ]
      }
      sources() {
        return [{ source: 'website', state: 'described', at, workers: 2 }]
      }
      siblings() {
        return ['worker:plus/frontier', 'worker:plus/standard']
      }
    }
    class Catalog extends Service {
      constructor(c: Context) {
        super(c, 'accounts')
      }
      async list() {
        return [{ id: 'plus', provider: 'chatgpt-web', label: 'Studio Plus', status: 'ready' }]
      }
      async duplicateIdentities() {
        return []
      }
    }
    const pool = { pool: 'plus.chat', account: 'plus', kind: 'interactive' as const, windows: [{ id: 'three-hour', kind: 'rolling' as const, seconds: 10_800 }] }
    const fibers = [ctx.plugin(Router), ctx.plugin(Catalog), ctx.plugin(EventLog, {}), ctx.plugin(FakeResources, { pools: [pool] })]
    await Promise.all(fibers)
    onTestFinished(async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    })
    const roster = async (token: string) => (await connect(url, token)).callTool({ name: 'roster', arguments: {} })
    const operator = await roster(tokens.operator)
    const schemas = new SchemaRegistry()
    schemas.assertDef('mcp-roster@1.3', 'roster-output', operator.structuredContent)
    expect(operator.structuredContent).toMatchObject({
      counts: { ready: 0, busy: 1, resting: 1, unavailable: 0, quarantined: 0 },
      workers: { value: [
        { worker: 'worker:plus/frontier', availability: { state: 'resting', until: { value: '2026-10-24T11:00:00.000Z' } }, siblings: { value: ['worker:plus/standard'] } },
        { worker: 'worker:plus/standard', role: { value: null }, availability: { summary: 'busy 1 of 2' }, account: { value: { record: { value: { kind: 'website', label: { value: 'Studio Plus' }, status: 'ready' } } } },
          pools: { value: [{ pool: 'plus.chat', available: false, windows: [{ id: 'three-hour', state: 'unknown', used: { unknown: 'no reading yet' } }], unknownUsage: { value: { runs: 0, kinds: {} } } }] },
          work: { unknown: 'the workflow engine (ctx.workflow) is not mounted' } },
      ] },
    })
    expect((operator.content as Array<{ text: string }>)[0]!.text).toMatch(/^Roster as of .*: 2 Worker\(s\): 0 ready, 1 busy, 1 resting, 0 unavailable, 0 quarantined\n/)
    const client = await roster(tokens.client)
    schemas.assertDef('mcp-roster@1.3', 'roster-output', client.structuredContent)
    expect(JSON.stringify(client.structuredContent)).not.toContain('Studio Plus')
    expect(client.structuredContent).toMatchObject({ counts: { busy: 1, resting: 1 } })
    // The model token reaches no MCP tool.
    const model = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'roster', arguments: {} } }), headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.model}` } })
    expect(model.status).toBe(401)
  })

  it('reads each Worker source\'s last read into health, after listing the Workers: a silent one is named, never ok (INV-2)', async () => {
    const { url, tokens, ctx } = await boot()
    const at = '2026-10-23T09:41:07.000Z'
    const order: string[] = []
    // A router whose last read did not hear from the agents source: seven Workers answered, its three did not.
    class Router extends Service {
      constructor(c: Context) {
        super(c, 'workers')
      }
      async list() {
        order.push('list')
        return Array.from({ length: 7 }, (_, i) => ({ worker: `w${i}`, state: 'ready' }))
      }
      sources() {
        order.push('sources')
        return [{ source: 'agents', state: 'silent', at, workers: 0, detail: 'did not describe its Workers within 5 s' }, { source: 'turns', state: 'described', at, workers: 7 }]
      }
    }
    const fiber = ctx.plugin(Router)
    await fiber
    onTestFinished(() => fiber.dispose())
    type Health = { state: string; checks: Array<{ name: string; state: string; detail?: string }> }
    const health = async (token: string) => ((await (await connect(url, token)).callTool({ name: 'status', arguments: {} })).structuredContent as { health: Health }).health
    const operator = await health(tokens.operator)
    expect(operator.checks.find((c) => c.name === 'workers')).toEqual({ name: 'workers', state: 'degraded', detail: expect.stringMatching(/^7 available; source agents did not describe its Workers within 5 s \(at 2026-10-23T09:41:07\.000Z\): routing sees none of its Workers/) })
    expect(operator.state).toBe('degraded')
    expect(order).toEqual(['list', 'sources'])
    // A client sees that it is degraded, never which source.
    expect((await health(tokens.client)).checks.find((c) => c.name === 'workers')).toEqual({ name: 'workers', state: 'degraded' })
  })

  it('counts and lists the runs whose liveness needs a look, for the operator, and is degraded while one holds what it ran in (PROP-0013, ADR-0023)', async () => {
    const { url, tokens, ctx } = await boot()
    const run = (execution: string, state: string, since: string) => ({ source: 'agents', execution, worker: 'agent:dev', state, since, runId: 'run_1', sessionId: 'ses_1', reasons: ['r'], holds: ['session ses_1'], action: 'a' })
    let told = { runs: [run('arun_2', 'stalled', '2026-10-24T02:00:00.000Z'), run('arun_1', 'unknown', '2026-10-24T01:00:00.000Z')], counts: { unknown: 1, looking: 0, stalled: 1 }, unread: [] as Array<{ source: string; detail: string }> }
    let reads = 0
    class Router extends Service {
      constructor(c: Context) {
        super(c, 'workers')
      }
      async list() {
        return [{ worker: 'agent:dev', state: 'ready' }]
      }
      async liveness() {
        reads += 1
        return told
      }
    }
    const fiber = ctx.plugin(Router)
    await fiber
    onTestFinished(() => fiber.dispose())
    type Status = { liveness?: Record<string, unknown>; health: { state: string; checks: Array<{ name: string; state: string; detail?: string }> } }
    const call = async (token: string) => (await connect(url, token)).callTool({ name: 'status', arguments: {} })
    const operator = await call(tokens.operator)
    const status = operator.structuredContent as Status
    // Read once for the check and the list.
    expect(reads).toBe(1)
    expect(status.health.checks.find((c) => c.name === 'liveness')).toEqual({
      name: 'liveness', state: 'degraded',
      detail: '1 ended without being known to be gone, their session and worktree held: arun_1 (agent:dev); 1 stalled (nothing is sent to them; their deadline ends them): arun_2 (agent:dev). system explain <run> says why and what to do; free a run once its agent is gone: system free <run> --agent-gone (docs/operations/runbooks.md#a-runs-liveness-is-unknown)',
    })
    expect(status.liveness).toEqual({
      counts: { unknown: 1, looking: 0, stalled: 1 },
      runs: [
        { source: 'agents', execution: 'arun_2', worker: 'agent:dev', state: 'stalled', since: '2026-10-24T02:00:00.000Z', runId: 'run_1' },
        { source: 'agents', execution: 'arun_1', worker: 'agent:dev', state: 'unknown', since: '2026-10-24T01:00:00.000Z', runId: 'run_1' },
      ],
    })
    expect((operator.content as Array<{ text: string }>)[0]!.text).toMatch(/; runs: 1 unknown, 1 stalled$/)
    // A client learns the check's state, never the runs.
    const client = (await call(tokens.client)).structuredContent as Status
    expect(client.liveness).toBeUndefined()
    expect(client.health.checks.find((c) => c.name === 'liveness')).toEqual({ name: 'liveness', state: 'degraded' })
    // A stall alone needs nothing yet; a source that cannot tell is never read as having none (INV-2).
    told = { runs: [run('arun_2', 'stalled', '2026-10-24T02:00:00.000Z')], counts: { unknown: 0, looking: 0, stalled: 1 }, unread: [] }
    expect(((await call(tokens.operator)).structuredContent as Status).health.checks.find((c) => c.name === 'liveness')).toMatchObject({ state: 'ok', detail: '1 stalled (nothing is sent to them; their deadline ends them): arun_2 (agent:dev)' })
    told = { runs: [], counts: { unknown: 0, looking: 0, stalled: 0 }, unread: [{ source: 'agents', detail: 'the store failed' }] }
    const unread = (await call(tokens.operator)).structuredContent as Status
    expect(unread.health.checks.find((c) => c.name === 'liveness')).toMatchObject({ state: 'degraded', detail: expect.stringMatching(/^source agents cannot tell \(the store failed\)\./) })
    expect(unread.liveness).toEqual({ counts: { unknown: 0, looking: 0, stalled: 0 }, runs: [], unread: [{ source: 'agents', detail: 'the store failed' }] })
    told = { runs: [], counts: { unknown: 0, looking: 0, stalled: 0 }, unread: [] }
    const quiet = (await call(tokens.operator)).structuredContent as Status
    expect(quiet.liveness).toBeUndefined()
    expect(quiet.health.checks.find((c) => c.name === 'liveness')).toMatchObject({ state: 'ok', detail: 'no run is stalled, being looked at, or held for want of a verdict' })
  })

  it('lists every plugin of the composition with its manifest, recorded lifecycle, and what the manifest check found, for the operator only, and fails health on a finding (REQ-HOST-7, ADR-0023, ADR-0048)', async () => {
    const { url, tokens, ctx } = await boot()
    const composition = {
      rows: [{ id: 'a', name: '@x/a', mounted: true }, { id: 'b', name: '@x/b', mounted: false }, { id: 'c', name: '@x/c', mounted: true }, { id: 'dsh', name: '@x/dsh', mounted: true }, { id: 'allowed', name: '@x/allowed', mounted: true }],
      packages: { '@x/a': manifestText('@x/a', { version: '2.1.0' }), '@x/b': manifestText('@x/b'), '@x/c': manifestText('@x/c', { _meta: {} }), '@x/dsh': undefined, '@x/allowed': undefined },
      allowWithoutManifest: ['@x/allowed'],
    }
    // @x/allowed was recorded while its row was off; with no manifest now its record stays `candidate` though it is mounted.
    const recorded = { state: 'candidate' as const, since: '2026-01-01T00:00:00.000Z', decision: `sha256:${'a'.repeat(64)}` as const, version: '1.0.0' }
    const ledger = new Map([['@x/allowed', { name: '@x/allowed', ...recorded, rows: ['allowed'] }]])
    const host = ctx.plugin(FakePluginHost, { composition, ledger })
    await host
    onTestFinished(() => host.dispose())
    type Status = { plugins?: Array<Record<string, unknown>>; pluginsOmitted?: number; health: { state: string; checks: Array<{ name: string; state: string; detail?: string }> } }
    const call = async (token: string, args: Record<string, unknown> = {}) => (await connect(url, token)).callTool({ name: 'status', arguments: args })
    const status = async (token: string, args: Record<string, unknown> = {}) => (await call(token, args)).structuredContent as Status
    const all = await status(tokens.operator, { plugins: true })
    const checked = { since: expect.any(String), decision: expect.stringMatching(/^sha256:/) }
    const [a, b, c, dsh, allowed] = [
      { name: '@x/a', rows: ['a'], mounted: true, manifest: 'valid', version: '2.1.0', class: { kind: 'family', family: 'surface' }, lifecycle: { state: 'default', since: expect.any(String), decision: expect.stringMatching(/^sha256:/) } },
      { name: '@x/b', rows: ['b'], mounted: false, manifest: 'valid', version: '1.0.0', class: { kind: 'family', family: 'surface' }, lifecycle: expect.objectContaining({ state: 'candidate' }) },
      { name: '@x/c', rows: ['c'], mounted: true, manifest: 'refused', reason: expect.stringMatching(/_meta/), findings: [{ kind: 'no-manifest', manifest: 'refused', reason: expect.stringMatching(/refused: it declares _meta/) }], checked },
      { name: '@x/dsh', rows: ['dsh'], mounted: true, manifest: 'absent', reason: expect.stringMatching(/ships no plugin-manifest\.json/), findings: [{ kind: 'no-manifest', manifest: 'absent', reason: expect.stringMatching(/no manifest/) }], checked },
      { name: '@x/allowed', rows: ['allowed'], mounted: true, manifest: 'absent', reason: expect.stringMatching(/ships no plugin-manifest\.json/), lifecycle: { state: 'candidate', since: recorded.since, decision: recorded.decision } },
    ]
    expect(all.plugins).toEqual([a, b, c, dsh, allowed])
    expect(all).not.toHaveProperty('pluginsOmitted')
    // Unasked, only the plugins that need a look: a finding, a refused manifest, a lifecycle the composition does not give it.
    const operator = await status(tokens.operator)
    expect(operator.plugins).toEqual([c, dsh, allowed])
    expect(operator.pluginsOmitted).toBe(2)
    expect(operator.health).toEqual(all.health)
    expect(operator.health.checks.find((c) => c.name === 'manifests')).toMatchObject({ state: 'down', detail: expect.stringMatching(/^@x\/c: it runs with a manifest the host refused: it declares _meta.*; @x\/dsh: it runs with no manifest/) })
    expect(operator.health.state).toBe('down')
    // The text is a summary of the answer, never the answer again.
    // The host's own checks (disk) depend on where the test runs, so the expected text names what this health reports.
    const notOk = operator.health.checks.filter((c) => c.state !== 'ok').map((c) => `${c.name} ${c.state}`)
    expect(notOk).toContain('manifests down')
    expect((await call(tokens.operator)).content).toEqual([{ type: 'text', text: `health down: 5 checks, ${notOk.join(', ')}; 5 plugins, 3 listed (those that need a look; plugins: true lists every one)` }])
    for (const args of [{}, { plugins: true }]) {
      const client = await status(tokens.client, args)
      expect(client.plugins).toBeUndefined()
      expect(client.health.checks.find((c) => c.name === 'manifests')).toEqual({ name: 'manifests', state: 'down' })
    }
  })

  it('lists unasked a plugin whose recorded lifecycle is not the one the composition gives it: default when mounted, candidate when its rows are off, retired when none names it', () => {
    const plugin = (mounted: boolean, rows: string[], state?: 'default' | 'candidate' | 'retired'): PluginRecord => ({
      name: '@x/p', rows, mounted, manifestState: 'valid', ...(state ? { lifecycle: { state, since: '2026-01-01T00:00:00.000Z', decision: `sha256:${'a'.repeat(64)}` } } : {}),
    })
    expect([plugin(true, ['p'], 'default'), plugin(false, ['p'], 'candidate'), plugin(false, [], 'retired'), plugin(true, ['p'])].map(needsLook)).toEqual([false, false, false, false])
    expect([plugin(true, ['p'], 'candidate'), plugin(false, ['p'], 'default'), plugin(false, [], 'candidate')].map(needsLook)).toEqual([true, true, true])
    expect(needsLook({ ...plugin(true, ['p'], 'default'), manifestState: 'refused' })).toBe(true)
  })

  it('reads the event log for the operator only, in order, a page at a time (QA-7, ADR-0023)', async () => {
    const { url, tokens, ctx } = await boot()
    const fiber = ctx.plugin(EventLog, {})
    await fiber
    onTestFinished(() => fiber.dispose())
    for (const type of ['a.one', 'b.two', 'a.three']) ctx.eventLog.append({ type, runId: 'r1' })
    const operator = await connect(url, tokens.operator)
    const read = async (args: Record<string, unknown>) => (await operator.callTool({ name: 'events', arguments: args })).structuredContent as { events: Array<{ seq: number; type: string }>; next: number }
    const first = await read({ runId: 'r1', limit: 2 })
    expect(first.events.map((e) => e.type)).toEqual(['a.one', 'b.two'])
    expect((await read({ runId: 'r1', afterSeq: first.next })).events.map((e) => e.type)).toEqual(['a.three'])
    expect((await read({ type: 'a.three' })).events).toHaveLength(1)
    const client = await connect(url, tokens.client)
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('events')
  })

  it('shows drift evidence to the operator only, and nothing but evidence (INV-12, ADR-0023)', async () => {
    const { url, tokens, ctx } = await boot()
    const outline = { schema: 'ui-outline@1.0', root: 'body', truncated: false, nodes: [{ depth: 0, tag: 'body', text: 3 }] }
    const evidence = ctx.artifacts.put({ kind: 'evidence', bodySchema: 'ui-outline@1.0', body: outline, classification: 'local-private', producer: { type: 'system', ref: 'ui-ops/test' } })
    const report = ctx.artifacts.put({ kind: 'report', bodySchema: 'ui-outline@1.0', body: outline, classification: 'local-private', producer: { type: 'system', ref: 'test' } })
    const operator = await connect(url, tokens.operator)
    expect((await operator.callTool({ name: 'evidence', arguments: { id: evidence.id } })).structuredContent).toMatchObject({ id: evidence.id, bodySchema: 'ui-outline@1.0', body: outline })
    expect(await operator.callTool({ name: 'evidence', arguments: { id: report.id } })).toMatchObject({ isError: true })
    const client = await connect(url, tokens.client)
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('evidence')
  })

  it('reports health down, naming the plugin, when a plugin failed to activate or waits for a service no one supplies (M6b)', async () => {
    const { url, tokens, ctx } = await boot()
    const broken = ctx.plugin({ name: 'broken-plugin', apply: () => { throw new Error('bad config') } } as never, {} as never)
    const waiting = ctx.plugin({ name: 'waiting-plugin', inject: ['nowhere'], apply: () => {} } as never, {} as never)
    await Promise.resolve(broken).catch(() => undefined)
    onTestFinished(() => broken.dispose())
    onTestFinished(() => waiting.dispose())
    const health = ((await (await connect(url, tokens.operator)).callTool({ name: 'status', arguments: {} })).structuredContent as { health: { state: string; checks: Array<{ name: string; state: string; detail: string }> } }).health
    expect(health.state).toBe('down')
    expect(health.checks.find((c) => c.name === 'plugins')).toMatchObject({ state: 'down', detail: expect.stringMatching(/broken-plugin failed: bad config; waiting-plugin pending: waiting for service nowhere/) })
  })

  it('keeps health ok when a running plugin waits, inside itself, for a service no one supplies (an anonymous inject callback, as DSH waits for settings)', async () => {
    const { url, tokens, ctx } = await boot()
    const fine = ctx.plugin({ name: 'fine-plugin', apply: (c: Context) => { c.inject(['settings'], () => {}) } } as never, {} as never)
    await fine
    onTestFinished(() => fine.dispose())
    const health = ((await (await connect(url, tokens.operator)).callTool({ name: 'status', arguments: {} })).structuredContent as { health: { checks: Array<{ name: string; state: string; detail: string }> } }).health
    expect(health.checks.find((c) => c.name === 'plugins')).toMatchObject({ state: 'ok' })
  })

  it('answers liveness at /healthz with no token and no data', async () => {
    const { url } = await boot()
    const live = await fetch(new URL('/healthz', url))
    expect([live.status, await live.text()]).toEqual([200, 'ok'])
  })

  it('reports ask as not installed rather than pretending to work', async () => {
    const { url, token } = await boot()
    const client = await connect(url, token)
    const result = await client.callTool({ name: 'ask', arguments: { prompt: 'hello' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toMatch(/workflow engine is not mounted/)
  })

  it('rejects a missing token, a browser origin, and a foreign Host header (QA-5)', async () => {
    const { url, token } = await boot()
    const init = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }
    expect((await fetch(url, init)).status).toBe(401)
    expect((await fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}`, origin: 'https://evil.example' } })).status).toBe(403)
    const port = new URL(url).port
    const response = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: `evil.example:${port}`, authorization: `Bearer ${token}` } }, (res) => resolve(res.statusCode ?? 0))
        req.on('error', reject)
        req.end('{}')
      }, reject)
    })
    expect(response).toBe(421)
  })

  it('removes the discovery file when the plugin unloads', async () => {
    const { dir, stop } = await boot()
    await stop()
    expect(() => statSync(join(dir, 'mcp.json'))).toThrow()
  })
})

/** Scoped control credentials (ADR-0023): what each token holder may see and call over /mcp. */
describe('scoped tokens', () => {
  const callBody = (name: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
  const post = (url: string, token: string, body: string) => fetch(url, {
    method: 'POST', body, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
  })

  it('lets the operator read any artifact, local-private included, and never a client (INV-12, QA-14)', async () => {
    const { url, tokens, ctx } = await boot()
    const answer = ctx.artifacts.put({
      kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'local-private', producer: { type: 'worker', ref: 'gemini-web/gemini-main' },
      body: { schema: 'provider-answer@1.0', provider: 'gemini-web', account: 'gemini-main', turnId: 'turn_1', conversation: { mode: 'temporary' }, promptHash: `sha256:${'0'.repeat(64)}`, text: 'The findings follow.' },
    })
    const operator = await connect(url, tokens.operator)
    expect((await operator.callTool({ name: 'artifact', arguments: { id: answer.id, max: 3 } })).structuredContent).toMatchObject({ state: 'stored', classification: 'local-private', content: 'text', chars: 20, truncated: true, text: 'The' })
    expect(await operator.callTool({ name: 'artifact', arguments: { id: 'run_1' } })).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^not a content id/) }] })
    const client = await connect(url, tokens.client)
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('artifact')
    const refused = await post(url, tokens.client, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'artifact', arguments: { id: answer.id } } }))
    expect(refused.status).toBe(403)
  })

  it('refuses a client token calling the operator\'s events tool (QA-14, QA-7)', async () => {
    const { url, tokens } = await boot()
    const refused = await post(url, tokens.client, callBody('events'))
    expect(refused.status).toBe(403)
    expect(refused.headers.get('www-authenticate')).toContain('insufficient_scope')
  })

  it('shows a client only the client tools; the operator sees every tool; a tool that declares no scope is operator-only (QA-14)', async () => {
    const { url, tokens, ctx } = await boot()
    ctx.mcp.tool('op_only', { description: 'operator action', inputSchema: {} }, async () => ({ content: [{ type: 'text' as const, text: 'done' }] }))
    ctx.mcp.tool('cl_tool', { description: 'client tool', inputSchema: {}, scope: 'client' }, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }))
    const client = await connect(url, tokens.client)
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['ask', 'cl_tool', 'research', 'result', 'roster', 'status'])
    const operator = await connect(url, tokens.operator)
    const listed = (await operator.listTools()).tools
    expect(listed.map((t) => t.name).sort()).toEqual(['artifact', 'ask', 'cl_tool', 'events', 'evidence', 'op_only', 'research', 'result', 'roster', 'status'])
    // The reference page shows each tool's scope from the listing: marked operator, or a client tool too.
    expect(listed.find((t) => t.name === 'op_only')?._meta).toEqual({ 'system/scope': 'operator' })
    expect(listed.find((t) => t.name === 'cl_tool')).not.toHaveProperty('_meta')
    expect((await operator.callTool({ name: 'op_only', arguments: {} })).content).toEqual([{ type: 'text', text: 'done' }])
  })

  it('lists each tool as the SDK would, less what tells a client nothing; a call is validated as strictly (QA-12, QA-14)', async () => {
    const { url, tokens, ctx } = await boot()
    const at = zod.iso.datetime({ offset: true })
    const inputSchema = { since: at.optional().describe('From'), window: zod.object({ until: at, size: zod.number().int().min(1) }).optional(), tag: zod.string().regex(/^[a-z]+$/).max(20).optional() }
    ctx.mcp.tool('when', { description: 'dated', inputSchema, scope: 'client' }, async (args) => ({ content: [{ type: 'text' as const, text: JSON.stringify(args) }] }))
    ctx.mcp.tool('op_when', { description: 'dated, operator', inputSchema }, async () => ({ content: [] }))
    // What the SDK's own tools/list sends for the same zod schema (JSON Schema draft-07, with $schema).
    const sdk = toJsonSchemaCompat(zod.object(inputSchema), { strictUnions: true, pipeStrategy: 'input' }) as Record<string, unknown>
    expect(sdk).toHaveProperty('$schema')
    expect(JSON.stringify(sdk)).toMatch(/"format":"date-time","pattern":"\^\(\?:/)
    // Draft-07 and 2020-12 read these keywords alike, so no $schema; the date-time format stands for zod's pattern.
    const strip = (node: unknown): unknown => Array.isArray(node) ? node.map(strip) : node !== null && typeof node === 'object'
      ? Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$schema' && !(key === 'pattern' && (node as { format?: unknown }).format === 'date-time')).map(([key, value]) => [key, strip(value)]))
      : node
    const expected = strip(sdk)
    for (const [scope, token] of [['client', tokens.client], ['operator', tokens.operator]] as const) {
      const response = await post(url, token, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
      const text = await response.text()
      const tools = (JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6)) as { result: { tools: Array<Record<string, unknown>> } }).result.tools
      // No `$schema`, no `execution` (absent, a tool takes no task: the SDK's "forbidden").
      for (const tool of tools) {
        expect(Object.keys(tool).filter((key) => key !== '_meta').sort(), `${scope} ${String(tool.name)}`).toEqual(['description', 'inputSchema', 'name'])
        expect(JSON.stringify(tool.inputSchema)).not.toContain('$schema')
      }
      expect(tools.find((t) => t.name === 'when')).toEqual({ name: 'when', description: 'dated', inputSchema: expected })
      expect(JSON.stringify(expected)).toContain('"pattern":"^[a-z]+$"')
      expect(JSON.stringify(expected)).not.toMatch(/date-time","pattern"/)
      // Only the operator token sees a tool the client token may not call, and only it is marked.
      expect(tools.filter((t) => t._meta !== undefined).map((t) => t.name).sort()).toEqual(scope === 'operator' ? ['artifact', 'events', 'evidence', 'op_when'] : [])
    }
    // The server still checks every date-time and pattern with zod, as before.
    const client = await connect(url, tokens.client)
    expect(await client.callTool({ name: 'when', arguments: { since: '2026-10-24T08:00:00+07:00', window: { until: '2026-10-24T09:00:00Z', size: 1 } } })).not.toHaveProperty('isError', true)
    for (const bad of [{ since: '2026-10-24' }, { since: '2026-02-30T08:00:00Z' }, { window: { until: 'tomorrow', size: 1 } }, { tag: 'A' }]) {
      expect(await client.callTool({ name: 'when', arguments: bad }), JSON.stringify(bad)).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/Input validation error/) }] })
    }
  })

  it('refuses a client calling an operator tool with 403 insufficient_scope, in a batch too (QA-14)', async () => {
    const { url, tokens, ctx } = await boot()
    ctx.mcp.tool('op_only', { description: 'operator action', inputSchema: {} }, async () => ({ content: [] }))
    const refused = await post(url, tokens.client, callBody('op_only'))
    expect(refused.status).toBe(403)
    expect(refused.headers.get('www-authenticate')).toMatch(/error="insufficient_scope".*scope="operator"/)
    expect(await refused.json()).toMatchObject({ error: 'insufficient_scope' })
    expect((await post(url, tokens.client, `[${callBody('status')},${callBody('op_only')}]`)).status).toBe(403)
    expect((await post(url, tokens.operator, callBody('op_only'))).status).toBe(200)
  })

  it('tells a tool handler the caller\'s scope, so what it records names who acted (QA-14)', async () => {
    const { url, tokens, ctx } = await boot()
    ctx.mcp.tool('whoami', { description: 'scope', inputSchema: {}, scope: 'client' }, async (_args, { scope }) => ({ content: [{ type: 'text' as const, text: scope }] }))
    for (const scope of ['client', 'operator'] as const) {
      const client = await connect(url, tokens[scope])
      expect((await client.callTool({ name: 'whoami', arguments: {} })).content).toEqual([{ type: 'text', text: scope }])
    }
  })

  it('accepts no model token on /mcp: a model holder reaches only the model gateways (QA-14)', async () => {
    const { url, tokens } = await boot()
    expect((await post(url, tokens.model, callBody('status'))).status).toBe(401)
  })

  it('keeps one distinct owner-only file per scope and names them in the discovery file', async () => {
    const { dir, tokens } = await boot()
    expect(new Set(Object.values(tokens)).size).toBe(3)
    for (const scope of ['operator', 'client', 'model']) expect(statSync(join(dir, `${scope}.token`)).mode & 0o777).toBe(0o600)
    expect(() => statSync(join(dir, 'mcp.token'))).toThrow()
  })
})

describe('discovery file ownership (PR #3 security review)', () => {
  it("does not delete another instance's discovery file on unload", async () => {
    const { dir, stop } = await boot()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:1/mcp', tokenFile: 'x', pid: process.pid + 1 }))
    await stop()
    expect(JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')).pid).toBe(process.pid + 1)
  })
})

const { mcpToolsConformance } = await import('../../../gateway-core/conformance/mcp-tools.ts')
let endpoint: { url: string; tokens: Tokens } | undefined
mcpToolsConformance('mcp-server', async () => {
  const booted = await boot()
  endpoint = { url: booted.url, tokens: booted.tokens }
  return { ctx: booted.ctx, dispose: booted.stop }
}, async (_ctx, scope) => {
  // What a real MCP client holding that scope's token sees over the authenticated endpoint.
  const client = await connect(endpoint!.url, endpoint!.tokens[scope])
  return (await client.listTools()).tools.map((tool) => tool.name)
})
