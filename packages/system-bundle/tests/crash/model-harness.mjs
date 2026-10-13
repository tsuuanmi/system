/**
 * One engine process for the model-call crash case (plain JavaScript on the built packages):
 * boots the store, routing, the vault, the DSH `llm` and `llm-pi-ai` rows with one route to the
 * test's fake OpenAI-compatible server, the `models` row with one catalog entry, and the workflow
 * engine; starts or resumes an `ask` run; reports on stdout as `@@ {json}` lines. The route's key
 * comes from the environment, which the vault reads first.
 * Usage: model-harness.mjs <dir> <baseURL> start <input> | resume <runId>
 */
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import Artifacts from '@tsuuanmi/system-artifacts'
import Vault from '@tsuuanmi/system-credentials-vault'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import * as Models from '@tsuuanmi/system-models'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow from '@tsuuanmi/system-workflow'

const [dir, baseURL, mode, arg] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)

const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
  ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') }), ctx.plugin(LlmRuntime),
  ctx.plugin(PiAi, { providers: { fake: { api: 'openai-completions', baseURL, apiKeyEnv: 'SYSTEM_CRASH_MODEL_KEY', models: [{ id: 'm1' }] } } }),
  ctx.plugin(WorkerRouter, {}), ctx.plugin(Models, { models: [{ id: 'fast', route: 'fake', model: 'm1', tier: 'standard' }] }),
  ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, { retryDelayMs: 300 }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['workflow', 'models'], () => resolve(undefined)))
const runId = mode === 'start' ? ctx.workflow.start({ template: 'ask', input: arg, classification: 'public' }).runId : arg
report({ runId })
const done = await ctx.workflow.wait(runId, 240_000)
report({ done })
for (const fiber of [...fibers].reverse()) await fiber.dispose()
process.exit(0)
