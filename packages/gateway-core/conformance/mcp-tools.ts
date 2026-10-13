/**
 * Conformance suite for `ctx.mcp` (plugin rule 7). The provider's test supplies how a client
 * holding a scope's token lists its tools (ADR-0023).
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type {} from '../src/index.ts'

export type ListTools = (ctx: Context, scope: 'operator' | 'client') => Promise<string[]>
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
        expect(await listTools(ctx, 'operator')).toContain('conformance_echo')
        await fiber.dispose()
        expect(await listTools(ctx, 'operator')).not.toContain('conformance_echo')
      } finally {
        await dispose()
      }
    })

    it('serves a tool that declares no scope to the operator only (fail closed), and a client tool to both', async () => {
      const { ctx, dispose } = await boot()
      try {
        const handler = async () => ({ content: [] })
        ctx.mcp.tool('conformance_operator', { description: 'x', inputSchema: {} }, handler)
        ctx.mcp.tool('conformance_client', { description: 'x', inputSchema: {}, scope: 'client' }, handler)
        expect(await listTools(ctx, 'operator')).toEqual(expect.arrayContaining(['conformance_operator', 'conformance_client']))
        const client = await listTools(ctx, 'client')
        expect(client).toContain('conformance_client')
        expect(client).not.toContain('conformance_operator')
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
