// A workflow run's checks (src/checks.ts, T151, ADR-0063): the source that holds the run's worktree
// runs each check the run asks for with the command the operator configured for the repository, on
// the exact tree the result is on, confined as the setup is, only when the policy lets the command run
// unasked. A check passes on exit 0 and fails on any other code, only while the tree is unchanged
// after it; anything else is an error, neither passed nor failed. What ran is one check-run@1.0.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { captureGitSubject, SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import WorkerRouter, { type RunCheck, type WorkRequirement } from '@tsuuanmi/system-workers'
import { afterEach, describe, expect, it } from 'vitest'
import AgentWorkers, { type Config } from '../src/index.ts'
import { loadSetups } from '../src/setup.ts'

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

/** A repository whose tests need what its setup installs, and whose lint fails on a file the agent writes. */
function repository(): string {
  const dir = temp('system-checks-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(dir, 'test.mjs'), "import { ok } from './node_modules/dep/index.js'\nconsole.log(`tests: ${ok}`)\n")
  writeFileSync(join(dir, 'lint.mjs'), [
    "import { existsSync } from 'node:fs'",
    "if (existsSync('unused.js')) { console.error('lint: unused.js declares a variable it never uses'); process.exit(3) }",
    "console.log('lint: clean')",
    '',
  ].join('\n'))
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

/** A writing agent: it writes `unused.js` when its prompt says so, as a change the lint check judges. */
class WritingAgent implements AgentRuntimeProvider {
  readonly kind = 'scripted'
  readonly runs: RunSpec[] = []
  async probe() {
    return { available: true, detail: 'scripted 1.0', sandboxes: ['read-only', 'workspace-write'] as Array<'read-only' | 'workspace-write'>, resume: true, executes: true, readsConfined: true, gatesToolCalls: true }
  }
  async run(spec: RunSpec, _signal: AbortSignal, onHandle?: (handle: string) => void) {
    this.runs.push(spec)
    onHandle?.(`h-${this.runs.length}`)
    writeFileSync(join(spec.workspace, spec.prompt.includes('unused') ? 'unused.js' : 'used.js'), 'const kept = 1\n')
    return { text: 'done', nativeHandle: `h-${this.runs.length}`, turns: 1 }
  }
}

const SETUP = ['mkdir -p node_modules/dep', 'cp dep.js node_modules/dep/index.js']

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

type Setup = NonNullable<Config['worktreeSetup']>[number]

async function boot(repo: string, setup: Partial<Setup>, listed: string[] | null) {
  // The setup copies the dependency from the repository's own untracked file, so no view is needed.
  writeFileSync(join(repo, 'dep.js'), "export const ok = 'dep ok'\n")
  git(repo, 'add', 'dep.js')
  git(repo, 'commit', '-q', '-m', 'dep')
  const ctx = new Context()
  const agent = new WritingAgent()
  const config: Config = { workers: [writer(repo)], worktreeRoot: temp('system-worktrees-'), worktreeSetup: [{ repository: repo, commands: SETUP, ...setup }] }
  const fibers = [
    ctx.plugin(Store, { path: join(temp('system-checks-'), 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ...(listed ? [ctx.plugin(StoreApprovals, { policies: [policy(listed)] })] : []),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry), ctx.plugin(AgentWorkers, config),
  ]
  await Promise.all(fibers)
  ctx.agentRuntimes.register(agent)
  cleanups.push(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  /** One writing run of `agent:dev` in workflow run `runId`; its worktree and the exact tree it left. */
  const write = async (runId: string, prompt = 'write'): Promise<{ workspace: string; subject: { ref: string; version: string } }> => {
    const source = ctx.workers.source('agents')!
    const started = source.start({ key: `${runId}-${Math.random()}`, worker: 'agent:dev', prompt, sessionId: `ses_${runId}`, runId, requirement, decisions: { tier: 'sha256:0', route: 'sha256:0' } as never })
    const done = await source.wait(started.id, 30_000)
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: 'completed' })
    const workspace = agent.runs.at(-1)!.workspace
    const { subject } = captureGitSubject(workspace)!
    return { workspace, subject: { ref: subject.ref, version: subject.version! } }
  }
  const check = (runId: string, at: { workspace: string; subject: { ref: string; version: string } }, checks: RunCheck[] = ['tests', 'lint']) =>
    ctx.workers.check!({ runId, workspace: at.workspace, subject: at.subject, checks, classification: 'operator-shared' })
  return { ctx, write, check }
}

const TESTS = 'node test.mjs'
const LINT = 'node lint.mjs'

describe('a workflow run\'s checks (worktreeSetup checks, T151)', { timeout: 60_000 }, () => {
  describe.skipIf(!CONFINES)('under the real bubblewrap', () => {
    it('runs each check\'s configured command on the exact tree, confined, in the setup\'s environment: tests pass, lint fails by its exit code, recorded as check-run@1.0 (REQ-WF-15, INV-5, INV-13)', async () => {
      const repo = repository()
      const { ctx, write, check } = await boot(repo, { checks: { tests: TESTS, lint: LINT } }, [...SETUP, TESTS, LINT])
      const at = await write('run_lint', 'write unused')
      const checked = await check('run_lint', at)
      expect(checked).toMatchObject({
        source: 'agents', outcome: 'checked',
        results: [
          { check: 'tests', outcome: 'passed', exitCode: 0, reason: expect.stringContaining(`(${TESTS}) exited 0 on git:${at.subject.ref}:${at.subject.version}`) },
          { check: 'lint', outcome: 'failed', exitCode: 3, reason: expect.stringContaining(`(${LINT}) exited with code 3`) },
        ],
      })
      if (checked?.outcome !== 'checked') throw new Error('not checked')
      const evidence = ctx.artifacts.get(checked.evidence as `sha256:${string}`)!
      expect(evidence).toMatchObject({ kind: 'evidence', bodySchema: 'check-run@1.0', classification: 'operator-shared', runId: 'run_lint', producer: { type: 'system', ref: 'agent-workers' } })
      new SchemaRegistry().assert('check-run@1.0', evidence.body)
      const body = evidence.body as { subject: unknown; checks: Array<{ argv: string[]; autonomy: string; output: { tail: string; bytes: number; sha256: string } }> }
      expect(body.subject).toEqual({ type: 'git-head', ...at.subject })
      expect(body.checks[0]).toMatchObject({ argv: ['node', 'test.mjs'], output: { tail: 'tests: dep ok\n', bytes: 14 } })
      expect(body.checks[1]!.output.tail).toContain('lint: unused.js declares a variable it never uses')
      // Each command ran on the policy's own decision, named among the evidence's inputs.
      for (const c of body.checks) {
        expect(evidence.inputs).toContain(c.autonomy)
        expect(ctx.artifacts.get(c.autonomy as `sha256:${string}`)!.body).toMatchObject({ decisionType: 'autonomy' })
      }
      // The tree is as the result left it.
      expect(captureGitSubject(at.workspace)!.subject).toMatchObject(at.subject)
      // A clean change passes both.
      const clean = await write('run_clean')
      expect(await check('run_clean', clean)).toMatchObject({ outcome: 'checked', results: [{ check: 'tests', outcome: 'passed' }, { check: 'lint', outcome: 'passed', exitCode: 0 }] })
    })

    it('never passes a check that changed the tree it checks, and runs none after it; stops one at its deadline (INV-5, INV-9)', async () => {
      const repo = repository()
      const touch = 'touch stray.txt'
      const { check, write } = await boot(repo, { checks: { tests: touch, lint: LINT, typecheck: 'sleep 30' }, checkTimeoutSeconds: 1 }, [...SETUP, touch, LINT, 'sleep 30'])
      const at = await write('run_moves')
      expect(await check('run_moves', at)).toMatchObject({
        outcome: 'checked',
        results: [
          { check: 'tests', outcome: 'error', exitCode: 0, reason: expect.stringMatching(/the tests check \(touch stray\.txt\) left the worktree as git:\S+, no longer git:/) },
          { check: 'lint', outcome: 'error', reason: expect.stringMatching(/^not run: the tests check/) },
        ],
      })
      // The tree moved: the run's checks now refuse it, nothing run.
      expect(await check('run_moves', at)).toMatchObject({ outcome: 'refused', cause: 'moved' })
      const slow = await write('run_slow')
      const started = Date.now()
      expect(await check('run_slow', slow, ['typecheck'])).toMatchObject({ outcome: 'checked', results: [{ check: 'typecheck', outcome: 'error', reason: expect.stringContaining('did not finish within 1 s') }] })
      expect(Date.now() - started).toBeLessThan(15_000)
    })

    it('runs no check the policy does not let run unasked, none with no command configured, and none on a worktree its setup no longer matches; each stays an error, never passed (INV-2, INV-6)', async () => {
      const repo = repository()
      // The lint command is not on the policy's commands list: it would ask, so it is not run.
      const { ctx, write, check } = await boot(repo, { checks: { tests: TESTS, lint: LINT } }, [...SETUP, TESTS])
      const at = await write('run_ask')
      const checked = await check('run_ask', at, ['tests', 'lint', 'typecheck'])
      expect(checked).toMatchObject({
        outcome: 'checked',
        results: [
          { check: 'tests', outcome: 'passed' },
          { check: 'lint', outcome: 'error', reason: expect.stringContaining('the autonomy policy asks the operator about its command (node lint.mjs)') },
          { check: 'typecheck', outcome: 'error', reason: expect.stringContaining('no command for the typecheck check is configured') },
        ],
      })
      // Nothing was put to the operator for it.
      expect(await ctx.approvals.list()).toEqual([])
    })
  })

  it('answers nothing for a worktree it does not hold, so another source may (ADR-0063)', async () => {
    const repo = repository()
    const { check } = await boot(repo, { checks: { tests: TESTS } }, null)
    expect(await check('run_none', { workspace: '/nowhere', subject: { ref: 'a'.repeat(40), version: 'b'.repeat(64) } })).toBeUndefined()
  })

  it('refuses at load a check no policy can require, a command the policy cannot match word for word, and a deadline out of bounds', () => {
    const repo = repository()
    mkdirSync(join(repo, 'x'), { recursive: true })
    const load = (setup: Record<string, unknown>) => () => new AgentWorkers(new Context(), { workers: [writer(repo)], worktreeSetup: [{ repository: repo, commands: ['true'], ...setup } as never] })
    expect(load({ checks: { review: 'true' } })).toThrow(/checks names review; a check is one of tests, typecheck, lint/)
    expect(load({ checks: { tests: 'pnpm test && rm -rf /' } })).toThrow(/the tests check's command has a shell metacharacter/)
    expect(load({ checks: { lint: 'pnpm  lint' } })).toThrow(/the lint check's command has an empty word 2/)
    expect(load({ checks: ['pnpm test'] })).toThrow(/checks maps a check name to its command/)
    expect(load({ checkTimeoutSeconds: 0 })).toThrow(/checkTimeoutSeconds/)
    // Loaded: each command as argv, and none of it in the setup's hash, so a setup's approvals stand when its checks change.
    const plain = loadSetups([{ repository: repo, commands: ['true'] }], [repo]).get(repo)!
    const checked = loadSetups([{ repository: repo, commands: ['true'], checks: { tests: 'corepack pnpm test:affected' }, checkTimeoutSeconds: 3600 }], [repo]).get(repo)!
    expect(checked).toMatchObject({ checks: { tests: { line: 'corepack pnpm test:affected', argv: ['corepack', 'pnpm', 'test:affected'] } }, checkTimeoutSeconds: 3600, hash: plain.hash })
    expect(plain).toMatchObject({ checks: {}, checkTimeoutSeconds: 1800 })
  })
})
