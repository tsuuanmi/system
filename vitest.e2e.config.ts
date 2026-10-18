import { defineConfig } from 'vitest/config'

// End-to-end lane: runs built artifacts through the real dsh launcher (needs `pnpm build`).
export default defineConfig({
  test: { include: ['packages/**/tests/**/*.e2e.ts'], testTimeout: 120_000, hookTimeout: 180_000, fileParallelism: false, globalSetup: ['./scripts/test-tmp.ts'] },
})
