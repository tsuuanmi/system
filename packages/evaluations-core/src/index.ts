/**
 * Evaluation engine seam definition: `ctx.evaluations` (docs/design/evaluations.md), a guarantee
 * seam of the gate (ADR-0036, ADR-0044). The engine runs a pre-registered experiment offline under
 * its pins and seals, as paired trials in an order drawn from the experiment's seed, measures each
 * trial through registered collectors and the resource ledger, analyses once at the horizon by the
 * declared method, and classifies the evaluation by the deterministic verdict rule, recorded as a
 * `verdict` decision. It decides no promotion. The types mirror `evaluation@1.0`; the schemas in
 * `schemas/` are canonical. The schedule, the integrity checks, and the verdict rule are pure
 * functions here, the same for every provider; the statistics are the pinned library's (F2).
 * @module @tsuuanmi/system-evaluations-core
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import type { ArtifactRef, Arm, EvidencePartition, Method, MethodKind, Outcome } from '@tsuuanmi/system-experiments-core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    evaluations: Evaluations
  }
}

/** The contract version of this seam; its conformance suite names the same. */
export const EVALUATIONS_CONTRACT = '1.0' as const

/** The integrity checks of an evaluation, in the order it records them; one failed makes the verdict `invalid`. */
export type Check = 'pins' | 'seal' | 'arms' | 'families' | 'metrics' | 'judge' | 'trials'
export const CHECKS: readonly Check[] = ['pins', 'seal', 'arms', 'families', 'metrics', 'judge', 'trials']

export interface Interval { estimate: number; lower: number; upper: number }

/** One trial of the schedule: a case of an evidence partition, in one arm, at one repetition. */
export interface TrialSpec { index: number; case: string; partition: EvidencePartition; arm: Arm; repetition: number }

/** The Workers and families that served a trial, as its run recorded them. */
export interface Route {
  workers: string[]
  families: string[]
  /** Whether the run fell back to one family (ADR-0029): the trial is then invalid. */
  sameFamily: boolean
  /** The model or provider version each Worker showed, by worker. */
  observed?: Record<string, string>
}

export interface Measurement { metric: string; value: number; source: string }

/**
 * A trial as the engine records it: `scheduled`, `started` (recorded before its run starts), and
 * then `completed` or `failed` (measured), `lost` (started, its outcome unknown after a restart:
 * never run again, INV-4), or `skipped` (the evaluation ended first).
 */
export type TrialState = 'scheduled' | 'started' | 'completed' | 'failed' | 'lost' | 'skipped'
export interface Trial extends TrialSpec {
  state: TrialState
  task?: string
  run?: string
  results: ArtifactRef[]
  route?: Route
  measurements: Measurement[]
  invalid?: string
}

export type EndReason = 'horizon' | 'budget' | 'integrity' | 'hard-constraint'

/** `evaluation@1.0`: the body of an `evidence` artifact the engine writes once the evaluation ends. */
export interface Evaluation {
  schema: 'evaluation@1.0'
  evaluationId: string
  experiment: { id: string; revision: number; ref: ArtifactRef; identity: ArtifactRef }
  startedAt: string
  ended: { reason: EndReason; at: string; detail?: string }
  horizonReached: boolean
  trials: Array<Trial & { state: 'completed' | 'failed' | 'lost' | 'skipped' }>
  arms: Array<{ arm: Arm; metrics: Array<{ metric: string; value: number; cases: number }> }>
  analysis: Array<{ metric: string; method: { kind: MethodKind; library: string; version: string }; cases: number; difference: Interval; candidate?: Interval }>
  hardConstraints: Array<{ id: string; held: boolean; broken: number[] }>
  cost: {
    lines: Array<{ pool: string; unit: 'tokens' | 'usd' | 'turns' | 'runs' | 'minutes'; amount: number; phase: Phase; kind: 'sunk' | 'projected' }>
    operator?: { interruptions: number; adjudicationMinutes: number }
  }
  integrity: { checks: Array<{ check: Check; passed: boolean; detail?: string }>; missing: Array<{ trial: number; metric: string; why: string }> }
}
export type Phase = 'research' | 'brainstorm' | 'implementation' | 'evaluation' | 'review' | 'deployment' | 'operations'

/** A trial as a collector reads it: its spec, how its run ended, the artifacts it produced, and its route. */
export interface CollectedTrial {
  experimentId: string
  revision: number
  evaluationId: string
  trial: TrialSpec
  state: 'completed' | 'failed'
  results: ArtifactRef[]
  route: Route
}

/** What a collector measured on one trial: metrics by the contract's names, the hard constraints it validated, and whether it found the trial contaminated. */
export interface Collection { metrics?: Record<string, number>; constraints?: Record<string, boolean>; contaminated?: string }

/**
 * A metric collector or validator (the verification family), registered through
 * `evaluations.collector` as acceptance contracts register through `workers.contract`. It reads a
 * trial's result artifacts and fails open in the capability sense only: what it does not return is
 * missing, and a trial missing a metric or constraint the contract needs makes the evaluation
 * `invalid`, never a pass.
 */
export interface Collector {
  id: string
  version: string
  /** The contract metrics it measures, and the hard constraints it validates, by name. */
  metrics: string[]
  constraints?: string[]
  /** A model-based collector's provider family: never the maker's, a reviewer's, or an arm's. A deterministic one has none. */
  family?: string
  measure(trial: CollectedTrial, read: (ref: ArtifactRef) => unknown): Promise<Collection> | Collection
}

/** Per case, one arm's values over its repetitions; for a ratio metric, its numerator's and denominator's. */
export type ArmValues = { values: number[] } | { numerator: number[]; denominator: number[] }

/** What a method analyses: one metric's paired values per case (the unit of analysis), at the protocol's confidence, from the experiment's seed. */
export interface AnalysisInput {
  metric: string
  method: Method
  confidence: number
  seed: string
  ratio: boolean
  cases: Array<{ case: string; baseline: ArmValues; candidate: ArmValues }>
}

/**
 * One method of the pinned statistics library (F2; docs/proposals/0011-feedback-loop.md#statistics-library-pending).
 * Deterministic for the same input and seed. It returns the paired difference (candidate minus
 * baseline, as measured) and the candidate arm's own level, each as an estimate with its interval.
 */
export interface AnalysisMethod {
  kind: MethodKind
  library: string
  version: string
  analyse(input: AnalysisInput): { difference: Interval; candidate: Interval }
}

/** An evaluation as the engine holds it while it runs, and after. */
export interface EvaluationEntry {
  evaluationId: string
  experimentId: string
  revision: number
  /** `running` → `evaluated` (its record written) → `closed` (its verdict recorded). */
  state: 'running' | 'evaluated' | 'closed'
  trials: Array<TrialSpec & { state: TrialState; invalid?: string }>
  startedAt: string
  ended?: { reason: EndReason; at: string; detail?: string }
  evaluation?: ArtifactRef
  verdict?: ArtifactRef
  outcome?: Outcome
  updatedAt: string
}

/**
 * Why `start` was refused; nothing started, and the experiment stays `preregistered` (a changed
 * pin or seal is a new revision, never a run under the old one). `unavailable`: the engine could
 * not read what it must check, so nothing starts.
 */
export type EvaluationsFailure =
  | 'unknown-experiment' | 'not-preregistered' | 'pins-changed' | 'seal-broken' | 'touches-judge' | 'not-independent' | 'unmeasurable' | 'unavailable'
export class EvaluationsError extends Error {
  constructor(readonly failure: EvaluationsFailure, message: string) {
    super(message)
    this.name = 'EvaluationsError'
  }
}

export abstract class Evaluations extends Service {
  constructor(ctx: Context) {
    super(ctx, 'evaluations')
  }

  /** Register a collector for as long as its plugin lives; the returned disposer removes it. A second collector with the same id is refused. */
  abstract collector(collector: Collector): () => void

  /**
   * Start evaluating a pre-registered experiment. Before any trial, the engine checks the pins
   * against the live environment, the seal of each partition used, that the candidate changes
   * none of its judge, the families' independence, and that every metric and hard constraint the
   * contract needs has a registered collector at the pinned version and a pinned analysis method;
   * any failure refuses the start (`EvaluationsError`). It then schedules every trial from the
   * seed, records the schedule, and takes the experiment to `running`. Idempotent: starting a
   * running experiment returns its evaluation. `at` is a test seam, as in `sweep`.
   */
  abstract start(experimentId: string, at?: Date): Promise<EvaluationEntry>

  /**
   * Make every move due at `at`: reconcile trials that started before a restart (an unknown
   * outcome is `lost`, never run again), take finished trials' results and measure them, start the
   * next trial when the budget covers it, and end an evaluation at its horizon, its budget, an
   * integrity breach, or a broken hard constraint: its record written (`evaluated`), then its
   * verdict recorded (`closed`). A verdict that cannot be recorded leaves it `evaluated` for the
   * next sweep. A restart is a sweep. Returns the evaluations it moved.
   */
  abstract sweep(at: Date): Promise<EvaluationEntry[]>

  abstract get(evaluationId: string): Promise<EvaluationEntry | undefined>

  /** Evaluations, newest first (default 100, at most 1000). */
  abstract list(filter?: { experimentId?: string; states?: Array<EvaluationEntry['state']>; limit?: number }): Promise<EvaluationEntry[]>
}

export * from './protocol.ts'
export * from './verdict.ts'
