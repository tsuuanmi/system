/**
 * One engine process for the crash-injection suite (plain JavaScript on the built packages:
 * a TypeScript loader that keeps function names breaks code sent to the browser): boots the real stack against the fake site,
 * starts or resumes a run, and reports on stdout as `@@ {json}` lines. The suite kills it with
 * SIGKILL (its whole process group: Xvfb and Chrome too) at a reconcile point, then starts it
 * again on the same state. Usage: crash-harness.mjs <dir> <origin> <chrome> start <persist|temporary> <prompt>
 *                                 crash-harness.mjs <dir> <origin> <chrome> resume <runId>
 */
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Accounts from '@tsuuanmi/system-accounts'
import Artifacts from '@tsuuanmi/system-artifacts'
import BrowserPool from '@tsuuanmi/system-browser-patchright'
import Vault from '@tsuuanmi/system-credentials-vault'
import VirtualDisplay from '@tsuuanmi/system-display-virtual'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Login from '@tsuuanmi/system-login'
import ChatGptWeb from '@tsuuanmi/system-provider-chatgpt-web'
import Providers from '@tsuuanmi/system-providers'
import Store from '@tsuuanmi/system-store'
import TurnReceipts from '@tsuuanmi/system-turn-receipts'
import Turns from '@tsuuanmi/system-turns'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'

const [dir, origin, chrome, mode, ...rest] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)

const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
  ctx.plugin(TurnReceipts, {}), ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
  ctx.plugin(Accounts, { accounts: [{ id: 'chatgpt-main', provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers: { economy: 'instant', standard: 'medium', frontier: 'high' } }] }),
  ctx.plugin(VirtualDisplay, {}), ctx.plugin(BrowserPool, { chromePath: chrome }), ctx.plugin(Providers),
  ctx.plugin(ChatGptWeb, { origin, overlayPath: join(dir, 'none.yaml'), modes: { instant: { model: 'Latest', effort: 'Instant' }, medium: { model: 'Latest', effort: 'Medium' }, high: { model: 'GPT-6', effort: 'High' } }, defaultMode: 'instant' }),
  ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }), ctx.plugin(WorkerRouter, {}),
  ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000 }), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 300 }),
]
await Promise.all(fibers)
// Services come up once their dependencies are ready, possibly after the fibers settle.
await new Promise((resolve) => ctx.inject(['workflow', 'accounts'], () => resolve(undefined)))
let runId
if (mode === 'start') {
  await ctx.accounts.saveState('chatgpt-main', {
    state: { origins: [origin], cookies: [], capturedAt: '2026-10-12T00:00:00Z' }, identityHash: `sha256:${'0'.repeat(64)}`, verifiedAt: '2026-10-12T00:00:00Z',
  })
  const [conversation, prompt] = rest
  runId = ctx.workflow.start({ template: 'ask', input: prompt, ...(conversation === 'persist' ? { persist: true } : {}) }).runId
} else {
  runId = rest[0]
}
report({ runId })
const done = await ctx.workflow.wait(runId, 240_000)
report({ done })
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
