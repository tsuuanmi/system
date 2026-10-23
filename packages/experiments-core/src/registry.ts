/**
 * The registry's rule (docs/design/experiments.md#the-four-answers), pure and the same for every
 * provider: which recorded experiments a registration matches and how, the retry predicates that
 * changed between them, the answer, whether the registration is pre-registered or refused, the
 * checks that make a registration invalid, and the `registration` decision that records it.
 */
import { canonicalJson, contentId, SchemaRegistry } from '@tsuuanmi/system-libs'
import type {
  ArtifactRef, Environment, Experiment, ExperimentDraft, ExperimentState, Hypothesis, Link, Match, ObjectiveContract, Predicate, Protocol,
  Registration, RegistryAnswer, Relation, Vocabulary,
} from './index.ts'
import { COUNTED, ExperimentsError, PREDICATES } from './index.ts'
import { environmentHash, fingerprintOf, identityOf, IDENTITY_VERSION, sharesTargetAndMechanism, vocabularyHash, vocabularyProblems } from './keys.ts'

/** The decider of every `registration` decision. */
export const REGISTRY_RULE = { id: 'experiments.registry', version: '1' } as const

/** A recorded revision, as the rule reads it. */
export interface RecordedExperiment {
  experimentId: string
  revision: number
  ref: ArtifactRef
  state: ExperimentState
  experiment: Experiment
  hypothesis: Hypothesis
}

/** What the rule reads of a registration being answered. */
export interface Answered {
  experimentId: string
  identity: ArtifactRef
  hypothesis: Pick<Hypothesis, 'fingerprint' | 'priorEvidence'>
  experiment: Pick<Experiment, 'objectiveContract' | 'suite'> & { environment: Omit<Environment, 'hash'> }
}

const unique = (items: readonly string[]): string[] => [...new Set(items)].sort()
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
const observed = (e: Omit<Environment, 'hash'>): string[] => unique(e.workers.map((w) => `${w.family}\u0000${w.observed ?? ''}`))
const collectors = (e: Omit<Environment, 'hash'>): string[] => unique(e.collectors.map((c) => `${c.id}\u0000${c.version}`))

/**
 * The retry predicates that changed between an earlier experiment and a later one, in the records,
 * in `PREDICATES` order: a family showing another model version (or another family), another
 * workload, another objective contract or version, another suite or version, another mechanism,
 * another collector or collector version (a measurement defect fixed), another cost model.
 */
export function changedPredicates(earlier: Pick<RecordedExperiment, 'experiment' | 'hypothesis'>, later: Pick<Answered, 'experiment' | 'hypothesis'>): Predicate[] {
  const a = earlier.experiment
  const b = later.experiment
  const changed: Record<Predicate, boolean> = {
    'model-version': !same(observed(a.environment), observed(b.environment)),
    workload: (a.environment.workload ?? null) !== (b.environment.workload ?? null),
    'objective-version': a.objectiveContract.id !== b.objectiveContract.id || a.objectiveContract.version !== b.objectiveContract.version,
    'suite-version': a.suite.id !== b.suite.id || a.suite.version !== b.suite.version,
    mechanism: earlier.hypothesis.fingerprint.mechanism !== later.hypothesis.fingerprint.mechanism,
    'measurement-defect': !same(collectors(a.environment), collectors(b.environment)),
    'cost-structure': (a.environment.costModel ?? null) !== (b.environment.costModel ?? null),
  }
  return PREDICATES.filter((p) => changed[p])
}

/** The registry's answer and every recorded experiment it found, the closest relation first. */
export interface Answer { answer: RegistryAnswer; matches: Match[] }

const RELATIONS: readonly Relation[] = ['exact', 'equal-fingerprint', 'shared', 'linked']

/**
 * Answer a registration against the recorded experiments. Only pre-registered experiments that were
 * not replaced count (`COUNTED`), and an experiment's own revisions never count against it. A
 * recorded experiment matches as `exact` (equal identity), `equal-fingerprint`, `shared` (the same
 * target and mechanism), or `linked`: named in the hypothesis's prior evidence, or linked by hand to
 * an experiment matched otherwise (one hop). The answer is EXACT_REPEAT when one is exact;
 * CONTEXT_CHANGED when fingerprints are equal and, against every equal one, a retry predicate
 * changed in the records; RELATED when anything else matched (an equal fingerprint with nothing
 * changed included); NOVEL otherwise.
 */
export function answerOf(registration: Answered, recorded: readonly RecordedExperiment[], links: readonly Pick<Link, 'a' | 'b'>[]): Answer {
  const counted = recorded.filter((r) => COUNTED.includes(r.state) && r.experimentId !== registration.experimentId)
  const fingerprint = registration.hypothesis.fingerprint
  const matches = new Map<string, Match>()
  const add = (r: RecordedExperiment, relation: Relation): void => {
    if (matches.has(r.experimentId)) return
    matches.set(r.experimentId, { experimentId: r.experimentId, revision: r.revision, ref: r.ref, relation, changed: changedPredicates(r, registration), state: r.state })
  }
  for (const r of counted) if (r.experiment.identity.hash === registration.identity) add(r, 'exact')
  for (const r of counted) if (r.hypothesis.fingerprint.hash === fingerprint.hash) add(r, 'equal-fingerprint')
  for (const r of counted) if (sharesTargetAndMechanism(r.hypothesis.fingerprint, fingerprint)) add(r, 'shared')
  const prior = new Set(registration.hypothesis.priorEvidence.experiments)
  for (const r of counted) if (prior.has(r.experimentId)) add(r, 'linked')
  const matched = [...matches.keys()]
  for (const { a, b } of links) {
    for (const [from, to] of [[a, b], [b, a]] as const) {
      const other = matched.includes(from) ? counted.find((r) => r.experimentId === to) : undefined
      if (other) add(other, 'linked')
    }
  }
  const all = [...matches.values()].sort((x, y) => RELATIONS.indexOf(x.relation) - RELATIONS.indexOf(y.relation) || (x.experimentId < y.experimentId ? -1 : 1))
  const equal = all.filter((m) => m.relation === 'equal-fingerprint')
  const answer: RegistryAnswer = all.some((m) => m.relation === 'exact') ? 'EXACT_REPEAT'
    : equal.length && equal.every((m) => m.changed.length > 0) ? 'CONTEXT_CHANGED'
      : all.length ? 'RELATED' : 'NOVEL'
  return { answer, matches: all }
}

/** What the registration itself declares: the experiments it cites, by id, the predicates it names as changed, and why. */
export interface Declared { cites: readonly string[]; changed: readonly Predicate[]; why?: string }

/** Pre-registered or refused, with why each was or was not chosen (every candidate of the decision says why). */
export interface Admission { outcome: 'preregistered' | 'refused'; reasons: { preregistered: string[]; refused: string[] } }

const named = (m: Match): string => `experiment ${m.experimentId} (revision ${m.revision})`
const RELATION_WORDS: Record<Relation, string> = {
  exact: 'the same identity', 'equal-fingerprint': 'an equal fingerprint', shared: 'the same target and mechanism', linked: 'a link made by hand',
}

/**
 * Whether an answered registration is pre-registered. An exact repeat is always refused. Every
 * other match must be cited. An equal fingerprint against which no retry predicate changed in the
 * records is refused: nothing says the earlier evidence no longer applies. Every predicate the
 * registration names as changed must have changed against a match. A CONTEXT_CHANGED answer must
 * also name, against each equal fingerprint, a predicate that changed, and say why.
 */
export function admit(answer: Answer, declared: Declared): Admission {
  const refusals: string[] = []
  const exact = answer.matches.filter((m) => m.relation === 'exact')
  if (exact.length) {
    refusals.push(...exact.map((m) => `its identity equals ${named(m)}'s: an exact repeat is refused, and the earlier experiment, its verdict, and its lessons are returned`))
  } else {
    const equal = answer.matches.filter((m) => m.relation === 'equal-fingerprint')
    for (const m of equal.filter((x) => x.changed.length === 0)) refusals.push(`its fingerprint equals ${named(m)}'s and no retry predicate changed in the records, so nothing says that evidence no longer applies`)
    const cited = new Set(declared.cites)
    for (const m of answer.matches.filter((x) => !cited.has(x.experimentId))) refusals.push(`it does not cite ${named(m)}, related by ${RELATION_WORDS[m.relation]}`)
    for (const p of declared.changed.filter((p) => !answer.matches.some((m) => m.changed.includes(p)))) refusals.push(`it names ${p} as changed, which no record confirms`)
    if (answer.answer === 'CONTEXT_CHANGED') {
      if (!declared.changed.length) refusals.push('it names no retry predicate that changed')
      for (const m of equal.filter((x) => !declared.changed.some((p) => x.changed.includes(p)))) refusals.push(`none of the predicates it names changed against ${named(m)}; the records show ${m.changed.join(', ')}`)
      if (!declared.why?.trim()) refusals.push('it does not say why the earlier evidence may no longer apply')
    }
  }
  const cites = answer.matches.map((m) => `${m.experimentId}`).join(', ')
  const admitted = answer.answer === 'NOVEL'
    ? 'NOVEL: no recorded experiment has its identity, its fingerprint, or its target and mechanism, and none is linked to it'
    : answer.answer === 'CONTEXT_CHANGED'
      ? `CONTEXT_CHANGED: it cites ${cites}, names ${declared.changed.join(', ')} as changed, which the records confirm, and says why`
      : `RELATED: it cites every related experiment (${cites})`
  return refusals.length
    ? { outcome: 'refused', reasons: { refused: refusals, preregistered: [`not pre-registered: ${refusals[0]}`] } }
    : { outcome: 'preregistered', reasons: { preregistered: [admitted], refused: [`not refused: ${admitted}`] } }
}

const missing = (needed: Iterable<string>, have: ReadonlySet<string>, what: string): string[] => [...new Set(needed)].filter((m) => !have.has(m)).map((m) => `${what} ${m} is not one of the contract's metrics`)

/**
 * Every problem of an objective contract, empty when experiments may be judged under it: unique
 * metric and hard constraint ids, every metric it names defined, a ratio's parts defined and not
 * ratios, one method per metric, a method for the primary and every guardrail, and no guardrail on
 * the primary or twice on one metric.
 */
export function contractProblems(contract: ObjectiveContract): string[] {
  const problems: string[] = []
  const ids = contract.metrics.map((m) => m.id)
  if (new Set(ids).size !== ids.length) problems.push('a metric is defined twice')
  const defined = new Set(ids)
  const byId = new Map(contract.metrics.map((m) => [m.id, m]))
  problems.push(...missing([contract.primary.metric], defined, 'the primary metric'))
  problems.push(...missing(contract.guardrails.map((g) => g.metric), defined, 'the guardrail metric'))
  problems.push(...missing(contract.cost.metrics, defined, 'the cost metric'))
  problems.push(...missing(contract.protocol.methods.map((m) => m.metric), defined, 'the method\'s metric'))
  for (const m of contract.metrics.filter((x) => x.source === 'ratio')) {
    for (const part of [m.numerator!, m.denominator!]) {
      if (!byId.has(part)) problems.push(`the ratio ${m.id} reads ${part}, which is not one of the contract's metrics`)
      else if (byId.get(part)!.source === 'ratio') problems.push(`the ratio ${m.id} reads ${part}, which is itself a ratio`)
    }
  }
  const methods = contract.protocol.methods.map((m) => m.metric)
  if (new Set(methods).size !== methods.length) problems.push('a metric has more than one method')
  for (const metric of [contract.primary.metric, ...contract.guardrails.map((g) => g.metric)]) {
    if (!methods.includes(metric)) problems.push(`the metric ${metric} is judged but has no method`)
  }
  const guarded = contract.guardrails.map((g) => g.metric)
  if (new Set(guarded).size !== guarded.length) problems.push('a metric has more than one guardrail')
  if (guarded.includes(contract.primary.metric)) problems.push('the primary metric is also a guardrail')
  const constraints = contract.hardConstraints.map((c) => c.id)
  if (new Set(constraints).size !== constraints.length) problems.push('a hard constraint is named twice')
  return problems
}

/**
 * Why an experiment's protocol is not at least as strict as its contract's: a lower confidence,
 * fewer cases or repetitions, a partition the contract requires left out, or a method other than
 * the contract's (another kind or prior, or fewer resamples), or one the contract does not name.
 */
export function protocolProblems(experiment: Protocol, contract: Protocol): string[] {
  const problems: string[] = []
  if (experiment.confidence < contract.confidence) problems.push(`its confidence ${experiment.confidence} is below the contract's ${contract.confidence}`)
  if (experiment.minCases < contract.minCases) problems.push(`its minimum of ${experiment.minCases} cases is below the contract's ${contract.minCases}`)
  if (experiment.repetitions < contract.repetitions) problems.push(`its ${experiment.repetitions} repetitions are fewer than the contract's ${contract.repetitions}`)
  for (const p of contract.partitions.filter((x) => !experiment.partitions.includes(x))) problems.push(`it leaves out the ${p} partition the contract requires`)
  for (const method of contract.methods) {
    const own = experiment.methods.find((m) => m.metric === method.metric)
    if (!own) problems.push(`it has no method for ${method.metric}`)
    else if (own.kind !== method.kind) problems.push(`its method for ${method.metric} is ${own.kind}, not the contract's ${method.kind}`)
    else if ((own.resamples ?? 0) < (method.resamples ?? 0)) problems.push(`its ${own.resamples ?? 0} resamples for ${method.metric} are fewer than the contract's ${method.resamples}`)
    else if (canonicalJson(own.prior ?? null) !== canonicalJson(method.prior ?? null)) problems.push(`its prior for ${method.metric} is not the contract's`)
  }
  for (const own of experiment.methods.filter((m) => !contract.methods.some((c) => c.metric === m.metric))) problems.push(`it adds a method for ${own.metric}, which the contract does not name`)
  return problems
}

/**
 * Why an experiment's families are not independent: the maker's, the reviewers', and the
 * model-based validators' families must be pairwise different, and no validator may be of a family
 * either arm runs on (a candidate is never judged by its own family).
 */
export function independenceProblems(independence: Experiment['independence'], workers: ReadonlyArray<{ family: string }>): string[] {
  const problems: string[] = []
  if (independence.reviewers.includes(independence.maker)) problems.push('a reviewer is of the maker\'s family')
  if (independence.validators.includes(independence.maker)) problems.push('a validator is of the maker\'s family')
  if (independence.validators.some((v) => independence.reviewers.includes(v))) problems.push('a validator is of a reviewer\'s family')
  const arms = new Set(workers.map((w) => w.family))
  if (independence.validators.some((v) => arms.has(v))) problems.push('a validator is of a family one of the arms runs on')
  return problems
}

/**
 * Every problem of an experiment under its contract: the contract it names (id, version, the hash
 * of its canonical JSON); the protocol at least as strict; the partitions used, as the protocol
 * declares, present in the suite, with at least the protocol's minimum of cases; a horizon of every
 * case in both arms at the protocol's repetitions; each arm on Workers of its own; a hypothesis
 * about a metric the contract measures; a budget within the contract's cost ceiling, in which every
 * trial's reservation has a line; and independent families.
 */
export function experimentProblems(experiment: ExperimentDraft & { objectiveContract: Experiment['objectiveContract'] }, contract: ObjectiveContract, effectMetric: string): string[] {
  const problems: string[] = []
  const pinned = experiment.objectiveContract
  if (pinned.id !== contract.contractId || pinned.version !== contract.version) problems.push(`it names contract ${pinned.id} version ${pinned.version}, but its ref holds ${contract.contractId} version ${contract.version}`)
  if (pinned.hash !== contentId(contract)) problems.push('its contract hash is not the sha256 of the contract its ref holds')
  problems.push(...protocolProblems(experiment.protocol, contract.protocol))
  const used: string[] = [...new Set(experiment.suite.used)].sort()
  if (!same(used, [...new Set(experiment.protocol.partitions)].sort())) problems.push(`it uses the partitions ${used.join(', ')}, but its protocol declares ${experiment.protocol.partitions.join(', ')}`)
  const partitions: string[] = experiment.suite.partitions.map((p) => p.name)
  if (new Set(partitions).size !== partitions.length) problems.push('the suite names a partition twice')
  for (const p of used.filter((x) => !partitions.includes(x))) problems.push(`the suite has no ${p} partition`)
  const cases = experiment.suite.partitions.filter((p) => used.includes(p.name)).reduce((n, p) => n + p.cases, 0)
  if (cases < experiment.protocol.minCases) problems.push(`its ${cases} cases are fewer than the protocol's minimum of ${experiment.protocol.minCases}`)
  const horizon = cases * 2 * experiment.protocol.repetitions
  if (experiment.stopping.trials !== horizon) problems.push(`its horizon is ${experiment.stopping.trials} trials, but its cases in both arms at ${experiment.protocol.repetitions} repetitions make ${horizon}`)
  for (const arm of ['baseline', 'candidate'] as const) {
    if (!experiment.environment.workers.some((w) => w.arm === arm)) problems.push(`the ${arm} arm has no Worker`)
  }
  if (!contract.metrics.some((m) => m.id === effectMetric)) problems.push(`its hypothesis is about ${effectMetric}, which the contract does not measure`)
  const spend = experiment.budget.lines.filter((l) => l.unit === contract.cost.unit).reduce((n, l) => n + l.amount, 0)
  if (spend > contract.cost.ceiling) problems.push(`its budget of ${spend} ${contract.cost.unit} passes the contract's ceiling of ${contract.cost.ceiling}`)
  for (const line of experiment.budget.perTrial) {
    if (!experiment.budget.lines.some((l) => l.pool === line.pool && l.unit === line.unit)) problems.push(`a trial reserves ${line.unit} of ${line.pool}, which its budget has no line for`)
  }
  problems.push(...independenceProblems(experiment.independence, experiment.environment.workers))
  return problems
}

/** The sha256 of a registration's canonical JSON: the same registration, retried, has the same hash. */
export function registrationHash(registration: Registration): ArtifactRef {
  const { producer: _, classification: __, ...content } = registration
  return contentId({ ...content, cites: unique(content.cites ?? []), changed: unique(content.changed ?? []), why: content.why ?? null }) as ArtifactRef
}

/** What the registry needs to answer a registration: its vocabulary, the contract the experiment's ref holds, and every recorded revision with the manual links. */
export interface RegistrationContext {
  vocabulary: Vocabulary
  contract: ObjectiveContract
  recorded: readonly RecordedExperiment[]
  links: readonly Pick<Link, 'a' | 'b'>[]
}

/** A registration checked and answered, ready to be recorded. */
export interface Prepared {
  hypothesis: Hypothesis
  environment: Environment
  identity: { version: typeof IDENTITY_VERSION; hash: ArtifactRef }
  /** The recorded revisions it cites, resolved. */
  cites: RecordedExperiment[]
  /** The revision it supersedes, from revision 2 on. */
  previous?: RecordedExperiment
  answer: Answer
  admission: Admission
}

const schemas = new SchemaRegistry()
const PLACEHOLDER = `sha256:${'0'.repeat(64)}` as ArtifactRef

/**
 * Check a registration and answer it, recording nothing. Throws `unavailable` for a vocabulary that
 * cannot be used, and `invalid`, naming every problem, for a hypothesis or experiment that is not a
 * valid record, a tag outside the vocabulary, a contract that cannot judge it, a cited experiment
 * the registry does not count, or a revision that supersedes nothing pre-registered.
 */
export function prepareRegistration(registration: Registration, context: RegistrationContext): Prepared {
  const broken = vocabularyProblems(context.vocabulary)
  if (broken.length) throw new ExperimentsError('unavailable', `the registry's vocabulary cannot be used: ${broken.join('; ')}`)
  const { hypothesis: given, experiment: draft } = (registration ?? {}) as Partial<Registration>
  if (!given || typeof given !== 'object' || !draft || typeof draft !== 'object') throw new ExperimentsError('invalid', 'a registration names a hypothesis and an experiment')
  const cited = registration.cites ?? []
  if (!Array.isArray(cited) || cited.length > 64 || cited.some((c) => typeof c !== 'string')) throw new ExperimentsError('invalid', 'a registration cites at most 64 experiments, by id')
  // The records are checked with stand-ins for what the registry computes, before anything is computed from them.
  const problems: string[] = []
  const valid = (record: object): void => {
    try {
      schemas.assertRecord(record as { schema: string })
    } catch (error) {
      problems.push((error as Error).message)
    }
  }
  valid({ ...given, schema: 'hypothesis@1.0', fingerprint: { version: '1', target: 'x:x', mechanism: 'x', intervention: 'x', effect: 'x:x', hash: PLACEHOLDER } })
  valid({
    ...draft, schema: 'experiment@1.0', environment: { ...draft.environment, hash: PLACEHOLDER }, hypothesis: { id: given.hypothesisId, ref: PLACEHOLDER },
    ...(draft.revision > 1 ? { supersedes: PLACEHOLDER } : {}),
    registry: { answer: 'NOVEL', cites: [], changed: [...(registration.changed ?? [])], ...(registration.why !== undefined ? { why: registration.why } : {}) },
    identity: { version: IDENTITY_VERSION, hash: PLACEHOLDER },
  })
  if (problems.length) throw new ExperimentsError('invalid', `the registration is not a valid record: ${problems.join('; ')}`)
  const hypothesis: Hypothesis = { ...given, schema: 'hypothesis@1.0', fingerprint: fingerprintOf(given, context.vocabulary) }
  const environment: Environment = { ...draft.environment, hash: environmentHash(draft.environment) }
  const identity = identityOf({ ...draft, environment }, hypothesis)
  problems.push(...contractProblems(context.contract).map((p) => `its contract: ${p}`))
  problems.push(...experimentProblems(draft, context.contract, hypothesis.expectedEffect.metric))
  const counted = (id: string): RecordedExperiment | undefined => context.recorded.find((r) => r.experimentId === id && COUNTED.includes(r.state))
  const cites = [...new Set(cited)].map((id) => {
    const found = counted(id)
    if (!found) problems.push(`it cites ${id}, which is no pre-registered experiment`)
    return found
  }).filter((r): r is RecordedExperiment => r !== undefined)
  let previous: RecordedExperiment | undefined
  const own = context.recorded.filter((r) => r.experimentId === draft.experimentId)
  if (draft.revision === 1 && own.length) problems.push(`experiment ${draft.experimentId} is already recorded: a change is a new revision`)
  if (draft.revision > 1) {
    // A new revision takes the next number, and replaces the live revision, which must not have started.
    const next = Math.max(0, ...own.map((r) => r.revision)) + 1
    if (draft.revision !== next) problems.push(`the next revision of ${draft.experimentId} is ${next}, not ${draft.revision}`)
    previous = own.filter((r) => COUNTED.includes(r.state)).sort((a, b) => b.revision - a.revision)[0]
    if (previous?.state !== 'preregistered') problems.push(`revision ${draft.revision} would replace a ${previous ? previous.state : 'missing'} revision: only a pre-registered revision is superseded`)
  }
  if (problems.length) throw new ExperimentsError('invalid', `the registration is refused as invalid: ${problems.join('; ')}`)
  const answer = answerOf({ experimentId: draft.experimentId, identity: identity.hash, hypothesis, experiment: draft }, context.recorded, context.links)
  const admission = admit(answer, { cites: cited, changed: registration.changed ?? [], ...(registration.why !== undefined ? { why: registration.why } : {}) })
  return { hypothesis, environment, identity, cites, ...(previous ? { previous } : {}), answer, admission }
}

/** The `experiment@1.0` record a prepared registration writes, once its hypothesis is recorded. */
export function experimentRecord(registration: Registration, prepared: Prepared, hypothesisRef: ArtifactRef): Experiment {
  return {
    ...registration.experiment,
    schema: 'experiment@1.0',
    ...(prepared.previous ? { supersedes: prepared.previous.ref } : {}),
    hypothesis: { id: prepared.hypothesis.hypothesisId, ref: hypothesisRef },
    environment: prepared.environment,
    registry: {
      answer: prepared.answer.answer,
      cites: prepared.cites.map((r) => ({ experimentId: r.experimentId, revision: r.revision, ref: r.ref })),
      changed: [...new Set(registration.changed ?? [])],
      ...(registration.why !== undefined ? { why: registration.why } : {}),
    },
    identity: prepared.identity,
  }
}

/** The body of a `registration` decision (`decision@1.7`), as a provider records it through `ctx.artifacts.recordDecision`. */
export interface RegistrationDecision {
  schema: 'decision@1.7'
  decisionType: 'registration'
  question: string
  inputs: ArtifactRef[]
  candidates: Array<{ option: 'preregistered' | 'refused'; selected: boolean; reasons: string[] }>
  decider: { type: 'rule'; id: typeof REGISTRY_RULE.id; version: typeof REGISTRY_RULE.version; hash: ArtifactRef }
  outcome: {
    option: 'preregistered' | 'refused'
    detail: {
      experimentId: string
      revision: number
      answer: RegistryAnswer
      identity: ArtifactRef
      fingerprint: ArtifactRef
      cites: string[]
      changed: Predicate[]
      matches: Array<{ experimentId: string; revision: number; relation: Relation; changed: Predicate[] }>
      supersedes?: number
    }
  }
  deterministic: true
  rationale: string
}

/**
 * The `registration` decision of a prepared registration: its inputs the experiment and hypothesis
 * it recorded, the experiments it matched, and the revision it supersedes; its decider the
 * registry's rule, hashed with the vocabulary the fingerprint was normalized from.
 */
export function registrationDecision(registration: Registration, prepared: Prepared, refs: { experiment: ArtifactRef; hypothesis: ArtifactRef }, vocabulary: Vocabulary): RegistrationDecision {
  const { experimentId, revision } = registration.experiment
  const option = prepared.admission.outcome
  return {
    schema: 'decision@1.7',
    decisionType: 'registration',
    question: `Is experiment ${experimentId} revision ${revision} pre-registered?`,
    inputs: [...new Set([refs.experiment, refs.hypothesis, ...prepared.answer.matches.map((m) => m.ref), ...(prepared.previous ? [prepared.previous.ref] : [])])],
    candidates: (['preregistered', 'refused'] as const).map((o) => ({ option: o, selected: o === option, reasons: prepared.admission.reasons[o] })),
    decider: { type: 'rule', id: REGISTRY_RULE.id, version: REGISTRY_RULE.version, hash: vocabularyHash(vocabulary) },
    outcome: {
      option,
      detail: {
        experimentId, revision, answer: prepared.answer.answer, identity: prepared.identity.hash, fingerprint: prepared.hypothesis.fingerprint.hash,
        cites: prepared.cites.map((r) => r.experimentId), changed: [...new Set(registration.changed ?? [])],
        matches: prepared.answer.matches.map((m) => ({ experimentId: m.experimentId, revision: m.revision, relation: m.relation, changed: m.changed })),
        ...(prepared.previous ? { supersedes: prepared.previous.revision } : {}),
      },
    },
    deterministic: true,
    rationale: 'The registry answers from the records only: the exact identity refuses a repeat; a fingerprint or a link asks for citations and, for an equal fingerprint, a retry predicate the records confirm (PROP-0011).',
  }
}
