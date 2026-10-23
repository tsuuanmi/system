import { type ArtifactLookup, type BriefClassification, BriefError, type RenderOptions, type StartInput, startPrompt } from '@tsuuanmi/system-libs'
import { ProviderError } from './errors.ts'

/**
 * What a Worker source sends for a start, and the classification its egress check uses: the
 * start's prompt, or its brief rendered with the default text rendering, pointers resolved through
 * `read` (`ctx.artifacts.get`). A start that names neither or both, or a brief that cannot be
 * rendered (a pointer no longer stored), is refused as `invalid_input`: nothing is sent. `options`
 * say how the source renders it (a source that writes the brief's files says so).
 */
export function promptOfStart(request: StartInput, read: ArtifactLookup, options: RenderOptions = {}): { prompt: string; classification: BriefClassification } {
  try {
    return startPrompt(request, read, options)
  } catch (error) {
    if (error instanceof BriefError) throw new ProviderError('invalid_input', error.message, { cause: error })
    throw error
  }
}
