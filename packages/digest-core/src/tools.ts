/**
 * The `digests_*` MCP tools (docs/design/digests.md), client scope, which every provider of
 * `ctx.digests` serves the same way: a lead asks for a digest of raw artifacts and reads it as it
 * settles. Each call's input and structured output are validated against
 * `schemas/mcp-digests.v1.json` `$defs/<tool>-input` and `-output`; a refused input does nothing,
 * and `digests_request` checks the output it would give through the request's `check` (contract
 * 1.2), before the request is recorded, so an output its schema refuses (a defect) records nothing.
 * The tools belong to the seam, not to a provider, so replacing the provider keeps them.
 */
import type { Context } from '@deepseek-ai/cordis'
import { outline, reply, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { z as zod } from 'zod'
import { type ArtifactRef, DigestError, type Digests, type DigestView } from './index.ts'

export const DIGEST_TOOLS = ['digests_request', 'digests_get'] as const
export type DigestTool = typeof DIGEST_TOOLS[number]

const schemas = new SchemaRegistry()
/** The `$defs` name of a tool's input or output: underscores written as hyphens. */
const defOf = (tool: DigestTool, part: 'input' | 'output'): string => `${tool.replaceAll('_', '-')}-${part}`
const refused = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

const artifactRef = () => zod.string().regex(/^sha256:[0-9a-f]{64}$/)
const waitSeconds = () => zod.number().int().min(0).max(55).optional().describe('Seconds to wait for the request to settle (default 0)')

/** Input shapes, matching `$defs/<tool>-input`. */
export const DIGEST_TOOL_INPUTS: Record<DigestTool, ToolSpec['inputSchema']> = {
  digests_request: {
    sources: zod.array(artifactRef()).min(1).max(64).describe('The raw artifacts to digest, by content id (1 to 64, each once)'),
    clientRequestId: zod.string().min(1).max(200).optional().describe('Retry-safe request key'),
    waitSeconds: waitSeconds(),
  },
  digests_get: {
    requestId: zod.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/).describe('The digest request, as digests_request returned it'),
    waitSeconds: waitSeconds(),
  },
}

const DESCRIPTIONS: Record<DigestTool, string> = {
  digests_request: 'Ask for a cited digest (digest@1.0) of raw artifacts: a read-only Worker on the economy tier summarizes them (once more on the standard tier when every claim fails the check); a claim is kept only if its quote is verbatim in the artifact it cites. It settles written, not-written (no claim survived), or bypassed (no Worker could serve it: a digest never blocks work). Read the digest with the artifact tool.',
  digests_get: 'Read a digest request as it stands: pending, written (with its digest), not-written, or bypassed, with why.',
}

/** Checks the output a call would give: `digests_request` runs it before its request is recorded. */
type OutputCheck = (output: DigestView) => void
type Handler = (args: Record<string, unknown>, check: OutputCheck) => Promise<DigestView>

/** The output a call would give, refused by its schema before its request was recorded. */
class RefusedOutput extends Error {}

/** The tools' behavior, over any provider; exported so tests call it as a client would. */
export function digestToolHandlers(digests: Digests): Record<DigestTool, Handler> {
  const settled = async (view: DigestView, args: Record<string, unknown>): Promise<DigestView> =>
    (typeof args.waitSeconds === 'number' && args.waitSeconds > 0 ? digests.wait(view.requestId, args.waitSeconds * 1000) : view)
  return {
    digests_request: async (args, check) => settled(await digests.request({ sources: args.sources as ArtifactRef[], ...(typeof args.clientRequestId === 'string' ? { key: args.clientRequestId } : {}), check }), args),
    digests_get: async (args) => {
      const view = await digests.get(String(args.requestId))
      if (!view) throw new DigestError('unknown-request', `no digest request ${String(args.requestId)}`)
      return settled(view, args)
    },
  }
}

/**
 * Wrap a handler: validate the input first; give it the check of its output, which
 * `digests_request` runs before its request is recorded; validate the structured output once more
 * last (all a read needs, and the request as it stands after a wait); and report a refusal as an MCP
 * error.
 */
export function digestTool(name: DigestTool, handler: Handler): ToolHandler {
  return async (args) => {
    try {
      schemas.assertDef('mcp-digests@1.0', defOf(name, 'input'), args)
    } catch (error) {
      return refused(`invalid input, nothing done: ${(error as Error).message}`)
    }
    const check: OutputCheck = (output) => {
      try {
        schemas.assertDef('mcp-digests@1.0', defOf(name, 'output'), output)
      } catch (error) {
        throw new RefusedOutput((error as Error).message)
      }
    }
    let output: DigestView
    try {
      output = await handler(args, check)
    } catch (error) {
      if (error instanceof RefusedOutput) return refused(`digests: ${name} would make an output its schema refuses (a defect), so nothing changed: ${error.message}`)
      return refused(error instanceof DigestError ? `${error.failure}: ${error.message}` : `digests: ${(error as Error).message}`)
    }
    try {
      schemas.assertDef('mcp-digests@1.0', defOf(name, 'output'), output)
    } catch (error) {
      return refused(`digests: ${name} made an output its schema refuses (a defect${name === 'digests_request' ? '; the request was recorded before it was waited on' : ''}): ${(error as Error).message}`)
    }
    return reply(output, outline(output))
  }
}

/** Contribute the tools to `ctx.mcp` for the provider's lifetime: a provider calls it from `ctx.inject(['mcp'], …)`. */
export function registerDigestTools(ctx: Context, digests: Digests): void {
  const behavior = digestToolHandlers(digests)
  for (const name of DIGEST_TOOLS) ctx.mcp.tool(name, { scope: 'client', description: DESCRIPTIONS[name], inputSchema: DIGEST_TOOL_INPUTS[name] }, digestTool(name, behavior[name]))
}
