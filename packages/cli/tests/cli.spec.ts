import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHROME_LOCK } from '@tsuuanmi/system-browser-patchright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { accountTarget, agentAccountLine, formatMigration, parseMigrate, assertRuntime, callTool, checkRows, signInEnvironment, signInLine, formatEvents, formatHealth, formatPlugins, parseEvents, healthExit, hostHealth, hostPlugins, hostRoster, claudeGatewayCommand, codexGatewayCommand, drainHost, formatTools, ensureBrowser, hostProcessProblem, shutdownHost, exitCode, formatArtifact, formatExplanation, formatFreed, formatLiveness, parseFree, formatWorktrees, formatWorktreesRemoved, parseWorktreesRemove, formatUsage, mcpConfig, mcpHeaders, mcpToken, mergeProfileManifest, parseAsk, parseReport, uiUrl, parseComposedRows, presetOf, rowOffProblem } from '../src/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})


/** A running profile's state as the CLI reads it: one token file per scope (ADR-0023) and the discovery file. */
function seedHome(home: string, extra: Record<string, unknown> = {}): Record<'operator' | 'client' | 'model', string> {
  mkdirSync(join(home, 'system'), { recursive: true })
  const fills = { operator: 7, client: 8, model: 9 } as const
  const tokenFiles = Object.fromEntries(Object.keys(fills).map((scope) => [scope, join(home, 'system', `${scope}.token`)]))
  for (const [scope, fill] of Object.entries(fills)) writeFileSync(tokenFiles[scope]!, Buffer.alloc(32, fill))
  writeFileSync(join(home, 'system', 'mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:47317/mcp', tokenFiles, ...extra }))
  return Object.fromEntries(Object.entries(fills).map(([scope, fill]) => [scope, Buffer.alloc(32, fill).toString('base64url')])) as Record<'operator' | 'client' | 'model', string>
}

describe('system CLI (PR #3 kernel review)', () => {
  it('merges the bundle into an existing profile manifest without dropping operator plugins', () => {
    const merged = mergeProfileManifest({
      name: 'dsh-profile-system', dependencies: { 'operator-plugin': '^1.0.0' },
      dsh: { profile: { bundles: ['@tsuuanmi/system-bundle', 'operator-plugin'] } },
    }, '/opt/bundle')
    expect(merged.dependencies).toEqual({ 'operator-plugin': '^1.0.0', '@tsuuanmi/system-bundle': 'link:/opt/bundle' })
    expect(merged.dsh.profile.bundles).toEqual(['@tsuuanmi/system-bundle', 'operator-plugin'])
    expect(mergeProfileManifest(undefined, '/b').dsh.profile.bundles).toEqual(['@tsuuanmi/system-bundle'])
  })

  it('composes a preset as a bundle layer right after the system bundle, kept until changed, never in the operator patch (ADR-0025)', () => {
    const operator = { name: 'dsh-profile-system', dependencies: { 'operator-plugin': '^1.0.0' }, dsh: { profile: { bundles: ['@tsuuanmi/system-bundle', 'operator-plugin'] } } }
    const apiFirst = mergeProfileManifest(operator, '/opt/bundle', 'api-first')
    expect(apiFirst.dsh.profile.bundles).toEqual(['@tsuuanmi/system-bundle', '@tsuuanmi/system-preset-api-first', 'operator-plugin'])
    expect(apiFirst.dependencies).toEqual({ 'operator-plugin': '^1.0.0', '@tsuuanmi/system-bundle': 'link:/opt/bundle', '@tsuuanmi/system-preset-api-first': 'link:/opt/bundle/presets/api-first' })
    expect(presetOf(apiFirst)).toBe('api-first')
    // A plain refresh keeps the preset; `default` removes it.
    expect(mergeProfileManifest(apiFirst, '/opt/bundle').dsh.profile.bundles).toEqual(apiFirst.dsh.profile.bundles)
    const back = mergeProfileManifest(apiFirst, '/opt/bundle', 'default')
    expect(back.dsh.profile.bundles).toEqual(['@tsuuanmi/system-bundle', 'operator-plugin'])
    expect(back.dependencies).toEqual({ 'operator-plugin': '^1.0.0', '@tsuuanmi/system-bundle': 'link:/opt/bundle' })
  })

  it('reads which composed rows are mounted from the launcher\'s config dump', () => {
    const dump = '# from bundle\n- id: timer\n  name: \'@deepseek-ai/cordis-plugin-timer\'\n- id: browser\n  name: x\n  disabled: true\n- id: workers\n  name: y\n  config:\n    disabled: true\n'
    expect(parseComposedRows(dump)).toEqual([{ id: 'timer', mounted: true }, { id: 'browser', mounted: false }, { id: 'workers', mounted: true }])
    // A client helper names the row it needs and how to turn it on (PROP-0004: gateways are off by default).
    expect(rowOffProblem('workers', parseComposedRows(dump))).toBeUndefined()
    expect(rowOffProblem('browser', parseComposedRows(dump))).toBe('the browser row is off in this composition; turn it on in your profile patch (- id: browser, disabled: false), then restart')
    expect(rowOffProblem('gateway-anthropic', parseComposedRows(dump))).toMatch(/gateway-anthropic row is off/)
  })

  it('refuses to init or start on a runtime the store would refuse, before anything is written (REQ-HOST-2, CON-2)', () => {
    expect(() => assertRuntime('Node 22.23.3 is not supported; system needs Node ^24.18.1 || >=26.5.1')).toThrow(/^Node 22\.23\.3 is not supported/)
    expect(() => assertRuntime(undefined)).not.toThrow()
    expect(() => assertRuntime()).not.toThrow()
  })

  it('reads the event log by run, session, or type, a page after a cursor (QA-7)', () => {
    expect(parseEvents(['--run', 'r1', '--after', '12', '--limit', '50'])).toEqual({ runId: 'r1', afterSeq: 12, limit: 50 })
    expect(parseEvents(['--node', 'n1', '--turn', 't1', '--since', '2026-10-14'])).toEqual({ nodeId: 'n1', turnId: 't1', since: '2026-10-14' })
    expect(parseEvents(['--bogus', 'x'])).toBeUndefined()
    expect(parseEvents(['--run'])).toBeUndefined()
    expect(formatEvents([{ seq: 3, at: '2026-10-14T00:00:00Z', type: 'workflow.node.failed', runId: 'r1', nodeId: 'n2', data: { kind: 'ui_drift' } }]))
      .toEqual(['3 2026-10-14T00:00:00Z workflow.node.failed run=r1/n2 {"kind":"ui_drift"}'])
  })

  it('asks for the baseline report of a project or every one, over the period its flags name, each flag once (PROP-0010 B8)', () => {
    expect(parseReport([])).toEqual({})
    expect(parseReport(['--project', 'p1', '--days', '14', '--until', '2026-10-23T00:00:00Z'])).toEqual({ projectId: 'p1', days: 14, until: '2026-10-23T00:00:00Z' })
    expect(parseReport(['--since', '2026-10-01T00:00:00Z'])).toEqual({ since: '2026-10-01T00:00:00Z' })
    // The tool refuses a period it cannot name (both since and days, or days that are not a whole number), with nothing read.
    expect(parseReport(['--days', 'week'])).toEqual({ days: Number.NaN })
    for (const args of [['--project'], ['--bogus', 'x'], ['--days', '7', '--days', '8'], ['p1']]) expect(parseReport(args), args.join(' ')).toBeUndefined()
  })

  it('reports health with exit 0, 1, or 2, and a host that does not answer as down (REQ-HOST-6)', async () => {
    const report = { state: 'degraded' as const, checks: [{ name: 'store', state: 'ok' as const, detail: 'integrity check passed' }, { name: 'accounts', state: 'degraded' as const, detail: 'main (reauth-required)' }] }
    expect(await hostHealth(async () => ({ isError: false, text: '', structured: { health: report } }))).toEqual(report)
    expect(formatHealth(report)).toEqual(['health: degraded', '  ok       store      integrity check passed', '  degraded accounts   main (reauth-required)'])
    expect([healthExit('ok'), healthExit('degraded'), healthExit('down'), healthExit('unknown')]).toEqual([0, 1, 2, 2])
    const down = await hostHealth(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:47317') })
    expect(down).toMatchObject({ state: 'down', checks: [{ name: 'host', detail: expect.stringContaining('ECONNREFUSED') }] })
  })

  it('prints the roster from the running profile: its rendering, or with --json the record, and refuses a failed call (REQ-HOST-8)', async () => {
    const record = { asOf: '2026-10-24T09:30:00.000Z', workers: { value: [] }, unlisted: 0, counts: { ready: 0, busy: 0, resting: 0, unavailable: 0, quarantined: 0 }, sources: { value: [] }, unknownUsage: { value: { unreadable: 0, unconfigured: [] } } }
    const calls: string[] = []
    const call = async (name: string) => {
      calls.push(name)
      return { isError: false, text: 'Roster as of 2026-10-24T09:30:00.000Z: 0 Worker(s): 0 ready, 0 busy, 0 resting, 0 unavailable, 0 quarantined', structured: record }
    }
    expect(await hostRoster(false, call)).toBe('Roster as of 2026-10-24T09:30:00.000Z: 0 Worker(s): 0 ready, 0 busy, 0 resting, 0 unavailable, 0 quarantined')
    expect(JSON.parse(await hostRoster(true, call))).toEqual(record)
    expect(calls).toEqual(['roster', 'roster'])
    await expect(hostRoster(false, async () => ({ isError: true, text: 'the roster could not be made: mcp-roster@1.5#/$defs/roster-output: …', structured: undefined }))).rejects.toThrow(/could not be made/)
    await expect(hostRoster(true, async () => ({ isError: false, text: 'x', structured: undefined }))).rejects.toThrow(/no roster record/)
  })

  it('lists the plugins with their recorded lifecycle and manifest, and refuses a host whose plugin host lists none (REQ-HOST-7)', async () => {
    const plugins = [
      { name: '@tsuuanmi/system-store', rows: ['store'], mounted: true, manifest: 'valid' as const, version: '0.8.0', class: { kind: 'core' as const, component: 'ledger-of-record' }, lifecycle: { state: 'default', since: '2026-10-23T00:00:00.000Z', decision: `sha256:${'1'.repeat(64)}` } },
      { name: '@tsuuanmi/system-runtime-acp', rows: ['runtime-acp'], mounted: false, manifest: 'valid' as const, version: '0.8.0', class: { kind: 'family' as const, family: 'worker' }, lifecycle: { state: 'candidate', since: '2026-10-23T00:00:00.000Z', decision: `sha256:${'2'.repeat(64)}` } },
      { name: '@deepseek-ai/dsh-llm', rows: ['llm'], mounted: true, manifest: 'absent' as const, reason: '@deepseek-ai/dsh-llm ships no plugin-manifest.json' },
    ]
    expect(await hostPlugins(async () => ({ isError: false, text: '', structured: { plugins } }))).toEqual(plugins)
    expect(formatPlugins(plugins)).toEqual([
      'default   on  @tsuuanmi/system-store@0.8.0       core: ledger-of-record   row store',
      'candidate off @tsuuanmi/system-runtime-acp@0.8.0 family: worker           row runtime-acp',
      '—         on  @deepseek-ai/dsh-llm                                        row llm',
      '              manifest absent: @deepseek-ai/dsh-llm ships no plugin-manifest.json',
    ])
    await expect(hostPlugins(async () => ({ isError: false, text: '', structured: { health: {} } }))).rejects.toThrow(/plugin-host row is off or not running/)
  })

  it('prints each finding of the manifest check under its plugin, with the decision that recorded it (ADR-0048)', () => {
    const decision = `sha256:${'3'.repeat(64)}`
    expect(formatPlugins([
      { name: '@x/third-party', rows: ['third'], mounted: true, manifest: 'absent', reason: '@x/third-party ships no plugin-manifest.json', findings: [{ kind: 'no-manifest', reason: 'it runs with no manifest: @x/third-party ships no plugin-manifest.json' }], checked: { since: '2026-10-23T00:00:00.000Z', decision } },
      { name: '@x/c', rows: ['c'], mounted: true, manifest: 'valid', version: '1.0.0', class: { kind: 'family', family: 'surface' }, lifecycle: { state: 'default', since: '2026-10-23T00:00:00.000Z', decision }, findings: [{ kind: 'unsatisfied', reason: 'it consumes ctx.workflow in the range ^2.0.0, which @tsuuanmi/system-workflow does not satisfy: it provides 1.3.0' }], checked: { since: '2026-10-23T00:00:00.000Z', decision } },
    ])).toEqual([
      '—         on  @x/third-party                          row third',
      '              manifest absent: @x/third-party ships no plugin-manifest.json',
      '              finding: it runs with no manifest: @x/third-party ships no plugin-manifest.json',
      `              recorded by ${decision} (system artifact)`,
      'default   on  @x/c@1.0.0     family: surface          row c',
      '              finding: it consumes ctx.workflow in the range ^2.0.0, which @tsuuanmi/system-workflow does not satisfy: it provides 1.3.0',
      `              recorded by ${decision} (system artifact)`,
    ])
  })

  it('checks a profile\'s rows before a start: a shipped plugin that does not resolve or load is a problem, never a row with nothing to check (REQ-HOST-2, INV-2)', async () => {
    const bundle = mkdtempSync(join(tmpdir(), 'system-check-'))
    dirs.push(bundle)
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'bundle', version: '0.0.0' }))
    const plugin = (name: string, files: Record<string, string>, main = 'index.js'): void => {
      mkdirSync(join(bundle, 'node_modules', name, 'lib'), { recursive: true })
      writeFileSync(join(bundle, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '0.0.0', main }))
      for (const [file, text] of Object.entries(files)) writeFileSync(join(bundle, 'node_modules', name, file), text)
    }
    plugin('good-plugin', { 'index.js': "module.exports = { Config: (c) => { if (c.n !== undefined && typeof c.n !== 'number') throw new Error('n must be a number'); return c } }" })
    plugin('broken-plugin', { 'index.js': "throw new Error('boom at import')" })
    plugin('unbuilt-plugin', {}, 'lib/index.js')
    const checked = await checkRows([
      { id: 'good', name: 'good-plugin', config: { n: 1 } },
      { id: 'bad-config', name: 'good-plugin', config: { n: 'x' } },
      { id: 'broken', name: 'broken-plugin' },
      { id: 'unbuilt', name: 'unbuilt-plugin' },
      { id: 'dsh', name: 'not-shipped-plugin' },
      { id: 'off', name: 'broken-plugin', disabled: true },
    ], createRequire(join(bundle, 'package.json')))
    expect(checked.rows).toBe(2)
    expect(checked.problems).toEqual([
      'row bad-config (good-plugin): n must be a number',
      expect.stringMatching(/^row broken \(broken-plugin\): its plugin does not load: boom at import/),
      expect.stringMatching(/^row unbuilt \(unbuilt-plugin\): its plugin cannot be resolved: Cannot find module/),
    ])
  })

  it('maps a signal death to 128 + signal number', () => {
    expect(exitCode(null, 'SIGTERM')).toBe(143)
    expect(exitCode(null, 'SIGINT')).toBe(130)
    expect(exitCode(3, null)).toBe(3)
  })

  it('never prints the bearer token inside the client configuration', () => {
    const home = mkdtempSync(join(tmpdir(), 'system-cli-'))
    dirs.push(home)
    const tokens = seedHome(home)
    for (const client of ['claude', 'codex'] as const) for (const token of Object.values(tokens)) expect(mcpConfig(client, home)).not.toContain(token)
    expect(mcpConfig('codex', home)).toMatch(/\[mcp_servers\.system\][\s\S]*mcp-stdio/)
    expect(mcpConfig('claude', home)).toContain('headersHelper')
    expect(readFileSync(join(home, 'system', 'mcp.json'), 'utf8')).toContain('47317')
  })
})

describe('system init: browser prerequisites', () => {
  const chrome = { path: '/usr/bin/google-chrome', source: 'system' as const }

  it('keeps a usable Chrome and does not download one', async () => {
    const install = vi.fn()
    const report = await ensureBrowser({ discover: () => chrome, install, hasXvfb: () => true, vnc: () => '/usr/bin/x0vncserver' })
    expect(install).not.toHaveBeenCalled()
    expect(report).toEqual(['chrome: /usr/bin/google-chrome (system)', 'xvfb: ok', 'vnc (remote login): /usr/bin/x0vncserver'])
  })

  it('installs the pinned managed Chrome when none is usable, and flags a missing Xvfb', async () => {
    const install = vi.fn(async () => ({ path: '/home/u/.dsh/system/browsers/chrome', installed: true }))
    const report = await ensureBrowser({ discover: () => undefined, install, hasXvfb: () => false, vnc: () => undefined })
    expect(install).toHaveBeenCalledOnce()
    expect(report[0]).toBe(`chrome: installed managed Chrome ${CHROME_LOCK.buildId} at /home/u/.dsh/system/browsers/chrome`)
    expect(report[1]).toMatch(/xvfb: missing .*apt install xvfb/)
    expect(report[2]).toMatch(/vnc \(remote login\): missing .*tigervnc-scraping-server/)
  })
})

describe('system account (an MCP client of the running profile)', () => {
  it('explains that the profile must be running when there is no discovery file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'system-cli-'))
    dirs.push(home)
    await expect(callTool('account_list', {}, home)).rejects.toThrow(/system start/)
  })
})

describe('system ask arguments', () => {
  it('reads the prompt from stdin with -, so it stays out of the process list and shell history', async () => {
    expect(await parseAsk(['--persist', '-'], async () => 'secret prompt\n')).toEqual({ prompt: 'secret prompt', persist: true })
    expect(await parseAsk(['--session', 'ses_1', 'hello', 'world'], async () => '')).toEqual({ prompt: 'hello world', sessionId: 'ses_1' })
    expect(await parseAsk(['--tier', 'frontier', 'q'], async () => '')).toEqual({ prompt: 'q', tier: 'frontier' })
    expect(await parseAsk([], async () => '')).toBeUndefined()
    expect(await parseAsk(['--deep', 'q'], async () => '')).toEqual({ prompt: 'q', deep: true })
    expect(await parseAsk(['--variant', 'deep', 'q'], async () => '')).toEqual({ prompt: 'q', variant: 'deep' })
    expect(await parseAsk(['--variant'], async () => '')).toBeUndefined()
  })

  it('takes the board task a run serves as MCP run\'s task does: the task alone, or with the claim a lead hands over, holder and generation both or neither', async () => {
    expect(await parseAsk(['--task', 'task-1', 'go'], async () => '')).toEqual({ prompt: 'go', task: { taskId: 'task-1' } })
    expect(await parseAsk(['--task', 'task-1', '--holder', 'lead', '--generation', '3', '-'], async () => 'the input\n')).toEqual({ prompt: 'the input', task: { taskId: 'task-1', holder: 'lead', generation: 3 } })
    expect(await parseAsk(['--holder', 'lead', '--generation', '3', '--task', 'task-1', '--variant', 'v', 'go'], async () => '')).toEqual({ prompt: 'go', variant: 'v', task: { taskId: 'task-1', holder: 'lead', generation: 3 } })
    // Half a claim, a claim without its task, a generation that is not a positive whole number, or a flag given twice: refused.
    for (const args of [
      ['--task', 'task-1', '--holder', 'lead', 'go'], ['--task', 'task-1', '--generation', '3', 'go'], ['--holder', 'lead', '--generation', '3', 'go'],
      ['--task', 'task-1', '--holder', 'lead', '--generation', '0', 'go'], ['--task', 'task-1', '--holder', 'lead', '--generation', '1.5', 'go'],
      ['--task', 'task-1', '--holder', 'lead', '--generation', 'x', 'go'], ['--task', 'a', '--task', 'b', 'go'], ['--task'],
    ]) expect(await parseAsk(args, async () => ''), args.join(' ')).toBeUndefined()
  })
})

describe('system usage and explain output', () => {
  it('shows, per request and step, the Worker, tier, and quota class that served it, and a model Worker\'s tokens (REQ-WRK-10)', () => {
    const lines = formatUsage({
      runs: [{
        runId: 'run_1', template: 'research', status: 'completed', createdAt: '2026-10-12T01:02:03.000Z',
        nodes: [
          { nodeId: 'research:1', state: 'COMPLETED', minTier: 'frontier', tier: 'frontier', worker: 'worker:chatgpt-main/frontier', quotaClass: 'subscription-chat' },
          { nodeId: 'compact:1', state: 'COMPLETED', minTier: 'economy', tier: 'economy', worker: 'model:fast', quotaClass: 'metered', usage: { inputTokens: 412, outputTokens: 96 } },
          { nodeId: 'compact:2', state: 'WAITING', minTier: 'economy' },
          // Usage the ledger could not count (D25): said, never shown as nothing.
          { nodeId: 'review:1', state: 'COMPLETED', minTier: 'standard', tier: 'standard', worker: 'agent:reviewer', quotaClass: 'agent-plan', usageUnknown: 'not-reported' },
        ],
      }],
    })
    expect(lines).toEqual([
      'run_1  research  completed  2026-10-12T01:02:03.000Z',
      '  research:1  COMPLETED  frontier  subscription-chat  worker:chatgpt-main/frontier',
      '  compact:1  COMPLETED  economy  metered  model:fast  412 in / 96 out tokens',
      '  compact:2  WAITING  -  -  -',
      '  review:1  COMPLETED  standard  agent-plan  agent:reviewer  usage unknown (not-reported)',
    ])
  })

  it('prints a run\'s decision chain, step by step', () => {
    const lines = formatExplanation({
      runId: 'run_1', template: 'ask', status: 'completed', specHash: 'sha256:ab',
      nodes: [{ nodeId: 'ask:1', state: 'COMPLETED', worker: 'worker:a/standard', quotaClass: 'subscription-chat', turnId: 'turn_1', decisions: [
        { id: 'sha256:01', type: 'egress', outcome: 'allow', reasons: ['public content is permitted'] },
        { id: 'sha256:02', type: 'route', outcome: 'worker:a/standard', reasons: ['proves reason', 'quota class subscription-chat'] },
        { id: 'sha256:03', type: 'acceptance', outcome: 'reject', reasons: ['no JSON'], result: 'sha256:a1' },
      ] }],
    })
    expect(lines).toEqual([
      'run_1  ask  completed  spec sha256:ab',
      '  ask:1  COMPLETED  worker:a/standard  subscription-chat  turn_1',
      '    egress  allow  public content is permitted  (sha256:01)',
      '    route  worker:a/standard  proves reason; quota class subscription-chat  (sha256:02)',
      '    acceptance  reject  no JSON  (sha256:03)  result sha256:a1',
    ])
  })

  it('prints a board task\'s run with the decisions no step holds first: how it took the task, the result\'s subject, acceptance, and report (T99 D9)', () => {
    const lines = formatExplanation({
      runId: 'run_2', template: 'algorithm-development', status: 'failed', specHash: 'sha256:cd',
      decisions: [
        { id: 'sha256:11', type: 'admission', outcome: 'claim', reasons: ['the caller holds no claim on task task-1, which is ready: the run claims it as workflow:run_2'] },
        { id: 'sha256:12', type: 'gate', outcome: 'fail', reasons: ['no result of the run is on git-head abc, the subject task task-1 writes'] },
        { id: 'sha256:13', type: 'reconciliation', outcome: 'report', reasons: ['the run failed (stale_subject): an attempt the board counts'] },
      ],
      nodes: [{ nodeId: 'develop:1', state: 'COMPLETED', worker: 'agent:dev', quotaClass: 'agent-plan', decisions: [] }],
    })
    expect(lines).toEqual([
      'run_2  algorithm-development  failed  spec sha256:cd',
      '  run (decisions no step holds)',
      '    admission  claim  the caller holds no claim on task task-1, which is ready: the run claims it as workflow:run_2  (sha256:11)',
      '    gate  fail  no result of the run is on git-head abc, the subject task task-1 writes  (sha256:12)',
      '    reconciliation  report  the run failed (stale_subject): an attempt the board counts  (sha256:13)',
      '  develop:1  COMPLETED  agent:dev  agent-plan  -',
    ])
  })

  it('prints a run\'s executions whose liveness needs a look after its decision chain: the verdict, its looks, why, what it holds, and what to do (PROP-0013)', () => {
    const held = {
      source: 'agents', execution: 'arun_00000000000000aa', worker: 'agent:dev', state: 'unknown' as const, since: '2026-10-24T01:00:00.000Z', verdict: 'unknown (liveness@1)', looks: { taken: 3, max: 3 },
      reasons: ['the holder\'s process: gone (no process 41 exists)', 'the agent process: unknown (never reported)'], decision: 'sha256:0d', holds: ['session ses_1'], action: 'confirm that no process of its agent runs, then free it: system free arun_00000000000000aa --agent-gone',
    }
    const lines = formatExplanation({ runId: 'run_1', template: 'develop', status: 'running', specHash: 'sha256:ab', nodes: [], liveness: [held], livenessUnread: [{ source: 'other', detail: 'the store failed' }] })
    expect(lines).toEqual([
      'run_1  develop  running  spec sha256:ab',
      'liveness',
      '  arun_00000000000000aa  agent:dev  ended without being known to be gone since 2026-10-24T01:00:00.000Z  verdict unknown (liveness@1)  looks 3 of 3  (sha256:0d)',
      '    why   the holder\'s process: gone (no process 41 exists)',
      '    why   the agent process: unknown (never reported)',
      '    holds session ses_1',
      '    do    confirm that no process of its agent runs, then free it: system free arun_00000000000000aa --agent-gone',
      '  source other cannot tell: the store failed',
    ])
    const { verdict: _v, looks: _l, decision: _d, ...stalled } = held
    expect(formatLiveness([{ ...stalled, state: 'stalled', holds: [] }])[0]).toBe('  arun_00000000000000aa  agent:dev  stalled since 2026-10-24T01:00:00.000Z')
  })

  it('asks to free a run only on the operator\'s word that its agent is gone, and prints what was freed and each worktree (PROP-0013)', () => {
    expect(() => parseFree(['arun_00000000000000aa'])).toThrow(/your word that its agent is gone.*add --agent-gone/)
    expect(() => parseFree(['--agent-gone'])).toThrow(/name the agent run/)
    expect(() => parseFree(['arun_00000000000000aa', '--agent-gone', '--force'])).toThrow(/unknown option --force/)
    expect(parseFree(['arun_00000000000000aa', '--agent-gone'])).toEqual({ agentRun: 'arun_00000000000000aa', agentGone: true })
    expect(parseFree(['arun_00000000000000aa', '--commit-worktree', '--agent-gone', 'host', 'rebooted'])).toEqual({ agentRun: 'arun_00000000000000aa', agentGone: true, commitWorktree: true, note: 'host rebooted' })
    expect(formatFreed({
      agentRun: 'arun_00000000000000aa', decision: 'sha256:0f', again: false, freed: ['session ses_1', 'worktree /w/run_1 (branch system/run/run_1)'],
      worktrees: [{ path: '/w/run_1', branch: 'system/run/run_1', outcome: 'removed', why: 'its uncommitted changes are committed on system/run/run_1, which stays, then it is removed', commit: 'c0ffee' }],
    })).toEqual([
      'freed arun_00000000000000aa (decision sha256:0f): session ses_1; worktree /w/run_1 (branch system/run/run_1)',
      '  worktree /w/run_1: removed, its changes committed on system/run/run_1 as c0ffee (its uncommitted changes are committed on system/run/run_1, which stays, then it is removed)',
    ])
  })

  it('lists the run worktrees with their state and retirement, and asks to remove the finished ones with the operator\'s options, printing each removed or kept (D12)', () => {
    expect(formatWorktrees({
      retentionHours: 24, total: 3,
      worktrees: [
        { runId: 'run_1', path: '/w/run_1', branch: 'system/run/run_1', state: 'finished', changes: 'clean', lastActivityAt: '2026-10-24T07:19:40Z', retiresAt: '2026-10-25T07:19:40Z' },
        { runId: 'run_2', path: '/w/run_2', branch: 'system/run/run_2', state: 'held', changes: 'uncommitted', lastActivityAt: '2026-10-24T07:31:05Z', failure: 'git could not remove it' },
      ],
    })).toEqual([
      '3 run worktree(s); the retention removes a finished one 24 h after its last agent run; the oldest 2 shown',
      '  run_1  finished, clean  last activity 2026-10-24T07:19:40Z, retires 2026-10-25T07:19:40Z',
      '    /w/run_1  (system/run/run_1)',
      '  run_2  held, uncommitted  last activity 2026-10-24T07:31:05Z',
      '    /w/run_2  (system/run/run_2)',
      '    last retirement failed: git could not remove it',
    ])
    expect(formatWorktrees({ retentionHours: 0, total: 0, worktrees: [] })).toEqual(['0 run worktree(s); the retention removes none (worktreeRetentionHours 0)'])
    expect(parseWorktreesRemove([])).toEqual({})
    expect(parseWorktreesRemove(['--run', 'run_1', '--commit-changes', 'merged', 'to', 'main'])).toEqual({ runId: 'run_1', commitChanges: true, note: 'merged to main' })
    expect(() => parseWorktreesRemove(['--run'])).toThrow(/--run names a workflow run/)
    expect(() => parseWorktreesRemove(['--force'])).toThrow(/unknown option --force/)
    expect(formatWorktreesRemoved({
      decision: 'sha256:0f', more: 2,
      worktrees: [
        { runId: 'run_1', path: '/w/run_1', branch: 'system/run/run_1', outcome: 'removed', why: 'its uncommitted changes are committed on system/run/run_1, which stays, then it is removed', commit: 'c0ffee' },
        { runId: 'run_2', path: '/w/run_2', branch: 'system/run/run_2', outcome: 'kept', why: 'an agent run of workflow run run_2 is unfinished' },
      ],
    })).toEqual([
      'removed finished run worktrees (decision sha256:0f)',
      '  run_1  /w/run_1: removed, its changes committed on system/run/run_1 as c0ffee (its uncommitted changes are committed on system/run/run_1, which stays, then it is removed)',
      '  run_2  /w/run_2: kept (an agent run of workflow run run_2 is unfinished)',
      '  2 more not looked at: run it again',
    ])
    expect(formatWorktreesRemoved({ more: 0, worktrees: [] })).toEqual(['no finished run worktree could be removed; nothing was decided'])
  })

  it('prints an artifact\'s header, its classification first among its facts, then the window; one not stored as its note', () => {
    const stored = { id: 'sha256:a1', state: 'stored' as const, kind: 'report', bodySchema: 'provider-answer@1.0', classification: 'local-private', runId: 'run_1', nodeId: 'review:m2:propose', createdAt: '2026-10-17T14:12:53.000Z', inputs: ['sha256:b2'] }
    expect(formatArtifact({ ...stored, content: 'text', chars: 5, offset: 1, truncated: true, text: '😀b' })).toEqual([
      'sha256:a1  report (provider-answer@1.0)  local-private  run run_1 / review:m2:propose  2026-10-17T14:12:53.000Z',
      'inputs: sha256:b2',
      'text: 5 characters; 1..3 (more: --offset 3)',
      '---',
      '😀b',
    ])
    expect(formatArtifact({ id: 'sha256:c3', state: 'expired', note: 'expired: collected by retention; its content is gone' })).toEqual(['sha256:c3  expired: collected by retention; its content is gone'])
  })
})

describe('Claude Code connection (headersHelper)', () => {
  it('prints the bearer header for headersHelper, and a config that never contains the token', () => {
    const home = mkdtempSync(join(tmpdir(), 'system-cli-'))
    dirs.push(home)
    const tokens = seedHome(home)
    // An MCP client gets the client scope (ADR-0023).
    expect(JSON.parse(mcpHeaders(home))).toEqual({ Authorization: `Bearer ${tokens.client}` })
    const claude = mcpConfig('claude', home)
    expect(claude).toContain('headersHelper')
    expect(claude).toContain('mcp-headers')
    for (const token of Object.values(tokens)) expect(claude).not.toContain(token)
    // The web UI link carries the operator token, in its fragment only.
    expect(uiUrl(home)).toBe(`http://127.0.0.1:47317/ui/#token=${tokens.operator}`)
    // Each scope's token alone, by name.
    expect(mcpToken('model', home)).toBe(tokens.model)
    expect(mcpToken('client', home)).toBe(tokens.client)
    // The gateway commands never carry a token: the model scope's is read when the client connects.
    const gateway = claudeGatewayCommand(home)
    expect(gateway).toMatch(/^ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:47317\/anthropic claude --settings '\{"apiKeyHelper":".* mcp-token --scope model"\}'$/)
    for (const token of Object.values(tokens)) expect(gateway).not.toContain(token)
    const codex = codexGatewayCommand(home)
    expect(codex).toMatch(/^SYSTEM_MCP_TOKEN="\$\(.* mcp-token --scope model\)" codex -c model_provider=system -c 'model_providers\.system=\{name="system",base_url="http:\/\/127\.0\.0\.1:47317\/openai\/v1",env_key="SYSTEM_MCP_TOKEN",wire_api="responses",request_max_retries=0,stream_max_retries=0,stream_idle_timeout_ms=900000\}' -m system-standard$/)
    for (const token of Object.values(tokens)) expect(codex).not.toContain(token)
  })

  it('says a running profile predates scoped tokens instead of failing obscurely (ADR-0023)', () => {
    const home = mkdtempSync(join(tmpdir(), 'system-cli-'))
    dirs.push(home)
    mkdirSync(join(home, 'system'))
    writeFileSync(join(home, 'system', 'mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:47317/mcp', tokenFile: join(home, 'system', 'mcp.token'), pid: 1 }))
    for (const command of [() => mcpToken('model', home), () => mcpHeaders(home), () => uiUrl(home), () => claudeGatewayCommand(home), () => codexGatewayCommand(home), () => mcpConfig('claude', home)]) {
      expect(command).toThrow(/predates scoped tokens/)
    }
  })
})

describe('drain (REQ-HOST-1)', () => {
  const polls = (answers: string[][]) => {
    const calls: string[] = []
    const call = async (name: string) => {
      calls.push(name)
      return { isError: false, text: '', structured: { draining: true, active: answers.shift() ?? [] } }
    }
    return { calls, call: call as never }
  }

  it('polls until nothing is executing', async () => {
    const { calls, call } = polls([['run_a'], ['run_a'], []])
    expect(await drainHost(10_000, { call, pollMs: 1 })).toEqual({ drained: true, active: [] })
    expect(calls).toEqual(['drain', 'drain', 'drain'])
  })

  it('reports what is still running at the deadline', async () => {
    const { call } = polls([['run_a'], ['run_a'], ['run_a'], ['run_a']])
    expect(await drainHost(0, { call, pollMs: 1 })).toEqual({ drained: false, active: ['run_a'] })
  })

  it('stops a host whose engine is not running, once its process is proven to be this home\'s host', async () => {
    const { spawn } = await import('node:child_process')
    const home = mkdtempSync(join(tmpdir(), 'system-shutdown-'))
    const bin = join(home, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    mkdirSync(join(home, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(bin, 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)')
    const host = spawn(process.execPath, [bin, '--profile', 'system'], { env: { ...process.env, DSH_HOME: home }, stdio: 'ignore' })
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      mkdirSync(join(home, 'system'))
      const discovery = (pid: number) => writeFileSync(join(home, 'system', 'mcp.json'), JSON.stringify({ url: 'http://127.0.0.1:1/mcp', pid }))
      const missing = (async () => ({ isError: true, text: 'MCP error -32602: Tool drain not found', structured: undefined })) as never
      // Not a DSH profile, or another home's: refused, and nothing is signalled.
      expect(hostProcessProblem(other.pid!, home)).toBe('it does not run a DSH profile')
      expect(hostProcessProblem(host.pid!, join(home, 'elsewhere'))).toMatch(/its DSH_HOME is .*, not .*elsewhere/)
      discovery(other.pid!)
      await expect(shutdownHost(1000, { home, call: missing })).rejects.toThrow(/drain is not available .*Tool drain not found.*, and process \d+ is not stopped: it does not run a DSH profile/)
      expect(other.exitCode).toBeNull()
      // This home's host: stopped without a drain, and said so.
      discovery(host.pid!)
      expect(await shutdownHost(1000, { home, call: missing })).toMatchObject({ drained: false, active: [], pid: host.pid, undrained: expect.stringMatching(/Tool drain not found/) })
      // Any other drain failure is not taken for a missing engine.
      const failing = (async () => ({ isError: true, text: 'run run_a is busy', structured: undefined })) as never
      await expect(shutdownHost(1000, { home, call: failing })).rejects.toThrow('run run_a is busy')
    } finally {
      host.kill()
      other.kill()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('tool contracts reference', () => {
  it('renders each tool with its arguments, and escapes table cells', () => {
    const page = formatTools([
      { name: 'ask', description: 'Ask a | Worker', inputSchema: { properties: { prompt: { type: 'string', description: 'the prompt' }, tier: { enum: ['economy', 'standard'] } }, required: ['prompt'] } },
      { name: 'status', inputSchema: {} },
      { name: 'stop', description: 'Stop a run', _meta: { 'system/scope': 'operator' }, inputSchema: {} },
    ])
    // The listing marks a tool only the operator may call; one without the mark is a client tool too.
    expect(page).toContain('## `ask`\n\nAsk a \\| Worker\n\nScope: `client`')
    expect(page).toContain('| `prompt` | string | yes | the prompt |')
    expect(page).toContain('| `tier` | "economy" \\| "standard" |  |  |')
    expect(page).toContain('## `status`\n\n\n\nScope: `client`\n\nNo arguments.')
    expect(page).toContain('## `stop`\n\nStop a run\n\nScope: `operator`\n\nNo arguments.')
    // A backslash is escaped too, so one before a pipe cannot leave the pipe a cell break.
    expect(formatTools([{ name: 'grep', inputSchema: { properties: { pattern: { type: 'string', description: 'say a\\|b' } } } }])).toContain('| `pattern` | string |  | say a\\\\\\|b |')
  })
})

describe('the command surface (REQ-GW-4)', () => {
  it('offers turn, workflow, account, and maintenance commands', async () => {
    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
    const help = spawnSync(tsx, [bin, '--help'], { encoding: 'utf8' })
    const usage = `${help.stdout}${help.stderr}`
    const commands = [...usage.matchAll(/^ {2}([a-z][a-z-]*(?: [a-z][a-z-]*)?)/gm)].map((m) => m[1]!.split(' ')[0])
    for (const family of [['ask', 'research', 'brainstorm', 'review'], ['run', 'approve', 'vote', 'result', 'stop', 'continue', 'delete', 'supersede', 'usage', 'report', 'explain'], ['account'], ['init', 'start', 'drain', 'resume', 'shutdown', 'backup', 'restore', 'tools']]) {
      for (const command of family) expect(commands, command).toContain(command)
    }
  })
  it('says what the web UI holds, in the usage and the CLI reference: every part of the web UI reference', async () => {
    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
    const doc = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../docs/reference/${name}`, import.meta.url)), 'utf8')
    const flat = (text: string): string => text.replace(/\s+/g, ' ').toLowerCase()
    // The `ui` entry runs until the next command; the reference's row is one line.
    const usage = flat(/^ {2}ui {2,}([\s\S]*?)(?=^ {2}[a-z])/m.exec(spawnSync(tsx, [bin, '--help'], { encoding: 'utf8' }).stdout)![1]!)
    const reference = flat(/^\| `system ui` \|(.*)$/m.exec(doc('cli.md'))![1]!)
    const parts = [...doc('web-ui.md').matchAll(/^## (.+)$/gm)].map((m) => m[1]!.toLowerCase())
    expect(parts).toEqual(expect.arrayContaining(['runs', 'reviews', 'projects', 'approval queue', 'autonomy policy']))
    for (const part of parts) {
      expect(usage, part).toContain(part)
      expect(reference, part).toContain(part)
    }
    // Its two pages beside the runs, by the names the page gives them.
    for (const page of ['board page', 'autonomy policy page']) {
      expect(usage, page).toContain(page)
      expect(reference, page).toContain(page)
    }
  })
  it('hands out only the model token by name, and only with a gateway row on; the operator and client tokens stay with the CLI and its helpers (ADR-0023)', async () => {
    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
    const tsx = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
    const home = mkdtempSync(join(tmpdir(), 'system-cli-'))
    dirs.push(home)
    const tokens = seedHome(home)
    const run = (...args: string[]) => spawnSync(tsx, [bin, ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
    // No gateway row is mounted here (the model gateways are off by default, PROP-0004): even the model token is withheld.
    const model = run('mcp-token', '--scope', 'model')
    expect(model.status).not.toBe(0)
    for (const token of Object.values(tokens)) expect(`${model.stdout}${model.stderr}`).not.toContain(token)
    for (const args of [['mcp-token'], ['mcp-token', '--scope', 'operator'], ['mcp-token', '--scope', 'client']]) {
      const refused = run(...args)
      expect(refused.status, args.join(' ')).toBe(2)
      for (const token of Object.values(tokens)) expect(`${refused.stdout}${refused.stderr}`).not.toContain(token)
    }
   }, 60_000)
})

describe('client configuration (REQ-HOST-3)', () => {
  it('connects clients without editing their configuration: the commands only print, so there is nothing to journal', async () => {
    const { readdirSync } = await import('node:fs')
    const home = mkdtempSync(join(tmpdir(), 'system-clients-'))
    dirs.push(home)
    seedHome(home, { pid: 1 })
    const listing = (): string[] => readdirSync(home, { recursive: true }).map(String).sort()
    const before = listing()
    for (const command of [() => claudeGatewayCommand(home), () => codexGatewayCommand(home), () => mcpConfig('claude', home), () => mcpConfig('codex', home)]) {
      expect(command()).toBeTruthy()
    }
    expect(listing()).toEqual(before)
  })
})

describe('agent accounts on the command line (ADR-0051)', () => {
  it('tells an agent account from a website account: an id with a colon, or a runtime the host lists; a slot only for a runtime', () => {
    const runtimes = ['codex-sdk', 'claude-agent-sdk']
    expect(accountTarget(['codex-sdk:04aa5c1e9b7d3f20'], runtimes)).toEqual({ kind: 'agent', accountId: 'codex-sdk:04aa5c1e9b7d3f20' })
    expect(accountTarget(['codex-sdk'], runtimes)).toEqual({ kind: 'agent', provider: 'codex-sdk' })
    expect(accountTarget(['codex-sdk', '--slot', '2', '--accept'], runtimes)).toEqual({ kind: 'agent', provider: 'codex-sdk', slot: 2 })
    expect(accountTarget(['chatgpt-main'], runtimes)).toEqual({ kind: 'website', id: 'chatgpt-main' })
    // With the agents source not loaded, a runtime's name is a website account's.
    expect(accountTarget(['codex-sdk'], [])).toEqual({ kind: 'website', id: 'codex-sdk' })
    expect(() => accountTarget(['chatgpt-main', '--slot', '2'], runtimes)).toThrow(/--slot does not apply/)
    expect(() => accountTarget(['codex-sdk:04aa5c1e9b7d3f20', '--slot', '1'], runtimes)).toThrow(/names its slot/)
    expect(() => accountTarget(['codex-sdk', '--slot', 'x'], runtimes)).toThrow(/unknown option/)
  })

  it('takes system account migrate\'s flags (--apply or --rollback, --stop <runtime> repeatable) and refuses any other', () => {
    expect(parseMigrate([])).toEqual({ apply: false, rollback: false, stop: [] })
    expect(parseMigrate(['--apply', '--stop', 'antigravity-cli', '--stop', 'codex-sdk'])).toEqual({ apply: true, rollback: false, stop: ['antigravity-cli', 'codex-sdk'] })
    expect(parseMigrate(['--rollback'])).toEqual({ apply: false, rollback: true, stop: [] })
    expect(() => parseMigrate(['--apply', '--rollback'])).toThrow(/not both/)
    expect(() => parseMigrate(['--rollback', '--stop', 'codex-sdk'])).toThrow(/--stop is for/)
    expect(() => parseMigrate(['--stop'])).toThrow(/name the runtime/)
    expect(() => parseMigrate(['--yes'])).toThrow(/unknown option --yes/)
  })

  it('prints the move: each hand-named Worker\'s new id, what stops it (exit 1), and once nothing does, the row for the profile patch as YAML', () => {
    const workers = [{ from: 'agent:agy-review', runtime: 'antigravity-cli', role: 'review', why: 'unverified' }, { from: 'agent:codex-review', runtime: 'codex-sdk', role: 'review', to: 'agent:codex-sdk:04aa5c1e9b7d3f20/review', why: 'slot 1' }]
    const row = { providers: [{ provider: 'codex-sdk' }], roles: [{ id: 'review', workspace: '/w', sandbox: 'read-only', tier: 'standard' }], assignments: [{ account: 'codex-sdk:04aa5c1e9b7d3f20', roles: ['review'] }] }
    const blocked = formatMigration({ outcome: 'planned', plan: { workers, templates: [], blockers: ['the cutover waits for its reader'] }, row })
    expect(blocked.exit).toBe(1)
    expect(blocked.text).toMatch(/agent:agy-review -> stops: unverified\n {2}agent:codex-review -> agent:codex-sdk:04aa5c1e9b7d3f20\/review: slot 1\n\nwhat stops the move:\n {2}- the cutover waits for its reader$/)
    const ready = formatMigration({ outcome: 'applied', plan: { workers, templates: [{ template: 'plan', group: 'codex-sdk', kind: 'interactive', windows: [{ id: 'w', kind: 'rolling' }] }], blockers: [] }, row, cutover: { decision: 'sha256:1', appliedAt: 't' }, moved: { sessions: 1, runs: 2 } })
    expect(ready.exit).toBe(0)
    expect(ready.text).toMatch(/^applied \(decision sha256:1\): 1 session\(s\) and 2 run\(s\) moved/)
    const yaml = ready.text.split('# the agent-workers row of the profile patch (it replaces the row\'s whole config):\n')[1]!.split('\n\n# add to the resources row')[0]!
    expect(parseYaml(yaml)).toEqual([{ id: 'agent-workers', config: row }])
    expect(ready.text).toMatch(/# add to the resources row's config:\ntemplates:\n {2}- template: plan/)
    expect(formatMigration({ outcome: 'rolled-back', plan: { workers, templates: [], blockers: [] }, row, moved: { sessions: 1, runs: 2 } }).text).not.toMatch(/agent-workers row/)
  })

  it('runs the sign-in with the operator\'s environment, the runtime\'s variables for the home, and no session bus; the line they could run says the same', () => {
    const login = { command: '/usr/bin/codex', args: ['login'], env: { CODEX_HOME: '/home/op/.dsh/system/agent-homes/codex-sdk/2' } }
    const env = signInEnvironment({ PATH: '/usr/bin', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', CODEX_HOME: '/home/op/.codex' }, login)
    expect(env).toEqual({ PATH: '/usr/bin', CODEX_HOME: '/home/op/.dsh/system/agent-homes/codex-sdk/2' })
    expect(signInLine(login)).toBe('env -u DBUS_SESSION_BUS_ADDRESS CODEX_HOME=/home/op/.dsh/system/agent-homes/codex-sdk/2 /usr/bin/codex login')
    expect(signInLine({ command: 'agy', args: [], env: { HOME: '/a b' } })).toBe("env -u DBUS_SESSION_BUS_ADDRESS HOME='/a b' agy")
  })

  it('lists an agent account beside the website accounts without its hash, its hint only masked', () => {
    const line = agentAccountLine({
      account: {
        schema: 'agent-account@1.0', accountId: 'codex-sdk:04aa5c1e9b7d3f20', provider: 'codex-sdk', slot: 2, home: '/h', status: 'quarantined', hint: 'a…@example.com',
        quarantine: { reason: 'duplicate', since: '2026-10-24T08:00:00Z', decision: `sha256:${'0'.repeat(64)}` },
        identity: { hmac: 'f'.repeat(64), reader: 'codex-auth-json', runtimeVersion: '0.164.0', verifiedAt: '2026-10-24T08:00:00Z' }, revision: 2, updatedAt: '2026-10-24T08:00:00Z',
      },
      workers: [],
    })
    expect(line).toEqual({
      kind: 'agent', id: 'codex-sdk:04aa5c1e9b7d3f20', provider: 'codex-sdk', slot: 2, status: 'quarantined', reason: 'duplicate', since: '2026-10-24T08:00:00Z', hint: 'a…@example.com', home: '/h',
      reader: 'codex-auth-json', runtimeVersion: '0.164.0', verifiedAt: '2026-10-24T08:00:00Z', workers: [],
    })
    expect(JSON.stringify(line)).not.toContain('f'.repeat(64))
  })

  it('lists an agent account with the operator\'s label and what its quarantine\'s reading found (agent-account@1.1, T103)', () => {
    const detail = 'slot 1 of claude-agent-sdk cannot be verified: found Claude Code 2.1.310 (/usr/bin/claude); its identity reader admits only 2.1.308'
    const line = agentAccountLine({
      account: {
        schema: 'agent-account@1.1', accountId: 'claude-agent-sdk:b4bd4c88be9fffdf', provider: 'claude-agent-sdk', slot: 1, home: '/h', status: 'quarantined',
        quarantine: { reason: 'unverified', since: '2026-10-24T09:00:00Z', decision: `sha256:${'0'.repeat(64)}`, detail }, revision: 3, updatedAt: '2026-10-24T09:00:00Z',
      },
      workers: ['agent:claude-agent-sdk:b4bd4c88be9fffdf/develop'],
      label: 'science',
    })
    expect(line).toEqual({
      kind: 'agent', id: 'claude-agent-sdk:b4bd4c88be9fffdf', label: 'science', provider: 'claude-agent-sdk', slot: 1, status: 'quarantined', reason: 'unverified', detail, since: '2026-10-24T09:00:00Z', home: '/h',
      workers: ['agent:claude-agent-sdk:b4bd4c88be9fffdf/develop'],
    })
  })
})

