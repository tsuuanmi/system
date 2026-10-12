/** Conformance suite for `ctx.mcp` (plugin rule 7). The provider's test supplies how a client lists its tools. */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {} from '../src/index.ts'

export type ListTools = (ctx: Context) => Promise<string[]>
export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

export function mcpToolsConformance(name: string, boot: Boot, listTools: ListTools): void {
  describe(`ctx.mcp conformance: ${name}`, () => {
    it('serves a contributed tool for the contributor\'s lifetime only', async () => {
      const { ctx, dispose } = await boot()
      try {
        const fiber = ctx.inject(['mcp'], (c) => {
          c.mcp.tool('conformance_echo', { description: 'echo', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: String(text) }] }))
        })
        await fiber
        expect(await listTools(ctx)).toContain('conformance_echo')
        await fiber.dispose()
        expect(await listTools(ctx)).not.toContain('conformance_echo')
      } finally {
        await dispose()
      }
    })

    it('refuses a second contribution under the same name', async () => {
      const { ctx, dispose } = await boot()
      try {
        const handler = async () => ({ content: [] })
        ctx.mcp.tool('conformance_once', { description: 'x', inputSchema: {} }, handler)
        expect(() => ctx.mcp.tool('conformance_once', { description: 'x', inputSchema: {} }, handler)).toThrow()
      } finally {
        await dispose()
      }
    })
  })
}
