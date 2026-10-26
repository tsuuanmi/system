// A landing's merge that conflicts only in files the repository declares generated (src/regenerate.ts,
// src/worktrees.ts, T166): the agents source makes the merge in the run's worktree, takes a side of each
// conflicted file, runs the repository's commands for them confined as the setup runs, and moves the base
// to that one merge commit only when they exit 0, change no other file, and change nothing on a repeat.
// A conflict in any other file, a command that fails, or one that changes another file refuses, the
// repository as it was (INV-2).
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
import { afterEach, describe, expect, it } from 'vitest'
import AgentWorkers, { type Config } from '../src/index.ts'
import { generatedPath, loadSetups } from '../src/setup.ts'

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

/** A repository with a generated file, the command that makes it, and a command that fails. */
function repository(): string {
  const dir = temp('system-regenerate-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(dir, 'gen.mjs'), [
    "import { readdirSync, writeFileSync } from 'node:fs'",
    "writeFileSync('generated.txt', readdirSync('.').filter((n) => n.endsWith('.js')).sort().join('\\n') + '\\n')",
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'fail.mjs'), "console.error('gen: the sources do not parse')\nprocess.exit(2)\n")
  // What pnpm does before a script unless told not to (T235): an install, which needs the network the confinement does not give.
  writeFileSync(join(dir, 'pnpm-like.mjs'), [
    "if (process.env.pnpm_config_verify_deps_before_run !== 'false') { console.error('pnpm-like: verify-deps-before-run started an install: failed to lookup address'); process.exit(1) }",
    "if (process.env.pnpm_config_offline !== 'true') { console.error('pnpm-like: not offline'); process.exit(1) }",
    "await import('./gen.mjs')",
    '',
  ].join('\n'))
  writeFileSync(join(dir, 'dep.js'), 'export const dep = 1\n')
  writeFileSync(join(dir, 'generated.txt'), listing('dep.js'))
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** A writing agent: it adds `used.js` (and, told to clash, its own `main.js`) and regenerates `generated.txt`, as a run does. */
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

const SETUP = ['mkdir -p node_modules']
const GEN = 'node gen.mjs'

/** The studio policy: listed commands run as workspace-write (tests and lint pending); others ask. */
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

const writer = (workspace: string): Config['workers'][number] => ({ id: 'dev', runtime: 'scripted', workspace, sandbox: 'workspace-write', tier: 'standard', tools: [], worktreePerRun: true })

async function boot(repo: string, commands: string[], setup: string[] = SETUP) {
  const ctx = new Context()
  const agent = new WritingAgent()
  const config: Config = { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeSetup: [{ repository: repo, commands: setup, generated: { paths: ['generated.txt'], commands } }] }
  const fibers = [
    ctx.plugin(Store, { path: join(temp('system-regenerate-'), 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    // Each line once: a policy's commands list holds no line twice (a setup and a generated command may be the same).
    ctx.plugin(StoreApprovals, { policies: [policy([...new Set([...setup, ...commands])])] }),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(AgentWorkers, config),
  ]
  await Promise.all(fibers)
  ctx.agentRuntimes.register(agent)
  cleanups.push(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  /**
   * One writing run of `agent:dev` in workflow run `runId`, its result committed on its branch as a
   * landing commits it; then the base moves on `main` (`main.js` added, `generated.txt` made again),
   * and the merge of the branch, approved on the base as it is then, is asked of the source;
   * `meddle`, when given, acts on the worktree just before that.
   */
  const land = async (runId: string, prompt = 'write', meddle?: (workspace: string, base: { branch: string; sha: string }) => void) => {
    const source = ctx.workers.source('agents')!
    const started = source.start({ key: `${runId}-${Math.random()}`, worker: 'agent:dev', prompt, sessionId: `ses_${runId}`, runId, requirement, decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
    const done = await source.wait(started.id, 30_000)
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: 'completed' })
    const workspace = agent.runs.at(-1)!.workspace
    const { subject } = captureGitSubject(workspace)!
    const committed = await ctx.workers.land!({ step: 'commit', runId, workspace, subject: { ref: subject.ref, version: subject.version! }, message: `land ${runId}` })
    if (committed?.outcome !== 'committed') throw new Error(`not committed: ${JSON.stringify(committed)}`)
    writeFileSync(join(repo, 'main.js'), 'export const main = 1\n')
    writeFileSync(join(repo, 'generated.txt'), listing('dep.js', 'main.js'))
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'main moves')
    const base = { branch: 'main', sha: git(repo, 'rev-parse', 'HEAD') }
    meddle?.(workspace, base)
    const merged = await ctx.workers.land!({ step: 'merge', runId, workspace, head: committed.head, base, message: `Merge the accepted result of ${runId}` })
    return { merged, workspace, head: committed.head, base, branch: committed.branch }
  }
  return { ctx, land }
}

/** The worktree is back on its branch at the run's head, holding nothing uncommitted. */
const backOnBranch = (workspace: string, branch: string, head: string): void => {
  expect(git(workspace, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${branch}`)
  expect(git(workspace, 'rev-parse', 'HEAD')).toBe(head)
  expect(git(workspace, 'status', '--porcelain', '--untracked-files=no')).toBe('')
}

describe('a landing\'s conflict confined to generated files (worktreeSetup generated, T166)', { timeout: 90_000 }, () => {
  describe.skipIf(!CONFINES)('under the real bubblewrap', () => {
    it('lands a merge that conflicts only in a generated file, the file regenerated by the repository\'s command, as one merge commit of the base and the head (INV-13)', async () => {
      const repo = repository()
      const { ctx, land } = await boot(repo, [GEN])
      const { merged, workspace, head, base, branch } = await land('run_gen')
      expect(merged).toMatchObject({ source: 'agents', outcome: 'merged', head, base, already: false, regenerated: { files: ['generated.txt'], commands: [GEN] } })
      if (merged?.outcome !== 'merged') throw new Error('not merged')
      expect(merged.regenerated!.autonomy.length).toBeGreaterThan(0)
      // The base moved to exactly that merge commit, holding both sides and the file made from them.
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(merged.commit)
      expect(git(repo, 'log', '-1', '--format=%P', merged.commit)).toBe(`${base.sha} ${head}`)
      expect(git(repo, 'log', '-1', '--format=%an <%ae>%n%s', merged.commit)).toBe('system <system@localhost>\nMerge the accepted result of run_gen')
      expect(readFileSync(join(repo, 'generated.txt'), 'utf8')).toBe(listing('dep.js', 'main.js', 'used.js'))
      expect(git(repo, 'status', '--porcelain')).toBe('')
      backOnBranch(workspace, branch, head)
      // Asked again (a restart): found merged, not made twice.
      expect(await ctx.workers.land!({ step: 'merge', runId: 'run_gen', workspace, head, base, message: 'again' })).toMatchObject({ outcome: 'merged', commit: merged.commit, already: true })
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(merged.commit)
    })

    it('runs the generated files\' commands with pnpm\'s verify-deps-before-run off and offline, as a check\'s, so a pnpm script never starts an install (T235)', async () => {
      const repo = repository()
      const { merged } = await (await boot(repo, ['node pnpm-like.mjs'])).land('run_pnpm')
      expect(merged).toMatchObject({ outcome: 'merged', regenerated: { files: ['generated.txt'], commands: ['node pnpm-like.mjs'] } })
      expect(readFileSync(join(repo, 'generated.txt'), 'utf8')).toBe(listing('dep.js', 'main.js', 'used.js'))
    })

    it('refuses a merge that also conflicts in a source file: nothing is run, and the repository is as it was (INV-2)', async () => {
      const repo = repository()
      const { land } = await boot(repo, [GEN])
      const { merged, workspace, head, base, branch } = await land('run_clash', 'write and clash')
      expect(merged).toMatchObject({ outcome: 'refused', cause: 'conflict', reason: expect.stringMatching(/conflicts with main at \S+ in .*main\.js.*, of which main\.js is not declared generated: the merge was aborted, and the repository is as it was/) })
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(base.sha)
      expect(git(repo, 'status', '--porcelain')).toBe('')
      expect(readFileSync(join(repo, 'generated.txt'), 'utf8')).toBe(listing('dep.js', 'main.js'))
      backOnBranch(workspace, branch, head)
    })

    it('refuses when a command fails, or changes a file that is not declared generated; the repository as it was, the worktree back on its branch (INV-2)', async () => {
      const failing = repository()
      const { land } = await boot(failing, [GEN, 'node fail.mjs'])
      const refused = await land('run_fail')
      expect(refused.merged).toMatchObject({ outcome: 'refused', cause: 'conflict', reason: expect.stringContaining('the generated files\' command 2 (node fail.mjs) exited with code 2. Its output ended: gen: the sources do not parse') })
      expect(refused.merged).toMatchObject({ reason: expect.stringContaining('the repository is as it was') })
      expect(git(failing, 'rev-parse', 'HEAD')).toBe(refused.base.sha)
      expect(git(failing, 'status', '--porcelain')).toBe('')
      backOnBranch(refused.workspace, refused.branch, refused.head)

      const straying = repository()
      const stray = await (await boot(straying, [GEN, 'touch stray.txt'])).land('run_stray')
      expect(stray.merged).toMatchObject({ outcome: 'refused', cause: 'conflict', reason: expect.stringContaining('changed stray.txt, which is not declared generated') })
      expect(git(straying, 'rev-parse', 'HEAD')).toBe(stray.base.sha)
      expect(git(straying, 'status', '--porcelain')).toBe('')
      backOnBranch(stray.workspace, stray.branch, stray.head)
    })

    it('refuses when a command makes, or changes, a file git ignores (INV-2)', async () => {
      const making = repository()
      const made = await (await boot(making, [GEN, 'touch node_modules/stray.txt'])).land('run_ignored_new')
      expect(made.merged).toMatchObject({ outcome: 'refused', cause: 'conflict', reason: expect.stringContaining('changed node_modules/stray.txt, which git ignores') })
      expect(git(making, 'rev-parse', 'HEAD')).toBe(made.base.sha)
      expect(git(making, 'status', '--porcelain')).toBe('')
      backOnBranch(made.workspace, made.branch, made.head)

      // An ignored file that was there before the commands, changed by them.
      const changing = repository()
      const changed = await (await boot(changing, [GEN, 'touch node_modules/kept.txt'], [...SETUP, 'touch node_modules/kept.txt'])).land('run_ignored_old', 'write', (workspace) => {
        utimesSync(join(workspace, 'node_modules', 'kept.txt'), new Date(2000, 0, 1), new Date(2000, 0, 1))
      })
      expect(changed.merged).toMatchObject({ outcome: 'refused', cause: 'conflict', reason: expect.stringContaining('changed node_modules/kept.txt, which git ignores') })
      expect(git(changing, 'rev-parse', 'HEAD')).toBe(changed.base.sha)
      backOnBranch(changed.workspace, changed.branch, changed.head)
    })

    it('refuses when a command changes, or removes, the worktree\'s .git file, which git lists neither as changed nor as ignored (INV-2)', async () => {
      const touching = repository()
      const touched = await (await boot(touching, [GEN, 'touch .git'])).land('run_control_touched', 'write', (workspace) => {
        utimesSync(join(workspace, '.git'), new Date(2000, 0, 1), new Date(2000, 0, 1))
      })
      expect(touched.merged).toMatchObject({ outcome: 'refused', cause: 'conflict', reason: expect.stringContaining('.git, the worktree\'s git control file') })
      expect(git(touching, 'rev-parse', 'HEAD')).toBe(touched.base.sha)
      expect(git(touching, 'status', '--porcelain')).toBe('')
      backOnBranch(touched.workspace, touched.branch, touched.head)

      // Removed: the worktree cannot be put back on its branch either, and the base is not moved.
      const removing = repository()
      const removed = await (await boot(removing, [GEN, 'rm -f .git'])).land('run_control_removed')
      expect(removed.merged).toMatchObject({ outcome: 'refused', cause: 'conflict', reason: expect.stringContaining('.git, the worktree\'s git control file') })
      expect(removed.merged).toMatchObject({ reason: expect.stringContaining(`could not be put back on ${removed.branch}`) })
      expect(git(removing, 'rev-parse', 'HEAD')).toBe(removed.base.sha)
      expect(git(removing, 'status', '--porcelain')).toBe('')
    })

    it('leaves a worktree found off its branch with uncommitted work as it is, and refuses, rather than forcing it back (INV-2)', async () => {
      const repo = repository()
      const { land } = await boot(repo, [GEN])
      const { merged, workspace, base } = await land('run_detached', 'write', (ws, at) => {
        git(ws, 'checkout', '-q', '--detach', at.sha)
        writeFileSync(join(ws, 'dep.js'), 'export const dep = "mine"\n')
      })
      expect(merged).toMatchObject({ outcome: 'refused', cause: 'conflict', reason: expect.stringMatching(/is not on \S+, and it is left as it is: it holds uncommitted changes outside the generated files \(dep\.js\)/) })
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(base.sha)
      expect(git(repo, 'status', '--porcelain')).toBe('')
      // Nothing of it was lost: still detached there, the change still in it.
      expect(git(workspace, 'rev-parse', 'HEAD')).toBe(base.sha)
      expect(readFileSync(join(workspace, 'dep.js'), 'utf8')).toBe('export const dep = "mine"\n')

      // Detached elsewhere, even clean: not this landing's merge, so not touched either.
      const other = repository()
      const elsewhere = await (await boot(other, [GEN])).land('run_elsewhere', 'write', (ws) => git(ws, 'checkout', '-q', '--detach', 'HEAD~1'))
      expect(elsewhere.merged).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('which is not this landing\'s merge of') })
      expect(git(elsewhere.workspace, 'rev-parse', 'HEAD')).toBe(git(elsewhere.workspace, 'rev-parse', `${elsewhere.head}~1`))
    })
  })

  it('refuses at load generated paths and commands that are not ones, and matches a * within one segment only', () => {
    const repo = repository()
    const load = (generated: unknown) => () => loadSetups([{ repository: repo, commands: ['true'], generated: generated as never }], [repo])
    expect(load({ paths: [], commands: ['true'] })).toThrow(/generated\.paths holds 1 to 32 paths/)
    expect(load({ paths: ['../outside'], commands: ['true'] })).toThrow(/generated path 1 \(\.\.\/outside\) is not a relative path/)
    expect(load({ paths: ['/etc/passwd'], commands: ['true'] })).toThrow(/is not a relative path/)
    expect(load({ paths: ['docs/**/x.md'], commands: ['true'] })).toThrow(/holds a glob character other than a single \*/)
    expect(load({ paths: ['.git/config'], commands: ['true'] })).toThrow(/names \.git, \.system, or every top-level entry/)
    expect(load({ paths: ['a.md', 'a.md'], commands: ['true'] })).toThrow(/names a path twice/)
    expect(load({ paths: ['a.md'], commands: [] })).toThrow(/generated\.commands holds 1 to 16 commands/)
    expect(load({ paths: ['a.md'], commands: ['pnpm gen && rm -rf /'] })).toThrow(/generated command 1 has a shell metacharacter/)
    expect(load(['a.md'])).toThrow(/generated holds paths and commands/)
    // Loaded: the commands as argv, and none of it in the setup's hash, so a setup's approvals stand when it changes.
    const plain = loadSetups([{ repository: repo, commands: ['true'] }], [repo]).get(repo)!
    const declared = loadSetups([{ repository: repo, commands: ['true'], generated: { paths: ['packages/*/plugin-manifest.json'], commands: ['corepack pnpm gen:manifests'] } }], [repo]).get(repo)!
    expect(declared).toMatchObject({ hash: plain.hash, generated: { paths: ['packages/*/plugin-manifest.json'], lines: ['corepack pnpm gen:manifests'], commands: [['corepack', 'pnpm', 'gen:manifests']] } })
    expect(plain.generated).toBeUndefined()
    // An omitted `generated`, as the plugin's config schema fills it in (both lists empty), declares none.
    expect(loadSetups([{ repository: repo, commands: ['true'], generated: { paths: [], commands: [] } }], [repo]).get(repo)!.generated).toBeUndefined()
    const patterns = ['docs/validation/traceability.md', 'packages/*/plugin-manifest.json', 'packages/plugins/*/plugin-manifest.json']
    expect(generatedPath(patterns, 'docs/validation/traceability.md')).toBe(true)
    expect(generatedPath(patterns, 'packages/workers-core/plugin-manifest.json')).toBe(true)
    expect(generatedPath(patterns, 'packages/plugins/agent-workers/plugin-manifest.json')).toBe(true)
    expect(generatedPath(patterns, 'packages/plugins/agent-workers/src/plugin-manifest.json')).toBe(false)
    expect(generatedPath(patterns, 'docs/validation/traceability.md.bak')).toBe(false)
    expect(generatedPath(patterns, 'packages/plugin-manifest.json')).toBe(false)
  })

  it('refuses at load, through the plugin\'s own config, a generated declaration that is not one', () => {
    const repo = repository()
    expect(() => new AgentWorkers(new Context(), { workers: [writer(repo)], worktreeSetup: [{ repository: repo, commands: ['true'], generated: { paths: ['x/../y'], commands: ['true'] } }] })).toThrow(/generated path 1 \(x\/\.\.\/y\) is not a relative path/)
  })
})
