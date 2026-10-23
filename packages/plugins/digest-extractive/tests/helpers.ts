import type { ArtifactRef } from '@tsuuanmi/system-digest-core'
import type { SourcesOf } from '../../../digest-core/conformance/worker.ts'
import type { DigestExtract } from '../src/index.ts'

/** The request's sources as this provider's brief names them: through the one extract it points at. */
export const sourcesOfExtract: SourcesOf = (brief, read) => (read(brief.artifacts[0]!.ref as ArtifactRef)!.body as DigestExtract).sources.map((s) => s.ref)
