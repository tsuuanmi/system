/**
 * `landing-local`: the landing seam's local provider (`ctx.landing`; PROP-0017 L0). It wraps today's
 * local landing unchanged (ADR-0060): the source that holds a run's worktree (`workers.land`, the
 * `agents` source) merges the run's branch into the repository's checked-out branch, in the operator's
 * checkout, on the operator's `merge` approval, at exact SHAs. Never a force, a reset, or a push.
 *
 * - `prepare` binds the merge to the base branch's head and the branch's head
 *   (`landing:merge:<base>:<head>`), the subject the approval request names.
 * - `land` merges only on an approval of that exact subject, through the merge step of `workers.land`,
 *   which refuses a moved head or base, a dirty checkout, or a conflict, changing nothing, and finds a
 *   merge done before a restart (`already`) instead of merging twice (INV-4).
 * - `status` cannot read where a landing stands without acting: the merge step reads it, and does
 *   nothing again when it is done. It answers `unknown`, so the engine relies on `land`.
 *
 * {@link LocalLanding} provides the seam over `ctx.workers` (the bundle's `landing-local` row);
 * {@link localLanding} is the same provider as a plain call over a given workers seam. The workflow
 * engine depends on the seam's definition only, never on this package.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  Landing, type Landed, type LandingProvider, type LandingRefusal, type LandingRefusalCause, type LandingStatus, type LandingTarget, type LandRequest,
  type Prepared, sameSubject, SUBJECT_VERSION_MAX,
} from '@tsuuanmi/system-landing-core'
import type { LandStep, Workers } from '@tsuuanmi/system-workers-core'

/** The local provider's id. */
export const LOCAL = 'local'

/** The landing version a local `merge` request binds to: the base branch's head and the run branch's head (ADR-0060). */
export const landingVersion = (base: string, head: string): string => `landing:merge:${base}:${head}`

const refusal = (cause: LandingRefusalCause, reason: string): LandingRefusal => ({ outcome: 'refused', provider: LOCAL, cause, reason })

/** The local provider over the workers seam `workers()` gives when called. */
export function localLanding(workers: () => Pick<Workers, 'land'> | undefined): LandingProvider {
  const prepare = async (t: LandingTarget): Promise<Prepared | LandingRefusal> => {
    const version = landingVersion(t.base.sha, t.head)
    if (version.length > SUBJECT_VERSION_MAX) return refusal('failed', `a landing version of this repository's object ids is longer than a request's subject holds (${version.length} > ${SUBJECT_VERSION_MAX}): merge ${t.branch} by hand`)
    return {
      outcome: 'prepared', provider: LOCAL, subject: { type: 'git-head', ref: t.branch, version },
      consequences: [
        `Approved: system merges ${t.branch} (at ${t.head}) into ${t.base.branch} (at ${t.base.sha}) in ${t.repository}, as one merge commit. Never a force or a push; a conflict or a moved branch changes nothing.`,
        `Denied or unanswered: nothing is merged; ${t.branch} keeps the commit.`,
      ],
    }
  }
  return {
    id: LOCAL,
    prepare,
    async land(r: LandRequest): Promise<Landed | LandingRefusal> {
      const prepared = await prepare(r)
      if (prepared.outcome === 'refused') return prepared
      if (!sameSubject(prepared.subject, r.subject)) return refusal('unbound', `the approval is of ${r.subject.ref} at ${r.subject.version}, not of ${prepared.subject.ref} at ${prepared.subject.version}: nothing is merged`)
      const seam = workers()
      const land = seam?.land
      if (!seam || typeof land !== 'function') return refusal('failed', 'the workers seam cannot land a result (no land)')
      const landed = await land.call(seam, { step: 'merge', runId: r.runId, workspace: r.workspace, head: r.head, base: r.base, message: r.message } satisfies LandStep)
      if (!landed) return refusal('gone', `no Worker source holds the worktree of run ${r.runId} any more`)
      if (landed.outcome === 'refused') return refusal(landed.cause, landed.reason)
      if (landed.outcome !== 'merged') return refusal('failed', `source ${landed.source} answered ${landed.outcome} to a merge`)
      return { outcome: 'landed', provider: LOCAL, commit: landed.commit, already: landed.already, source: landed.source, ...(landed.regenerated ? { regenerated: landed.regenerated } : {}) }
    },
    async status(): Promise<LandingStatus> {
      return { state: 'unknown', provider: LOCAL, reason: 'a local landing is read by its merge step, which finds a merge done before and changes nothing (ADR-0060): land it again to know' }
    },
  }
}

/** `ctx.landing` over `ctx.workers`: today's local landing (ADR-0060), unchanged. */
export class LocalLanding extends Landing {
  static inject = ['workers']
  readonly id = LOCAL
  private readonly local: LandingProvider

  constructor(ctx: Context) {
    super(ctx)
    this.local = localLanding(() => ctx.workers)
  }

  prepare(target: LandingTarget): Promise<Prepared | LandingRefusal> {
    return this.local.prepare(target)
  }

  land(request: LandRequest): Promise<Landed | LandingRefusal> {
    return this.local.land(request)
  }

  status(target: LandingTarget): Promise<LandingStatus> {
    return this.local.status(target)
  }
}

export default LocalLanding
