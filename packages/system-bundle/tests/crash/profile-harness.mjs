/**
 * One engine process for the crash-injection suite, with a session-bound account (ADR-0030): a
 * Gemini account against the fake site in its `deviceBound` mode, whose session works only in the
 * login profile that signed in. Reports on stdout as `@@ {json}` lines, like crash-harness.mjs.
 * Usage: profile-harness.mjs <dir> <origin> <chrome> start <prompt>   (signs in the profile, Saves, a persistent ask)
 *        profile-harness.mjs <dir> <origin> <chrome> resume <runId>
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
import * as GeminiWeb from '@tsuuanmi/system-provider-gemini-web'
import Providers from '@tsuuanmi/system-providers'
import Store from '@tsuuanmi/system-store'
import TurnReceipts from '@tsuuanmi/system-turn-receipts'
import Turns from '@tsuuanmi/system-turns'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'
import { LEASE_CAP_MS } from './leases.mjs'

const [dir, origin, chrome, mode, arg] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)

const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, { maxTtlMs: LEASE_CAP_MS }), ctx.plugin(Egress, {}),
  ctx.plugin(TurnReceipts, {}), ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
  ctx.plugin(Accounts, { accounts: [{ id: 'gemini-main', provider: 'gemini-web', quotaClass: 'subscription-chat', tiers: { economy: 'flash-lite', standard: 'flash', frontier: 'pro' } }] }),
  ctx.plugin(VirtualDisplay, {}), ctx.plugin(BrowserPool, { chromePath: chrome }), ctx.plugin(Providers),
  ctx.plugin(GeminiWeb, { origin, pageGapMs: 0 }),
  ctx.plugin(Login, { profilesDir: join(dir, 'profiles') }), ctx.plugin(WorkerRouter, {}),
  ctx.plugin(Turns, { turnTimeoutMs: 90_000, stallTimeoutMs: 80_000 }), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 300 }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['workflow', 'accounts', 'login'], () => resolve(undefined)))
let runId
if (mode === 'start') {
  // The operator's sign-in, in the login profile (as a remote login leaves it), then Save.
  const profile = { dir: ctx.login.profileDir('gemini-main') }
  const signIn = await ctx.browser.openTurn('gemini-main', { profile })
  await signIn.page.goto(`${origin}/signin`)
  await signIn.page.locator('#bound').waitFor({ state: 'visible' })
  await signIn.close()
  await ctx.browser.close('gemini-main')
  await ctx.login.save('gemini-main')
  await ctx.accounts.setFeatures('gemini-main', ['deep-research'])
  runId = ctx.workflow.start({ template: 'ask', input: arg, persist: true }).runId
} else {
  runId = arg
}
report({ runId })
const done = await ctx.workflow.wait(runId, 240_000)
report({ done })
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
