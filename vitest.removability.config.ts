import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// The removability matrix: the bundle booted once per optional row with that row off, in this process
// on the packages' source (no build). Slow by design (one boot per row), so it is not part of `pnpm test`.
export default defineConfig({
  resolve: base.resolve,
  test: { include: ['packages/**/tests/removability/*.removability.ts'], testTimeout: 180_000, hookTimeout: 120_000, fileParallelism: false, globalSetup: ['./scripts/test-tmp.ts'] },
})
