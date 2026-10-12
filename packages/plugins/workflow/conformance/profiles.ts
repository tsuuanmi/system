/**
 * Conformance suite for the `profiles` seam (`ctx.workflow.template`, REQ-WF-9): a profile is a
 * plugin that contributes templates to the engine, and nothing else of the engine. The
 * profile's test supplies a booted engine.
 */
import type { Context, Plugin } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { preflight } from '../src/index.ts'
import type { NodeTemplate } from '../src/index.ts'

export type Boot = () => Promise<{ ctx: Context; dispose: () => Promise<void> }>

export function profileConformance(name: string, boot: Boot, profile: Plugin, templates: Record<string, NodeTemplate[]>): void {
  describe(`profiles conformance: ${name}`, () => {
    it('contributes its templates while loaded, each passing preflight, and withdraws them when unloaded', async () => {
      const { ctx, dispose } = await boot()
      try {
        for (const nodes of Object.values(templates)) expect(() => preflight(nodes)).not.toThrow()
        const before = ctx.workflow.templateNames()
        const fiber = ctx.plugin(profile)
        await fiber
        expect(ctx.workflow.templateNames()).toEqual([...new Set([...before, ...Object.keys(templates)])].sort())
        await fiber.dispose()
        expect(ctx.workflow.templateNames()).toEqual(before)
      } finally {
        await dispose()
      }
    })

    it('names only acceptance contracts that are registered while it is loaded', async () => {
      const { ctx, dispose } = await boot()
      try {
        await ctx.plugin(profile)
        const known = new Set(ctx.workers.contracts())
        for (const [template, nodes] of Object.entries(templates)) {
          for (const node of nodes) expect(known.has(node.acceptance), `${template}/${node.nodeId}: ${node.acceptance}`).toBe(true)
        }
      } finally {
        await dispose()
      }
    })
  })
}
