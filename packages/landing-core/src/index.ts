/**
 * The landing seam (`ctx.landing`; PROP-0017 L0, ADR-0037): what happens to an accepted result
 * **after its commit**: it is put on its target, on the operator's approval of exactly that head, and
 * the landed commit, or a typed refusal, is reported.
 *
 * The commit, and a target that moved (ADR-0068: rebase, a conflict resolved by the result's author,
 * the required checks run again), are the same whichever provider lands, so they stay with the
 * workflow engine over `workers.land`, the one writer of the worktree (INV-15). The seam starts where
 * the providers differ (PROP-0017, "One landing seam, two providers"):
 * - `prepare`: what would land, and the subject an approval binds it to;
 * - `land`: on an approval of that exact subject, put it on the target;
 * - `status`: where a landing stands, for a restart (INV-4).
 *
 * Providers: `landing-local` (today's local merge in the repository's checkout, ADR-0060) and,
 * later, a GitHub provider (PROP-0017 G2). A guarantee seam (core: gate): an irreversible action goes
 * to a person, so nothing lands without an approval bound to the exact head and target, and every
 * refusal changes nothing (INV-2, INV-5). Every provider, a fake included, passes
 * `conformance/landing.ts`.
 */
import { type Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    landing: Landing
  }
}

/** The contract this definition and its suite are at (`conformance/landing.ts`). */
export const LANDING_CONTRACT = '1.0'

/** The longest subject version an approval request holds (`approval-request@1`'s `subject.version`). */
export const SUBJECT_VERSION_MAX = 128

/**
 * An accepted result ready to land: committed on its run's branch (`branch` at `head`), in
 * `repository`, to land on `base.branch`, which was at `base.sha` when it was read. `workspace` and
 * `runId` name the run's worktree, through which the local provider reaches the source that holds it.
 */
export interface LandingTarget {
  runId: string
  workspace: string
  repository: string
  branch: string
  head: string
  base: { branch: string; sha: string }
}

/** The subject an approval of a landing binds: the run's branch, at a version naming the exact head and target. */
export interface LandingSubject {
  type: 'git-head'
  ref: string
  version: string
}

/** Why a landing changed nothing. Everything stays as it was. */
export type LandingRefusalCause =
  /** The request's subject is not the one `prepare` gives for its target: an approval of another head or target. */
  | 'unbound'
  /** The target branch is not where the approval saw it. */
  | 'base-moved'
  /** The run's branch is not at the approved head. */
  | 'head-moved'
  /** The target's working tree has uncommitted changes (a local checkout). */
  | 'dirty'
  /** The head conflicts with the target. */
  | 'conflict'
  /** Someone else is changing the run's worktree or repository now: asked again later. */
  | 'busy'
  /** Nothing holds the run's worktree or branch any more. */
  | 'gone'
  /** The tree moved after its acceptance. */
  | 'moved'
  /** Anything else: the provider could not, and changed nothing. */
  | 'failed'

export const LANDING_REFUSAL_CAUSES: readonly LandingRefusalCause[] = ['unbound', 'base-moved', 'head-moved', 'dirty', 'conflict', 'busy', 'gone', 'moved', 'failed']

/** A landing step that changed nothing, and why. */
export interface LandingRefusal {
  outcome: 'refused'
  provider: string
  cause: LandingRefusalCause
  reason: string
}

/**
 * What would land: the subject an approval binds (`prepare` gives the same one for the same target,
 * and another for any other head or target), and what the provider does on an approval and on a
 * denial, in words for the request's consequences.
 */
export interface Prepared {
  outcome: 'prepared'
  provider: string
  subject: LandingSubject
  consequences: string[]
}

/** Files the repository declares generated, made again by its commands while landing (T166). */
export interface LandingRegenerated {
  files: string[]
  commands: string[]
  /** The autonomy decisions the commands ran on. */
  autonomy: string[]
}

/**
 * The result landed: `commit` is the target's head that holds it (`already` when the target held it
 * before this call, such as after a restart: never landed twice); `source`, when the provider landed
 * through a Worker source, names it; `regenerated` when generated files were made again.
 */
export interface Landed {
  outcome: 'landed'
  provider: string
  commit: string
  already: boolean
  source?: string
  regenerated?: LandingRegenerated
}

/** A land call: the target, the subject the approval was given on, the approval's decision, and the merge commit's message. */
export interface LandRequest extends LandingTarget {
  subject: LandingSubject
  /** The `approval` decision the operator's answer recorded (INV-13). */
  approval: string
  message: string
}

/**
 * Where a landing stands: `landed` at `commit`; `open`, not landed (yet); or `unknown`, with why,
 * when the provider cannot read it without acting. A consumer that reads `unknown` relies on `land`
 * finding its own work done (INV-4).
 */
export type LandingStatus =
  | { state: 'landed'; provider: string; commit: string }
  | { state: 'open'; provider: string }
  | { state: 'unknown'; provider: string; reason: string }

/** The calls every landing provider answers. */
export interface LandingProvider {
  /** The provider's id (`local`, a fake's own). */
  readonly id: string
  /** What would land, and the subject an approval binds it to; changes nothing. */
  prepare(target: LandingTarget): Promise<Prepared | LandingRefusal>
  /**
   * Land `request` on its target, only while its subject is the one `prepare` gives for it, its
   * branch at `head`, and its target at `base.sha` (or already holding `head`: then `already`, and
   * nothing is done again). A refusal changes nothing.
   */
  land(request: LandRequest): Promise<Landed | LandingRefusal>
  /** Where a landing of `target` stands; changes nothing. */
  status(target: LandingTarget): Promise<LandingStatus>
}

/**
 * The seam: `ctx.landing`. While a plugin provides it, the workflow engine lands every accepted
 * result through it; with none, a landing waits, asking and merging nothing (INV-2).
 */
export abstract class Landing extends Service implements LandingProvider {
  constructor(ctx: Context) {
    super(ctx, 'landing')
  }

  abstract readonly id: string
  abstract prepare(target: LandingTarget): Promise<Prepared | LandingRefusal>
  abstract land(request: LandRequest): Promise<Landed | LandingRefusal>
  abstract status(target: LandingTarget): Promise<LandingStatus>
}

/** Whether two subjects are the same one. */
export const sameSubject = (a: LandingSubject, b: { type: string; ref: string; version?: string }): boolean => a.type === b.type && a.ref === b.ref && a.version === b.version
