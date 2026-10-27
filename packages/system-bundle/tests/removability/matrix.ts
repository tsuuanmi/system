/**
 * The removability matrix (docs/engineering/testing.md#removability-matrix; operator, 2026-10-27: "when
 * a plugin is removed, System still works normally"). It boots the system bundle, row by row as
 * `cordis.patch.yml` lists them, with one optional row off, and runs a smoke scenario on it: health, the
 * MCP tools that do not need the row, and a run on a fake Worker through `ask` and one through
 * `algorithm-development` when the row is not its Worker source. Each step succeeds, or fails with the
 * documented reason that the removed row's seam is absent; a crash, a hang, or any other failure is named
 * by the row and the step: `row <id>, step <name>: <what>`.
 *
 * The rows are the bundle's own and are mounted in this process on the packages' source, over a loader
 * stub that shows the plugin host the same composition (no build, no `dsh`): what is faked is the Worker
 * (a scripted source of `ctx.workers`), nothing else. Which rows are optional is read from the lists in
 * docs/architecture/plugin-model.md#required-and-optional-rows.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context, type Fiber, Service } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import Llm from '@deepseek-ai/dsh-llm'
import { vi } from 'vitest'
import { ScriptedWorkers, verifierReply } from '../../../plugins/workflow/conformance/workflow.ts'
import { worker } from '../../../workers-core/conformance/workers.ts'

const BUNDLE = fileURLToPath(new URL('../..', import.meta.url))
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
/** `yaml` is the CLI's dependency, not the bundle's: read it from there. */
const { parse } = createRequire(join(ROOT, 'packages', 'cli', 'package.json'))('yaml') as { parse: (text: string) => unknown }

/** The DSH rows' packages, mounted from the bundle's own dependencies (they are not workspace packages, so the alias does not reach them). */
const DSH: Record<string, unknown> = {
  '@deepseek-ai/cordis-plugin-timer': Timer, '@deepseek-ai/dsh-host-webserver': WebServer, '@deepseek-ai/dsh-llm': Llm, '@deepseek-ai/dsh-llm-pi-ai': LlmPiAi,
}

export interface Row { id: string; name: string; config?: Record<string, unknown>; disabled: boolean }

/** The bundle's rows in order, with the configuration and the `disabled` flag each carries (`packages/system-bundle/cordis.patch.yml`). */
export function bundleRows(): Row[] {
  const patch = parse(readFileSync(join(BUNDLE, 'cordis.patch.yml'), 'utf8')) as Array<{ insert: Array<{ id: string; name: string; config?: Record<string, unknown>; disabled?: boolean }> }>
  return patch.flatMap((p) => p.insert).map((r) => ({ id: r.id, name: r.name, ...(r.config ? { config: r.config } : {}), disabled: r.disabled === true }))
}

/**
 * The two lists of docs/architecture/plugin-model.md#required-and-optional-rows: the row ids in the
 * backticks of the `- **Required** …` and `- **Optional** …` items.
 */
export function classes(): { required: string[]; optional: string[] } {
  const text = readFileSync(join(ROOT, 'docs', 'architecture', 'plugin-model.md'), 'utf8')
  const section = text.split(/^## Required and optional rows$/m)[1]?.split(/^## /m)[0]
  if (!section) throw new Error('plugin-model.md has no "Required and optional rows" section')
  const items = section.split(/^- /m).slice(1)
  const ids = (label: string): string[] => {
    const item = items.find((i) => i.startsWith(`**${label}**`))?.split(/\n\s*\n/)[0]
    if (!item) throw new Error(`plugin-model.md lists no ${label} rows`)
    return [...item.matchAll(/`([\w-]+)`/g)].map((m) => m[1]!)
  }
  return { required: ids('Required'), optional: ids('Optional') }
}

/** What a step's failure reads as when it is the documented absence of the removed row's seam, not a fault. */
export const ABSENT = /not mounted|not installed|unknown workflow template|no Worker can take this work/i

export class StepFailure extends Error {
  constructor(readonly row: string, readonly step: string, detail: string) {
    super(`removability: row ${row}, step ${step}: ${detail}`)
  }
}

const within = <T>(promise: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  const bound = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`hung: ${what} took over ${ms} ms`)), ms) })
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer))
}

interface Rpc { isError?: boolean; structuredContent?: Record<string, unknown>; content?: Array<{ text?: string }> }

/** One JSON-RPC call to the stateless MCP endpoint, as a client holding `token` makes it. */
async function rpc(url: string, token: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST', signal: AbortSignal.timeout(60_000), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} answered ${response.status}: ${text.slice(0, 200)}`)
  const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).at(-1) ?? text
  const message = JSON.parse(data) as { result?: Record<string, unknown>; error?: { message: string } }
  if (message.error) throw new Error(`${method}: ${message.error.message}`)
  return message.result ?? {}
}

/** The scripted Worker's answers: an approving review (for any step that gives a subject), and a verifier's vote; anything else, its prompt echoed. */
function scripted(): ScriptedWorkers {
  const workers = new ScriptedWorkers()
  workers.extra = [
    worker('w:developer', { tier: 'standard', proves: ['reason', 'develop', 'local-data', 'persistent-conversation', 'dossier', 'review'] }),
    worker('w:reviewer', { tier: 'standard', proves: ['review', 'local-data'] }),
    worker('w:reviewer-2', { tier: 'standard', proves: ['review', 'local-data'] }),
  ]
  workers.reply = (request) => {
    const vote = verifierReply(request.prompt)
    if (vote) return vote
    const subject = /^Subject: (\S+)$/m.exec(request.prompt)?.[1]
    if (subject) return { text: '```json\n' + JSON.stringify({ subject, verdict: 'approve', findings: [{ severity: 'nit', title: 'nothing to change', file: 'README.md' }] }) + '\n```' }
    return { text: `answer: ${request.prompt.slice(0, 80)}` }
  }
  return workers
}

export interface Booted {
  ctx: Context
  /** Where a row failed to start (its error), by row id; empty when every mounted row started. */
  failed: Map<string, string>
  rows: Row[]
  mcp?: { url: string; operator: string; client: string }
  dispose: () => Promise<void>
}

/**
 * Boot the bundle with `off` turned off (none: as the bundle ships), with `on` turned on as well (rows the
 * bundle ships off), a scripted Worker registered, and every mounted row started or named in `failed`.
 */
export async function bootBundle(off: string | undefined, on: string[] = []): Promise<Booted> {
  const rows = bundleRows().map((r) => ({ ...r, disabled: r.id === off ? true : on.includes(r.id) ? false : r.disabled }))
  const dir = mkdtempSync(join(tmpdir(), 'system-removability-'))
  vi.stubEnv('DSH_HOME', dir)
  const ctx = new Context()
  // The plugin host reads the composition from the DSH loader and resolves each row's package from the bundle.
  ;(ctx as unknown as { baseUrl: string }).baseUrl = pathToFileURL(`${BUNDLE}/`).href
  const failed = new Map<string, string>()
  /** Each row as the DSH loader's `Entry` holds it: turned by `update`, which disposes the running fiber (not awaited) or applies the row again (ADR-0078). */
  const entries = rows.map((row) => {
    const entry = {
      options: { id: row.id, name: row.name, ...(row.config ? { config: row.config } : {}) },
      disabled: row.disabled,
      fiber: undefined as Fiber | undefined,
      update: async ({ disabled }: { disabled: boolean }): Promise<void> => {
        entry.disabled = disabled
        if (disabled) void entry.fiber?.dispose()
        else await mount(entry, row)
      },
    }
    return entry
  })
  type Entry = (typeof entries)[number]
  const mount = async (entry: Entry, row: Row): Promise<void> => {
    const module = DSH[row.name] ?? await import(row.name) as { default?: unknown }
    const loaded = (module as { default?: unknown }).default ?? module
    const fiber = ctx.plugin(loaded as never, { ...row.config, ...overrides[row.id] } as never)
    entry.fiber = fiber
    // A row that cannot start is a finding, never an unhandled rejection; one that waits on a seam that is absent never settles.
    void Promise.resolve(fiber).catch((error: unknown) => { failed.set(row.id, (error as Error).message) })
  }
  class Loader extends Service {
    constructor(c: Context) {
      super(c, 'loader')
    }
    *entries(): Generator<Entry> {
      yield* entries
    }
  }
  const overrides: Record<string, Record<string, unknown>> = {
    webserver: { host: '127.0.0.1', port: 0 },
    store: { path: join(dir, 'system.db') },
    credentials: { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') },
    'mcp-server': { tokenDir: dir, discoveryFile: join(dir, 'mcp.json'), minFreeBytes: 0, availabilitySeconds: 0 },
    approvals: { sweepSeconds: 3600 },
    board: { sweepSeconds: 0 },
  }
  const fibers: Fiber[] = [ctx.plugin(Loader)]
  for (const [i, row] of rows.entries()) if (!row.disabled) await mount(entries[i]!, row)
  const scriptedWorkers = scripted()
  const worker = ctx.plugin({ name: 'removability-worker', inject: ['workers', 'artifacts'], apply: (c: Context) => void c.workers.register(scriptedWorkers.source(c)) } as never, {} as never)
  const dispose = async (): Promise<void> => {
    await worker.dispose()
    for (const entry of [...entries].reverse()) await entry.fiber?.dispose()
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  try {
    // Ready: the engine (a required row) and, when it is mounted, the MCP endpoint (its discovery file).
    await within(new Promise<void>((resolve) => { ctx.inject(['workflow', 'workers', 'artifacts'] as never, () => resolve()) }), 60_000, 'the workflow engine to start')
    const mounted = rows.some((r) => r.id === 'mcp-server' && !r.disabled)
    let mcp: Booted['mcp']
    if (mounted) {
      await within(new Promise<void>((resolve) => { ctx.inject(['mcp'] as never, () => resolve()) }), 30_000, 'the MCP endpoint to start')
      const discovery = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8')) as { url: string; tokenFiles: Record<'operator' | 'client', string> }
      const token = (scope: 'operator' | 'client'): string => readFileSync(discovery.tokenFiles[scope]).toString('base64url')
      mcp = { url: discovery.url, operator: token('operator'), client: token('client') }
    }
    return { ctx, failed, rows, ...(mcp ? { mcp } : {}), dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

/** The plugin host's runtime switch (contract 1.2, ADR-0078), through its loosely typed surface: the matrix names no plugin's types. */
interface Switches {
  turn(row: string, on: boolean, reason?: string): Promise<{ row: { id: string; on: boolean; required: boolean; turned?: { reason?: string } } }>
  rows(): Array<{ id: string; on: boolean; required: boolean }>
}
export const switches = (booted: Booted): Switches => (booted.ctx as unknown as { pluginHost: Switches }).pluginHost

/**
 * Turn row `id` off or on in the running bundle through the plugin host, no restart. A turn that
 * fails is named by the row and the step. `mcp-server`, which serves the switches, is never turned
 * off at runtime (ADR-0078).
 */
export async function turnRow(booted: Booted, id: string, on: boolean): Promise<Booted> {
  const step = on ? 'turn on' : 'turn off'
  try {
    const turned = await within(switches(booted).turn(id, on, 'the removability matrix'), 120_000, `row ${id} to ${step}`)
    if (turned.row.on !== on) throw new Error(`the row is ${turned.row.on ? 'on' : 'off'} after it`)
  } catch (error) {
    throw new StepFailure(id, step, (error as Error).message)
  }
  return booted
}

/**
 * A row that ships off and provides a seam another row provides: only one provider runs at a time
 * (INV-1, plugin rule 4), so the other is turned off before it is turned on, and back on after.
 */
export const SWAPS: Readonly<Record<string, string>> = { 'digest-extractive': 'digest' }

/**
 * The runtime cycle of an optional row that ships off, in the running bundle with no restart: its
 * swap (if any) off, the row on, smoke; the row off, its swap on again, smoke with the tools of the
 * baseline. A failure is named by the row and the step.
 */
export async function cycleShippedOff(booted: Booted, id: string, baseline: readonly string[]): Promise<void> {
  const swap = SWAPS[id]
  if (swap) await turnRow(booted, swap, false)
  await turnRow(booted, id, true)
  await smoke(booted, swap)
  await turnRow(booted, id, false)
  if (swap) await turnRow(booted, swap, true)
  const { tools } = await smoke(booted, undefined, baseline)
  if (booted.mcp && [...tools].sort().join() !== [...baseline].sort().join()) throw new StepFailure(id, 'tools after', `the tools differ from the baseline's: ${tools.filter((t) => !baseline.includes(t)).join(', ')} added, ${baseline.filter((t) => !tools.includes(t)).join(', ')} gone`)
}

type Step = { name: string; run: () => Promise<void> }

/**
 * Run the smoke scenario on a booted bundle with `off` removed, step by step; the first failure throws a
 * {@link StepFailure} naming the row and the step. `off` undefined is the baseline the matrix compares to.
 */
export async function smoke(booted: Booted, off: string | undefined, baselineTools: readonly string[] = []): Promise<{ tools: string[]; steps: string[] }> {
  const row = off ?? 'baseline'
  const { mcp } = booted
  // The engine and the web server through their loosely typed surface: the matrix names no plugin's types.
  const ctx = booted.ctx as unknown as {
    workflow: { start(input: Record<string, unknown>): unknown; wait(runId: string, ms: number): Promise<unknown> }
    webServer: { port: number }
  }
  const tools: string[] = []
  const done: string[] = []
  const call = async (name: string, args: Record<string, unknown>, token = mcp!.operator): Promise<Rpc> =>
    await within(rpc(mcp!.url, token, 'tools/call', { name, arguments: args }), 90_000, `MCP ${name}`) as Rpc
  /** Succeeded, or failed with the documented absence of a seam; otherwise the step's failure. */
  const succeeds = (what: string, reply: Rpc): void => {
    if (!reply.isError) return
    const text = (reply.content ?? []).map((c) => c.text ?? '').join(' ')
    if (!ABSENT.test(text)) throw new Error(`${what} failed: ${text.slice(0, 300)}`)
  }
  const waitRun = async (view: { runId: string; status: string }): Promise<{ status: string; answer?: string }> =>
    view.status === 'running' || view.status === 'pending' ? within(ctx.workflow.wait(view.runId, 60_000), 70_000, `run ${view.runId}`) as never : view as never
  const steps: Step[] = [
    { name: 'start', run: async () => {
      if (booted.failed.size) throw new Error(`rows that failed to start: ${[...booted.failed].map(([id, why]) => `${id} (${why.slice(0, 200)})`).join('; ')}`)
    } },
    { name: 'health', run: async () => {
      if (mcp) {
        const status = await call('status', { plugins: true, checks: true })
        succeeds('status', status)
        const health = (status.structuredContent as { health: { state: string; checks: Array<{ name: string; state: string; detail: string }> } }).health
        const bad = health.checks.filter((c) => c.state === 'down')
        if (health.state === 'down' || bad.length) throw new Error(`health is ${health.state}: ${bad.map((c) => `${c.name}: ${c.detail.slice(0, 200)}`).join('; ')}`)
        const plugin = (status.structuredContent as { plugins?: Array<{ rows: string[]; mounted: boolean; findings?: unknown }> }).plugins ?? []
        const found = plugin.filter((p) => p.findings)
        if (found.length) throw new Error(`the plugin host's manifest check found: ${JSON.stringify(found).slice(0, 300)}`)
        if (off && plugin.some((p) => p.rows.includes(off) && p.mounted)) throw new Error(`the plugin host lists ${off} as mounted`)
      } else {
        // No MCP endpoint (the seam is absent): the host answers, and there is no /healthz.
        const gone = await fetch(`http://127.0.0.1:${ctx.webServer.port}/healthz`, { signal: AbortSignal.timeout(10_000) })
        if (gone.status !== 404) throw new Error(`/healthz answered ${gone.status} with the MCP endpoint off, not 404`)
      }
    } },
    { name: 'tools', run: async () => {
      if (!mcp) return
      const listed = ((await within(rpc(mcp.url, mcp.operator, 'tools/list', {}), 60_000, 'MCP tools/list')).tools as Array<{ name: string }>).map((t) => t.name).sort()
      tools.push(...listed)
      for (const must of ['status', 'roster', 'ask', 'run']) if (!listed.includes(must)) throw new Error(`the tool ${must} is gone`)
      // A tool the row owned goes with it; none appears that the baseline lacked.
      const extra = listed.filter((t) => baselineTools.length && !baselineTools.includes(t))
      if (extra.length) throw new Error(`tools appeared with the row off: ${extra.join(', ')}`)
      // The tools that read and need no argument, those still listed, answer.
      for (const name of ['roster', 'approvals_list', 'resources_pools', 'resources_usage', 'board_projects', 'report', 'dispatch_status']) {
        if (listed.includes(name)) succeeds(name, await call(name, {}, mcp.client))
      }
    } },
    { name: 'ask', run: async () => {
      const prompt = 'Say hello'
      if (mcp) {
        const reply = await call('ask', { prompt, waitSeconds: 30 }, mcp.client)
        succeeds('ask', reply)
        const view = reply.structuredContent as { status?: string; answer?: string } | undefined
        if (!reply.isError && (view?.status !== 'completed' || !view.answer?.startsWith('answer:'))) throw new Error(`ask did not complete on the fake Worker: ${JSON.stringify(view).slice(0, 300)}`)
      } else {
        const view = await waitRun(await ctx.workflow.start({ template: 'ask', input: prompt }) as { runId: string; status: string })
        if (view.status !== 'completed' || !view.answer?.startsWith('answer:')) throw new Error(`ask did not complete on the fake Worker: ${JSON.stringify(view).slice(0, 300)}`)
      }
    } },
    { name: 'algorithm-development', run: async () => {
      // The profile row contributes the template; with it off, the template is absent and the run says so.
      const input = 'Make the change and say what it is'
      const absent = off === 'profile-software-development'
      if (mcp) {
        const reply = await call('run', { template: 'algorithm-development', input, waitSeconds: 45 }, mcp.client)
        if (absent) {
          if (!reply.isError) throw new Error('algorithm-development ran with its profile row off')
          succeeds('run', reply)
          return
        }
        succeeds('run', reply)
        const view = reply.structuredContent as { status?: string } | undefined
        if (!reply.isError && view?.status !== 'completed') throw new Error(`algorithm-development did not complete on the fake Worker: ${JSON.stringify(view).slice(0, 1500)}`)
      } else {
        const started = await Promise.resolve(ctx.workflow.start({ template: 'algorithm-development', input, classification: 'operator-shared' }) as { runId: string; status: string }).catch((error: unknown) => ({ error: (error as Error).message }))
        if ('error' in started) {
          if (absent && ABSENT.test(started.error)) return
          throw new Error(`algorithm-development was refused: ${started.error.slice(0, 300)}`)
        }
        const view = await waitRun(started)
        if (view.status !== 'completed') throw new Error(`algorithm-development did not complete on the fake Worker: ${JSON.stringify(view).slice(0, 400)}`)
      }
    } },
  ]
  for (const step of steps) {
    try {
      await step.run()
      done.push(step.name)
    } catch (error) {
      if (error instanceof StepFailure) throw error
      throw new StepFailure(row, step.name, (error as Error).message)
    }
  }
  return { tools, steps: done }
}
