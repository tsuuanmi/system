import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Store from '@tsuuanmi/system-store'
import { runSuite } from '../../../libs/conformance/runner.ts'
import { SESSIONS_CONFIG, workerSessionsSuite } from '../conformance/worker-sessions.ts'
import WorkerSessions from '../src/index.ts'

// The real provider, over a real store and artifact ledger, runs the seam's suite (ADR-0037).
runSuite(workerSessionsSuite, {
  name: '@tsuuanmi/system-worker-sessions',
  contract: '1.0',
  // Gaps between the documented contract and this provider, reported for reconciliation.
  expectedFailures: {
    'workerSessions.reactivation-advances-generation': 'activate never advances binding.generation; only rebind (compaction) does',
    'workerSessions.stale-activation-fenced': 'no write takes the activation\'s generation, so settle from a superseded activation lands',
    'workerSessions.one-writer-per-subject': 'join takes no write subject: policy.writes is never recorded, so INV-15 is not enforced here',
    'workerSessions.refs-egress-checked': 'send checks no egress: local-private refs reach a remote Worker\'s mailbox',
  },
  boot: async () => {
    const dir = mkdtempSync(join(tmpdir(), 'system-sessions-conformance-'))
    const ctx = new Context()
    const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(WorkerSessions, SESSIONS_CONFIG)]
    await Promise.all(fibers)
    return {
      ctx,
      dispose: async () => {
        for (const fiber of fibers.reverse()) await fiber.dispose()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  },
})
