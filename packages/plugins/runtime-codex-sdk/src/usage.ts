/**
 * A Codex run's token counts (docs/design/agent-runtimes.md#metering, T208): the sum of the `usage`
 * each `turn.completed` reports, normalized as the ledger counts tokens (`TokenUsage`).
 *
 * Codex's turn usage holds five counts, two of them parts of another (OpenAI's usage semantics):
 * - `input_tokens`: every input token of the turn, cached ones included → `inputTokens`;
 * - `cached_input_tokens`: the part of `input_tokens` read from the prompt cache → `cacheReadInputTokens`;
 * - `cache_write_input_tokens`: the part of `input_tokens` written to the prompt cache → `cacheCreationInputTokens`;
 * - `output_tokens`: every output token, reasoning included → `outputTokens`;
 * - `reasoning_output_tokens`: the part of `output_tokens` spent reasoning; not added anywhere,
 *   since `output_tokens` already counts it (the ledger's `tokenUsage` has no field of its own for it).
 *
 * No part is ever added to its whole, so nothing is counted twice. A turn whose counts are not counts
 * (missing, negative, fractional) or whose parts exceed their whole is not read: the run then reports
 * no tokens at all, never a sum that leaves that turn out unsaid. Codex reports no charge, so there is
 * no cost here (a Codex subscription is judged by its windows, `rate-limits.ts`).
 * @module
 */
import type { TokenUsage } from '@tsuuanmi/system-agent-runtime-core'

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export class TurnUsage {
  private sum: Required<TokenUsage> = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  private turns = 0
  private unread = false

  /** Adds one completed turn's `usage`, as `turn.completed` reports it. */
  add(usage: unknown): void {
    const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>
    const input = u.input_tokens
    const output = u.output_tokens
    // A Codex that does not report a part reports none of it: 0, never a guess.
    const cached = u.cached_input_tokens ?? 0
    const written = u.cache_write_input_tokens ?? 0
    const reasoning = u.reasoning_output_tokens ?? 0
    if (!count(input) || !count(output) || !count(cached) || !count(written) || !count(reasoning) || cached + written > input || reasoning > output) {
      this.unread = true
      return
    }
    this.turns++
    this.sum = {
      inputTokens: this.sum.inputTokens + input,
      outputTokens: this.sum.outputTokens + output,
      cacheReadInputTokens: this.sum.cacheReadInputTokens + cached,
      cacheCreationInputTokens: this.sum.cacheCreationInputTokens + written,
    }
  }

  /** The completed turns' summed counts; undefined when no turn reported them, or one could not be read. */
  total(): TokenUsage | undefined {
    if (this.unread || this.turns === 0) return undefined
    const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = this.sum
    return { inputTokens, outputTokens, ...(cacheReadInputTokens ? { cacheReadInputTokens } : {}), ...(cacheCreationInputTokens ? { cacheCreationInputTokens } : {}) }
  }
}
