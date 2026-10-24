// This spike's probe, run by hand (spikes are not part of `pnpm test`):
// pnpm exec vitest run --root spikes/m0-dsh-core
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['*.spec.ts'] } })
