/**
 * Experiment registry seam definition: `ctx.experiments` (docs/design/experiments.md), a guarantee
 * seam of the work state machine (ADR-0036, ADR-0045). The registry records hypotheses and
 * experiments, answers every registration EXACT_REPEAT, RELATED, CONTEXT_CHANGED, or NOVEL from the
 * exact identity and the structured fingerprint, pre-registers or refuses it with a `registration`
 * decision, holds each experiment's state while the evaluation engine runs it, and keeps lessons,
 * whose applicability is computed when they are read. The types mirror `hypothesis@1.0`,
 * `experiment@1.0`, `lesson@1.0`, and `objective-contract@1.0`; the schemas in `schemas/` are
 * canonical. The keys, the answer, and the checks every provider applies are pure functions here.
 * @module @tsuuanmi/system-experiments-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    experiments: Experiments
  }
}

/** The contract version of this seam; its conformance suite names the same. */
export const EXPERIMENTS_CONTRACT = '1.0' as const

/** A content id (`sha256:<hex>`): an artifact, or a hash of canonical JSON that names none. */
export type ArtifactRef = `sha256:${string}`
export type Classification = 'public' | 'operator-shared' | 'local-private'
export type Unit = 'tokens' | 'usd' | 'turns' | 'runs' | 'minutes'
export interface BudgetLine { pool: string; unit: Unit; amount: number }
/** An exact subject (INV-5): always with its version. */
export interface ExactSubject { type: 'content' | 'git-head' | 'pull-request' | 'artifact' | 'external'; ref: string; version: string }

export type Direction = 'increase' | 'decrease'
export type EvidencePartition = 'regression' | 'held-out'
export type Partition = 'development' | EvidencePartition
export type MethodKind = 'sign-flip' | 'bootstrap' | 'bayesian'
export interface Method { metric: string; kind: MethodKind; resamples?: number; prior?: Record<string, number | string> }
/** `objective-contract@1.0#/$defs/protocol`, also an experiment's. */
export interface Protocol { confidence: number; minCases: number; repetitions: number; partitions: EvidencePartition[]; methods: Method[] }
export interface MetricDef {
  id: string
  unit: string
  source: 'collector' | 'ledger' | 'ratio'
  collector?: string
  ledgerUnit?: Unit
  numerator?: string
  denominator?: string
  description?: string
}
export interface Guardrail { metric: string; direction: Direction; nonInferiorityMargin?: number; floor?: number }

/** `objective-contract@1.0`: the body of a `criteria` artifact the operator approved. */
export interface ObjectiveContract {
  schema: 'objective-contract@1.0'
  contractId: string
  version: number
  application: { kind: 'project' | 'workflow-profile'; ref: string }
  metrics: MetricDef[]
  hardConstraints: Array<{ id: string; statement: string; validator: string }>
  primary: { metric: string; direction: Direction; minimumPracticalEffect: number }
  guardrails: Guardrail[]
  cost: { metrics: string[]; unit: string; ceiling: number }
  comparison: 'constrained-dominance'
  protocol: Protocol
  note?: string
}

export type TargetKind = 'template' | 'plugin' | 'seam-provider' | 'configuration'
/** `hypothesis@1.0#/$defs/fingerprint`, version 1. */
export interface Fingerprint { version: '1'; target: string; mechanism: string; intervention: string; effect: string; hash: ArtifactRef }

/** `hypothesis@1.0`: the body of a `criteria` artifact. */
export interface Hypothesis {
  schema: 'hypothesis@1.0'
  hypothesisId: string
  statement: string
  target: { kind: TargetKind; ref: string; version: string }
  mechanism: { tag: string; text: string }
  intervention: { tag: string; text: string }
  expectedEffect: { metric: string; direction: Direction | 'non-inferior'; magnitude?: number }
  context: { workload?: string; text: string }
  priorEvidence: { experiments: string[]; lessons: ArtifactRef[]; research: ArtifactRef[] }
  source: { kind: 'research' | 'brainstorm' | 'retrospective' | 'operator'; ref?: ArtifactRef }
  fingerprint: Fingerprint
}

export type Arm = 'baseline' | 'candidate'
export interface EnvironmentWorker { arm: Arm; worker: string; family: string; descriptor?: ArtifactRef; observed?: string }
/** `experiment@1.0#/$defs/environment`: what an evaluation pins. */
export interface Environment {
  hash: ArtifactRef
  composition: ArtifactRef
  plugins: Array<{ name: string; version: string; manifestDigest?: ArtifactRef }>
  workers: EnvironmentWorker[]
  templates: Array<{ name: string; specHash: ArtifactRef }>
  collectors: Array<{ id: string; version: string }>
  statistics: { library: string; version: string }
  workload?: string
  costModel?: string
}

export type RegistryAnswer = 'EXACT_REPEAT' | 'RELATED' | 'CONTEXT_CHANGED' | 'NOVEL'
export const REGISTRY_ANSWERS: readonly RegistryAnswer[] = ['EXACT_REPEAT', 'RELATED', 'CONTEXT_CHANGED', 'NOVEL']

/** A retry predicate: what may have changed since an earlier experiment, checked against the records. */
export type Predicate = 'model-version' | 'workload' | 'objective-version' | 'suite-version' | 'mechanism' | 'measurement-defect' | 'cost-structure'
export const PREDICATES: readonly Predicate[] = ['model-version', 'workload', 'objective-version', 'suite-version', 'mechanism', 'measurement-defect', 'cost-structure']

/** `experiment@1.0`: the body of a `plan` artifact, written by the registry. */
export interface Experiment {
  schema: 'experiment@1.0'
  experimentId: string
  revision: number
  supersedes?: ArtifactRef
  hypothesis: { id: string; ref: ArtifactRef }
  objectiveContract: { id: string; version: number; hash: ArtifactRef; ref: ArtifactRef }
  comparison: { type: 'superiority' } | { type: 'non-inferiority'; margin: number }
  baseline: { subject: ExactSubject; label?: string }
  candidate: { subject: ExactSubject; label?: string; provenance: { runs: string[] } }
  suite: { id: string; version: number; partitions: Array<{ name: Partition; hash: ArtifactRef; cases: number }>; used: EvidencePartition[] }
  environment: Environment
  protocol: Protocol
  stopping: { rule: 'fixed-horizon'; trials: number }
  budget: { projectId: string; milestone: string; funding: ArtifactRef; lines: BudgetLine[]; perTrial: BudgetLine[] }
  seed: string
  independence: { maker: string; reviewers: string[]; validators: string[] }
  registry: { answer: RegistryAnswer; cites: Array<{ experimentId: string; revision: number; ref: ArtifactRef }>; changed: Predicate[]; why?: string }
  identity: { version: '1'; hash: ArtifactRef }
  note?: string
}

export type Outcome = 'supported' | 'refuted' | 'inconclusive' | 'invalid'
export const OUTCOMES: readonly Outcome[] = ['supported', 'refuted', 'inconclusive', 'invalid']

export type Invalidation =
  | { kind: 'model-version'; family: string; observed: string }
  | { kind: 'objective-version' | 'suite-version'; id: string; version: number }
  | { kind: 'mechanism'; tag: string }
  | { kind: 'measurement-defect'; collector: string; version: string }
  | { kind: 'cost-structure'; costModel: string }
  | { kind: 'expiry'; at: string }

/** `lesson@1.0`: the body of a `finding` artifact. */
export interface Lesson {
  schema: 'lesson@1.0'
  lessonId: string
  claim: string
  outcome: Outcome
  evidence: { verdicts: ArtifactRef[]; experiments: Array<{ id: string; revision: number; ref: ArtifactRef }> }
  applicability: {
    workload?: string
    families: Array<{ family: string; observed?: string }>
    environment: ArtifactRef
    objective: { id: string; version: number }
    suite: { id: string; version: number }
    date: string
    confidence: 'low' | 'medium' | 'high'
  }
  invalidatedBy: Invalidation[]
  supersedes?: ArtifactRef
}

/** A term of the registry's vocabulary, with the words it also accepts for it. */
export interface VocabularyTerm { tag: string; aliases?: string[] }
/** The controlled vocabulary fingerprints are normalized from: operator configuration, never a model's. */
export interface Vocabulary { mechanisms: VocabularyTerm[]; interventions: VocabularyTerm[] }

/** A hypothesis as its author gives it: the registry computes its fingerprint. */
export type HypothesisDraft = Omit<Hypothesis, 'schema' | 'fingerprint'>
/**
 * An experiment as its author gives it: the registry fills in the hypothesis it records, the
 * revision it supersedes, its answer, the environment's hash, and the identity.
 */
export type ExperimentDraft = Omit<Experiment, 'schema' | 'hypothesis' | 'supersedes' | 'registry' | 'identity' | 'environment'> & {
  environment: Omit<Environment, 'hash'>
}

/** Who registers: the controller (a workflow node), the lead (a client), or the operator. */
export interface Producer { type: 'node' | 'system' | 'operator'; ref: string }

/** One registration: a hypothesis and the experiment that tests it, with what it cites and names as changed. */
export interface Registration {
  hypothesis: HypothesisDraft
  experiment: ExperimentDraft
  /** Recorded experiments it cites, by id (their latest counted revision). */
  cites?: string[]
  /** The retry predicates it names as changed since the experiments it cites. */
  changed?: Predicate[]
  /** Why the earlier evidence may no longer apply. */
  why?: string
  producer: Producer
  /** The records' classification; never below their inputs'. Default `operator-shared`. */
  classification?: Classification
}

/**
 * An experiment's state. `proposed` exists only inside `register`: the records and the
 * registration decision commit together. `refused` and `superseded` are terminal for that
 * revision; `closed` is terminal once its verdict is recorded.
 */
export type ExperimentState = 'refused' | 'preregistered' | 'running' | 'evaluated' | 'closed' | 'superseded'
/** The states whose experiments count for the registry's answers: those that were pre-registered and not replaced. */
export const COUNTED: readonly ExperimentState[] = ['preregistered', 'running', 'evaluated', 'closed']

/** How a recorded experiment relates to a registration. */
export type Relation = 'exact' | 'equal-fingerprint' | 'shared' | 'linked'
export interface Match {
  experimentId: string
  revision: number
  ref: ArtifactRef
  relation: Relation
  /** The retry predicates that changed between it and the registration, in the records. */
  changed: Predicate[]
  state?: ExperimentState
  /** Its verdict, once closed. */
  verdict?: ArtifactRef
  outcome?: Outcome
  /** The lessons that cite it. */
  lessons?: ArtifactRef[]
}

/** A manual link between two recorded experiments, by the lead or the operator: a registration related to one is related to the other. */
export interface Link { a: string; b: string; by: 'lead' | 'operator'; note: string; at: string }

/** One revision of one experiment, as the registry holds it. */
export interface ExperimentEntry {
  experimentId: string
  revision: number
  state: ExperimentState
  /** The `experiment@1.0` artifact. */
  experiment: ArtifactRef
  hypothesis: ArtifactRef
  identity: ArtifactRef
  fingerprint: ArtifactRef
  answer: RegistryAnswer
  /** The `registration` decision that pre-registered or refused it. */
  registration: ArtifactRef
  /** What the registry found when it answered: for a refused exact repeat, the earlier experiment with its verdict and lessons. */
  matches: Match[]
  /** The evaluation that holds it, from `running` on. */
  evaluationId?: string
  evaluation?: ArtifactRef
  verdict?: ArtifactRef
  outcome?: Outcome
  /** For a superseded revision: the revision that replaced it. */
  supersededBy?: number
  createdAt: string
  updatedAt: string
}

/** What the registry would answer now, recording nothing. */
export interface Lookup {
  answer: RegistryAnswer
  identity: ArtifactRef
  fingerprint: Fingerprint
  matches: Match[]
  /** What `register` would do now, and why. */
  outcome: 'preregistered' | 'refused'
  reasons: string[]
}

/** The environment a lesson is read against: what is in use now. */
export interface CurrentEnvironment {
  workers: Array<{ family: string; observed?: string }>
  objectives: Array<{ id: string; version: number }>
  suites: Array<{ id: string; version: number }>
  collectors: Array<{ id: string; version: string }>
  mechanisms: string[]
  costModel?: string
  now: string
}

/** A lesson as it is read: whether it applies now, and which of its predicates fired. */
export interface LessonView { ref: ArtifactRef; lesson: Lesson; fired: Invalidation[] }

/** Why an experiments call was refused. Nothing changed. */
export type ExperimentsFailure = 'invalid' | 'unknown-experiment' | 'invalid-transition' | 'unavailable'
export class ExperimentsError extends Error {
  constructor(readonly failure: ExperimentsFailure, message: string) {
    super(message)
    this.name = 'ExperimentsError'
  }
}

export abstract class Experiments extends Service {
  constructor(ctx: Context) {
    super(ctx, 'experiments')
  }

  /** What `register` would answer now, with the matches it found; records nothing. Throws `invalid` as `register` does. */
  abstract lookup(registration: Registration): Promise<Lookup>

  /**
   * Record the hypothesis and the experiment, answer the registration, and pre-register it or
   * refuse it, recorded first as a `registration` decision (INV-13), all in one transaction. An
   * invalid registration records nothing (`invalid`). A registration of a revision already
   * recorded with the same content returns that entry; with other content it is `invalid`. A
   * revision above 1 supersedes the previous one, which must be `preregistered`; if it is refused,
   * the previous one stays as it was. `at` is a test seam, as in every method here.
   */
  abstract register(registration: Registration, at?: Date): Promise<ExperimentEntry>

  /** One experiment as it stands: its live revision (pre-registered or later, not superseded), else its latest; or the revision named. */
  abstract get(experimentId: string, revision?: number): Promise<ExperimentEntry | undefined>

  /** Experiments, newest first: every revision, refused and superseded ones included (default 100, at most 1000). */
  abstract list(filter?: { states?: ExperimentState[]; target?: string; limit?: number }): Promise<ExperimentEntry[]>

  /** Link two recorded experiments by hand (the lead or the operator): later registrations related to one are related to both. Idempotent. */
  abstract link(link: Omit<Link, 'at'>, at?: Date): Promise<Link>

  /**
   * The evaluation engine's moves, fenced by the evaluation that holds the experiment (one writer,
   * INV-15): `begin` takes a `preregistered` experiment to `running` for `evaluationId`; `settle`
   * takes it to `evaluated` with the evaluation's record; `close` takes it to `closed` with its
   * `verdict` decision. Another state, or another evaluation, is `invalid-transition`.
   */
  abstract begin(experimentId: string, evaluationId: string, at?: Date): Promise<ExperimentEntry>
  abstract settle(experimentId: string, evaluated: { evaluationId: string; evaluation: ArtifactRef }, at?: Date): Promise<ExperimentEntry>
  abstract close(experimentId: string, closed: { evaluationId: string; verdict: ArtifactRef }, at?: Date): Promise<ExperimentEntry>

  /**
   * Record a lesson, refused (`invalid`) unless every verdict it cites is a recorded `verdict`
   * decision with the lesson's outcome, and every experiment it cites is closed with one of those
   * verdicts.
   */
  abstract recordLesson(lesson: Lesson, producer: Producer, at?: Date): Promise<{ ref: ArtifactRef }>

  /**
   * The lessons about the experiments the filter selects, split as they are read: those whose
   * every `invalidatedBy` predicate is checkably unchanged in `current` apply; the rest are
   * history, shown as possibly stale.
   */
  abstract lessons(filter: { experimentId?: string; target?: string }, current: CurrentEnvironment): Promise<{ applicable: LessonView[]; stale: LessonView[] }>
}

export * from './keys.ts'
export * from './registry.ts'
export * from './lessons.ts'
