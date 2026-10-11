import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    // Bare workspace imports resolve to source, never to built lib/ (DSH testing convention).
    alias: {
      '@tsuuanmi/system-libs': src('./packages/libs/src/index.ts'),
      '@tsuuanmi/system-store': src('./packages/plugins/store/src/index.ts'),
      '@tsuuanmi/system-artifacts': src('./packages/plugins/artifacts/src/index.ts'),
      '@tsuuanmi/system-credentials-vault': src('./packages/plugins/credentials-vault/src/index.ts'),
      '@tsuuanmi/system-mcp-server': src('./packages/plugins/mcp-server/src/index.ts'),
    },
  },
  test: {
    include: ['scripts/**/*.spec.ts', 'spikes/**/*.spec.ts', 'packages/**/tests/**/*.spec.ts'],
  },
})
