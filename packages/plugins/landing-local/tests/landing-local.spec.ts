import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import { LANDING_CONTRACT, type LandingTarget } from '@tsuuanmi/system-landing-core'
import Store from '@tsuuanmi/system-store'
import WorkerRouter from '@tsuuanmi/system-workers'
import type { Landed, LandStep } from '@tsuuanmi/system-workers-core'
import { describe, expect, it, onTestFinished } from 'vitest'
import { type Booted, landingSuite, MemoryRepository } from '../../../landing-core/conformance/landing.ts'
import { runSuite } from '../../../libs/conformance/runner.ts'
import LocalLanding, { landingVersion, localLanding } from '../src/index.ts'

/**
 * A Worker source that holds a worktree for each run of a repository in memory and merges as the
 * `agents` source does (ADR-0060): only the merge step, at exact SHAs, a merge done before found done.
 * Every step it is asked is kept.
 */
class MemorySource {
  readonly steps: LandStep[] = []
  readonly repo = new MemoryRepository()
  private readonly held = new Map<string, LandingTarget>()
  /** Set: the next step throws, as a source whose git failed would. */
  throws = false

  target(): LandingTarget {
    const t = this.repo.run()
    this.held.set(`${t.runId}\n${t.workspace}`, t)
    return t
  }

  source() {
    return {
      name: 'memory', describe: async () => [],
      start: () => {
        throw new Error('the memory source runs nothing')
      },
      get: () => undefined, wait: () => Promise.reject(new Error('the memory source runs nothing')),
      land: async (step: LandStep): Promise<Landed | undefined> => {
        this.steps.push(step)
        if (this.throws) throw new Error('git is not there')
        const t = this.held.get(`${step.runId}\n${step.workspace}`)
        if (!t || step.step !== 'merge') return undefined
        const merged = this.repo.merge(t.branch, step.head, step.base)
        if (merged.outcome === 'refused') return merged
        return { outcome: 'merged', repository: t.repository, branch: t.branch, head: step.head, base: step.base, commit: merged.commit, already: merged.already }
      },
    }
  }
}

async function boot(through: 'seam' | 'call'): Promise<Booted & { source: MemorySource; ctx: Context }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-landing-local-'))
  const ctx = new Context()
  const source = new MemorySource()
  const fibers: Fiber[] = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(WorkerRouter, {})]
  await Promise.all(fibers)
  ctx.workers.register(source.source())
  if (through === 'seam') {
    const fiber = ctx.plugin(LocalLanding)
    await fiber
    fibers.push(fiber)
  }
  const world = source.repo.world()
  return {
    ctx, source, provider: through === 'seam' ? ctx.landing : localLanding(() => ctx.workers),
    world: { ...world, target: async () => source.target() },
    dispose: async () => {
      for (const fiber of [...fibers].reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

// The local provider passes the suite every provider must pass (ADR-0037), as the seam's provider and as a plain call.
runSuite(landingSuite, { name: 'landing-local, as ctx.landing over ctx.workers', contract: LANDING_CONTRACT, boot: () => boot('seam') })
runSuite(landingSuite, { name: 'landing-local, as a plain call over ctx.workers', contract: LANDING_CONTRACT, boot: () => boot('call') })

describe('landing-local wraps today\'s local landing unchanged (ADR-0060)', () => {
  const approve = async (b: Awaited<ReturnType<typeof boot>>) => {
    onTestFinished(() => b.dispose?.())
    const t = await b.world.target()
    const prepared = await b.provider.prepare(t)
    if (prepared.outcome !== 'prepared') throw new Error(prepared.reason)
    return { t, subject: prepared.subject }
  }

  it('binds the merge to landing:merge:<base>:<head> on the run\'s branch, and asks the merge step of workers.land exactly as the engine did', async () => {
    const b = await boot('seam')
    const { t, subject } = await approve(b)
    expect(subject).toEqual({ type: 'git-head', ref: t.branch, version: landingVersion(t.base.sha, t.head) })
    const landed = await b.provider.land({ ...t, subject, approval: 'sha256:x', message: 'system: merge it' })
    expect(landed).toMatchObject({ outcome: 'landed', provider: 'local', source: 'memory', already: false })
    expect(b.source.steps).toEqual([{ step: 'merge', runId: t.runId, workspace: t.workspace, head: t.head, base: t.base, message: 'system: merge it' }])
  })

  it('asks nothing of the workers seam on an approval of another subject', async () => {
    const b = await boot('call')
    const { t, subject } = await approve(b)
    expect(await b.provider.land({ ...t, subject: { ...subject, version: landingVersion(t.base.sha, `${t.head}0`) }, approval: 'sha256:x', message: 'm' })).toMatchObject({ outcome: 'refused', cause: 'unbound' })
    expect(b.source.steps).toEqual([])
  })

  it('refuses as gone when no source holds the worktree, and as failed when the source throws (the workers seam\'s refusal), changing nothing', async () => {
    const b = await boot('call')
    const { t, subject } = await approve(b)
    expect(await b.provider.land({ ...t, workspace: '/elsewhere', subject, approval: 'sha256:x', message: 'm' })).toEqual({ outcome: 'refused', provider: 'local', cause: 'gone', reason: `no Worker source holds the worktree of run ${t.runId} any more` })
    b.source.throws = true
    expect(await b.provider.land({ ...t, subject, approval: 'sha256:x', message: 'm' })).toMatchObject({ outcome: 'refused', provider: 'local', cause: 'failed' })
    expect(await b.world.baseOf(t)).toBe(t.base.sha)
  })

  it('refuses with no land on the workers seam, and a version too long for a request\'s subject', async () => {
    const none = localLanding(() => ({}))
    const t: LandingTarget = { runId: 'r', workspace: '/w', repository: '/repo', branch: 'system/run/r', head: 'c'.repeat(40), base: { branch: 'main', sha: 'b'.repeat(40) } }
    const prepared = await none.prepare(t)
    if (prepared.outcome !== 'prepared') throw new Error(prepared.reason)
    expect(await none.land({ ...t, subject: prepared.subject, approval: 'sha256:x', message: 'm' })).toEqual({ outcome: 'refused', provider: 'local', cause: 'failed', reason: 'the workers seam cannot land a result (no land)' })
    expect(await none.prepare({ ...t, head: 'c'.repeat(64), base: { branch: 'main', sha: 'b'.repeat(64) } })).toMatchObject({ outcome: 'refused', cause: 'failed', reason: expect.stringMatching(/longer than a request's subject holds \(143 > 128\)/) })
  })
})
