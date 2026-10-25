// A landing's rebase of an accepted result onto its target as it is now (src/worktrees.ts, ADR-0068):
// the agents source replays the run's committed change on top of the base in the run's worktree, which
// stays on its branch; with no conflict (or conflicts only in declared generated files, made again by the
// repository's commands) it commits the replay as the system's rebase commit; with a conflict elsewhere it
// leaves the files marked for a writing step, commits the resolution once no marker is left, or puts the
// branch back at the head. Each phase finds its own work done when asked again (INV-4).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRuntimeRegistry, { type AgentRuntimeProvider, type RunSpec } from '@tsuuanmi/system-agent-runtimes'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import { captureGitSubject } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type WorkRequirement } from '@tsuuanmi/system-workers'
import type { Landed, LandStep } from '@tsuuanmi/system-workers-core'
import { afterEach, describe, expect, it } from 'vitest'
import AgentWorkers, { type Config } from '../src/index.ts'
import { ONTO_TRAILER, REBASED_TRAILER, rebaseRef, SUBJECT_TRAILER } from '../src/worktrees.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

function findBwrap(): string | undefined {
  try {
    return execFileSync('sh', ['-c', 'command -v bwrap'], { encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}
// CI requires the real bubblewrap, so a missing one fails instead of skipping silently.
const CONFINES = !!findBwrap() || process.env.SYSTEM_REQUIRE_BWRAP === '1'

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' }).trim()

/** `generated.txt` lists the repository's `.js` files, one a line: what `node gen.mjs` writes. */
const listing = (...names: string[]): string => `${[...names].sort().join('\n')}\n`

/** A repository on `main` with a source file, a generated file, and the command that makes it. */
function repository(): string {
  const dir = temp('system-rebase-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(dir, 'gen.mjs'), [
    "import { readdirSync, writeFileSync } from 'node:fs'",
    "writeFileSync('generated.txt', readdirSync('.').filter((n) => n.endsWith('.js')).sort().join('\\n') + '\\n')",
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'dep.js'), 'export const dep = 1\n')
  writeFileSync(join(dir, 'generated.txt'), listing('dep.js'))
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** A writing agent: it adds `used.js` and makes `generated.txt` again; told to clash, it also writes its own `main.js`. */
class WritingAgent implements AgentRuntimeProvider {
  readonly kind = 'scripted'
  readonly runs: RunSpec[] = []
  async probe() {
    return { available: true, detail: 'scripted 1.0', sandboxes: ['read-only', 'workspace-write'] as Array<'read-only' | 'workspace-write'>, resume: true, executes: true, readsConfined: true, gatesToolCalls: true }
  }
  async run(spec: RunSpec, _signal: AbortSignal, onHandle?: (handle: string) => void) {
    this.runs.push(spec)
    onHandle?.(`h-${this.runs.length}`)
    writeFileSync(join(spec.workspace, 'used.js'), 'export const used = 1\n')
    const names = ['dep.js', 'used.js']
    if (spec.prompt.includes('clash')) {
      writeFileSync(join(spec.workspace, 'main.js'), 'export const main = "theirs"\n')
      names.push('main.js')
    }
    writeFileSync(join(spec.workspace, 'generated.txt'), listing(...names))
    return { text: 'done', nativeHandle: `h-${this.runs.length}`, turns: 1 }
  }
}

const GEN = 'node gen.mjs'
const SETUP = ['mkdir -p node_modules']

const policy = (commands: string[]): AutonomyPolicy => ({
  schema: 'autonomy-policy@1.0', id: 'studio-test', version: 1, scope: 'studio',
  rules: [
    { actionClass: 'read', mode: 'auto' }, { actionClass: 'workspace-write', mode: 'auto', requires: ['tests', 'lint'] }, { actionClass: 'command', mode: 'ask' },
    ...(['merge', 'external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'remediation', 'policy-change'] as const).map((actionClass) => ({ actionClass, mode: 'ask' as const })),
  ],
  default: 'ask', commands, expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
})

const requirement: WorkRequirement = {
  schema: 'work-requirement@1.0', objective: 'change the code', capabilities: ['develop', 'local-data'],
  data: { classification: 'operator-shared', refs: [] }, egressPolicy: 'egress.classification-and-secrets',
  tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' },
}

/** Booted with the repository's generated file declared (its command run confined, as a setup's), or with none. */
async function boot(repo: string, generated: boolean) {
  const ctx = new Context()
  const agent = new WritingAgent()
  const config: Config = {
    workers: [{ id: 'dev', runtime: 'scripted', workspace: repo, sandbox: 'workspace-write', tier: 'standard', tools: [], worktreePerRun: true }],
    worktreeRoot: temp('system-worktrees-'),
    ...(generated ? { worktreeSetup: [{ repository: repo, commands: SETUP, generated: { paths: ['generated.txt'], commands: [GEN] } }] } : {}),
  }
  const fibers = [
    ctx.plugin(Store, { path: join(temp('system-rebase-'), 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(StoreApprovals, { policies: [policy(generated ? [...SETUP, GEN] : [])] }),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(AgentWorkers, config),
  ]
  await Promise.all(fibers)
  ctx.agentRuntimes.register(agent)
  cleanups.push(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  const land = async (step: LandStep): Promise<Landed> => {
    const landed = await ctx.workers.land!(step)
    if (!landed) throw new Error('no source holds the worktree')
    return landed
  }
  /**
   * One writing run of `agent:dev` in workflow run `runId`, its result committed on its branch as a
   * landing commits it; then `main` moves on by `move` (default: `other.js` added, which nothing of the
   * run touches), and the commit is asked again, as the landing does before it asks for the merge.
   */
  const accepted = async (runId: string, prompt = 'write', move: () => void = () => {
    writeFileSync(join(repo, 'other.js'), 'export const other = 1\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'main moves')
  }) => {
    const source = ctx.workers.source('agents')!
    const started = source.start({ key: `${runId}-${Math.random()}`, worker: 'agent:dev', prompt, sessionId: `ses_${runId}`, runId, requirement, decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
    const done = await source.wait(started.id, 30_000)
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: 'completed' })
    const workspace = agent.runs.at(-1)!.workspace
    const { subject } = captureGitSubject(workspace)!
    const fork = git(repo, 'rev-parse', 'HEAD')
    const first = await land({ step: 'commit', runId, workspace, subject: { ref: subject.ref, version: subject.version! }, message: `system: land ${runId}\n\nSystem-Task: t1` })
    if (first.outcome !== 'committed') throw new Error(`not committed: ${JSON.stringify(first)}`)
    expect(first.fork).toBe(fork)
    move()
    const committed = await land({ step: 'commit', runId, workspace, subject: { ref: subject.ref, version: subject.version! }, message: 'again' })
    if (committed.outcome !== 'committed') throw new Error(`not committed: ${JSON.stringify(committed)}`)
    return { workspace, subject: { ref: subject.ref, version: subject.version! }, committed, fork }
  }
  return { ctx, agent, land, accepted }
}

const rebaseOf = (runId: string, workspace: string, head: string, base: { branch: string; sha: string }, phase: 'start' | 'resolved' | 'abandon' = 'start'): Extract<LandStep, { step: 'rebase' }> =>
  ({ step: 'rebase', runId, workspace, phase, head, base, message: `Rebased onto ${base.branch} at ${base.sha}.` })

describe('a landing\'s rebase of an accepted result onto its target (ADR-0068)', { timeout: 90_000 }, () => {
  it('replays a result whose target moved without conflict on top of it, as the system\'s rebase commit on the run\'s branch, the head kept; asked again it is found done, and the landing\'s commit finds it its own (INV-4, INV-5)', async () => {
    const repo = repository()
    const { land, accepted } = await boot(repo, false)
    const { workspace, subject, committed, fork } = await accepted('run_clean')
    // The base moved since the result's work started: its fork is not the base's head.
    expect(committed.fork).toBe(fork)
    expect(committed.fork).not.toBe(committed.base.sha)
    const rebased = await land(rebaseOf('run_clean', workspace, committed.head, committed.base))
    if (rebased.outcome !== 'rebased') throw new Error(JSON.stringify(rebased))
    expect(rebased).toMatchObject({ source: 'agents', branch: committed.branch, from: committed.head, base: committed.base, already: false })
    expect(rebased.regenerated).toBeUndefined()
    // On the base, holding both sides; the worktree clean on its branch at it, and the subject is that tree.
    expect(git(workspace, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${committed.branch}`)
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(rebased.head)
    expect(git(workspace, 'log', '-1', '--format=%P', rebased.head)).toBe(committed.base.sha)
    expect(git(workspace, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(workspace, 'other.js'))).toBe(true)
    expect(readFileSync(join(workspace, 'used.js'), 'utf8')).toBe('export const used = 1\n')
    expect(rebased.subject).toEqual({ ref: rebased.head, version: captureGitSubject(workspace)!.subject.version })
    expect(rebased.stat).toMatch(/used\.js/)
    expect(rebased.stat).not.toMatch(/other\.js/)
    // The system's commit, the head's message kept with the step's line and the rebase's trailers.
    const message = git(workspace, 'log', '-1', '--format=%an <%ae>%n%B', rebased.head)
    expect(message).toMatch(/^system <system@localhost>\nsystem: land run_clean\n/)
    expect(message).toContain(`Rebased onto main at ${committed.base.sha}.`)
    expect(message).toContain(`${SUBJECT_TRAILER}: git:${subject.ref}:${subject.version}`)
    expect(message).toMatch(new RegExp(`${REBASED_TRAILER}: ${committed.head}\n${ONTO_TRAILER}: ${committed.base.sha}$`))
    // What the branch held before is kept, for the operator.
    expect(git(repo, 'rev-parse', rebaseRef('run_clean', committed.head))).toBe(committed.head)
    // Asked again (a restart): found done, nothing made twice.
    expect(await land(rebaseOf('run_clean', workspace, committed.head, committed.base))).toMatchObject({ outcome: 'rebased', head: rebased.head, already: true })
    // The landing's commit, asked again on the accepted subject, finds the rebase its own: nothing to rebase now.
    const again = await land({ step: 'commit', runId: 'run_clean', workspace, subject, message: 'again' })
    expect(again).toMatchObject({ outcome: 'committed', head: rebased.head, committed: false, fork: committed.base.sha, contained: false })
    // And it merges into the base with no conflict.
    const merged = await land({ step: 'merge', runId: 'run_clean', workspace, head: rebased.head, base: committed.base, message: 'merge it' })
    expect(merged).toMatchObject({ outcome: 'merged', head: rebased.head })
    expect(readFileSync(join(repo, 'used.js'), 'utf8')).toBe('export const used = 1\n')
  })

  it('leaves a conflict in a source file marked in the worktree, on its branch at the base, for a writing step; refuses a resolution with markers left; commits one without them (INV-2, INV-4)', async () => {
    const repo = repository()
    const { land, accepted } = await boot(repo, false)
    const { workspace, committed } = await accepted('run_conflict', 'write and clash', () => {
      writeFileSync(join(repo, 'main.js'), 'export const main = "ours"\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', 'main adds its own main.js')
    })
    const step = rebaseOf('run_conflict', workspace, committed.head, committed.base)
    const conflicted = await land(step)
    if (conflicted.outcome !== 'conflicted') throw new Error(JSON.stringify(conflicted))
    // Both sides added main.js; generated.txt changed on the result's side only, so it replays as it is.
    expect(conflicted).toMatchObject({ from: committed.head, base: committed.base, fork: committed.fork, files: ['main.js'], more: 0 })
    expect(conflicted.moved).toEqual([expect.stringMatching(/^[0-9a-f]+ main adds its own main\.js$/)])
    expect(git(workspace, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${committed.branch}`)
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(committed.base.sha)
    expect(readFileSync(join(workspace, 'main.js'), 'utf8')).toMatch(/^<<<<<<< /m)
    // Asked again (a restart before the Worker started): the same conflict, nothing replayed twice.
    expect(await land(step)).toMatchObject({ outcome: 'conflicted', files: ['main.js'] })
    // Called resolved with a marker left: refused, the worktree left as it is.
    expect(await land({ ...step, phase: 'resolved' })).toMatchObject({ outcome: 'refused', cause: 'conflict', reason: expect.stringContaining('conflict markers are left in main.js') })
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(committed.base.sha)
    // Resolved, the base's behaviour kept beside the result's: committed as the rebase.
    writeFileSync(join(workspace, 'main.js'), 'export const main = "ours"\nexport const theirs = "theirs"\n')
    const rebased = await land({ ...step, phase: 'resolved' })
    if (rebased.outcome !== 'rebased') throw new Error(JSON.stringify(rebased))
    expect(git(workspace, 'log', '-1', '--format=%P', rebased.head)).toBe(committed.base.sha)
    expect(git(workspace, 'status', '--porcelain')).toBe('')
    expect(git(workspace, 'show', `${rebased.head}:main.js`)).toBe('export const main = "ours"\nexport const theirs = "theirs"')
    expect(await land({ ...step, phase: 'resolved' })).toMatchObject({ outcome: 'rebased', head: rebased.head, already: true })
  })

  it('puts the branch and the worktree back at the head when a conflict is given up, and the retention never commits a rebase left unresolved (INV-2)', async () => {
    const repo = repository()
    const { land, accepted } = await boot(repo, false)
    const { workspace, committed } = await accepted('run_abandon', 'write and clash', () => {
      writeFileSync(join(repo, 'main.js'), 'export const main = "ours"\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-q', '-m', 'main adds its own main.js')
    })
    const step = rebaseOf('run_abandon', workspace, committed.head, committed.base)
    expect(await land(step)).toMatchObject({ outcome: 'conflicted' })
    writeFileSync(join(workspace, 'notes.txt'), 'what the resolution left\n')
    const abandoned = await land({ ...step, phase: 'abandon' })
    expect(abandoned).toMatchObject({ outcome: 'abandoned', head: committed.head, left: ['notes.txt'] })
    expect(git(workspace, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${committed.branch}`)
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(committed.head)
    expect(git(workspace, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(readFileSync(join(workspace, 'main.js'), 'utf8')).toBe('export const main = "theirs"\n')
    // Asked again: still back, nothing else touched.
    expect(await land({ ...step, phase: 'abandon' })).toMatchObject({ outcome: 'abandoned', head: committed.head })
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('what the resolution left\n')
    // The base moved: a merge of the head is still the operator's to ask, as before any rebase.
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(committed.base.sha)
  })

  it('after a restart between moving the branch to the base and making the worktree the base\'s, replays again instead of committing the head\'s tree on the base (INV-4)', async () => {
    const repo = repository()
    const { land, accepted } = await boot(repo, false)
    const { workspace, committed } = await accepted('run_crash')
    // What the start does before its crash: the head kept, the branch moved to the base; the worktree's files are still the head's.
    git(repo, 'update-ref', rebaseRef('run_crash', committed.head), committed.head)
    git(repo, 'update-ref', `refs/heads/${committed.branch}`, committed.base.sha, committed.head)
    expect(existsSync(join(workspace, 'other.js'))).toBe(false)
    expect(git(workspace, 'status', '--porcelain')).not.toBe('')
    const rebased = await land(rebaseOf('run_crash', workspace, committed.head, committed.base))
    if (rebased.outcome !== 'rebased') throw new Error(JSON.stringify(rebased))
    // The base's change is kept, the result's replayed on it: not the head's tree committed over the base.
    expect(git(workspace, 'log', '-1', '--format=%P', rebased.head)).toBe(committed.base.sha)
    expect(git(workspace, 'show', `${rebased.head}:other.js`)).toBe('export const other = 1')
    expect(git(workspace, 'show', `${rebased.head}:used.js`)).toBe('export const used = 1')
    expect(git(workspace, 'diff', '--name-only', committed.base.sha, rebased.head).split('\n').sort()).toEqual(['generated.txt', 'used.js'])
    expect(git(workspace, 'status', '--porcelain')).toBe('')
    // A resolution is never committed for a rebase that was begun and not replayed.
    const repo2 = repository()
    const second = await boot(repo2, false)
    const two = await second.accepted('run_crash2')
    git(repo2, 'update-ref', rebaseRef('run_crash2', two.committed.head), two.committed.head)
    git(repo2, 'update-ref', `refs/heads/${two.committed.branch}`, two.committed.base.sha, two.committed.head)
    expect(await second.land(rebaseOf('run_crash2', two.workspace, two.committed.head, two.committed.base, 'resolved'))).toMatchObject({ outcome: 'refused', cause: 'failed', reason: expect.stringContaining('never replayed') })
  })

  it('after a restart that finds the rebase committed, takes it only on a clean worktree, its subject the committed tree that lands; an edit since is refused, left as it is (INV-4, INV-5)', async () => {
    const repo = repository()
    const { land, accepted } = await boot(repo, false)
    const { workspace, committed } = await accepted('run_edited')
    const step = rebaseOf('run_edited', workspace, committed.head, committed.base)
    const rebased = await land(step)
    if (rebased.outcome !== 'rebased') throw new Error(JSON.stringify(rebased))
    // The process dies before the landing stores the rebase; meanwhile the worktree is edited, tracked and untracked.
    writeFileSync(join(workspace, 'used.js'), 'export const used = 2\n')
    writeFileSync(join(workspace, 'extra.js'), 'export const extra = 1\n')
    for (const phase of ['start', 'resolved'] as const) {
      const again = await land({ ...step, phase })
      expect(again).toMatchObject({ outcome: 'refused', cause: 'moved', reason: expect.stringMatching(/holds uncommitted changes \(.*used\.js.*\) beside .*rebase commit/) })
      expect(again).not.toHaveProperty('subject')
    }
    // Nothing was touched: the branch at the rebase commit, the edits still there.
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(rebased.head)
    expect(readFileSync(join(workspace, 'used.js'), 'utf8')).toBe('export const used = 2\n')
    expect(existsSync(join(workspace, 'extra.js'))).toBe(true)
    // Clean again: found done, and the subject is the committed tree, the one that lands.
    git(workspace, 'checkout', '--', 'used.js')
    rmSync(join(workspace, 'extra.js'))
    const done = await land(step)
    expect(done).toMatchObject({ outcome: 'rebased', head: rebased.head, already: true, subject: rebased.subject })
  })

  it('refuses a rebase whose head or base is not where the step says, changing nothing (INV-5)', async () => {
    const repo = repository()
    const { land, accepted } = await boot(repo, false)
    const { workspace, committed } = await accepted('run_moved')
    expect(await land(rebaseOf('run_moved', workspace, 'f'.repeat(40), committed.base))).toMatchObject({ outcome: 'refused', cause: 'head-moved' })
    expect(await land(rebaseOf('run_moved', workspace, committed.head, { branch: 'main', sha: committed.fork! }))).toMatchObject({ outcome: 'refused', cause: 'base-moved' })
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(committed.head)
    expect(git(workspace, 'status', '--porcelain')).toBe('')
  })

  describe.skipIf(!CONFINES)('under the real bubblewrap', () => {
    it('makes the declared generated files again after the replay, a conflict only in them taking a side first, and names them (T166, INV-13)', async () => {
      const repo = repository()
      const { land, accepted } = await boot(repo, true)
      const { workspace, committed } = await accepted('run_generated', 'write', () => {
        writeFileSync(join(repo, 'main.js'), 'export const main = 1\n')
        writeFileSync(join(repo, 'generated.txt'), listing('dep.js', 'main.js'))
        git(repo, 'add', '.')
        git(repo, 'commit', '-q', '-m', 'main moves')
      })
      const rebased = await land(rebaseOf('run_generated', workspace, committed.head, committed.base))
      if (rebased.outcome !== 'rebased') throw new Error(JSON.stringify(rebased))
      expect(rebased.regenerated).toMatchObject({ files: ['generated.txt'], commands: [GEN] })
      expect(rebased.regenerated!.autonomy.length).toBeGreaterThan(0)
      expect(git(workspace, 'show', `${rebased.head}:generated.txt`)).toBe(listing('dep.js', 'main.js', 'used.js').trimEnd())
      expect(git(workspace, 'status', '--porcelain')).toBe('')
    })
  })
})
