import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// The crash-injection suite: slow by design (each case waits out the killed process's leases: 30 s
// as the harnesses cap them, 60 s for the budget cases, packages/system-bundle/tests/crash/leases.mjs).
export default defineConfig({ resolve: base.resolve, test: { include: ['packages/**/tests/crash/*.crash.ts'], fileParallelism: false, globalSetup: ['./scripts/test-tmp.ts'] } })
