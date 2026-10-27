/**
 * The registry's two keys (docs/design/experiments.md#two-keys), pinned pure functions: the
 * structured fingerprint, normalized from the vocabulary, and the exact identity, the sha256 of the
 * canonical JSON of the normalized experiment. Each carries its version in the records it writes;
 * changing what either reads or how is a new version, never an edit of this one.
 */
import { contentId, unique } from '@tsuuanmi/system-libs'
import type { ArtifactRef, Environment, Experiment, ExactSubject, Fingerprint, Hypothesis, HypothesisDraft, Protocol, Vocabulary, VocabularyTerm } from './index.ts'
import { ExperimentsError } from './index.ts'

/** The fingerprint's version: what it reads and how it normalizes. */
export const FINGERPRINT_VERSION = '1' as const
/** The exact identity's version: what it reads and how it normalizes. */
export const IDENTITY_VERSION = '1' as const

/** A vocabulary tag (`objective-contract@1#/$defs/name`). */
export const TAG = /^[a-z][a-z0-9-]{0,63}(\.[a-z0-9-]{1,64}){0,3}$/

const sorted = <T>(items: readonly T[], key: (item: T) => string): T[] => [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))

/**
 * Every problem of a vocabulary, empty when it can be used: each tag and alias a valid tag, and no
 * word naming two terms of one list (a tag or alias of another term).
 */
export function vocabularyProblems(vocabulary: Vocabulary): string[] {
  const problems: string[] = []
  for (const [list, terms] of [['mechanisms', vocabulary.mechanisms], ['interventions', vocabulary.interventions]] as const) {
    if (!Array.isArray(terms) || terms.length === 0) {
      problems.push(`${list}: the vocabulary needs at least one term`)
      continue
    }
    const owner = new Map<string, string>()
    for (const term of terms) {
      for (const name of [term.tag, ...(term.aliases ?? [])]) {
        const other = owner.get(name)
        if (typeof name !== 'string' || !TAG.test(name)) problems.push(`${list}: ${JSON.stringify(name)} is not a vocabulary tag`)
        else if (other === undefined) owner.set(name, term.tag)
        else problems.push(other === term.tag ? `${list}: ${name} is listed twice for ${term.tag}` : `${list}: ${name} names both ${other} and ${term.tag}`)
      }
    }
  }
  return problems
}

/** The sha256 of a vocabulary's canonical form (terms by tag, aliases sorted): the registration decision's decider hash. */
export function vocabularyHash(vocabulary: Vocabulary): ArtifactRef {
  const norm = (terms: readonly VocabularyTerm[]) => sorted(terms, (t) => t.tag).map((t) => ({ tag: t.tag, aliases: unique(t.aliases ?? []) }))
  return contentId({ mechanisms: norm(vocabulary.mechanisms), interventions: norm(vocabulary.interventions) }) as ArtifactRef
}

/** The canonical tag a tag names in a list of terms (the tag itself or one of its aliases), or undefined. */
export function canonicalTag(terms: readonly VocabularyTerm[], given: string): string | undefined {
  return terms.find((t) => t.tag === given || (t.aliases ?? []).includes(given))?.tag
}

/**
 * The fingerprint of a hypothesis (version 1): the target's kind and ref, the mechanism and the
 * intervention as the vocabulary's canonical tags, and the expected effect's metric and direction;
 * `hash` is the sha256 of those four fields' canonical JSON. A tag the vocabulary does not know is
 * refused (`invalid`): a fingerprint outside the vocabulary could not be matched.
 */
export function fingerprintOf(hypothesis: Pick<HypothesisDraft, 'target' | 'mechanism' | 'intervention' | 'expectedEffect'>, vocabulary: Vocabulary): Fingerprint {
  const mechanism = canonicalTag(vocabulary.mechanisms, hypothesis.mechanism.tag)
  if (!mechanism) throw new ExperimentsError('invalid', `the mechanism ${JSON.stringify(hypothesis.mechanism.tag)} is not in the registry's vocabulary`)
  const intervention = canonicalTag(vocabulary.interventions, hypothesis.intervention.tag)
  if (!intervention) throw new ExperimentsError('invalid', `the intervention ${JSON.stringify(hypothesis.intervention.tag)} is not in the registry's vocabulary`)
  const key = {
    target: `${hypothesis.target.kind}:${hypothesis.target.ref}`,
    mechanism,
    intervention,
    effect: `${hypothesis.expectedEffect.metric}:${hypothesis.expectedEffect.direction}`,
  }
  return { version: FINGERPRINT_VERSION, ...key, hash: contentId({ v: FINGERPRINT_VERSION, ...key }) as ArtifactRef }
}

/** Whether two fingerprints share their target and mechanism: the registry's `shared` relation. */
export const sharesTargetAndMechanism = (a: Fingerprint, b: Fingerprint): boolean => a.target === b.target && a.mechanism === b.mechanism

const subject = (s: ExactSubject): ExactSubject => ({ type: s.type, ref: s.ref, version: s.version })

/** The environment as the hash reads it: every list in a fixed order, absent optional fields as null. */
function normalEnvironment(environment: Omit<Environment, 'hash'>): unknown {
  return {
    composition: environment.composition,
    plugins: sorted(environment.plugins, (p) => p.name).map((p) => ({ name: p.name, version: p.version, manifestDigest: p.manifestDigest ?? null })),
    workers: sorted(environment.workers, (w) => `${w.arm}\u0000${w.worker}`).map((w) => ({ arm: w.arm, worker: w.worker, family: w.family, descriptor: w.descriptor ?? null, observed: w.observed ?? null })),
    templates: sorted(environment.templates, (t) => t.name).map((t) => ({ name: t.name, specHash: t.specHash })),
    collectors: sorted(environment.collectors, (c) => c.id).map((c) => ({ id: c.id, version: c.version })),
    statistics: { library: environment.statistics.library, version: environment.statistics.version },
    workload: environment.workload ?? null,
    costModel: environment.costModel ?? null,
  }
}

/** The environment's hash: the sha256 of its canonical JSON, normalized, without the hash itself. */
export function environmentHash(environment: Omit<Environment, 'hash'> & { hash?: unknown }): ArtifactRef {
  const { hash: _, ...rest } = environment
  return contentId(normalEnvironment(rest)) as ArtifactRef
}

/** The protocol as the identity reads it: methods by metric, partitions sorted. */
function normalProtocol(protocol: Protocol): unknown {
  return {
    confidence: protocol.confidence,
    minCases: protocol.minCases,
    repetitions: protocol.repetitions,
    partitions: unique(protocol.partitions),
    methods: sorted(protocol.methods, (m) => m.metric).map((m) => ({ metric: m.metric, kind: m.kind, resamples: m.resamples ?? null, prior: m.prior ?? null })),
  }
}

/** The sha256 of an experiment's protocol, normalized: the verdict decision's decider hash. */
export const protocolHash = (protocol: Protocol): ArtifactRef => contentId(normalProtocol(protocol)) as ArtifactRef

/** What the identity reads of an experiment: everything but its ids, revision, budget, seed, registry answer, and identity. */
export type IdentityInput = Pick<Experiment, 'objectiveContract' | 'comparison' | 'baseline' | 'candidate' | 'suite' | 'protocol' | 'stopping' | 'independence'> & {
  environment: Omit<Environment, 'hash'> & { hash?: unknown }
}

/**
 * The exact identity (version 1): the sha256 of the canonical JSON of the normalized hypothesis
 * (its target with its version, its fingerprint's mechanism and intervention, the expected
 * effect's metric and direction, and its workload), the candidate's and the baseline's exact
 * subjects, the comparison, the objective contract (id, version, hash), the suite (id, version,
 * each partition's hash, the partitions used), the environment's hash, the protocol, the stopping
 * rule, and the families of maker, reviewers, and validators. Prose, ids, revisions, the budget,
 * the seed, and the candidate's provenance are not read: a reworded or re-seeded copy is the same
 * experiment.
 */
export function identityOf(experiment: IdentityInput, hypothesis: Pick<Hypothesis, 'target' | 'fingerprint' | 'expectedEffect' | 'context'>): { version: typeof IDENTITY_VERSION; hash: ArtifactRef } {
  const material = {
    v: IDENTITY_VERSION,
    hypothesis: {
      target: { kind: hypothesis.target.kind, ref: hypothesis.target.ref, version: hypothesis.target.version },
      mechanism: hypothesis.fingerprint.mechanism,
      intervention: hypothesis.fingerprint.intervention,
      effect: { metric: hypothesis.expectedEffect.metric, direction: hypothesis.expectedEffect.direction },
      workload: hypothesis.context.workload ?? null,
    },
    candidate: subject(experiment.candidate.subject),
    baseline: subject(experiment.baseline.subject),
    comparison: experiment.comparison.type === 'non-inferiority' ? { type: 'non-inferiority', margin: experiment.comparison.margin } : { type: 'superiority' },
    objectiveContract: { id: experiment.objectiveContract.id, version: experiment.objectiveContract.version, hash: experiment.objectiveContract.hash },
    suite: {
      id: experiment.suite.id,
      version: experiment.suite.version,
      partitions: sorted(experiment.suite.partitions, (p) => p.name).map((p) => ({ name: p.name, hash: p.hash })),
      used: unique(experiment.suite.used),
    },
    environment: environmentHash(experiment.environment),
    protocol: normalProtocol(experiment.protocol),
    stopping: { rule: experiment.stopping.rule, trials: experiment.stopping.trials },
    independence: {
      maker: experiment.independence.maker,
      reviewers: unique(experiment.independence.reviewers),
      validators: unique(experiment.independence.validators),
    },
  }
  return { version: IDENTITY_VERSION, hash: contentId(material) as ArtifactRef }
}
