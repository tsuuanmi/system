/**
 * Lessons (docs/design/experiments.md#lessons), pure: which of a lesson's invalidation predicates
 * fired against the current environment, and why a lesson's evidence does not hold. Applicability is
 * computed when a lesson is read and never stored: a lesson applies only while every predicate is
 * checkably unchanged, so one the environment cannot confirm is shown as possibly stale.
 */
import type { ArtifactRef, CurrentEnvironment, ExperimentState, Invalidation, Lesson, Outcome } from './index.ts'

/** Whether one invalidation predicate fired: what it names changed in `current`, or `current` no longer shows it. */
export function fired(predicate: Invalidation, current: CurrentEnvironment): boolean {
  switch (predicate.kind) {
    case 'model-version': {
      const shown = current.workers.filter((w) => w.family === predicate.family)
      return shown.length === 0 || shown.some((w) => w.observed !== predicate.observed)
    }
    case 'objective-version':
      return !current.objectives.some((o) => o.id === predicate.id && o.version === predicate.version)
    case 'suite-version':
      return !current.suites.some((s) => s.id === predicate.id && s.version === predicate.version)
    case 'mechanism':
      return !current.mechanisms.includes(predicate.tag)
    case 'measurement-defect':
      return !current.collectors.some((c) => c.id === predicate.collector && c.version === predicate.version)
    case 'cost-structure':
      return current.costModel !== predicate.costModel
    case 'expiry':
      return Date.parse(current.now) >= Date.parse(predicate.at)
  }
}

/** A lesson's invalidation predicates that fired against `current`, in its order; none means it applies. */
export function firedPredicates(lesson: Pick<Lesson, 'invalidatedBy'>, current: CurrentEnvironment): Invalidation[] {
  return lesson.invalidatedBy.filter((p) => fired(p, current))
}

/** What the evidence check reads of the records: a verdict decision, and a revision of an experiment. */
export interface LessonRecords {
  verdict(ref: ArtifactRef): { outcome: Outcome; experimentId: string; revision: number } | undefined
  experiment(experimentId: string, revision: number): { ref: ArtifactRef; state: ExperimentState; verdict?: ArtifactRef } | undefined
}

/**
 * Why a lesson's evidence does not hold, empty when it does: every verdict it cites is a recorded
 * `verdict` decision whose outcome is the lesson's, about one of the experiments it cites; and every
 * experiment it cites is that revision, closed, with one of those verdicts.
 */
export function lessonEvidenceProblems(lesson: Lesson, records: LessonRecords): string[] {
  const problems: string[] = []
  const cited = new Set(lesson.evidence.experiments.map((e) => `${e.id}@${e.revision}`))
  for (const ref of lesson.evidence.verdicts) {
    const verdict = records.verdict(ref)
    if (!verdict) problems.push(`it cites ${ref}, which is no recorded verdict`)
    else if (verdict.outcome !== lesson.outcome) problems.push(`the verdict ${ref} is ${verdict.outcome}, not the lesson's ${lesson.outcome}`)
    else if (!cited.has(`${verdict.experimentId}@${verdict.revision}`)) problems.push(`the verdict ${ref} is about experiment ${verdict.experimentId} revision ${verdict.revision}, which the lesson does not cite`)
  }
  for (const e of lesson.evidence.experiments) {
    const recorded = records.experiment(e.id, e.revision)
    if (!recorded || recorded.ref !== e.ref) problems.push(`it cites experiment ${e.id} revision ${e.revision} as ${e.ref}, which the registry does not hold`)
    else if (recorded.state !== 'closed' || !recorded.verdict) problems.push(`experiment ${e.id} revision ${e.revision} is ${recorded.state}: a lesson cites closed experiments only`)
    else if (!lesson.evidence.verdicts.includes(recorded.verdict)) problems.push(`it cites experiment ${e.id} revision ${e.revision} but not its verdict ${recorded.verdict}`)
  }
  return problems
}
