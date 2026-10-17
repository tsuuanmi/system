/**
 * One engine process for the crash-injection suite (plain JavaScript on the built packages:
 * a TypeScript loader that keeps function names breaks code sent to the browser): boots the real stack against the fake site,
 * starts or resumes a run, and reports on stdout as `@@ {json}` lines. The suite kills it with
 * SIGKILL (its whole process group: Xvfb and Chrome too) at a reconcile point, then starts it
 * again on the same state. Usage: crash-harness.mjs <dir> <origin> <chrome> start <persist|temporary> <prompt>
 *                                 crash-harness.mjs <dir> <origin> <chrome> resume <runId>
 *                                 crash-harness.mjs <dir> <origin> <chrome> delete <prompt>   (a persistent ask, then its run deleted)
 *                                 crash-harness.mjs <dir> <origin> <chrome> settle            (until no conversation is due)
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
/**
 * A step two others build on: `slow:1` answers slowly in its own conversation, and `blocked:1`
 * needs a capability no Worker has, so it fails at once and the run fails beside a running node.
 */
const step = (nodeId, prompt, extra = {}) => ({ nodeId, objective: nodeId, prompt, capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer', ...extra })
const TEMPLATES = {
  'fan-out': [
    step('context:1', 'Context for: {{input}}'),
    step('slow:1', 'Slow step on: {{node:context:1}}', { dependsOn: ['context:1'], conversation: 'persistent' }),
    step('blocked:1', 'Blocked on: {{node:context:1}}', { dependsOn: ['context:1'], capabilities: ['reason', 'connector:nowhere'] }),
    step('final:1', 'Both: {{node:slow:1}} {{node:blocked:1}}', { dependsOn: ['slow:1', 'blocked:1'] }),
  ],
}
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)

const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
  ctx.plugin(TurnReceipts, {}), ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
  ctx.plugin(Accounts, { accounts: [{ id: 'chatgpt-main', provider: 'chatgpt-web', quotaClass: 'subscription-chat', tiers: { economy: 'instant', standard: 'medium', frontier: 'high' } }] }),
  ctx.plugin(VirtualDisplay, {}), ctx.plugin(BrowserPool, { chromePath: chrome }), ctx.plugin(Providers),
  ctx.plugin(ChatGptWeb, { origin, pageGapMs: 0, overlayPath: join(dir, 'none.yaml'), modes: { instant: { model: 'Latest', effort: 'Instant' }, medium: { model: 'Latest', effort: 'Medium' }, high: { model: 'GPT-6', effort: 'High' } }, defaultMode: 'instant' }),
  ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }), ctx.plugin(WorkerRouter, {}),
  ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000 }), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 300, templates: TEMPLATES }),
]
await Promise.all(fibers)
// Services come up once their dependencies are ready, possibly after the fibers settle.
await new Promise((resolve) => ctx.inject(['workflow', 'accounts'], () => resolve(undefined)))
// As the live check does for the real site: the fake site's delete flow is the one its map describes.
const map = ctx.providers.get('chatgpt-web').map
for (const spec of [...Object.values(map.elements), ...Object.values(map.actions)]) delete spec.unverified
if (mode === 'settle') {
  // Deletions a crash interrupted are taken up again at start.
  const deadline = Date.now() + 180_000
  while (ctx.turns.conversations({ state: 'due' }).length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
  report({ conversations: ctx.turns.conversations() })
  for (const fiber of [...fibers].reverse()) await fiber.dispose()
  process.exit(0)
}
let runId
if (mode === 'start' || mode === 'delete' || mode === 'fan-out') {
  await ctx.accounts.saveState('chatgpt-main', {
    state: { origins: [origin], cookies: [], capturedAt: '2026-10-12T00:00:00Z' }, identityHash: `sha256:${'0'.repeat(64)}`, verifiedAt: '2026-10-12T00:00:00Z',
  })
  await ctx.accounts.setFeatures('chatgpt-main', ['deep-research', 'web-search', 'image-generation'])
  const [conversation, prompt] = mode === 'delete' || mode === 'fan-out' ? ['persist', rest[0]] : rest
  runId = mode === 'fan-out'
    ? ctx.workflow.start({ template: 'fan-out', input: prompt }).runId
    : ctx.workflow.start({ template: 'ask', input: prompt, ...(conversation === 'persist' ? { persist: true } : {}) }).runId
} else {
  runId = rest[0]
}
report({ runId })
if (mode === 'supersede') {
  // Started again: the run fails at once on the node that cannot run, while its sibling's turn
  // is still being reconciled. The operator replaces the step they both build on.
  const failed = await ctx.workflow.wait(runId, 120_000)
  report({ before: failed.status })
  await ctx.workflow.supersede(runId, 'context:1', { text: rest[1] })
  report({ superseded: true })
}
const done = await ctx.workflow.wait(runId, 240_000)
report({ done })
if (mode === 'delete') {
  // Its run deleted: the session is released and its conversation deleted in the background,
  // until the suite kills this process mid-deletion.
  ctx.workflow.delete(runId, ctx.workflow.delete(runId).updatedAt)
  report({ deleted: runId })
  await new Promise((resolve) => setTimeout(resolve, 240_000))
}
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
