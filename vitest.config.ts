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
      '@tsuuanmi/system-leases': src('./packages/plugins/leases/src/index.ts'),
      '@tsuuanmi/system-event-log': src('./packages/plugins/event-log/src/index.ts'),
      '@tsuuanmi/system-blobs': src('./packages/plugins/blobs/src/index.ts'),
      '@tsuuanmi/system-turn-receipts': src('./packages/plugins/turn-receipts/src/index.ts'),
      '@tsuuanmi/system-accounts': src('./packages/plugins/accounts/src/index.ts'),
      '@tsuuanmi/system-display-virtual': src('./packages/plugins/display-virtual/src/index.ts'),
      '@tsuuanmi/system-browser-patchright': src('./packages/plugins/browser-patchright/src/index.ts'),
      '@tsuuanmi/system-ui-ops': src('./packages/ui-ops/src/index.ts'),
      '@tsuuanmi/system-provider-chatgpt-web': src('./packages/plugins/provider-chatgpt-web/src/index.ts'),
      '@tsuuanmi/system-provider-core': src('./packages/provider-core/src/index.ts'),
    },
  },
  test: {
    include: ['scripts/**/*.spec.ts', 'spikes/**/*.spec.ts', 'packages/**/tests/**/*.spec.ts'],
  },
})
