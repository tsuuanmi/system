// The live update's dry run, its refusals, and its upgrade checks' rules
// (docs/operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release). The script
// runs on a throwaway repository and DSH home, with a stand-in system.service unit: a dry run changes
// nothing, every refusal comes before anything is written, and a rollback stops and starts the unit
// (a fake daemon). --apply itself is rehearsed by hand on a throwaway worktree and home (the runbook
// says how), since it builds and starts a real profile.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  awaitIdle, awaitWorkers, baselineProblems, cutOutcomes, cutReportLines, type CutSteps, type Health, healthOf, healthProblems, idle, type Running, runningInStore, runningLines, runningOf, runProblems,
  workerProblems, type Workers, workersNow, workersOf, workersTable,
} from './live-update-check.ts'
import { daemonEnv, type FakeSystem, fakeSystem, type FakeWork, standInUnit, type StandInUnit } from './systemd-stand-in.ts'

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

/** T223's develop step, the one the update to c2a45415 cut on 2026-10-26. */
const T223: FakeWork = { runId: 'run_T223', nodeId: 'develop:1', worker: 'agent:codex-main/develop', since: '2026-10-26T09:00:00.000Z', taskId: 'T223' }
const T223_LINE = /run run_T223 step develop:1 on agent:codex-main\/develop, for \d+ (s|min|h \d+ min) \(task T223, algorithm-development\)/

describe('live-update.sh waits for what runs before it stops the unit (T234)', () => {
  /** The fake `system` answering, and the daemon running under the stand-in unit. */
  function running(f: Fixture): FakeSystem {
    const system = fakeSystem(f.root, f.live, f.home)
    execFileSync(join(f.bin, 'systemctl'), ['--user', 'start', 'system.service'])
    waitForDaemon(f)
    return system
  }
  const stateOf = (f: Fixture): string => {
    const dir = readdirSync(f.backups).find((name) => name.includes('-before-base'))
    return dir ? readFileSync(join(f.backups, dir, 'live-update.state'), 'utf8') : ''
  }

  it('pauses dispatch, waits until no step runs while saying what runs, and only then stops the daemon', () => {
    const f = fixture()
    const system = running(f)
    // The capture's read, then the wait's: T223's develop step runs, then nothing does.
    system.work([T223], [T223], [])
    try {
      const { status, output } = run(f, f.target, '--apply', '--check-with', builtTarget(f), '--runs-every', '1')
      expect(output, output).toContain('dispatch paused: live update to')
      expect(output).toContain('waiting until no workflow step runs: up to 5 min, a look every 1 s')
      expect(output).toMatch(/waiting for what runs, \d+ s of at most 5 min:\n {2}run run_T223/)
      expect(output).toMatch(T223_LINE)
      expect(output).toMatch(/nothing runs: no workflow step runs \(after \d+ s\)/)
      expect(output.indexOf('nothing runs')).toBeLessThan(output.indexOf('system shutdown --deadline 60'))
      // The fixture has no backup to take: the update rolls back, as it did before T234, and the
      // rollback lifts the update's own pause once the daemon runs again.
      expect(output).toContain('ROLLING BACK')
      expect(status).toBe(1)
      // The daemon stopped by the short stop, the unit down with it: its own stop was not needed.
      expect(f.unit.calls()).toEqual(['start system.service', 'reset-failed system.service', 'start system.service'])
      // A profile from before the hold (T257) holds nothing: the wait is for every step.
      expect(output).toContain('this profile holds no steps')
      expect(system.calls()).toEqual(['status', 'roster', 'dispatch_status', 'dispatch_pause', 'hold_steps', 'roster', 'roster', `shutdown 60 ${realpathSync(f.home)}`, 'dispatch_resume', 'live_update_record'])
      expect(stateOf(f)).toContain('dispatch_paused=resumed')
      // The rollback is recorded once the daemon runs again, for every project's lead inbox (D107: live-update.failed).
      expect(system.liveUpdates()).toEqual([{ outcome: 'failed', from: f.from, to: f.target, reason: 'rolled-back' }])
      expect(output).toContain('recorded for the lead inbox: live update failed')
    } finally {
      f.unit.cleanup()
    }
  })

  it('with --no-cut, at the bound, stops with what still runs, the unit not stopped and dispatch resumed', () => {
    const f = fixture()
    const system = running(f)
    system.work([T223])
    try {
      const { status, output } = run(f, f.target, '--apply', '--check-with', builtTarget(f), '--runs-wait', '0', '--no-cut')
      expect(output, output).toContain('still running after 0 s, the bound:')
      expect(output).toMatch(T223_LINE)
      expect(output).toContain('STOP: steps still run after 0 min (above): system.service was not stopped')
      expect(output).toContain('the live install was not changed')
      expect(status).toBe(1)
      expect(f.unit.calls()).toEqual(['start system.service'])
      expect(readFileSync(join(f.unit.dir, 'state'), 'utf8').trim()).toBe('active')
      expect(system.calls()).toEqual(['status', 'roster', 'dispatch_status', 'dispatch_pause', 'hold_steps', 'roster', 'dispatch_resume'])
      expect(stateOf(f)).toContain('phase=captured')
      expect(f.git('rev-parse', 'HEAD')).toBe(f.from)
    } finally {
      f.unit.cleanup()
    }
  })

  it('with --cut-running (the default), cuts at the bound and names what it cuts; an operator\'s pause is left as it is', () => {
    const f = fixture()
    const system = running(f)
    system.work([T223])
    system.dispatch({ enabled: true, paused: { since: '2026-10-26T08:00:00.000Z', reason: 'by hand' } })
    try {
      const { status, output } = run(f, f.target, '--apply', '--check-with', builtTarget(f), '--runs-wait', '0', '--cut-running')
      expect(output, output).toContain('dispatch is paused already, since 2026-10-26T08:00:00.000Z (by hand): left as it is')
      expect(output).toContain('still running after 0 s, the bound; the stop cuts each step below, and each resumes by itself after the restart')
      expect(output).toMatch(T223_LINE)
      expect(output).toContain('cutting: the stop cuts the steps above, still running after 0 min')
      expect(status).toBe(1)
      expect(system.calls()).toContain(`shutdown 60 ${realpathSync(f.home)}`)
      expect(f.unit.calls()).not.toContain('stop system.service')
      expect(system.calls()).not.toContain('dispatch_pause')
      expect(system.calls()).not.toContain('dispatch_resume')
    } finally {
      f.unit.cleanup()
    }
  })

  it('by default holds steps, waits for the steps in flight, then cuts them: a stop with a 60 s drain, never the unit\'s 600 s one, each cut step named for the report (T269)', () => {
    const f = fixture()
    const system = running(f)
    // Held, T223's develop step is still in flight at the bound.
    system.work([T223])
    system.holds([T223])
    try {
      const { status, output } = run(f, f.target, '--apply', '--check-with', builtTarget(f), '--runs-wait', '0')
      expect(output, output).toContain('steps held: each running run finishes the step it is in')
      expect(output).toContain('waiting until no workflow step runs: up to 0 min')
      expect(output).toContain('still running after 0 s, the bound; the stop cuts each step below')
      expect(output).toMatch(T223_LINE)
      expect(output).toContain('stopping the daemon with a drain of at most 60 s (system shutdown --deadline 60)')
      expect(output).toContain('cut at the deadline (1 min): 1 run(s) still running were cut (run_T223)')
      // The hold, the wait, then the cut: in that order, and the unit's own stop never drained.
      const calls = system.calls()
      expect(calls.slice(0, 7)).toEqual(['status', 'roster', 'dispatch_status', 'dispatch_pause', 'hold_steps', 'roster', `shutdown 60 ${realpathSync(f.home)}`])
      expect(f.unit.calls()).not.toContain('stop system.service')
      expect(output).toContain('steps: the hold ends with the next start of the daemon')
      expect(stateOf(f)).toContain('steps_held=restart')
      // What was cut, for the report after the restart.
      const dir = readdirSync(f.backups).find((name) => name.includes('-before-base'))!
      const cut = JSON.parse(readFileSync(join(f.backups, dir, 'cut.json'), 'utf8')) as { cutAt: string; steps: unknown[] }
      expect(cut.steps).toEqual([expect.objectContaining({ runId: 'run_T223', nodeId: 'develop:1', worker: 'agent:codex-main/develop', taskId: 'T223' })])
      // The fixture has no backup to take: it rolls back, and the daemon runs again.
      expect(status).toBe(1)
      expect(readFileSync(join(f.unit.dir, 'state'), 'utf8').trim()).toBe('active')
    } finally {
      f.unit.cleanup()
    }
  })

  it('stops with the drain --cut-deadline names; a CLI without the short stop refuses the cut, never taking the unit\'s drain (T269)', () => {
    const f = fixture()
    const system = running(f)
    system.work([T223])
    try {
      const { output } = run(f, f.target, '--apply', '--check-with', builtTarget(f), '--runs-wait', '0', '--cut-deadline', '5')
      expect(output, output).toContain('stopping the daemon with a drain of at most 5 s (system shutdown --deadline 5)')
      expect(system.calls()).toContain(`shutdown 5 ${realpathSync(f.home)}`)
    } finally {
      f.unit.cleanup()
    }

    const old = fixture()
    const before = running(old)
    before.work([T223])
    before.noShutdown()
    try {
      const { status, output } = run(old, old.target, '--apply', '--check-with', builtTarget(old), '--runs-wait', '0')
      // Refused, nothing stopped: no cut takes the unit's 600 s drain.
      expect(output, output).toContain("this profile's CLI has no shutdownHost, so the short stop is unavailable")
      expect(output).toContain('STOP: the short stop (system shutdown --deadline 60) cannot be made')
      expect(output).toContain('the live install was not changed')
      expect(status).toBe(1)
      expect(old.unit.calls()).toEqual(['start system.service'])
      expect(readFileSync(join(old.unit.dir, 'state'), 'utf8').trim()).toBe('active')
      expect(before.calls()).toContain('dispatch_resume')
    } finally {
      old.unit.cleanup()
    }
  })

  it('waits for a step that runs on no Worker, which the roster does not list', () => {
    const f = fixture()
    const system = running(f)
    const gate: FakeWork = { runId: 'run_T224', nodeId: 'acceptance:1', since: '2026-10-26T09:30:00.000Z', taskId: 'T224' }
    system.work([gate], [gate], [])
    try {
      const { status, output } = run(f, f.target, '--apply', '--check-with', builtTarget(f), '--runs-every', '1')
      expect(output, output).toMatch(/waiting for what runs, \d+ s of at most 5 min:\n {2}run run_T224 step acceptance:1 on no Worker, for \d+ (s|min|h \d+ min) \(task T224, algorithm-development\)/)
      expect(output).toMatch(/nothing runs: no workflow step runs \(after \d+ s\)/)
      expect(output.indexOf('nothing runs')).toBeLessThan(output.indexOf('system shutdown --deadline 60'))
      expect(status).toBe(1)
    } finally {
      f.unit.cleanup()
    }
  })

  it('a dry run prints what --apply would wait for, and pauses nothing', () => {
    const f = fixture()
    const system = running(f)
    system.work([T223])
    try {
      const { status, output } = run(f, f.target)
      expect(output, output).toContain('what --apply would wait for before the stop (up to 5 min, then cut):')
      expect(output).toContain('running now:')
      expect(output).toMatch(T223_LINE)
      expect(output).toContain('at the bound: cut, naming each step it cuts (-> cut.json)')
      expect(output).toContain('system shutdown --deadline 60 (a drain of at most 60 s, then the daemon')
      expect(status).toBe(0)
      expect(f.unit.calls()).toEqual(['start system.service'])
      expect(system.calls()).not.toContain('dispatch_pause')
    } finally {
      f.unit.cleanup()
    }
  })

  /** T223's run chaining steps, as on 2026-10-26: its review, the fix, the review again, never done. */
  const REVIEW: FakeWork = { ...T223, nodeId: 'review:1' }
  const FIX: FakeWork = { ...T223, nodeId: 'fix:1' }

  /** `--apply` in the background, so a test can interrupt it: its output so far, and its exit status. */
  function applying(f: Fixture): { child: ReturnType<typeof spawn>; output: () => string; exited: Promise<number | null> } {
    const child = spawn('bash', [SCRIPT, f.target, '--from', f.from, '--live', f.live, '--dsh-home', f.home, '--backups', f.backups,
      '--node-dir', dirname(process.execPath), '--pnpm-dir', f.bin, '--apply', '--check-with', builtTarget(f), '--runs-every', '1'], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } })
    let output = ''
    child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()))
    return { child, output: () => output, exited: new Promise((resolve) => child.on('close', (code) => resolve(code))) }
  }

  it('holds steps, so the wait ends when the steps in flight end, though the run would chain its next steps (T257)', () => {
    const f = fixture()
    const system = running(f)
    // Unheld, the run goes on from its develop step to its review, the fix, the review again: never idle.
    system.work([T223], [T223], [REVIEW], [FIX], [REVIEW])
    // Held, its develop step finishes and nothing starts after it.
    system.holds([T223], [])
    try {
      const { status, output } = run(f, f.target, '--apply', '--check-with', builtTarget(f), '--runs-every', '1', '--runs-wait', '1')
      expect(output, output).toContain('steps held: each running run finishes the step it is in (0 in flight) and starts no next one until the restart')
      expect(output).toMatch(T223_LINE)
      expect(output).toMatch(/nothing runs: no workflow step runs \(after \d+ s\)/)
      expect(output).not.toContain('review:1')
      expect(output.indexOf('nothing runs')).toBeLessThan(output.indexOf('system shutdown --deadline 60'))
      // Once the daemon exited, its next start ends the hold: the update releases nothing itself.
      expect(output).toContain('steps: the hold ends with the next start of the daemon')
      expect(stateOf(f)).toContain('steps_held=restart')
      expect(system.calls()).toEqual(['status', 'roster', 'dispatch_status', 'dispatch_pause', 'hold_steps', 'roster', 'roster', `shutdown 60 ${realpathSync(f.home)}`, 'dispatch_resume', 'live_update_record'])
      expect(status).toBe(1)
    } finally {
      f.unit.cleanup()
    }
  })

  it('with --no-cut, at the bound, releases the hold before it stops, the unit not stopped (T257)', () => {
    const f = fixture()
    const system = running(f)
    system.work([T223])
    system.holds([T223])
    try {
      const { status, output } = run(f, f.target, '--apply', '--check-with', builtTarget(f), '--runs-wait', '0', '--no-cut')
      expect(output, output).toContain('steps released: each running run goes on from its recorded state')
      expect(output).toContain('STOP: steps still run after 0 min (above): system.service was not stopped')
      expect(status).toBe(1)
      expect(system.held()).toBe(false)
      expect(stateOf(f)).toContain('steps_held=released')
      expect(system.calls()).toEqual(['status', 'roster', 'dispatch_status', 'dispatch_pause', 'hold_steps', 'roster', 'hold_steps release', 'dispatch_resume'])
      expect(f.unit.calls()).toEqual(['start system.service'])
    } finally {
      f.unit.cleanup()
    }
  })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`an update interrupted while it waits (${signal}) ends the wait at once and leaves no hold (T257)`, async () => {
      const f = fixture()
      const system = running(f)
      system.work([T223])
      system.holds([T223])
      try {
        const update = applying(f)
        // It waits for T223's step, held (up to 5 min).
        await vi.waitFor(() => expect(update.output()).toMatch(/waiting for what runs, \d+ s of at most 5 min/), { timeout: 30_000, interval: 100 })
        expect(system.held()).toBe(true)
        update.child.kill(signal)
        // Its reader is stopped too: the script's output closes, long before the wait's bound.
        const code = await update.exited
        expect(code, update.output()).toBe(signal === 'SIGINT' ? 130 : 143)
        expect(update.output()).toContain('steps released: each running run goes on from its recorded state')
        expect(system.held()).toBe(false)
        expect(system.calls().slice(-1)).toEqual(['hold_steps release'])
        expect(stateOf(f)).toContain('steps_held=released')
        expect(f.unit.calls()).toEqual(['start system.service'])
      } finally {
        f.unit.cleanup()
      }
    })

    it(`an update interrupted (${signal}) while it asks for the hold, which the daemon set before it answered, leaves no hold (T257 review)`, async () => {
      const f = fixture()
      const system = running(f)
      system.work([T223])
      system.holds([T223])
      // The daemon sets the hold at once and answers 10 s later: long enough that the interruption
      // below always comes before the answer, however loaded the host.
      system.holdDelay(10_000)
      try {
        const update = applying(f)
        // The hold is set, and the script has no answer yet: its release is owed already.
        await vi.waitFor(() => expect(system.held()).toBe(true), { timeout: 30_000, interval: 50 })
        expect(stateOf(f)).toContain('steps_held=pending')
        update.child.kill(signal)
        const code = await update.exited
        expect(code, update.output()).toBe(signal === 'SIGINT' ? 130 : 143)
        expect(update.output()).toContain('steps released: each running run goes on from its recorded state')
        expect(system.held()).toBe(false)
        expect(system.calls().slice(-1)).toEqual(['hold_steps release'])
        expect(stateOf(f)).toContain('steps_held=released')
        expect(f.unit.calls()).toEqual(['start system.service'])
      } finally {
        f.unit.cleanup()
      }
    })
  }

  it('takes --runs-wait in whole minutes, --runs-every in whole seconds, at least 1, and --cut-deadline in whole seconds, at most 600', () => {
    const f = fixture()
    for (const args of [['--runs-wait', 'soon'], ['--runs-every', '0'], ['--cut-deadline', 'soon'], ['--cut-deadline', '601']]) {
      const { status, output } = run(f, f.target, ...args)
      expect(status).toBe(2)
      expect(output).toContain('[--runs-wait <minutes>] [--runs-every <seconds>] [--cut-running | --no-cut]')
      expect(output).toContain('[--cut-deadline <seconds>]')
    }
  })
})

describe('live-update-check: what runs before the stop (T234)', () => {
  const item = { runId: 'run_T223', template: 'algorithm-development', nodeId: 'develop:1', attempt: 1, task: { taskId: 'T223' }, since: { value: '2026-10-26T09:00:00.000Z' }, summary: 'Working on …' }
  const roster = (items: unknown[], more = 0, extra: { unread?: string; unlisted?: number } = {}) => ({
    workers: { value: [{ worker: 'agent:codex-main/develop', work: { value: { items, more, ...(extra.unread ? { unread: extra.unread } : {}) } } }, { worker: 'worker:gemini-main/flash', work: { value: { items: [], more: 0 } } }] },
    unlisted: extra.unlisted ?? 0,
  })
  /** T223's develop step as the store holds it: no task or start read there. */
  const stored = { runId: 'run_T223', nodeId: 'develop:1', worker: 'agent:codex-main/develop', template: 'algorithm-development' }
  const none = { steps: [] }
  const busy: Running = runningOf({ steps: [stored] }, roster([item]))
  const OLDER = 'only the newest 500 runs were read: an older run still running is not shown'

  /** A store as the engine's migrations leave it, with only the columns the read names. */
  function store(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY, template TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE workflow_nodes (run_id TEXT, node_id TEXT, state TEXT, worker TEXT);
      CREATE TABLE workflow_tasks (run_id TEXT, task_id TEXT);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, type TEXT, run_id TEXT, node_id TEXT)`)
    return db
  }

  it('reads every RUNNING step of every running run from the store, on a Worker or not', () => {
    const db = store()
    db.exec(`INSERT INTO workflow_runs VALUES ('run_T223', 'algorithm-development', 'running'), ('run_T224', 'algorithm-development', 'running'), ('run_done', 'ask', 'completed');
      INSERT INTO workflow_nodes VALUES ('run_T223', 'develop:1', 'RUNNING', 'agent:codex-main/develop'), ('run_T223', 'plan:1', 'COMPLETED', 'agent:codex-main/plan'),
        ('run_T224', 'acceptance:1', 'RUNNING', NULL), ('run_T224', 'report:1', 'WAITING', NULL), ('run_done', 'ask:1', 'RUNNING', 'w');
      INSERT INTO workflow_tasks VALUES ('run_T224', 'T224');
      INSERT INTO events (at, type, run_id, node_id) VALUES ('2026-10-26T09:00:00.000Z', 'workflow.node.started', 'run_T224', 'acceptance:1'), ('2026-10-26T09:30:00.000Z', 'workflow.node.started', 'run_T224', 'acceptance:1')`)
    expect(runningInStore(db)).toEqual({ steps: [stored, { runId: 'run_T224', nodeId: 'acceptance:1', template: 'algorithm-development', taskId: 'T224', since: '2026-10-26T09:30:00.000Z' }] })
    // A store from before workflow_tasks, or without the event log: the steps, without what those add.
    db.exec('DROP TABLE workflow_tasks; DROP TABLE events')
    expect(runningInStore(db)).toEqual({ steps: [stored, { runId: 'run_T224', nodeId: 'acceptance:1', template: 'algorithm-development' }] })
    db.exec('DROP TABLE workflow_nodes')
    expect(runningInStore(db)).toEqual({ unread: "the store's runs: no such table: workflow_nodes" })
    db.close()
  })

  it('a step on no Worker, which the roster never lists, keeps the wait waiting', () => {
    const gate = { runId: 'run_T224', nodeId: 'acceptance:1', template: 'algorithm-development', taskId: 'T224' }
    const running = runningOf({ steps: [gate] }, roster([]))
    expect(running).toEqual({ steps: [gate], more: 0, notes: [] })
    expect(idle(running)).toBe(false)
    expect(runningLines(running, 0)).toEqual(['run run_T224 step acceptance:1 on no Worker, since when unknown (task T224, algorithm-development)'])
  })

  it('takes the roster\'s task and start for a store step, and counts a step only the roster lists', () => {
    expect(busy).toEqual({ steps: [{ ...stored, taskId: 'T223', since: '2026-10-26T09:00:00.000Z' }], more: 0, notes: [] })
    expect(idle(busy)).toBe(false)
    expect(runningOf(none, roster([item]))).toEqual(busy)
    expect(idle(runningOf(none, roster([])))).toBe(true)
    expect(idle(runningOf(none, roster([], 2)))).toBe(false)
  })

  it('a store it cannot read is never nothing running', () => {
    const unread = runningOf({ unread: 'the store: database is locked' }, roster([]))
    expect(unread).toEqual({ unread: 'the store: database is locked' })
    expect(idle(unread)).toBe(false)
    expect(runningLines(unread, 0)).toEqual(['what runs cannot be read: the store: database is locked'])
  })

  it('past the roster\'s newest 500 runs, a run the store holds still runs, and the bound is said', () => {
    const old = { runId: 'run_old', nodeId: 'develop:1', worker: 'agent:codex-main/develop', template: 'algorithm-development' }
    const running = runningOf({ steps: [old] }, roster([], 0, { unread: OLDER }))
    expect(idle(running)).toBe(false)
    expect(runningLines(running, 0)).toEqual([
      'run run_old step develop:1 on agent:codex-main/develop, since when unknown (algorithm-development)',
      `note: the roster: ${OLDER}; the store's read covers every run`,
    ])
    // When nothing runs, the bound is said too.
    expect(runningLines(runningOf(none, roster([], 0, { unread: OLDER })), 0)).toEqual([`note: the roster: ${OLDER}; the store's read covers every run`])
  })

  it('a step on a Worker past the 256 the roster lists still runs, and the Workers not listed are said', () => {
    const far = { runId: 'run_far', nodeId: 'review:1', worker: 'worker:zz-last/flash', template: 'review' }
    const running = runningOf({ steps: [far] }, roster([], 0, { unlisted: 3 }))
    expect(idle(running)).toBe(false)
    expect(runningLines(running, 0)).toEqual([
      'run run_far step review:1 on worker:zz-last/flash, since when unknown (review)',
      "note: the roster did not list 3 Worker(s); the store's read covers their steps",
    ])
  })

  it('what the roster cannot tell is a note; the store still decides', () => {
    const unknown = runningOf({ steps: [stored] }, { workers: { value: [{ worker: 'a', work: { unknown: 'the engine is not mounted' } }, { worker: 'b' }] } })
    expect(idle(unknown)).toBe(false)
    expect('notes' in unknown && unknown.notes).toEqual(["the roster does not know what runs on 2 Worker(s): a (the engine is not mounted), b (the roster lists no work for it); the store's read covers their steps"])
    expect(runningOf(none, { workers: { unknown: 'the Worker registry is not mounted' } })).toEqual({
      steps: [], more: 0, notes: ["the roster's Workers are unknown (the Worker registry is not mounted): the store's steps are named without what it adds"],
    })
    expect(runningOf({ steps: [stored] }, { unread: 'roster: unknown tool roster' })).toEqual({
      steps: [stored], more: 0, notes: ["the roster was not read (roster: unknown tool roster): the store's steps are named without what it adds"],
    })
  })

  it('names each run, its step, its Worker, and for how long', () => {
    expect(runningLines(busy, Date.parse('2026-10-26T10:31:20.000Z'))).toEqual(['run run_T223 step develop:1 on agent:codex-main/develop, for 1 h 31 min (task T223, algorithm-development)'])
    expect(runningLines(runningOf({ steps: [stored] }, roster([{ ...item, task: undefined, since: { unknown: 'retention' } }], 1)), 0))
      .toEqual(['run run_T223 step develop:1 on agent:codex-main/develop, since when unknown (algorithm-development)', 'and 1 more step(s) the roster counted and did not list'])
  })

  it('waits, bounded, until nothing runs, and says what runs when it changes and every five minutes', async () => {
    let clock = Date.parse('2026-10-26T10:00:00.000Z')
    const sleeps: number[] = []
    const reports: string[][] = []
    const options = { waitMs: 90 * 60_000, everyMs: 30_000, reportEveryMs: 300_000, report: (lines: string[]) => reports.push(lines), sleep: async (ms: number) => { sleeps.push(ms); clock += ms }, now: () => clock }
    const reads = [busy, busy, runningOf(none, roster([]))]
    let read = 0
    const done = await awaitIdle(async () => reads[Math.min(read++, reads.length - 1)]!, options)
    expect(done.idle).toBe(true)
    expect(done.waitedMs).toBe(60_000)
    expect(sleeps).toEqual([30_000, 30_000])
    expect(reports).toEqual([['waiting for what runs, 0 s of at most 1 h 30 min:', '  run run_T223 step develop:1 on agent:codex-main/develop, for 1 h 0 min (task T223, algorithm-development)']])

    // Still running at the bound: no more than the wait, a report every five minutes.
    const start = clock
    sleeps.length = 0
    reports.length = 0
    const stuck = await awaitIdle(async () => busy, options)
    expect(stuck.idle).toBe(false)
    expect(clock - start).toBe(90 * 60_000)
    expect(sleeps).toHaveLength(180)
    expect(reports).toHaveLength(18)

    // Nothing runs: one read, no wait.
    sleeps.length = 0
    expect((await awaitIdle(async () => runningOf(none, roster([])), options)).idle).toBe(true)
    expect(sleeps).toEqual([])
  })
})

describe('live-update-check: how each step the stop cut resumed (T269)', () => {
  const CUT_AT = '2026-10-26T10:30:00.000Z'
  /** A store after the restart, as the engine's, the board's, and the event log's migrations leave it. */
  function store(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY, template TEXT, status TEXT, created_at TEXT);
      CREATE TABLE workflow_nodes (run_id TEXT, node_id TEXT, state TEXT, worker TEXT, infrastructure TEXT);
      CREATE TABLE workflow_tasks (run_id TEXT, task_id TEXT);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, type TEXT, run_id TEXT, node_id TEXT, entry TEXT)`)
    return db
  }
  const step = (runId: string, nodeId: string, taskId?: string) => ({ runId, nodeId, worker: 'agent:codex-main/develop', template: 'algorithm-development', ...(taskId ? { taskId } : {}) })

  it('names a free retry, a resumed session, a step not settled yet, and each check run again', () => {
    const db = store()
    db.exec(`INSERT INTO workflow_runs VALUES ('run_T223', 'algorithm-development', 'failed', '2026-10-26T09:00:00.000Z'), ('run_T223b', 'algorithm-development', 'running', '2026-10-26T10:41:00.000Z'),
        ('run_T224', 'algorithm-development', 'completed', '2026-10-26T09:10:00.000Z'), ('run_T225', 'algorithm-development', 'running', '2026-10-26T09:20:00.000Z'),
        ('run_T226', 'algorithm-development', 'failed', '2026-10-26T09:30:00.000Z');
      INSERT INTO workflow_nodes VALUES ('run_T223', 'develop:1', 'FAILED', 'agent:codex-main/develop', 'host-stopped'), ('run_T224', 'review:1', 'COMPLETED', 'agent:codex-main/review', NULL),
        ('run_T225', 'develop:1', 'READY', NULL, NULL), ('run_T226', 'develop:1', 'FAILED', 'agent:codex-main/develop', NULL);
      INSERT INTO workflow_tasks VALUES ('run_T223', 'T223'), ('run_T223b', 'T223');`)
    db.prepare("INSERT INTO events (at, type, run_id, entry) VALUES (?, 'agent-workers.check.rerun', ?, ?)")
      .run('2026-10-26T10:42:00.000Z', 'run_T227', JSON.stringify({ decision: 'sha256:abc', data: { check: 'tests', subject: 'git:main:v1', cuts: 1 } }))
    // A re-run from before this cut is another update's.
    db.prepare("INSERT INTO events (at, type, run_id, entry) VALUES (?, 'agent-workers.check.rerun', ?, ?)").run('2026-10-25T10:00:00.000Z', 'run_old', '{}')
    const cut: CutSteps = { cutAt: CUT_AT, steps: [step('run_T223', 'develop:1', 'T223'), step('run_T224', 'review:1'), step('run_T225', 'develop:1'), step('run_T226', 'develop:1'), step('run_gone', 'plan:1')] }
    const outcomes = cutOutcomes(db, cut)
    expect(outcomes.steps.map((o) => o.how)).toEqual(['free-retry', 'resumed', 'pending', 'counted', 'unknown'])
    expect(cutReportLines(cut, outcomes)).toEqual([
      'cut at 2026-10-26T10:30:00.000Z: 5 step(s)',
      '  run run_T223 step develop:1 on agent:codex-main/develop (task T223): free retry (T218): the step ended host-stopped, so its run\'s failure spends no attempt; run run_T223b serves task T223 now (running)',
      '  run run_T224 step review:1 on agent:codex-main/develop: resumed: the step went on in its session from its recorded state, and is completed (run completed)',
      '  run run_T225 step develop:1 on agent:codex-main/develop: not settled yet (step READY, run running): it resumes by itself; system explain run_T225',
      '  run run_T226 step develop:1 on agent:codex-main/develop: its run failed, not as the host\'s (step FAILED): the attempt counts; system explain run_T226',
      '  run run_gone step plan:1 on agent:codex-main/develop: the store no longer holds run run_gone step plan:1',
      '  run run_T227: its tests check, cut by the host, re-run on git:main:v1 (cut 1 time(s)), decision sha256:abc',
    ])
    db.close()
  })

  it('says what really happened to each cut step: resumed, restarted, a free retry on the engine\'s JSON mark, or failed with its reason (T283)', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY, template TEXT, status TEXT, created_at TEXT);
      CREATE TABLE workflow_nodes (run_id TEXT, node_id TEXT, state TEXT, worker TEXT, infrastructure TEXT, error TEXT);
      CREATE TABLE workflow_tasks (run_id TEXT, task_id TEXT);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, type TEXT, run_id TEXT, node_id TEXT, entry TEXT)`)
    const mark = JSON.stringify({ kind: 'host-stopped', reason: 'the host stopped' })
    const error = JSON.stringify({ kind: 'reconciliation_failed', disposition: 'USER_ACTION', message: 'it died on its own' })
    db.exec(`INSERT INTO workflow_runs VALUES ('run_a', 't', 'running', '2026-10-26T09:00:00.000Z'), ('run_b', 't', 'running', '2026-10-26T09:00:00.000Z'),
        ('run_c', 't', 'failed', '2026-10-26T09:00:00.000Z'), ('run_d', 't', 'failed', '2026-10-26T09:00:00.000Z');
      INSERT INTO workflow_nodes VALUES ('run_a', 'develop:1', 'RUNNING', 'w', NULL, NULL), ('run_b', 'develop:1', 'RUNNING', 'w', NULL, NULL),
        ('run_c', 'develop:1', 'FAILED', 'w', '${mark}', '${error}'), ('run_d', 'develop:1', 'FAILED', 'w', NULL, '${error}')`)
    const resumed = (run: string, how: string) => db.prepare("INSERT INTO events (at, type, run_id, node_id, entry) VALUES ('2026-10-26T10:41:00.000Z', 'agent-workers.run.resumed', ?, 'develop:1', ?)")
      .run(run, JSON.stringify({ nodeId: 'develop:1', data: { agentRun: 'arun_1', how, resumes: 1, step: 'develop:1' } }))
    resumed('run_a', 'resumed')
    resumed('run_b', 'restarted')
    const cut: CutSteps = { cutAt: CUT_AT, steps: [step('run_a', 'develop:1'), step('run_b', 'develop:1'), step('run_c', 'develop:1'), step('run_d', 'develop:1')] }
    const outcomes = cutOutcomes(db, cut)
    expect(outcomes.steps.map((o) => o.how)).toEqual(['resumed', 'restarted', 'free-retry', 'counted'])
    expect(outcomes.steps[0]!.detail).toMatch(/^resumed: the agent run went on in its native session after the restart, no attempt spent, nothing asked of the operator; the step is running \(run running\) \(cut 1 time\(s\)\)$/)
    expect(outcomes.steps[1]!.detail).toMatch(/^restarted: its runtime cannot resume, so the agent run started again from the same worktree/)
    expect(outcomes.steps[3]!.detail).toBe('its run failed, not as the host\'s (step FAILED): reconciliation_failed: it died on its own: the attempt counts; system explain run_d')
    db.close()
  })

  it('reads a store from before the infrastructure mark, and says when nothing was cut', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY, status TEXT); CREATE TABLE workflow_nodes (run_id TEXT, node_id TEXT, state TEXT);
      INSERT INTO workflow_runs VALUES ('run_T223', 'running'); INSERT INTO workflow_nodes VALUES ('run_T223', 'develop:1', 'RUNNING')`)
    expect(cutOutcomes(db, { cutAt: CUT_AT, steps: [step('run_T223', 'develop:1')] }).steps.map((o) => o.detail))
      .toEqual(['resumed: the step runs again in its session from its recorded state (run running)'])
    const none: CutSteps = { cutAt: CUT_AT, steps: [] }
    expect(cutReportLines(none, cutOutcomes(db, none))).toEqual(['cut at 2026-10-26T10:30:00.000Z: 0 step(s)', '  nothing was cut that the store tells of'])
    db.close()
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
