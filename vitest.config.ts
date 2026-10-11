import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/**/*.spec.ts', 'spikes/**/*.spec.ts', 'packages/**/tests/**/*.spec.ts'],
  },
})
