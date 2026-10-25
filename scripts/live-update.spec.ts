// The live update's dry run, its refusals, and its upgrade checks' rules
// (docs/operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release). The script
// runs on a throwaway repository and DSH home, with a stand-in system.service unit: a dry run changes
// nothing, every refusal comes before anything is written, and a rollback stops and starts the unit
// (a fake daemon). --apply itself is rehearsed by hand on a throwaway worktree and home (the runbook
// says how), since it builds and starts a real profile.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { awaitWorkers, baselineProblems, type Health, healthOf, healthProblems, runProblems, workerProblems, type Workers, workersNow, workersOf, workersTable } from './live-update-check.ts'
import { daemonEnv, standInUnit, type StandInUnit } from './systemd-stand-in.ts'

// Each test runs the script end to end, once or several times, and each run starts git, Node, and
// the stand-ins as real processes: 1 to 3 s a test on an idle core, up to 10 s on a loaded one,
// where the 5 s default failed them. A run is synchronous: the bound cannot stop a hung one, it
// only fails a slow one.
vi.setConfig({ testTimeout: 60_000 })

const SCRIPT = fileURLToPath(new URL('./live-update.sh', import.meta.url))

interface Fixture {
  root: string; live: string; home: string; backups: string; bin: string; from: string; target: string; envFile: string; unit: StandInUnit
  git: (...args: string[]) => string
}

/**
 * A repository whose second commit's build writes the build stamp (the first is code from before it),
 * checked out at the first; a profile; its unit's environment file; a stand-in pnpm and systemctl.
 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'live-update-'))
  const live = join(root, 'live')
  mkdirSync(join(live, 'packages', 'cli', 'src'), { recursive: true })
  execFileSync('git', ['init', '-q', live], { stdio: 'pipe' })
  const git = (...args: string[]): string => execFileSync('git', ['-C', live, '-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], { encoding: 'utf8' }).trim()
  writeFileSync(join(live, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  writeFileSync(join(live, 'packages', 'cli', 'src', 'index.ts'), 'export const previous = 1\n')
  writeFileSync(join(live, 'packages', 'cli', 'package.json'), `${JSON.stringify({ scripts: { build: 'tsc' } })}\n`)
  git('add', '-A')
  git('commit', '-q', '-m', 'previous')
  const from = git('rev-parse', 'HEAD')
  writeFileSync(join(live, 'packages', 'cli', 'package.json'), `${JSON.stringify({ scripts: { build: 'tsc && git rev-parse HEAD > lib/build-commit' } })}\n`)
  git('commit', '-q', '-am', 'target')
  const target = git('rev-parse', 'HEAD')
  git('checkout', '-q', '--detach', from)

  const home = join(root, 'dsh')
  mkdirSync(join(home, 'profiles', 'system'), { recursive: true })
  mkdirSync(join(home, 'system'))
  writeFileSync(join(home, 'profiles', 'system', 'package.json'), '{}\n')
  writeFileSync(join(home, 'profiles', 'system', 'cordis.yml'), '[]\n')
  writeFileSync(join(home, 'profiles', 'system', 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(home, 'system', 'system.db'), '')
  const backups = join(root, 'backups')
  mkdirSync(backups)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\necho 12.9.1\n')
  chmodSync(join(bin, 'pnpm'), 0o755)
  const envFile = daemonEnv(root, home)
  const unit = standInUnit(root, bin, live, home, envFile)
  return { root, live, home, backups, bin, from, target, envFile, unit, git }
}

/** A checkout of the target, "built": its lib's stamp names the target, and its `system check` passes. */
function builtTarget(f: Fixture): string {
  const dir = join(f.root, 'target')
  execFileSync('git', ['clone', '-q', f.live, dir], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', f.target], { stdio: 'pipe' })
  mkdirSync(join(dir, 'packages', 'cli', 'lib'))
  writeFileSync(join(dir, 'packages', 'cli', 'lib', 'build-commit'), `${f.target}\n`)
  writeFileSync(join(dir, 'packages', 'cli', 'lib', 'bin.js'), "console.log(`ok: 0 row(s) of the profile pass this code's checks (${process.argv.slice(2).join(' ')})`)\n")
  return dir
}

/** An update recorded under the backups, as an earlier run of the script left it: with no patch. */
function attempt(f: Fixture, phase: string): string {
  const dir = join(f.backups, '2026-10-01-before-base')
  mkdirSync(dir)
  writeFileSync(join(dir, 'live-update.state'), [`from=${f.from}`, `target=${f.target}`, `live=${realpathSync(f.live)}`, 'patch_sha256=none', `phase=${phase}`, ''].join('\n'))
  return dir
}

function run(f: Fixture, target: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync('bash', [SCRIPT, target, '--from', f.from, '--live', f.live, '--dsh-home', f.home, '--backups', f.backups,
    '--node-dir', dirname(process.execPath), '--pnpm-dir', f.bin, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** Wait until the fake daemon's discovery file exists. */
function waitForDaemon(f: Fixture): void {
  const discovery = join(f.home, 'system', 'mcp.json')
  for (const until = Date.now() + 10_000; !existsSync(discovery) && Date.now() < until;) spawnSync('sleep', ['0.1'])
  expect(existsSync(discovery)).toBe(true)
}

/**
 * Every entry under `dir` (but a repository's own .git): a file with its content, a symbolic link
 * with its target, anything else by its kind. Entry kinds come from the directory listing itself,
 * so nothing is stat'ed before it is read.
 */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === '.git') continue
      const full = join(path, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) files[full] = readFileSync(full, 'utf8')
      else if (entry.isSymbolicLink()) files[full] = `symlink -> ${readlinkSync(full)}`
      else files[full] = 'not a file, directory, or symbolic link'
    }
  }
  walk(dir)
  return files
}

describe('live-update.sh', () => {
  it('a dry run checks, prints the plan, and changes nothing', () => {
    const f = fixture()
    const before = snapshot(f.root)
    const { status, output } = run(f, f.target)
    expect(output, output).toContain('Plan for --apply (this dry run changed nothing)')
    expect(status).toBe(0)
    expect(output).toContain('at the previous commit')
    expect(output).toContain('the daemon is not running')
    expect(output).toContain('no --check-with')
    expect(snapshot(f.root)).toEqual(before)
    expect(f.git('rev-parse', 'HEAD')).toBe(f.from)
  })

  it('--apply without a checked target refuses before anything is written', () => {
    const f = fixture()
    const { status, output } = run(f, f.target, '--apply')
    expect(status).toBe(1)
    expect(output).toContain('--apply needs --check-with')
    expect(readdirSync(f.backups)).toEqual([])
  })

  it('refuses to run from the live checkout, whose files the update replaces', () => {
    const f = fixture()
    const copy = join(f.live, 'tools')
    mkdirSync(copy)
    for (const file of ['live-update.sh', 'live-update-check.ts']) writeFileSync(join(copy, file), readFileSync(join(dirname(SCRIPT), file)))
    const result = spawnSync('bash', [join(copy, 'live-update.sh'), f.target, '--from', f.from, '--live', f.live, '--dsh-home', f.home, '--backups', f.backups,
      '--node-dir', dirname(process.execPath), '--pnpm-dir', f.bin], { encoding: 'utf8' })
    expect(result.stderr).toContain('run this script from another checkout')
    expect(result.status).toBe(1)
  })

  it('refuses a live checkout with uncommitted changes', () => {
    const f = fixture()
    writeFileSync(join(f.live, 'pnpm-lock.yaml'), 'changed\n')
    const { status, output } = run(f, f.target)
    expect(status).toBe(1)
    expect(output).toContain('has uncommitted changes')
  })

  it('refuses a live checkout at neither the previous commit nor the target', () => {
    const f = fixture()
    writeFileSync(join(f.live, 'other.txt'), 'other\n')
    f.git('add', 'other.txt')
    f.git('commit', '-q', '-m', 'other')
    const { status, output } = run(f, f.target)
    expect(status).toBe(1)
    expect(output).toContain('neither the previous commit')
  })

  it('refuses a target that does not descend from the previous commit', () => {
    const f = fixture()
    // The last --from counts: the update would go from the target back to the previous commit.
    const { status, output } = run(f, f.from, '--from', f.target)
    expect(status).toBe(1)
    expect(output).toContain('not a forward update')
  })

  it('refuses a target whose build writes no stamp of its commit', () => {
    const f = fixture()
    writeFileSync(join(f.live, 'other.txt'), 'other\n')
    f.git('add', 'other.txt')
    f.git('commit', '-q', '-m', 'other, from before the stamp')
    const other = f.git('rev-parse', 'HEAD')
    f.git('checkout', '-q', '--detach', f.from)
    const { status, output } = run(f, other)
    expect(status).toBe(1)
    expect(output).toContain('writes no packages/cli/lib/build-commit')
  })

  it('refuses to check the profile with a checkout whose lib was built at another commit', () => {
    const f = fixture()
    const target = builtTarget(f)
    writeFileSync(join(target, 'packages', 'cli', 'lib', 'build-commit'), `${f.from}\n`)
    const { status, output } = run(f, f.target, '--check-with', target)
    expect(status).toBe(1)
    expect(output).toContain('is not built at its commit')
  })

  it("reads the stamp the CLI's build writes", () => {
    const build = (JSON.parse(readFileSync(fileURLToPath(new URL('../packages/cli/package.json', import.meta.url)), 'utf8')) as { scripts: { build: string } }).scripts.build
    expect(build).toMatch(/&& git rev-parse HEAD > lib\/build-commit$/)
    expect(readFileSync(SCRIPT, 'utf8')).toContain('STAMP_FILE=packages/cli/lib/build-commit\n')
  })

  it('a dry run checks the profile, with the patch candidate, by the target\'s code', () => {
    const f = fixture()
    const patch = join(f.root, 'candidate.yml')
    writeFileSync(patch, '- id: workflow\n  config:\n    allowSameFamily: true\n')
    const before = snapshot(f.home)
    const { status, output } = run(f, f.target, '--check-with', builtTarget(f), '--patch', patch)
    expect(output, output).toContain(`ok: 0 row(s) of the profile pass this code's checks (check --env-file ${f.envFile})`)
    expect(output).toContain('+    allowSameFamily: true')
    expect(status).toBe(0)
    expect(snapshot(f.home)).toEqual(before)
  })

  it('sets an earlier update aside when it stopped nothing and the patch changed since', () => {
    const f = fixture()
    const earlier = attempt(f, 'captured')
    const patch = join(f.root, 'candidate.yml')
    writeFileSync(patch, '[]\n')
    const { status, output } = run(f, f.target, '--apply', '--check-with', builtTarget(f), '--patch', patch)
    expect(output).toContain('stopped nothing and named another patch: it is set aside')
    // Then, with no daemon to capture, it stops before opening another.
    expect(output).toContain('the daemon is not running: start it')
    expect(status).toBe(1)
    expect(readFileSync(join(earlier, 'live-update.state'), 'utf8')).toContain('phase=set-aside')
    expect(readdirSync(f.backups).sort()).toEqual(['.live-update.lock', '2026-10-01-before-base'])
    expect(f.git('rev-parse', 'HEAD')).toBe(f.from)
  })

  it('goes on with an update that stopped the daemon only with the patch it started with', () => {
    const f = fixture()
    attempt(f, 'stopped')
    const patch = join(f.root, 'candidate.yml')
    writeFileSync(patch, '[]\n')
    const { status, output } = run(f, f.target, '--apply', '--check-with', builtTarget(f), '--patch', patch)
    expect(output).toContain('this update started with another patch candidate')
    expect(status).toBe(1)
    expect(f.git('rev-parse', 'HEAD')).toBe(f.from)
  })

  it('takes --workers-wait in whole seconds only', () => {
    const f = fixture()
    const { status, output } = run(f, f.target, '--workers-wait', 'ten')
    expect(status).toBe(2)
    expect(output).toContain('[--workers-wait <seconds>]')
  })

  it('refuses to check the profile with a checkout of other code than the target', () => {
    const f = fixture()
    const other = join(f.root, 'other')
    execFileSync('git', ['clone', '-q', f.live, other], { stdio: 'pipe' })
    execFileSync('git', ['-C', other, 'checkout', '-q', '--detach', f.from], { stdio: 'pipe' })
    const { status, output } = run(f, f.target, '--check-with', other)
    expect(status).toBe(1)
    expect(output).toContain('is not at the target\'s code')
  })
})

describe('live-update.sh and system.service', () => {
  it('refuses without the unit, with another directory, without one required environment file, or one for another home', () => {
    const f = fixture()
    const cases: [string, string, string][] = [
      ['LoadState', 'not-found', 'there is no system.service user unit: run the daemon under it once (docs/operations/runbooks.md#run-the-live-daemon-under-systemservice)'],
      ['WorkingDirectory', f.root, `system.service runs in ${f.root}, not in`],
      ['EnvironmentFiles', `${f.envFile} (ignore_errors=yes)`, 'system.service must name one environment file, required'],
      ['EnvironmentFiles', '', 'system.service must name one environment file, required'],
      ['EnvironmentFiles', `${join(f.root, 'missing.env')} (ignore_errors=no)`, `no environment file ${join(f.root, 'missing.env')}`],
    ]
    for (const [property, value, expected] of cases) {
      const before = readFileSync(join(f.unit.dir, property), 'utf8')
      f.unit.set(property, value)
      const { status, output } = run(f, f.target)
      expect(output, output).toContain(expected)
      expect(status).toBe(1)
      writeFileSync(join(f.unit.dir, property), before)
    }
    writeFileSync(f.envFile, 'PATH=/usr/bin:/bin\nDSH_HOME=/elsewhere\n')
    const { status, output } = run(f, f.target)
    expect(output).toContain(`does not set DSH_HOME to ${realpathSync(f.home)} (--dsh-home)`)
    expect(status).toBe(1)
  })

  it('refuses a daemon that runs outside the unit, with the one-time migration to point to', () => {
    const f = fixture()
    // The fake daemon started by hand: its parent is not the unit's main process.
    writeFileSync(join(f.unit.dir, 'MainPID'), '0\n')
    execFileSync('sh', [join(f.unit.dir, 'start')])
    waitForDaemon(f)
    writeFileSync(join(f.unit.dir, 'MainPID'), '0\n')
    try {
      const { status, output } = run(f, f.target)
      expect(output, output).toMatch(/the daemon \(pid \d+\) runs outside system\.service: run it under the unit once \(docs\/operations\/runbooks\.md#run-the-live-daemon-under-systemservice\)/)
      expect(status).toBe(1)
    } finally {
      const pid = Number(JSON.parse(readFileSync(join(f.home, 'system', 'mcp.json'), 'utf8')).pid)
      process.kill(pid, 'SIGTERM')
    }
  })

  it('rolls back through the unit: stopped by systemctl, started by systemctl, and up on /healthz', () => {
    const f = fixture()
    const dir = attempt(f, 'rolling-back')
    writeFileSync(join(dir, 'live-update.state'), `${readFileSync(join(dir, 'live-update.state'), 'utf8')}rollback_from=stopped\nrollback_reason=a test\nstart_log=${join(f.root, 'daemon.log')}\n`)
    writeFileSync(join(f.root, 'daemon.log'), '')
    execFileSync(join(f.bin, 'systemctl'), ['--user', 'start', 'system.service'])
    waitForDaemon(f)
    try {
      const { status, output } = run(f, f.target, '--apply', '--check-with', builtTarget(f))
      expect(output, output).toContain('ROLLING BACK to')
      expect(output).toContain('systemctl --user stop system.service')
      expect(output).toMatch(/the daemon is up: pid \d+ \(system\.service: \d+\)/)
      expect(output).toContain('rolled back: the live install runs')
      expect(status).toBe(1)
      expect(f.unit.calls()).toEqual(['start system.service', 'stop system.service', 'reset-failed system.service', 'start system.service'])
      expect(readFileSync(join(dir, 'live-update.state'), 'utf8')).toContain('phase=rolled-back')
      expect(readFileSync(join(f.unit.dir, 'state'), 'utf8').trim()).toBe('active')
    } finally {
      f.unit.cleanup()
    }
  })
})

describe('live-update-check: what the update may not make worse', () => {
  it('reads every health check, ok ones too, so a status that lists only the not-ok ones by default is no check gone (2026-10-25 rollback)', async () => {
    const asked: Array<Record<string, unknown>> = []
    const health: Health = { state: 'ok', checks: [{ name: 'store', state: 'ok' }] }
    const call = async (name: string, args: Record<string, unknown>) => {
      asked.push({ name, ...args })
      return { isError: false, text: '', structured: { health } }
    }
    expect(await healthOf(call, '/nowhere')).toEqual(health)
    expect(asked).toEqual([{ name: 'status', checks: true }])
  })

  const health = (state: Health['state'], ...checks: Health['checks']): Health => ({ state, checks })

  it('a check that was ok and is not, or is gone, is a problem; one that was not ok already is a note', () => {
    const before = health('degraded', { name: 'store', state: 'ok' }, { name: 'accounts', state: 'ok' }, { name: 'ui-drift', state: 'degraded', detail: 'drift' })
    const after = health('degraded', { name: 'store', state: 'degraded', detail: 'slow' }, { name: 'ui-drift', state: 'degraded', detail: 'drift' })
    const { problems, notes } = healthProblems(before, after)
    expect(problems).toEqual(['health check store was ok and is degraded: slow', 'health check accounts was ok and is gone'])
    expect(notes).toEqual(['health check ui-drift was degraded and is degraded: drift'])
  })

  it('a check worse than it was, a new check that is down, and a refused manifest are problems', () => {
    const before = health('degraded', { name: 'ui-drift', state: 'degraded', detail: 'drift' })
    const after = health('down', { name: 'ui-drift', state: 'down', detail: 'gone' }, { name: 'plugins', state: 'down', detail: 'board failed' },
      { name: 'manifests', state: 'degraded', detail: 'x: refused' }, { name: 'retention', state: 'ok' })
    expect(healthProblems(before, after).problems).toEqual(['health check ui-drift was degraded and is down: gone', 'health check plugins, new, is down: board failed',
      'health check manifests, new, is degraded: x: refused'])
  })

  it('the Workers check is judged Worker by Worker, never by its state', () => {
    // Only new Workers, none signed in yet: no Worker can take work, and none could before either.
    const before = health('ok', { name: 'workers', state: 'ok', detail: '0 available' })
    const after = health('down', { name: 'workers', state: 'down', detail: 'no Worker can take work: agent:claude-review (unavailable), agent:codex-review (unavailable)' })
    const { problems, notes } = healthProblems(before, after, ['agent:'])
    expect(problems).toEqual([])
    expect(notes).toHaveLength(2)
  })

  it('a profile down before the update is no baseline, unless only its Workers are', () => {
    expect(baselineProblems(health('down', { name: 'store', state: 'down', detail: 'integrity check: corrupt' }))).toEqual(['health check store is down: integrity check: corrupt'])
    expect(baselineProblems(health('down', { name: 'workers', state: 'down', detail: 'no Worker can take work: x (unavailable)' }))).toEqual([])
  })

  it('a Worker that could take work and cannot is a problem, unless it is new in the update', () => {
    const before = health('degraded', { name: 'workers', state: 'degraded', detail: 'cannot take work: worker:gemini-main/flash (reauth-required) (system explain shows why)' })
    const after = health('degraded', {
      name: 'workers', state: 'degraded',
      detail: 'cannot take work: worker:gemini-main/flash (reauth-required), worker:chatgpt-main/economy (unavailable), agent:codex-review (unavailable) (system explain shows why)',
    })
    const { problems, notes } = healthProblems(before, after, ['agent:'])
    expect(problems).toEqual(['Worker worker:chatgpt-main/economy could take work before the update and cannot now (unavailable)'])
    expect(notes).toEqual(["Worker agent:codex-review, new, cannot take work yet (unavailable): see the runbook's section on its runtime"])
  })

  it('an old run must explain and answer as it did; a running one may have moved on', () => {
    const done = { runId: 'r1', explained: true, template: 'ask', status: 'completed', nodes: 2, result: 'completed' }
    expect(runProblems(done, { ...done })).toEqual([])
    expect(runProblems(done, { ...done, status: 'failed', nodes: 3, result: 'failed' })).toEqual(['run r1: status failed, was completed', 'run r1: 3 step(s), was 2', 'run r1: result failed, was completed'])
    expect(runProblems(done, { runId: 'r1', explained: false, error: 'unknown run' })).toEqual(['run r1 no longer explains: unknown run'])
    const running = { ...done, status: 'running', result: 'running' }
    expect(runProblems(running, { ...done, nodes: 4 })).toEqual([])
    expect(runProblems(running, { ...done, template: 'plan' })).toEqual(['run r1: template plan, was ask'])
  })
})

/** A roster entry as MCP `roster` gives it (`mcp-roster@1.9`), with only what the check reads and a name. */
const entry = (worker: string, availability: Record<string, unknown>) => ({ worker, name: worker, provider: worker.split(':')[0], availability })
const PROBE_FAILED = 'its codex probe failed: bwrap: Unknown option --argv0 (bubblewrap 0.4.0)'

/** The live roster before the update to 803ac4b8 (2026-10-26): four Codex Workers ready or busy, a website Worker waiting on its sign-in. */
const ROSTER_BEFORE = {
  asOf: '2026-10-26T09:00:00.000Z',
  workers: {
    value: [
      entry('agent:codex-main/develop', { state: 'ready', summary: 'ready' }),
      entry('agent:codex-main/review', { state: 'busy', summary: 'busy 1 of 2', running: 1, slots: 2 }),
      entry('agent:codex-second/develop', { state: 'ready', summary: 'ready' }),
      entry('agent:codex-second/review', { state: 'ready', summary: 'ready' }),
      entry('worker:gemini-main/flash', { state: 'unavailable', summary: 'unavailable: its account must sign in again (system account login)', reason: { value: 'its account must sign in again (system account login)' } }),
    ],
  },
  unlisted: 0,
  counts: { ready: 3, busy: 1, resting: 0, unavailable: 1, quarantined: 0 },
}

/** The same roster after it: every Codex Worker unavailable, its probe failing on the host's bubblewrap. */
const ROSTER_AFTER = {
  ...ROSTER_BEFORE,
  asOf: '2026-10-26T09:12:00.000Z',
  workers: {
    value: ROSTER_BEFORE.workers.value.map((w) => (w.worker.startsWith('agent:codex-')
      ? entry(w.worker, { state: 'unavailable', summary: `unavailable: ${PROBE_FAILED}`, reason: { value: PROBE_FAILED } })
      : w)),
  },
  counts: { ready: 0, busy: 0, resting: 0, unavailable: 5, quarantined: 0 },
}

describe('live-update-check: the Workers take work again after the update (T219)', () => {
  it('reads each Worker\'s availability, and why one takes no work, from the roster', async () => {
    expect(workersOf(ROSTER_BEFORE)).toEqual({
      workers: [
        { worker: 'agent:codex-main/develop', state: 'ready' },
        { worker: 'agent:codex-main/review', state: 'busy' },
        { worker: 'agent:codex-second/develop', state: 'ready' },
        { worker: 'agent:codex-second/review', state: 'ready' },
        { worker: 'worker:gemini-main/flash', state: 'unavailable', reason: 'its account must sign in again (system account login)' },
      ],
    })
    expect(workersOf({ workers: { unknown: 'the Worker registry (ctx.workers) is not mounted' } })).toEqual({ unread: "the roster's Workers are unknown: the Worker registry (ctx.workers) is not mounted" })
    expect(workersOf({ workers: { value: [entry('agent:x', { state: 'unavailable', summary: 's', reason: { unknown: 'its Worker source gives no reason' } })] } }))
      .toEqual({ workers: [{ worker: 'agent:x', state: 'unavailable', reason: 'unknown (its Worker source gives no reason)' }] })
    // Read as the operator, through MCP `roster`; a profile that refuses it (one from before the roster) is unread, never an empty roster.
    const asked: string[] = []
    expect(await workersNow(async (name) => { asked.push(name); return { isError: false, text: '', structured: ROSTER_BEFORE } }, '/nowhere')).toEqual(workersOf(ROSTER_BEFORE))
    expect(asked).toEqual(['roster'])
    expect(await workersNow(async () => ({ isError: true, text: 'unknown tool roster', structured: undefined }), '/nowhere')).toEqual({ unread: 'roster: unknown tool roster' })
    expect(await workersNow(async () => { throw new Error('connect ECONNREFUSED') }, '/nowhere')).toEqual({ unread: 'roster: connect ECONNREFUSED' })
  })

  it('a Worker that took work before and is unavailable after fails the check with its reason; one that took none before is not held to it', () => {
    const { problems, notes, waiting } = workerProblems(workersOf(ROSTER_BEFORE), workersOf(ROSTER_AFTER))
    expect(problems).toEqual([
      `Worker agent:codex-main/develop was ready before the update and is unavailable now: ${PROBE_FAILED}`,
      `Worker agent:codex-main/review was busy before the update and is unavailable now: ${PROBE_FAILED}`,
      `Worker agent:codex-second/develop was ready before the update and is unavailable now: ${PROBE_FAILED}`,
      `Worker agent:codex-second/review was ready before the update and is unavailable now: ${PROBE_FAILED}`,
    ])
    expect(notes).toEqual([])
    expect(waiting).toEqual(['agent:codex-main/develop', 'agent:codex-main/review', 'agent:codex-second/develop', 'agent:codex-second/review'])
    expect(workerProblems(workersOf(ROSTER_BEFORE), workersOf(ROSTER_BEFORE))).toEqual({ problems: [], notes: [], waiting: [] })
  })

  it('a Worker gone from the roster, or a roster that cannot be read, is a problem; one resting at a limit is a note', () => {
    const before: Workers = { workers: [{ worker: 'a', state: 'ready' }, { worker: 'b', state: 'ready' }, { worker: 'c', state: 'unavailable', reason: 'x' }] }
    const after: Workers = { workers: [{ worker: 'b', state: 'resting', reason: 'resting at a limit until 2026-10-26T12:00:00Z' }, { worker: 'd', state: 'unavailable', reason: 'new' }] }
    expect(workerProblems(before, after)).toEqual({
      problems: ['Worker a was ready before the update and is not listed now (its source does not describe it)'],
      notes: ['Worker b was ready before the update and is resting at a limit now: resting at a limit until 2026-10-26T12:00:00Z'],
      waiting: ['a'],
    })
    expect(workerProblems(before, { unread: 'roster: connect ECONNREFUSED' })).toEqual({
      problems: ['the Workers cannot be read after the update (roster: connect ECONNREFUSED): 2 took work before it'], notes: [], waiting: ['a', 'b'],
    })
  })

  it('a capture without the Workers, or that could not read them, compares nothing and says so', () => {
    expect(workerProblems(undefined, workersOf(ROSTER_AFTER))).toEqual({ problems: [], notes: ['the capture holds no Workers (made before the check read them): their availability is not compared'], waiting: [] })
    expect(workerProblems({ unread: 'roster: unknown tool roster' }, workersOf(ROSTER_AFTER)).notes).toEqual(['the Workers were not read before the update (roster: unknown tool roster): their availability is not compared'])
  })

  it('waits, bounded, until every Worker that took work before takes work again', async () => {
    let clock = 0
    const sleeps: number[] = []
    const sleep = async (ms: number) => { sleeps.push(ms); clock += ms }
    const options = { waitMs: 600_000, everyMs: 10_000, sleep, now: () => clock }
    // Unavailable while each runtime's first probe runs after the start, then ready again.
    const reads = [ROSTER_AFTER, ROSTER_AFTER, ROSTER_BEFORE]
    let read = 0
    const back = await awaitWorkers(async () => workersOf(reads[Math.min(read++, reads.length - 1)]), workersOf(ROSTER_BEFORE), options)
    expect(back.problems).toEqual([])
    expect(read).toBe(3)
    expect(sleeps).toEqual([10_000, 10_000])

    // Still unavailable at the bound: the check fails with each one's reason, after no more than the wait.
    clock = 0
    sleeps.length = 0
    const stuck = await awaitWorkers(async () => workersOf(ROSTER_AFTER), workersOf(ROSTER_BEFORE), options)
    expect(stuck.problems).toHaveLength(4)
    expect(stuck.problems[0]).toContain(PROBE_FAILED)
    expect(clock).toBe(600_000)
    expect(sleeps).toHaveLength(60)

    // Nothing to wait for: one read.
    clock = 0
    sleeps.length = 0
    expect((await awaitWorkers(async () => workersOf(ROSTER_AFTER), undefined, options)).problems).toEqual([])
    expect(sleeps).toEqual([])
  })

  it('prints the Workers before and after the update, with why one takes no work', () => {
    // Columns as wide as their widest cell (the id, and the before column's sign-in reason), two spaces apart.
    const signIn = 'unavailable: its account must sign in again (system account login)'
    const row = (worker: string, before: string, after: string): string => `${worker.padEnd(26)}  ${before.padEnd(signIn.length)}  ${after}`
    expect(workersTable(workersOf(ROSTER_BEFORE), workersOf(ROSTER_AFTER))).toEqual([
      row('Worker', 'before', 'after'),
      row('agent:codex-main/develop', 'ready', `unavailable: ${PROBE_FAILED}`),
      row('agent:codex-main/review', 'busy', `unavailable: ${PROBE_FAILED}`),
      row('agent:codex-second/develop', 'ready', `unavailable: ${PROBE_FAILED}`),
      row('agent:codex-second/review', 'ready', `unavailable: ${PROBE_FAILED}`),
      row('worker:gemini-main/flash', signIn, signIn),
    ])
    expect(workersTable({ workers: [{ worker: 'a', state: 'ready' }] }, { workers: [{ worker: 'b', state: 'ready' }] })).toEqual(['Worker  before        after', 'a       ready         (not listed)', 'b       (not listed)  ready'])
    expect(workersTable({ workers: [{ worker: 'a', state: 'ready' }] })).toEqual(['Worker  before', 'a       ready'])
    expect(workersTable(undefined, { unread: 'roster: refused' })).toEqual(['Workers before the update: not captured', 'Workers after the update: not read (roster: refused)'])
  })
})
