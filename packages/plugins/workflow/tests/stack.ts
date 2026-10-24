/**
 * The real stack the engine's browser tests run on: the kernel, both website drivers against their
 * fake sites, the engine, and the MCP endpoint, with the team members' answers those tests script.
 * A test file calls {@link browserStack} once, at its top: that registers the file's one Xvfb and
 * returns `boot`, whose stack is stopped when its test finishes.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import Accounts from '@tsuuanmi/system-accounts'
import Artifacts from '@tsuuanmi/system-artifacts'
import BrowserPool from '@tsuuanmi/system-browser-patchright'
import Vault from '@tsuuanmi/system-credentials-vault'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Login from '@tsuuanmi/system-login'
import McpEndpoint from '@tsuuanmi/system-mcp-server'
import ChatGptWeb from '@tsuuanmi/system-provider-chatgpt-web'
import * as GeminiWeb from '@tsuuanmi/system-provider-gemini-web'
import Providers from '@tsuuanmi/system-providers'
import Store from '@tsuuanmi/system-store'
import TurnReceipts from '@tsuuanmi/system-turn-receipts'
import Turns from '@tsuuanmi/system-turns'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { ArtifactRef } from '@tsuuanmi/system-workers-core'
import { onTestFinished, vi } from 'vitest'
import { fileDisplay, testChrome } from '../../browser-patchright/tests/support.ts'
import { FakeChatGpt, type FakeOptions } from '../../provider-chatgpt-web/fixtures/fake-chatgpt.ts'
import { FakeGemini, type FakeOptions as FakeGeminiOptions } from '../../provider-gemini-web/fixtures/fake-gemini.ts'
import Workflow from '../src/index.ts'
import type { RunView } from '../src/types.ts'
import { TEST_TEMPLATES } from './templates.ts'

export const REPORT = 'Plugins matter <a href="https://src.example/catalog">[1]</a>.'
/** A team member's answers, as the engine's prompts ask for them (docs/design/teams.md). */
export const isProposal = (prompt: string): boolean => prompt.includes('Answer on your own')
export const kind = (prompt: string): string => (isProposal(prompt) ? 'proposal' : prompt.includes('is split') ? 'debate' : prompt.includes('your ballot') ? 'ballot' : 'other')
export const proposal = (recommendation: string): string => `My proposal.\n${JSON.stringify({ recommendation, rationale: 'it fits', risks: [] })}`
export const findings = (list: Array<{ severity: string; claim: string; location?: string; quote?: { path: string; line: number; text: string } }>): string => JSON.stringify({ findings: list.map((f) => ({ evidence: 'read it', ...f })) })
export const ballot = (choice: string, objections: string[] = [], team: 'brainstorm' | 'review' = 'brainstorm'): string => {
  const options = team === 'review' ? ['pass', 'changes'] : ['O1', 'O2']
  const other = options.find((o) => o !== choice)!
  return JSON.stringify({ choice, ranking: [choice, other], rationale: `I prefer ${choice}`, evidence: [], strongest: { [other]: 'it is simpler' }, objections, confidence: 'high' })
}

/** A member that proposes its own option and votes O1, with no objection. */
export const member = (prompt: string): string => (isProposal(prompt) ? proposal(`option of ${/member (\d)/.exec(prompt)?.[1]}`) : ballot('O1'))

/** Compaction answers cite; anything else answers plainly. */
export const answer = (prompt: string): string => (prompt.includes('<report>') ? 'Synthesis: plugins matter (https://src.example/catalog).' : 'Plain answer.')

/** The plan a run's gate waits on. */
export const waitingPlan = (view: RunView): ArtifactRef => (view.blocked?.kind === 'gate' ? view.blocked.plan : (() => { throw new Error(`run ${view.runId} waits on no plan`) })())

export const until = (check: () => boolean, ms = 30_000, what = ''): Promise<void> => vi.waitFor(() => {
  if (!check()) throw new Error(what ? `timed out waiting for ${what}` : 'timed out')
}, { timeout: ms, interval: 100 })

export interface BootOptions { fake?: FakeOptions; gemini?: FakeGeminiOptions; dir?: string; shared?: FakeChatGpt; turns?: Record<string, unknown>; workflow?: Record<string, unknown>; sessions?: Record<string, unknown>; ready?: boolean; accounts?: string[] }

/**
 * The test file's stack: every boot draws its browsers on the file's one Xvfb, and is stopped,
 * with its fake sites and directory, when its test finishes. Call it once, at the top of the file.
 */
export function browserStack() {
  /** The file's one Xvfb: every test's browser draws on it, as a profile's browsers share display-virtual's. */
  const TestDisplay = fileDisplay()

  /**
   * The kernel, both website drivers against their fake sites, and the engine. `gemini` adds a
   * Gemini account (`gemini-main`), so a team finds two provider families (ADR-0027).
   */
  async function boot(options: BootOptions = {}) {
    const ids = [...(options.accounts ?? ['chatgpt-main']), ...(options.gemini ? ['gemini-main'] : [])]
    const fake = options.shared ?? new FakeChatGpt({ answer, report: REPORT, ...options.fake })
    if (!options.shared) await fake.start()
    const gemini = options.gemini ? new FakeGemini({ startOnSpark: false, ...options.gemini }) : undefined
    if (gemini) {
      await gemini.start()
      onTestFinished(() => gemini.stop())
    }
    const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'system-workflow-'))
    if (!options.dir) onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
    if (!options.shared) onTestFinished(() => fake.stop())
    const ctx = new Context()
    const fibers = [
      ctx.plugin(Store, { path: join(dir, 'system.db') }),
      ctx.plugin(Artifacts, {}),
      ctx.plugin(EventLog, {}),
      ctx.plugin(Leases, {}),
      ctx.plugin(Egress, {}),
      ctx.plugin(TurnReceipts, {}),
      ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
      ctx.plugin(Accounts, {
        accounts: ids.map((id) => (id.startsWith('gemini')
          ? { id, provider: 'gemini-web', quotaClass: 'subscription-chat' as const, tiers: { economy: 'flash-lite', standard: 'flash', frontier: 'pro' } }
          : { id, provider: 'chatgpt-web', quotaClass: 'subscription-chat' as const, tiers: { economy: 'instant', standard: 'medium', frontier: 'high' } })),
      }),
      ctx.plugin(TestDisplay),
      ctx.plugin(BrowserPool, { chromePath: testChrome! }),
      ctx.plugin(Providers),
      ctx.plugin(ChatGptWeb, { origin: fake.origin, pageGapMs: 0, overlayPath: join(dir, 'none.yaml'), modes: { instant: { model: 'Latest', effort: 'Instant' }, medium: { model: 'Latest', effort: 'Medium' }, high: { model: 'GPT-6', effort: 'High' } }, defaultMode: 'instant' }),
      ...(gemini ? [ctx.plugin(GeminiWeb, { origin: gemini.origin, pageGapMs: 0 })] : []),
      ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }),
      ctx.plugin(WorkerRouter, {}),
      ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000, ...options.turns }),
      ctx.plugin(WorkerSessions, options.sessions ?? {}),
      ctx.plugin(Workflow, { retryDelayMs: 300, ...options.workflow, templates: { ...TEST_TEMPLATES, ...(options.workflow?.templates as object | undefined) } }),
      ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }),
      ctx.plugin(McpEndpoint, { tokenDir: dir, discoveryFile: join(dir, 'mcp.json') }),
    ]
    await Promise.all(fibers)
    const stop = async (): Promise<void> => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
    }
    onTestFinished(stop)
    if (!options.shared && options.ready !== false) {
      for (const [index, id] of ids.entries()) {
        await ctx.accounts.saveState(id, {
          state: { origins: [id.startsWith('gemini') ? gemini!.origin : fake.origin], cookies: [], capturedAt: '2026-10-12T00:00:00Z' },
          identityHash: `sha256:${String(index).repeat(64)}`, verifiedAt: '2026-10-12T00:00:00Z',
        })
        // As a feature probe on the fake site would find (REQ-PRV-7); fresh, so no background probe runs.
        await ctx.accounts.setFeatures(id, ['deep-research', 'web-search', 'image-generation'])
      }
    }
    return { ctx, fake, gemini, dir, stop }
  }

  return { boot }
}
