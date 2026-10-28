// The autonomy policy's structured command rules (autonomy-policy@1.4, T319b): the gate parses a
// Bash command into words and the matcher (src/command-rules.ts) decides it by the policy's rules, so
// the lead's routine commands run unasked; each refused form still asks. The rules are the project
// template's own, which policies/system.json carries too.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import type { AutonomyPolicy, CommandRule } from '@tsuuanmi/system-approvals-core'
import Artifacts from '@tsuuanmi/system-artifacts'
import EventLog from '@tsuuanmi/system-event-log'
import Store from '@tsuuanmi/system-store'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { runGate } from '../src/gate.ts'

const read = (path: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8'))
const RULES = (read('../../../cli/templates/software-repository/template.json') as { policy: { commandRules: CommandRule[] } }).policy.commandRules

const base = realpathSync(mkdtempSync(join(tmpdir(), 'system-command-rules-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const ws = join(base, 'ws')
const repo = join(base, 'repo')
const outside = join(base, 'outside')

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
}

beforeAll(() => {
  for (const dir of [ws, repo, outside]) mkdirSync(dir)
  mkdirSync(join(ws, 'src'))
  mkdirSync(join(ws, 'tests'))
  mkdirSync(join(ws, '.system'))
  mkdirSync(join(ws, 'packages', 'p', 'tests'), { recursive: true })
  mkdirSync(join(ws, 'packages', 'p-core', 'tests'), { recursive: true })
  writeFileSync(join(ws, 'src', 'a.ts'), 'export const foo = 1\n')
  writeFileSync(join(ws, 'tests', 'a.spec.ts'), 'x\n')
  // Two packages' tests: a filter word that is a substring of both (`tests`, `packages/p`) selects more than it names.
  writeFileSync(join(ws, 'packages', 'p', 'tests', 'b.spec.ts'), 'x\n')
  writeFileSync(join(ws, 'packages', 'p-core', 'tests', 'c.spec.ts'), 'x\n')
  writeFileSync(join(ws, '.system', 'x'), 'x\n')
  git(ws, 'init', '-q', '-b', 'main')
  git(ws, 'add', 'src', 'tests')
  git(ws, 'commit', '-q', '-m', 'one')
  writeFileSync(join(ws, 'scratch.txt'), 'scratch\n')
  symlinkSync(join(ws, 'src', 'a.ts'), join(ws, 'link'))
  writeFileSync(join(repo, 'README.md'), 'repo\n')
  writeFileSync(join(outside, 'f'), 'secret\n')
})

const policy = (rules: Partial<Record<AutonomyPolicy['rules'][number]['actionClass'], AutonomyPolicy['rules'][number]['mode']>> = {}): AutonomyPolicy => {
  const modes: Record<string, AutonomyPolicy['rules'][number]['mode']> = { 'read': 'auto', 'workspace-write': 'auto', 'command': 'ask', 'external-send': 'ask', 'merge': 'ask', ...rules }
  return {
    schema: 'autonomy-policy@1.4', id: 'studio-test', version: 1, scope: 'studio', default: 'ask', expiry: { defaultSeconds: 3600, maxSeconds: 86_400 },
    rules: Object.entries(modes).map(([actionClass, mode]) => ({ actionClass: actionClass as AutonomyPolicy['rules'][number]['actionClass'], mode })),
    commandRules: RULES,
  }
}

/** A project policy narrowing the studio's, for project `p`, carrying `commandRules` when given. */
const project = (commandRules?: CommandRule[]): AutonomyPolicy => ({
  schema: 'autonomy-policy@1.4', id: 'p.policy', version: 1, scope: 'project', projectId: 'p', narrows: 'studio-test', default: 'ask',
  expiry: { defaultSeconds: 3600, maxSeconds: 86_400 }, rules: [{ actionClass: 'merge', mode: 'ask' }], ...(commandRules ? { commandRules } : {}),
})

async function boot(set: AutonomyPolicy = policy(), extra: AutonomyPolicy[] = [], projectId?: string) {
  const dir = mkdtempSync(join(base, 'boot-'))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(StoreApprovals, { policies: [set, ...extra] })]
  await Promise.all(fibers)
  onTestFinished(async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })
  // No session: a call the policy asks about is denied as `no-session`, which is how a test sees that it asked.
  const gate = runGate(ctx, { runId: 'arun_t', worker: 'dev', workspace: realpathSync(ws), repository: realpathSync(repo), classification: 'public', ...(projectId ? { projectId } : {}) }).gate
  const signal = new AbortController().signal
  const verdict = (command: string) => gate({ tool: 'Bash', input: { command }, callId: 'c1' }, signal)
  return { ctx, verdict }
}

const ADMITTED = [
  // (1) read-only programs
  'cat src/a.ts', `cat ${join(ws, 'src', 'a.ts')} ${join(repo, 'README.md')}`, 'head -n 5 src/a.ts', 'head -5 src/a.ts', 'tail -n 20 src/a.ts', 'wc -l src/a.ts', 'ls -la src', 'ls -1AhRF', `ls ${repo}`,
  'grep -rn foo src', 'grep -rniwlcEFHo foo src/a.ts', 'grep -m 3 -A 2 -B 2 -C 1 foo src/a.ts', 'grep -e foo -e bar src/a.ts', 'rg -n -i foo src', 'rg -g x -t ts foo src', 'rg -e foo src',
  'echo hello there', 'pwd', 'true', 'false', 'sleep 5', 'sleep 99', 'node --version', 'pnpm --version',
  'git status', 'git status --short', 'git status -s --untracked-files=all', 'git status -uno --ignored --porcelain',
  'git diff --stat', 'git diff --cached --name-only', 'git diff --name-status HEAD~1 HEAD', 'git diff main..HEAD -- src/a.ts', 'git diff abc1234..def5678',
  'git log --oneline -5', 'git log -n 3 --stat --name-only --all HEAD', 'git log --format=%H:%s --grep=fix --author=tan --since=2026-01-01 --until=2026-12-31 src/a.ts', 'git log main..HEAD',
  'git show --stat HEAD', 'git show --name-only --format=%H abc1234', 'git show HEAD:src/a.ts', 'git branch -a', 'git branch --show-current', 'git branch -vv',
  'git grep -n -i foo', 'git grep -e foo src', 'git ls-files', 'git ls-files src', 'git rev-parse HEAD', 'git rev-parse --abbrev-ref HEAD', 'git merge-base main HEAD',
  // (2) a run's own tests and the repository's read-only checks
  'corepack pnpm vitest run tests/a.spec.ts', 'corepack pnpm vitest run --reporter=dot packages/p/tests', `corepack pnpm exec vitest run --reporter=verbose ${join(ws, 'packages', 'p-core', 'tests')}`,
  'corepack pnpm vitest run tests/a.spec.ts packages/p/tests/b.spec.ts', 'corepack pnpm vitest run packages/p/tests/', 'corepack pnpm lint', 'corepack pnpm -s typecheck', 'corepack pnpm check', 'corepack pnpm check:docs', 'corepack pnpm test:related src/a.ts tests/a.spec.ts',
  // (3) a run's own tree edits
  'git mv src/a.ts src/b.ts', 'git rm src/a.ts', 'git rm -r -q src', 'git rm -rq tests', 'corepack pnpm install --offline', 'corepack pnpm install --offline --frozen-lockfile',
  // (4) its own scratch
  'rm scratch.txt', `rm ${join(ws, 'scratch.txt')}`,
]

const REFUSED = [
  `cat ${outside}/f`, 'cat ../outside/f', 'cat /etc/passwd', 'cat .git/config', 'cat src/../../outside/f', 'cat', 'head -n src/a.ts', 'head -n', 'head -x 5 src/a.ts', 'wc src/a.ts', 'ls -z src',
  'grep foo', 'grep foo /etc/passwd', 'grep -e foo /etc/passwd', 'grep -P foo src', 'rg --pre cat foo src', 'rg foo ../outside', 'sleep 100', 'sleep', 'node', 'node script.js', 'pnpm install',
  'git status --untracked-files=bogus', 'git status -C /tmp', 'git diff --output=/tmp/x', `git diff --output=${outside}/x`, 'git diff --ext-diff', `git diff ${outside}/f ${outside}/g`,
  'git log -p', 'git show HEAD:../x', 'git show HEAD:.git/config', 'git branch -D main', 'git branch newname', 'git commit -m x', 'git push', 'git push origin main', 'git checkout main', 'git reset --hard',
  'git -C /tmp status', 'git -c core.fsmonitor=x status', 'git config user.name x', 'git grep -O foo', 'git ls-files -o',
  'corepack pnpm vitest run', 'corepack pnpm vitest run --reporter=dot', 'corepack pnpm vitest run package.json', 'corepack pnpm vitest run --reporter=json tests/a.spec.ts', 'corepack pnpm vitest run --watch packages/p/tests',
  // A filter word, not a path: vitest selects every test file whose path holds it, so a word that selects more than it names asks.
  'corepack pnpm vitest run tests', 'corepack pnpm vitest run --reporter=dot tests', `corepack pnpm vitest run ${join(ws, 'tests')}`, 'corepack pnpm vitest run test', 'corepack pnpm vitest run packages',
  'corepack pnpm vitest run packages/p', 'corepack pnpm vitest run packages/p/', 'corepack pnpm vitest run packages/p-core', 'corepack pnpm vitest run b.spec.ts', 'corepack pnpm vitest run packages/p/tests/none.spec.ts', 'corepack pnpm vitest run src', 'corepack pnpm exec vitest run tests',
  // A word starting with # is a shell comment: the shell would run what is left.
  'corepack pnpm vitest run #a.spec.ts', 'corepack pnpm vitest run tests/a.spec.ts #x', 'corepack pnpm test:related #x', 'cat src/a.ts #x', 'echo #x', 'git log #x', 'rm scratch.txt #x',
  // A ~ a shell expands after = or :.
  'echo --x=~/a', 'git log --author=~', 'git show HEAD:~/x',
  `corepack pnpm vitest run ${outside}/a.spec.ts`, 'corepack pnpm vitest run ../outside/a.spec.ts', 'corepack pnpm vitest run .', 'corepack pnpm exec vitest run', 'corepack pnpm vitest tests/a.spec.ts',
  'corepack pnpm lint --fix', 'corepack pnpm build', 'corepack pnpm check:', 'corepack pnpm test', 'corepack pnpm test:related', 'corepack pnpm test:related ../outside/a.ts', 'corepack pnpm test:related -- -t x',
  'git mv src/a.ts', 'git mv src/a.ts ../outside/a.ts', 'git mv .git/config x', 'git rm', 'git rm -r .', 'git rm -r ..', 'git rm .git/config', 'git rm -r .system', 'git rm --cached src/a.ts', `git rm ${outside}/f`,
  'corepack pnpm install', 'corepack pnpm install --frozen-lockfile', 'corepack pnpm install --offline --force', 'corepack pnpm add left-pad',
  'rm src/a.ts', 'rm src', 'rm link', 'rm -rf scratch.txt', 'rm', 'rm .git/config', 'rm .system/x', `rm ${outside}/f`, 'rm ../outside/f', 'rm nothing-here', 'rm .',
  'cat src/a.ts; ls', 'cat $(pwd)', 'echo `id`', 'cat src/a.ts | head', 'ls && pwd', 'echo x > src/a.ts', 'cat < src/a.ts', 'rm scratch.txt;',
]

describe('command rules (autonomy-policy@1.4)', () => {
  it('lets each admitted command run unasked, as a workspace write', async () => {
    const { verdict } = await boot()
    for (const command of ADMITTED) expect(await verdict(command), command).toEqual({ decision: 'allow' })
  })

  it('leaves every refused command asking (or denied), never allowed', async () => {
    const { verdict } = await boot()
    for (const command of REFUSED) {
      const answer = await verdict(command)
      expect(answer.decision, command).toBe('deny')
    }
  })

  it('records the autonomy decision with the rule that allowed the command', async () => {
    // Writes ask here, so the allowed command's verdict is visible: it is the workspace-write rule's, and names the rule.
    const { ctx, verdict } = await boot(policy({ 'workspace-write': 'ask' }))
    const answer = await verdict('git log --oneline -5')
    expect(answer.decision).toBe('deny')
    // The reason cites the gate's own decision (no session to wait in), whose input is the policy's autonomy decision.
    const gateId = /decision (sha256:[0-9a-f]{64})/.exec((answer as { reason: string }).reason)?.[1]
    expect(gateId).toBeDefined()
    const id = (ctx.artifacts.get(gateId! as never)!.body as { inputs: string[] }).inputs[0]
    expect(id).toBeDefined()
    expect((ctx.artifacts.get(id! as never)!.body as { decisionType: string; outcome: { option: string; detail: Record<string, unknown> } })).toMatchObject({
      decisionType: 'autonomy', outcome: { option: 'ask', detail: { actionClass: 'workspace-write', commandRule: 'git-log' } },
    })
  })

  it('keeps a forbidden command class forbidden', async () => {
    const { verdict } = await boot(policy({ command: 'forbid' }))
    expect(await verdict('git log --oneline -5')).toMatchObject({ decision: 'deny' })
  })

  it('without the change, no rule is in force: the same commands ask', async () => {
    const { commandRules: _rules, ...without } = policy()
    const { verdict } = await boot({ ...without, schema: 'autonomy-policy@1.3' })
    expect(await verdict('git log --oneline -5')).toMatchObject({ decision: 'deny' })
  })
})

describe('a project policy only narrows the studio\'s command rules', () => {
  const scratch = RULES.find((r) => r.id === 'scratch-rm')!
  const { commandRules: _rules, ...bare } = policy()

  it('grants nothing the studio does not hold: a project rule alone leaves the command asking', async () => {
    const { verdict } = await boot({ ...bare, schema: 'autonomy-policy@1.3' }, [project([scratch])], 'p')
    expect(await verdict('rm scratch.txt')).toMatchObject({ decision: 'deny' })
  })

  it('never widens a studio rule: a project rule of the same id that allows more is not in force', async () => {
    const wider: CommandRule = { ...scratch, positionals: [{ kind: 'path', scope: 'run-worktree', min: 1, max: 20 }] }
    const { verdict } = await boot(policy(), [project([wider])], 'p')
    expect(await verdict('rm src/a.ts')).toMatchObject({ decision: 'deny' })
    expect(await verdict('rm scratch.txt')).toMatchObject({ decision: 'deny' })
  })

  it('drops a studio rule it does not hold, and keeps the ones it holds the same', async () => {
    const { verdict } = await boot(policy(), [project([scratch])], 'p')
    expect(await verdict('rm scratch.txt')).toEqual({ decision: 'allow' })
    expect(await verdict('git log --oneline -5')).toMatchObject({ decision: 'deny' })
  })

  it('keeps every studio rule for a project whose policy carries none', async () => {
    const { verdict } = await boot(policy(), [project()], 'p')
    expect(await verdict('git log --oneline -5')).toEqual({ decision: 'allow' })
  })
})

describe('the rules the project template and policies/system.json carry', () => {
  it('are the same rules, and system.json adds only rules of enforce: warn, and they load', () => {
    const shipped = (read('../../../../policies/system.json') as AutonomyPolicy).commandRules!
    expect(shipped.slice(0, RULES.length)).toEqual(RULES)
    const added = shipped.slice(RULES.length)
    expect(added.length).toBeGreaterThan(0)
    expect(added.every((r) => r.enforce === 'warn')).toBe(true)
    expect(new Set(shipped.map((r) => r.id)).size).toBe(shipped.length)
  })
})

// T326: a run's own tests with the options Workers use, and the read-only checks, are the policy's
// rules, read from policies/system.json (never hard-coded in the gate). Shipped `enforce: warn`, they
// record what they would have allowed and the command still asks; the studio policy that grants them
// (`enforce` dropped) lets each run unasked, its decision naming the rule.
const SHIPPED = (read('../../../../policies/system.json') as AutonomyPolicy).commandRules!
const granted = (): CommandRule[] => SHIPPED.map(({ enforce: _enforce, ...rule }) => rule)
const T326 = (command: string): string => command.replaceAll('OUT', outside)
const many = (n: number): string => Array.from({ length: n }, () => 'src/a.ts').join(' ')

/** The rule a command's recorded autonomy decision names, or undefined when it was not allowed by a rule (workspace writes ask here, so the decision is visible). */
async function ruleOf(command: string, rules: CommandRule[]): Promise<string | undefined> {
  const { ctx, verdict } = await boot({ ...policy({ 'workspace-write': 'ask' }), schema: 'autonomy-policy@1.6', commandRules: rules })
  const answer = await verdict(T326(command))
  const gateId = /decision (sha256:[0-9a-f]{64})/.exec((answer as { reason?: string }).reason ?? '')?.[1]
  const first = gateId ? (ctx.artifacts.get(gateId as never)!.body as { inputs: string[] }).inputs[0] : undefined
  const body = first ? ctx.artifacts.get(first as never)?.body as { decisionType: string; outcome: { detail: { commandRule?: string } } } | undefined : undefined
  return body?.decisionType === 'autonomy' ? body.outcome.detail.commandRule : undefined
}

const OWN_TESTS: Array<[string, string]> = [
  ['corepack pnpm vitest run --silent tests/a.spec.ts', 'test-vitest-run-options'],
  ['corepack pnpm vitest run --silent=true tests/a.spec.ts', 'test-vitest-run-options'],
  ['corepack pnpm vitest run tests/a.spec.ts --silent=false', 'test-vitest-run-options'],
  ['corepack pnpm vitest run --reporter=json tests/a.spec.ts', 'test-vitest-run-options'],
  ['corepack pnpm vitest run --reporter=json --outputFile=out.json tests/a.spec.ts', 'test-vitest-run-options'],
  ['corepack pnpm vitest run --reporter=json --outputFile.json=out.json tests/a.spec.ts', 'test-vitest-run-options'],
  [`corepack pnpm vitest run --reporter=json --outputFile.json=${join(ws, 'out.json')} tests/a.spec.ts`, 'test-vitest-run-options'],
  ['corepack pnpm vitest run --exclude=packages/p/tests/b.spec.ts tests/a.spec.ts packages/p-core/tests/c.spec.ts', 'test-vitest-run-options'],
  ['corepack pnpm vitest run --reporter=basic --silent --exclude=src/a.ts packages/p/tests/', 'test-vitest-run-options'],
  ['corepack pnpm exec vitest run --silent --reporter=json --outputFile=out.json tests/a.spec.ts', 'test-vitest-exec-run-options'],
  ['corepack pnpm test:related src/a.ts -- --silent', 'test-related-options'],
  ['corepack pnpm test:related src/a.ts tests/a.spec.ts -- --silent=true --reporter=dot', 'test-related-options'],
  ['corepack pnpm test:related src/a.ts -- --reporter=json --outputFile=out.json', 'test-related-options'],
  ['corepack pnpm test:related src/a.ts -- --reporter=json --outputFile.json=out.json --exclude=tests/a.spec.ts', 'test-related-options'],
  ['corepack pnpm -s test:related src/a.ts', 'test-related-silent-options'],
  ['corepack pnpm -s test:related src/a.ts -- --silent=false', 'test-related-silent-options'],
  [`corepack pnpm test:related ${many(60)}`, 'test-related'],
  [`corepack pnpm test:related ${many(60)} -- --silent`, 'test-related-options'],
]

const NOT_OWN_TESTS = [
  // A path outside the worktree, `..`, git's and System's own data.
  'corepack pnpm vitest run --silent OUT/a.spec.ts', 'corepack pnpm vitest run --silent ../outside/a.spec.ts', 'corepack pnpm vitest run --silent tests/../../outside/a.spec.ts',
  'corepack pnpm test:related ../outside/a.ts -- --silent', 'corepack pnpm test:related OUT/f -- --silent', 'corepack pnpm test:related .git/config -- --silent', 'corepack pnpm test:related .system/x -- --silent',
  'corepack pnpm test:related src/a.ts ../outside/a.ts -- --silent', 'corepack pnpm -s test:related ../outside/a.ts',
  // An --outputFile (or --exclude) outside the worktree, or in git's or System's own data.
  'corepack pnpm vitest run --reporter=json --outputFile=../out.json tests/a.spec.ts', 'corepack pnpm vitest run --reporter=json --outputFile=OUT/out.json tests/a.spec.ts',
  'corepack pnpm vitest run --reporter=json --outputFile.json=OUT/out.json tests/a.spec.ts', 'corepack pnpm vitest run --outputFile=.git/hooks/pre-commit tests/a.spec.ts',
  'corepack pnpm vitest run --outputFile=.system/x tests/a.spec.ts', 'corepack pnpm test:related src/a.ts -- --outputFile=../out.json', 'corepack pnpm test:related src/a.ts -- --outputFile.json=OUT/o.json',
  'corepack pnpm vitest run --outputFile= tests/a.spec.ts', 'corepack pnpm vitest run --outputFile tests/a.spec.ts',
  'corepack pnpm vitest run --exclude=../outside/x tests/a.spec.ts', 'corepack pnpm vitest run --exclude=/etc/passwd tests/a.spec.ts',
  // An option the rule does not name, or a value it does not allow.
  'corepack pnpm vitest run --watch tests/a.spec.ts', 'corepack pnpm vitest run --coverage tests/a.spec.ts', 'corepack pnpm vitest run --reporter=junit tests/a.spec.ts',
  'corepack pnpm vitest run --reporter=./x.js tests/a.spec.ts', 'corepack pnpm vitest run --silent=maybe tests/a.spec.ts', 'corepack pnpm vitest run --outputFile.junit=out.xml tests/a.spec.ts',
  'corepack pnpm vitest run --config=x.ts tests/a.spec.ts', 'corepack pnpm vitest run -u tests/a.spec.ts', 'corepack pnpm vitest run --update tests/a.spec.ts',
  'corepack pnpm test:related src/a.ts -- --coverage', 'corepack pnpm test:related src/a.ts -- --bogus', 'corepack pnpm test:related src/a.ts -- --reporter=junit',
  // No path, a whole-suite filter, more than 60 paths (the plain `test:related` rule of T299 keeps its 64 until policy v4 is approved).
  'corepack pnpm vitest run --silent', 'corepack pnpm vitest run --silent tests', 'corepack pnpm test:related -- --silent', 'corepack pnpm test:related --',
  `corepack pnpm test:related ${many(61)} -- --silent`, `corepack pnpm -s test:related ${many(61)}`,
  // A command after ; or && (or any other shell word) is no command a rule judges.
  'corepack pnpm vitest run --silent tests/a.spec.ts; rm -rf src', 'corepack pnpm vitest run --silent tests/a.spec.ts && echo done', 'corepack pnpm test:related src/a.ts -- --silent; pwd',
  'corepack pnpm test:related src/a.ts && pwd', 'corepack pnpm -s test:related src/a.ts ; pwd', 'corepack pnpm vitest run --silent tests/a.spec.ts | cat', 'corepack pnpm vitest run --outputFile=$HOME/x tests/a.spec.ts',
  'corepack pnpm vitest run --silent tests/a.spec.ts #x', 'corepack pnpm lint; pwd', 'corepack pnpm check && pwd',
]

describe('a run\'s own tests and read-only checks (T326)', () => {
  it('allows each form, its rule named, once the studio policy grants the rules', async () => {
    for (const [command, rule] of OWN_TESTS) expect(await ruleOf(command, granted()), command).toBe(rule)
    const { verdict } = await boot({ ...policy(), schema: 'autonomy-policy@1.6', commandRules: granted() })
    for (const [command] of OWN_TESTS) expect(await verdict(T326(command)), command).toEqual({ decision: 'allow' })
  })

  it('allows the repository\'s read-only checks, and no other script', async () => {
    const { verdict } = await boot({ ...policy(), schema: 'autonomy-policy@1.6', commandRules: granted() })
    for (const command of ['corepack pnpm lint', 'corepack pnpm typecheck', 'corepack pnpm check', 'corepack pnpm check:docs', 'corepack pnpm -s check:schemas']) expect(await verdict(command), command).toEqual({ decision: 'allow' })
    for (const command of ['corepack pnpm build', 'corepack pnpm lint --fix', 'corepack pnpm check:', 'corepack pnpm test', 'corepack pnpm gen:reference']) expect((await verdict(command)).decision, command).toBe('deny')
  })

  it('does not allow a path outside the worktree, a `..`, an --outputFile outside it, an unknown option, or a command after ; or &&', async () => {
    const { verdict } = await boot({ ...policy(), schema: 'autonomy-policy@1.6', commandRules: granted() })
    for (const command of NOT_OWN_TESTS) expect((await verdict(T326(command))).decision, command).toBe('deny')
  })

  it('as shipped (enforce: warn) allows nothing: each form still asks, and a gate decision records the rule it would have allowed', async () => {
    // The studio holds the template's rules; the project policy carries the shipped ones, the warn rules among them.
    const { ctx, verdict } = await boot({ ...policy(), schema: 'autonomy-policy@1.6', commandRules: RULES }, [{ ...project(SHIPPED), schema: 'autonomy-policy@1.6' }], 'p')
    const forms = OWN_TESTS.filter(([, rule]) => rule !== 'test-related')
    for (const [command] of forms) expect((await verdict(T326(command))).decision, command).toBe('deny')
    const warnedRules = (): string[] => ctx.artifacts.list({ kind: 'decision' }).map((a) => (a.body as { outcome: { detail?: { warnedRule?: string } } }).outcome.detail?.warnedRule).filter((r): r is string => r !== undefined)
    expect(warnedRules()).toHaveLength(forms.length)
    expect(new Set(warnedRules())).toEqual(new Set(['test-vitest-run-options', 'test-vitest-exec-run-options', 'test-related-options', 'test-related-silent-options']))
    // What no rule matches records nothing.
    const before = warnedRules().length
    for (const command of NOT_OWN_TESTS) expect((await verdict(T326(command))).decision, command).toBe('deny')
    expect(warnedRules()).toHaveLength(before)
  })

  it('stays off for a project whose policy still holds the rules as warn, even once the studio grants them: both policies must drop enforce', async () => {
    const studio = { ...policy(), schema: 'autonomy-policy@1.6' as const, commandRules: granted() }
    // Project policy version 4, as shipped: its warn copies differ from the studio's, so the studio's are not in force for it.
    const v4 = await boot(studio, [{ ...project(SHIPPED), schema: 'autonomy-policy@1.6' }], 'p')
    const command = 'corepack pnpm vitest run --silent=true tests/a.spec.ts'
    expect((await v4.verdict(command)).decision).toBe('deny')
    expect(v4.ctx.artifacts.list({ kind: 'decision' }).map((a) => (a.body as { outcome: { detail?: { warnedRule?: string } } }).outcome.detail?.warnedRule)).toContain('test-vitest-run-options')
    // Its next version drops enforce, word for word the studio's: now the command runs unasked.
    const v5 = await boot(studio, [{ ...project(granted()), schema: 'autonomy-policy@1.6', version: 2 }], 'p')
    expect(await v5.verdict(command)).toEqual({ decision: 'allow' })
  })

  it('records the rule a warned command would have matched', async () => {
    const { ctx, verdict } = await boot({ ...policy(), schema: 'autonomy-policy@1.6', commandRules: RULES }, [{ ...project(SHIPPED), schema: 'autonomy-policy@1.6' }], 'p')
    expect((await verdict('corepack pnpm vitest run --silent tests/a.spec.ts')).decision).toBe('deny')
    const recorded = ctx.artifacts.list({ kind: 'decision' }).map((a) => a.body as { decisionType: string; decider: { id: string }; outcome: { option: string; detail?: { warnedRule?: string; command?: string } } })
      .filter((d) => d.outcome.detail?.warnedRule !== undefined)
    expect(recorded).toEqual([expect.objectContaining({ decisionType: 'gate', decider: expect.objectContaining({ id: 'agent-workers.tool-gate' }), outcome: expect.objectContaining({ option: 'ask', detail: expect.objectContaining({ warnedRule: 'test-vitest-run-options', command: 'corepack pnpm vitest run --silent tests/a.spec.ts' }) }) })])
  })
})
