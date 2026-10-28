import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { BaseSequencer, type TestSpecification } from 'vitest/node'
import { BrowserSkips } from './scripts/browser-skips.ts'
import { durationKey, order, readDurations } from './scripts/test-durations.ts'

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

/** The worker count an acceptance check gives its run (SYSTEM_CHECK_MAX_WORKERS, a positive integer); undefined when none. */
function checkWorkers(): number | undefined {
  const given = Number(process.env.SYSTEM_CHECK_MAX_WORKERS)
  return Number.isInteger(given) && given >= 1 ? given : undefined
}

/**
 * Starts the test files by the committed duration table (scripts/test-durations.ts): the files it
 * does not hold first, in vitest's own order, then the rest longest first. vitest's own order
 * needs its duration cache, which a fresh worktree and CI lack.
 */
class DurationSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const durations = readDurations()
    return order(await super.sort(files), (spec) => durationKey(this.ctx.config.root, spec.moduleId), durations)
  }
}

export default defineConfig({
  resolve: {
    // Bare workspace imports resolve to source, never to built lib/ (DSH testing convention).
    alias: {
      '@tsuuanmi/system-libs': src('./packages/libs/src/index.ts'),
      '@tsuuanmi/system-store': src('./packages/plugins/store/src/index.ts'),
      '@tsuuanmi/system-artifacts': src('./packages/plugins/artifacts/src/index.ts'),
      '@tsuuanmi/system-credentials-vault': src('./packages/plugins/credentials-vault/src/index.ts'),
      '@tsuuanmi/system-mcp-server': src('./packages/plugins/mcp-server/src/index.ts'),
      '@tsuuanmi/system-leases': src('./packages/plugins/leases/src/index.ts'),
      '@tsuuanmi/system-event-log': src('./packages/plugins/event-log/src/index.ts'),
      '@tsuuanmi/system-turn-receipts': src('./packages/plugins/turn-receipts/src/index.ts'),
      '@tsuuanmi/system-accounts': src('./packages/plugins/accounts/src/index.ts'),
      '@tsuuanmi/system-display-virtual': src('./packages/plugins/display-virtual/src/index.ts'),
      '@tsuuanmi/system-browser-patchright': src('./packages/plugins/browser-patchright/src/index.ts'),
      '@tsuuanmi/system-ui-ops': src('./packages/ui-ops/src/index.ts'),
      '@tsuuanmi/system-provider-gemini-web': src('./packages/plugins/provider-gemini-web/src/index.ts'),
      '@tsuuanmi/system-provider-chatgpt-web': src('./packages/plugins/provider-chatgpt-web/src/index.ts'),
      '@tsuuanmi/system-providers': src('./packages/plugins/providers/src/index.ts'),
      '@tsuuanmi/system-login': src('./packages/plugins/login/src/index.ts'),
      '@tsuuanmi/system-turns': src('./packages/plugins/turns/src/index.ts'),
      '@tsuuanmi/system-egress': src('./packages/plugins/egress/src/index.ts'),
      '@tsuuanmi/system-agent-runtime-core': src('./packages/agent-runtime-core/src/index.ts'),
      '@tsuuanmi/system-agent-workers': src('./packages/plugins/agent-workers/src/index.ts'),
      '@tsuuanmi/system-agent-runtimes': src('./packages/plugins/agent-runtimes/src/index.ts'),
      '@tsuuanmi/system-runtime-acp': src('./packages/plugins/runtime-acp/src/index.ts'),
      '@tsuuanmi/system-runtime-codex-sdk': src('./packages/plugins/runtime-codex-sdk/src/index.ts'),
      '@tsuuanmi/system-runtime-claude-agent-sdk': src('./packages/plugins/runtime-claude-agent-sdk/src/index.ts'),
      '@tsuuanmi/system-runtime-antigravity-cli': src('./packages/plugins/runtime-antigravity-cli/src/index.ts'),
      '@tsuuanmi/system-gateway-turns': src('./packages/gateway-turns/src/index.ts'),
      '@tsuuanmi/system-profile-scientific-research': src('./packages/plugins/profile-scientific-research/src/index.ts'),
      '@tsuuanmi/system-profile-software-development': src('./packages/plugins/profile-software-development/src/index.ts'),
      '@tsuuanmi/system-gateway-responses': src('./packages/plugins/gateway-responses/src/index.ts'),
      '@tsuuanmi/system-gateway-anthropic': src('./packages/plugins/gateway-anthropic/src/index.ts'),
      '@tsuuanmi/system-web-ui': src('./packages/plugins/web-ui/src/index.ts'),
      '@tsuuanmi/system-worker-sessions': src('./packages/plugins/worker-sessions/src/index.ts'),
      '@tsuuanmi/system-workflow': src('./packages/plugins/workflow/src/index.ts'),
      '@tsuuanmi/system-workers-core': src('./packages/workers-core/src/index.ts'),
      '@tsuuanmi/system-ledger-core': src('./packages/ledger-core/src/index.ts'),
      '@tsuuanmi/system-approvals-core': src('./packages/approvals-core/src/index.ts'),
      '@tsuuanmi/system-approvals': src('./packages/plugins/approvals/src/index.ts'),
      '@tsuuanmi/system-digest-core': src('./packages/digest-core/src/index.ts'),
      '@tsuuanmi/system-decision-core': src('./packages/decision-core/src/index.ts'),
      '@tsuuanmi/system-landing-core': src('./packages/landing-core/src/index.ts'),
      '@tsuuanmi/system-landing-local': src('./packages/plugins/landing-local/src/index.ts'),
      '@tsuuanmi/system-digest': src('./packages/plugins/digest/src/index.ts'),
      '@tsuuanmi/system-digest-extractive': src('./packages/plugins/digest-extractive/src/index.ts'),
      '@tsuuanmi/system-workers-fake': src('./packages/plugins/workers-fake/src/index.ts'),
      '@tsuuanmi/system-report': src('./packages/plugins/report/src/index.ts'),
      '@tsuuanmi/system-resources-core': src('./packages/resources-core/src/index.ts'),
      '@tsuuanmi/system-resources': src('./packages/plugins/resources/src/index.ts'),
      '@tsuuanmi/system-board-core': src('./packages/board-core/src/index.ts'),
      '@tsuuanmi/system-board': src('./packages/plugins/board/src/index.ts'),
      '@tsuuanmi/system-models-core': src('./packages/models-core/src/index.ts'),
      '@tsuuanmi/system-models': src('./packages/plugins/models/src/index.ts'),
      '@tsuuanmi/system-workers': src('./packages/plugins/workers/src/index.ts'),
      '@tsuuanmi/system-gateway-core': src('./packages/gateway-core/src/index.ts'),
      '@tsuuanmi/system-provider-core': src('./packages/provider-core/src/index.ts'),
      '@tsuuanmi/system-plugin-host-core': src('./packages/plugin-host-core/src/index.ts'),
      '@tsuuanmi/system-plugin-host': src('./packages/plugins/plugin-host/src/index.ts'),
      '@tsuuanmi/system-feedback-core': src('./packages/feedback-core/src/index.ts'),
      '@tsuuanmi/system-decisions': src('./packages/plugins/decisions/src/index.ts'),
      '@tsuuanmi/system-lead-inbox':src('./packages/plugins/lead-inbox/src/index.ts'),
      '@tsuuanmi/system-notify': src('./packages/plugins/notify/src/index.ts'),
    },
  },
  test: {
    include: ['scripts/**/*.spec.ts', 'packages/**/tests/**/*.spec.ts'],
    // One temporary parent per run, removed at its end (and a killed run's, at the next start).
    globalSetup: ['./scripts/test-tmp.ts'],
    // Browser tests skipped where no browser can run are counted and said at the end, and to a check (T247).
    reporters: ['default', new BrowserSkips()],
    // Setup starts real displays and browsers: on a loaded 4-vCPU CI runner that can pass the
    // 10 s default, which fails a whole suite before any of its tests runs.
    hookTimeout: 60_000,
    // At most 32 files at once (vitest's own default is one per CPU but one). On a 256-CPU host that
    // was 255: every file, its imports served by the one main process, its stores and processes at
    // once, and in-process tests of 1 to 2 s passed their 5 s bound (two copies of the suite: 9
    // failures, none capped, in the same 3.6 minutes). A 4-vCPU runner keeps its 3.
    // An acceptance check (agent-workers, T292) sets SYSTEM_CHECK_MAX_WORKERS: its share of the host's
    // cores, so that the checks the host runs at once, each with that many workers, fit its cores.
    maxWorkers: checkWorkers() ?? Math.max(1, Math.min(32, availableParallelism() - 1)),
    // Longest first by scripts/test-durations.json (`pnpm gen:test-durations`), cache or none.
    sequence: { sequencer: DurationSequencer },
  },
})
