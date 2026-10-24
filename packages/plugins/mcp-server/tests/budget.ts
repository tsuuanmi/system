/**
 * The token budget of the MCP surface (QA-12, INV-9; README "Token budget"): every MCP client pays
 * for `tools/list` once per session, and for every reply it reads. The tests that measure them
 * (packages/cli/tests/surface.e2e.ts on the shipped profile, packages/plugins/workflow/tests/replies.spec.ts
 * on fixtures) fail when one exceeds its ceiling here.
 *
 * Sizes are the bytes of the JSON-RPC response as the server sends it (compact JSON, UTF-8), and
 * tokens are estimated as ceil(bytes / 4), a common rule of thumb for English text and JSON; a
 * client's own tokenizer differs by some tens of percent, so the bytes are what is bounded.
 *
 * Each ceiling is the size measured when it was set plus about 10 %, rounded up. Raising one is a
 * deliberate, reviewed change: say in the change what grew and why it is worth every session's
 * tokens, update the measured size beside the ceiling, and keep the 10 % headroom; never raise a
 * ceiling just to make a test pass. When a change shrinks the surface, lower the ceiling with it.
 */

/** The tokens a client is estimated to pay for `bytes` of JSON (ceil(bytes / 4)). */
export const tokens = (bytes: number): number => Math.ceil(bytes / 4)

/** The UTF-8 size of a value as compact JSON, as it goes on the wire. */
export const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')

export const BUDGET = {
  /**
   * `tools/list` per scope, as the shipped profile serves it (the default composition). The
   * `operator` sees every tool; `client` is the lead's token (`system mcp-headers`, `system
   * mcp-stdio`). A Worker holds at most the `model` token, which `/mcp` refuses: it lists nothing.
   */
  toolsList: {
    operator: { measured: 51_105, ceiling: 55_500 },
    client: { measured: 31_685, ceiling: 34_100 },
  },
  /** One tool's entry in `tools/list` (name, description, schemas, `_meta`): the largest tool's ceiling. */
  tool: { measured: 4_896, ceiling: 5_400 },
  /** Canonical replies (the whole JSON-RPC response of a `tools/call`). */
  replies: {
    /** `status` on a fresh shipped profile, as the operator (with every plugin) and as the lead. */
    statusOperator: { measured: 30_628, ceiling: 33_700 },
    statusClient: { measured: 1_634, ceiling: 1_800 },
    /** `result` of a failed run on the shipped profile (an `ask` with no account: reauth_required). */
    resultFailed: { measured: 2_092, ceiling: 2_400 },
    /** `usage` on the shipped profile holding that one run. */
    usageOneRun: { measured: 2_116, ceiling: 2_400 },
    /** On the workflow's fixtures: `result` of a completed ask (a 1,000-byte answer) and of a research run (six steps, a 4,000-byte answer). */
    resultAsk: { measured: 2_817, ceiling: 3_100 },
    resultResearch: { measured: 10_780, ceiling: 11_900 },
    /** `usage` over those three runs (research, ask, a failed ask). */
    usageThreeRuns: { measured: 18_504, ceiling: 20_400 },
  },
} as const
