import { defineConfig } from 'vitest/config'
import base from './vitest.config.ts'

// The crash-injection suite: slow by design (each case waits out the killed process's leases).
export default defineConfig({ resolve: base.resolve, test: { include: ['packages/**/tests/crash/*.crash.ts'], fileParallelism: false } })
