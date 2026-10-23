/**
 * One daemon process for the enrollment crash case (plain JavaScript on the built packages): boots
 * the store, the vault, routing, and the agent Worker source with one configured Worker on a
 * scripted runtime whose own home is `<dir>/own-home`, adopted as slot 1. Reports on stdout as
 * `@@ {json}` lines.
 * - `crash`: takes slot 1, then verifies it with an identity reader that never answers, so the suite
 *   can kill the process with SIGKILL between the slot's allocation and its verification.
 * - `after`: reports the slot and the Worker's state as they are, then verifies the slot (the reader
 *   answers now) and reports both again.
 * Usage: enroll-harness.mjs <dir> crash|after
 */
import { createHmac } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry from '@tsuuanmi/system-agent-runtimes'
import AgentWorkers from '@tsuuanmi/system-agent-workers'
import Artifacts from '@tsuuanmi/system-artifacts'
import Vault from '@tsuuanmi/system-credentials-vault'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerRouter from '@tsuuanmi/system-workers'

const [dir, mode] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)
const home = join(dir, 'own-home')
mkdirSync(home, { recursive: true, mode: 0o700 })
const workspace = join(dir, 'ws')
mkdirSync(workspace, { recursive: true })

/** A scripted runtime: its own home is slot 1; its reader verifies one principal, or, in `crash`, never answers. */
const scripted = {
  kind: 'scripted',
  home,
  probe: async () => ({ available: true, detail: 'scripted', sandboxes: ['read-only'], resume: false, executes: false, readsConfined: true, gatesToolCalls: true }),
  run: async () => ({ text: 'ok' }),
  loginCommand: (at) => ({ command: 'true', args: [], env: { SCRIPTED_HOME: at } }),
  identity: async (_at, key) => {
    if (mode === 'crash') {
      report({ reading: true })
      await new Promise(() => undefined)
    }
    return { status: 'verified', hmac: createHmac('sha256', key).update(JSON.stringify(['scripted', [['user', 'principal-1']]])).digest('hex'), reader: 'scripted-reader', runtimeVersion: '1.0.0' }
  },
}

const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
  ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }),
  ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry, {}),
  ctx.plugin(AgentWorkers, { workers: [{ id: 'reviewer', runtime: 'scripted', workspace, sandbox: 'read-only', tier: 'standard' }], probeTtlMs: 0 }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['agentWorkers', 'agentRuntimes'], () => resolve(undefined)))
ctx.agentRuntimes.register(scripted)
const accounts = ctx.agentWorkers.agentAccounts
const state = async () => (await ctx.workers.list()).find((w) => w.worker === 'agent:reviewer')?.state
if (mode === 'crash') {
  const begun = await accounts.begin({ provider: 'scripted' })
  report({ begun: begun.account })
  await accounts.verify({ provider: 'scripted', slot: 1 })
} else {
  report({ before: { accounts: accounts.list(), state: await state() } })
  const verified = await accounts.verify({ provider: 'scripted', slot: 1 })
  report({ after: { verified, state: await state() } })
}
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
