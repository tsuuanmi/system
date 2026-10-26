/**
 * Conformance suite for the landing seam (`ctx.landing`, the abstract `Landing`, and the calls every
 * provider answers, `LandingProvider`; PROP-0017 L0). Every provider, a fake included, passes it:
 * - `prepare` binds a landing to the exact head and target, and changes nothing;
 * - `land` lands only on an approval of exactly that subject, reports the target's new head that
 *   holds the result, and never lands twice: asked again, it finds its own work done (INV-4);
 * - a moved target, a moved head, or an approval of another subject is a typed refusal that changes
 *   nothing (INV-2, INV-5);
 * - `status` never says landed before it is, and after, says landed at that commit or that it cannot
 *   tell without acting.
 *
 * The test supplies the provider under test and a {@link World}: the repository it lands in, which
 * the suite reads and moves from outside the provider. {@link MemoryRepository} is a world in memory,
 * with the local merge's semantics (ADR-0060); the seam's fake, {@link FakeLanding}, lands in one.
 */
import { expect } from 'vitest'
import { defineSuite, type Scenario } from '../../libs/conformance/runner.ts'
import {
  LANDING_REFUSAL_CAUSES, Landing, type Landed, type LandingProvider, type LandingRefusal, type LandingRefusalCause, type LandingStatus, type LandingSubject, type LandingTarget,
  type LandRequest, type Prepared, sameSubject, SUBJECT_VERSION_MAX,
} from '../src/index.ts'

/** The repository a provider lands in, read and moved from outside the provider. */
export interface World {
  /** A new accepted result ready to land: its own run's branch, one commit on top of the target's head; the target does not hold it. */
  target(): Promise<LandingTarget>
  /** Move the target branch on by one commit of someone else's; its new head. */
  moveBase(target: LandingTarget): Promise<string>
  /** Move the run's branch on by one commit; its new head. */
  moveHead(target: LandingTarget): Promise<string>
  /** Where the target branch is now. */
  baseOf(target: LandingTarget): Promise<string>
  /** Whether `commit` holds `head` (`head` is `commit` or one of its ancestors). */
  holds(commit: string, head: string): Promise<boolean>
}

export interface Booted {
  provider: LandingProvider
  world: World
  dispose?: () => Promise<void>
}

/** Boots a fresh provider under test over a fresh world. */
export type Boot = () => Promise<Booted>

/** An approval decision's id, as the engine passes one (the provider does not read it). */
export const APPROVAL = `sha256:${'a'.repeat(64)}`

const other = (sha: string): string => (sha.startsWith('f') ? '0' : 'f') + sha.slice(1)

function prepared(answer: Prepared | LandingRefusal): Prepared {
  if (answer.outcome !== 'prepared') throw new Error(`prepare refused (${answer.cause}): ${answer.reason}`)
  return answer
}

function landed(answer: Landed | LandingRefusal): Landed {
  if (answer.outcome !== 'landed') throw new Error(`land refused (${answer.cause}): ${answer.reason}`)
  return answer
}

/** A typed refusal: one of the seam's causes, the expected one, with a reason, naming the provider. */
function refused(answer: Landed | LandingRefusal | Prepared, cause: LandingRefusalCause, provider: string): void {
  expect(answer.outcome, JSON.stringify(answer)).toBe('refused')
  const r = answer as LandingRefusal
  expect(LANDING_REFUSAL_CAUSES).toContain(r.cause)
  expect(r.cause, r.reason).toBe(cause)
  expect(typeof r.reason === 'string' && r.reason.length > 0).toBe(true)
  expect(r.provider).toBe(provider)
}

const request = (target: LandingTarget, subject: LandingSubject): LandRequest => ({ ...target, subject, approval: APPROVAL, message: `system: merge run ${target.runId}` })

async function run(boot: Boot, body: (b: Booted) => Promise<void>): Promise<void> {
  const b = await boot()
  try {
    await body(b)
  } finally {
    await b.dispose?.()
  }
}

const scenario = (id: string, title: string, body: (b: Booted) => Promise<void>): Scenario<Boot> => ({ id: `landing.${id}`, since: '1.0', title, run: (boot) => run(boot, body) })

export const landingSuite = defineSuite<Boot>({
  seam: 'landing',
  // 1.0 (PROP-0017 L0): prepare binds the exact head and target; land only on that subject, never
  // twice; a moved target or head, or another subject, is a typed refusal that changes nothing;
  // status never says landed before it is.
  contract: '1.0',
  scenarios: [
    scenario('prepare-binds-exact', 'prepare binds a landing to its exact head and target: the same subject for the same target, another for another head or target, on the run\'s branch, within a request\'s subject; with what an approval and a denial do; and it changes nothing (INV-5)', async ({ provider, world }) => {
      const t = await world.target()
      const p = prepared(await provider.prepare(t))
      expect(p.provider).toBe(provider.id)
      expect(p.subject).toMatchObject({ type: 'git-head', ref: t.branch })
      expect(p.subject.version.length).toBeGreaterThan(0)
      expect(p.subject.version.length).toBeLessThanOrEqual(SUBJECT_VERSION_MAX)
      expect(prepared(await provider.prepare({ ...t })).subject).toEqual(p.subject)
      expect(prepared(await provider.prepare({ ...t, head: other(t.head) })).subject.version).not.toBe(p.subject.version)
      expect(prepared(await provider.prepare({ ...t, base: { ...t.base, sha: other(t.base.sha) } })).subject.version).not.toBe(p.subject.version)
      expect(p.consequences.length).toBeGreaterThan(0)
      for (const c of p.consequences) expect(typeof c === 'string' && c.length > 0).toBe(true)
      expect(await world.baseOf(t)).toBe(t.base.sha)
    }),

    scenario('lands-on-approval', 'lands on an approval of its exact subject: the target\'s new head holds the result, and is the commit reported', async ({ provider, world }) => {
      const t = await world.target()
      const p = prepared(await provider.prepare(t))
      const done = landed(await provider.land(request(t, p.subject)))
      expect(done).toMatchObject({ provider: provider.id, already: false })
      expect(await world.baseOf(t)).toBe(done.commit)
      expect(done.commit).not.toBe(t.base.sha)
      expect(await world.holds(done.commit, t.head)).toBe(true)
      expect(await world.holds(done.commit, t.base.sha)).toBe(true)
    }),

    scenario('never-twice', 'never lands twice: asked again (a restart), it finds its own work done, reports the same commit as already landed, and the target does not move (INV-4)', async ({ provider, world }) => {
      const t = await world.target()
      const p = prepared(await provider.prepare(t))
      const first = landed(await provider.land(request(t, p.subject)))
      const again = landed(await provider.land(request(t, p.subject)))
      expect(again).toMatchObject({ provider: provider.id, already: true, commit: first.commit })
      expect(await world.baseOf(t)).toBe(first.commit)
    }),

    scenario('unbound-refused', 'refuses, as unbound, an approval of another subject (another head, another target, another branch), and changes nothing (INV-5)', async ({ provider, world }) => {
      const t = await world.target()
      const p = prepared(await provider.prepare(t))
      const forOtherHead = prepared(await provider.prepare({ ...t, head: other(t.head) })).subject
      const forOtherBase = prepared(await provider.prepare({ ...t, base: { ...t.base, sha: other(t.base.sha) } })).subject
      for (const subject of [forOtherHead, forOtherBase, { ...p.subject, ref: `${t.branch}-other` }]) {
        expect(sameSubject(p.subject, subject)).toBe(false)
        refused(await provider.land(request(t, subject)), 'unbound', provider.id)
      }
      expect(await world.baseOf(t)).toBe(t.base.sha)
    }),

    scenario('base-moved-refused', 'refuses, as base-moved, a target that moved since the approval, and changes nothing: the merge is asked again on the target as it is (INV-2, INV-5)', async ({ provider, world }) => {
      const t = await world.target()
      const p = prepared(await provider.prepare(t))
      const moved = await world.moveBase(t)
      refused(await provider.land(request(t, p.subject)), 'base-moved', provider.id)
      expect(await world.baseOf(t)).toBe(moved)
      expect(await world.holds(moved, t.head)).toBe(false)
    }),

    scenario('head-moved-refused', 'refuses, as head-moved, a run branch that is not at the approved head, and changes nothing (INV-5)', async ({ provider, world }) => {
      const t = await world.target()
      const p = prepared(await provider.prepare(t))
      const moved = await world.moveHead(t)
      refused(await provider.land(request(t, p.subject)), 'head-moved', provider.id)
      expect(await world.baseOf(t)).toBe(t.base.sha)
      expect(await world.holds(t.base.sha, moved)).toBe(false)
    }),

    scenario('status', 'tells where a landing stands without acting: never landed before it is; after, landed at the reported commit, or unknown with why (INV-4)', async ({ provider, world }) => {
      const t = await world.target()
      const check = (s: LandingStatus): void => {
        expect(s.provider).toBe(provider.id)
        if (s.state === 'unknown') expect(s.reason.length).toBeGreaterThan(0)
      }
      const before = await provider.status(t)
      check(before)
      expect(before.state).not.toBe('landed')
      expect(await world.baseOf(t)).toBe(t.base.sha)
      const done = landed(await provider.land(request(t, prepared(await provider.prepare(t)).subject)))
      const after = await provider.status(t)
      check(after)
      expect(after.state).not.toBe('open')
      if (after.state === 'landed') expect(after.commit).toBe(done.commit)
    }),
  ],
})

/** A merge in a {@link MemoryRepository}, as the local landing makes one (ADR-0060). */
export type MemoryMerge =
  | { outcome: 'merged'; commit: string; already: boolean }
  | { outcome: 'refused'; cause: 'head-moved' | 'base-moved' | 'gone'; reason: string }

/**
 * A repository in memory: commits and their parents, and branches. Its merge has the local landing's
 * semantics (ADR-0060): only while the branch is at the approved head; a target that already holds
 * the head is done (`already`); a target not at the approved base is refused; else one merge commit.
 */
export class MemoryRepository {
  readonly parents = new Map<string, string[]>()
  readonly branches = new Map<string, string>()
  private count = 0
  private runs = 0

  constructor(readonly path = '/memory/repository', readonly target = 'main') {
    this.branches.set(target, this.commit([]))
  }

  /** A new commit on top of `parents`. */
  commit(parents: string[]): string {
    const sha = (++this.count).toString(16).padStart(40, '0')
    this.parents.set(sha, parents)
    return sha
  }

  holds(commit: string, head: string): boolean {
    const seen = new Set<string>()
    const queue = [commit]
    while (queue.length) {
      const at = queue.pop()!
      if (at === head) return true
      if (seen.has(at)) continue
      seen.add(at)
      queue.push(...(this.parents.get(at) ?? []))
    }
    return false
  }

  /** A new run's branch, one commit on top of the target. */
  run(): LandingTarget {
    const runId = `run_${++this.runs}`
    const base = this.branches.get(this.target)!
    const branch = `system/run/${runId}`
    const head = this.commit([base])
    this.branches.set(branch, head)
    return { runId, workspace: `/memory/worktrees/${runId}`, repository: this.path, branch, head, base: { branch: this.target, sha: base } }
  }

  /** Move `branch` on by one commit; its new head. */
  advance(branch: string): string {
    const head = this.commit([this.branches.get(branch)!])
    this.branches.set(branch, head)
    return head
  }

  merge(branch: string, head: string, base: { branch: string; sha: string }): MemoryMerge {
    const tip = this.branches.get(branch)
    if (tip === undefined) return { outcome: 'refused', cause: 'gone', reason: `${branch} is gone` }
    if (tip !== head) return { outcome: 'refused', cause: 'head-moved', reason: `${branch} is at ${tip}, not at ${head} as approved` }
    const now = this.branches.get(base.branch)
    if (now === undefined) return { outcome: 'refused', cause: 'base-moved', reason: `${base.branch} is gone` }
    if (this.holds(now, head)) return { outcome: 'merged', commit: now, already: true }
    if (now !== base.sha) return { outcome: 'refused', cause: 'base-moved', reason: `${base.branch} is at ${now} now, not at ${base.sha} as approved` }
    const commit = this.commit([now, head])
    this.branches.set(base.branch, commit)
    return { outcome: 'merged', commit, already: false }
  }

  /** The suite's world over this repository. */
  world(): World {
    return {
      target: async () => this.run(),
      moveBase: async (t) => this.advance(t.base.branch),
      moveHead: async (t) => this.advance(t.branch),
      baseOf: async (t) => this.branches.get(t.base.branch)!,
      holds: async (commit, head) => this.holds(commit, head),
    }
  }
}

/** The fake's subject version: its own, naming the target and the head. */
const fakeVersion = (t: LandingTarget): string => `landing:fake:${t.base.sha}:${t.head}`

/** The seam's fake: lands in a {@link MemoryRepository} of its own, and reads its status there. */
export class FakeLanding extends Landing {
  readonly id = 'fake'
  readonly repository = new MemoryRepository()

  async prepare(t: LandingTarget): Promise<Prepared> {
    return {
      outcome: 'prepared', provider: this.id, subject: { type: 'git-head', ref: t.branch, version: fakeVersion(t) },
      consequences: [`Approved: ${t.branch} at ${t.head} is merged into ${t.base.branch} at ${t.base.sha}.`, 'Denied: nothing is merged.'],
    }
  }

  async land(r: LandRequest): Promise<Landed | LandingRefusal> {
    const want = (await this.prepare(r)).subject
    if (!sameSubject(want, r.subject)) return { outcome: 'refused', provider: this.id, cause: 'unbound', reason: `the approval is of ${r.subject.ref} at ${r.subject.version ?? 'no version'}, not of ${want.ref} at ${want.version}` }
    const merged = this.repository.merge(r.branch, r.head, r.base)
    if (merged.outcome === 'refused') return { outcome: 'refused', provider: this.id, cause: merged.cause, reason: merged.reason }
    return { outcome: 'landed', provider: this.id, commit: merged.commit, already: merged.already }
  }

  async status(t: LandingTarget): Promise<LandingStatus> {
    const now = this.repository.branches.get(t.base.branch)
    return now !== undefined && this.repository.holds(now, t.head) ? { state: 'landed', provider: this.id, commit: now } : { state: 'open', provider: this.id }
  }
}
