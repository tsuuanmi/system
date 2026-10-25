// The automatic live update's pass (docs/operations/runbooks.md#update-the-live-install-automatically),
// on a throwaway upstream, live checkout, check worktree, and DSH home, with a stand-in gh and pnpm
// and no daemon: what it waits on, refuses, and pauses itself for. An update itself is
// scripts/live-update.sh's, whose own tests and rehearsal cover it.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { daemonEnv, standInUnit } from './systemd-stand-in.ts'

// Each test runs a pass of the script end to end, once or several times, and a pass that updates
// runs live-update.sh's dry run too, each starting git, Node, and the stand-ins as real processes:
// 1 to 3 s a test on an idle core, up to 8 s on a loaded one, where the 5 s default failed them. A
// pass is synchronous: the bound cannot stop a hung one, it only fails a slow one.
vi.setConfig({ testTimeout: 60_000 })

const SCRIPTS = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(SCRIPTS, 'live-auto-update.sh')

interface Fixture {
  root: string; upstream: string; live: string; check: string; home: string; backups: string; bin: string
  from: string; target: string; pause: string; log: string
  git: (dir: string, ...args: string[]) => string
  gh: (checkRuns: string, status?: string) => void
}

/**
 * An upstream whose main is one commit ahead of the live checkout (a clone at the first), a check
 * worktree of the live repository, a profile, and stand-ins: pnpm (its build writes a CLI whose
 * `system check` passes, unless FAKE_CHECK=fail, and the build stamp), gh (prints what `gh(…)` set),
 * and systemctl (system.service, with no daemon running).
 */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'live-auto-update-'))
  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
  const upstream = join(root, 'upstream')
  mkdirSync(join(upstream, 'packages', 'cli', 'src'), { recursive: true })
  mkdirSync(join(upstream, 'scripts'))
  execFileSync('git', ['init', '-q', '-b', 'main', upstream])
  for (const file of ['live-update.sh', 'live-update-check.ts']) copyFileSync(join(SCRIPTS, file), join(upstream, 'scripts', file))
  writeFileSync(join(upstream, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  writeFileSync(join(upstream, 'packages', 'cli', 'package.json'), `${JSON.stringify({ scripts: { build: 'tsc && git rev-parse HEAD > lib/build-commit' } })}\n`)
  writeFileSync(join(upstream, 'packages', 'cli', 'src', 'index.ts'), 'export const previous = 1\n')
  git(upstream, 'add', '-A')
  git(upstream, 'commit', '-q', '-m', 'live')
  const from = git(upstream, 'rev-parse', 'HEAD')
  writeFileSync(join(upstream, 'packages', 'cli', 'src', 'index.ts'), 'export const next = 2\n')
  git(upstream, 'commit', '-q', '-am', 'main')
  const target = git(upstream, 'rev-parse', 'HEAD')

  const live = join(root, 'live')
  execFileSync('git', ['clone', '-q', upstream, live])
  git(live, 'checkout', '-q', '--detach', from)
  const check = join(root, 'check')
  git(live, 'worktree', 'add', '-q', '--detach', check, from)

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
  mkdirSync(join(bin, 'gh-out'), { recursive: true })
  const cli = "console.log('ok: the profile passes'); process.exit(process.env.FAKE_CHECK === 'fail' ? 1 : 0)"
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\nif [ "$1" = build ]; then\n  mkdir -p packages/cli/lib && echo "${cli}" > packages/cli/lib/bin.js && git rev-parse HEAD > packages/cli/lib/build-commit\nfi\n`)
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\ncase "$*" in\n  *check-runs*) f=check-runs ;;\n  *) f=status ;;\nesac\n[ -f ${bin}/gh-out/fail ] && { echo 'gh: not signed in' >&2; exit 4; }\ncat ${bin}/gh-out/$f\n`)
  chmodSync(join(bin, 'pnpm'), 0o755)
  chmodSync(join(bin, 'gh'), 0o755)
  const gh = (checkRuns: string, status = 'pending 0'): void => {
    writeFileSync(join(bin, 'gh-out', 'check-runs'), checkRuns)
    writeFileSync(join(bin, 'gh-out', 'status'), `${status}\n`)
  }
  gh('completed success node 24 / check + test + e2e\ncompleted success codeql / javascript-typescript\n')
  standInUnit(root, bin, live, home, daemonEnv(root, home))
  return {
    root, upstream, live, check, home, backups, bin, from, target, git, gh,
    pause: join(home, 'system', 'auto-update.paused'), log: join(backups, 'auto-update', 'log'),
  }
}

function args(f: Fixture, ...extra: string[]): string[] {
  return [SCRIPT, '--live', f.live, '--check', f.check, '--dsh-home', f.home, '--backups', f.backups,
    '--node-dir', dirname(process.execPath), '--pnpm-dir', f.bin, '--settle', '0', ...extra]
}

function pass(f: Fixture, extra: string[] = [], env: Record<string, string> = {}): { status: number | null; output: string } {
  const result = spawnSync('bash', args(f, ...extra), { encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, ...env } })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const lines = (f: Fixture): string[] => readFileSync(f.log, 'utf8').trim().split('\n')

/** A `dev` branch on the upstream, one commit ahead of main; the upstream is left on main. */
function devBranch(f: Fixture): string {
  f.git(f.upstream, 'checkout', '-q', '-b', 'dev')
  writeFileSync(join(f.upstream, 'packages', 'cli', 'src', 'index.ts'), 'export const dev = 3\n')
  f.git(f.upstream, 'commit', '-q', '-am', 'dev')
  const head = f.git(f.upstream, 'rev-parse', 'HEAD')
  f.git(f.upstream, 'checkout', '-q', 'main')
  return head
}

/** What the check worktree's last fetch fetched (its FETCH_HEAD), or '' when it never fetched. */
function fetchHead(f: Fixture): string {
  const path = resolve(f.check, f.git(f.check, 'rev-parse', '--git-path', 'FETCH_HEAD'))
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

describe('live-auto-update.sh', () => {
  it('does nothing when the live checkout is at origin/main', () => {
    const f = fixture()
    f.git(f.live, 'checkout', '-q', '--detach', f.target)
    const { status, output } = pass(f)
    expect(output, output).toMatch(/ current: the live install is at origin\/main /)
    expect(status).toBe(0)
    expect(lines(f)).toHaveLength(1)
    expect(f.git(f.check, 'rev-parse', 'HEAD')).toBe(f.from)
  })

  it('refuses a main that is not a fast-forward of the live commit, and pauses', () => {
    const f = fixture()
    f.git(f.live, 'checkout', '-q', '--detach', f.target)
    // main rewritten: a commit on the live commit's parent, not on the live commit.
    f.git(f.upstream, 'reset', '-q', '--hard', f.from)
    writeFileSync(join(f.upstream, 'other.txt'), 'other\n')
    f.git(f.upstream, 'add', 'other.txt')
    f.git(f.upstream, 'commit', '-q', '-m', 'rewritten')
    const { status, output } = pass(f)
    expect(output, output).toContain('not a fast-forward')
    expect(status).toBe(1)
    expect(readFileSync(f.pause, 'utf8')).toContain('not a fast-forward')
    expect(f.git(f.live, 'rev-parse', 'HEAD')).toBe(f.target)
  })

  it('waits on a check still running, a pending status, no check yet, or no gh; refuses a failed one', () => {
    const f = fixture()
    const cases: [string, string, RegExp][] = [
      ['in_progress null node 26 / check + test + e2e\ncompleted success codeql\n', 'pending 0', / wait: CI of \w+: check run 'node 26 \/ check \+ test \+ e2e' is in_progress$/],
      ['completed success codeql\n', 'pending 1', / wait: CI of \w+: a commit status is pending$/],
      ['', 'pending 0', / wait: CI of \w+: no check run yet$/],
      ['completed failure node 24 / check + test + e2e\nin_progress null codeql\n', 'pending 0', / refused: CI of \w+: check run 'node 24 \/ check \+ test \+ e2e' ended failure$/],
      ['completed success codeql\n', 'failure 1', / refused: CI of \w+: the commit status is failure$/],
    ]
    for (const [runs, combined, expected] of cases) {
      f.gh(runs, combined)
      const { status, output } = pass(f)
      expect(status, output).toBe(0)
      expect(lines(f).at(-1)).toMatch(expected)
    }
    writeFileSync(join(f.bin, 'gh-out', 'fail'), '')
    expect(pass(f).status).toBe(0)
    expect(lines(f).at(-1)).toMatch(/ wait: CI of \w+: gh api failed: gh: not signed in$/)
    expect(existsSync(f.pause)).toBe(false)
    expect(f.git(f.check, 'rev-parse', 'HEAD')).toBe(f.from)
    expect(f.git(f.live, 'rev-parse', 'HEAD')).toBe(f.from)
  })

  it('waits for the settle delay after the commit is first seen, and for the hours', () => {
    const f = fixture()
    expect(pass(f, ['--settle', '30']).status).toBe(0)
    expect(lines(f).at(-1)).toMatch(/ wait: \w+ settles for 30 more minute\(s\)$/)
    // Two hours ahead: the hour may turn before the pass reads it, and the next one is still outside.
    const hour = new Date().getHours()
    const pad = (h: number): string => String(h % 24).padStart(2, '0')
    expect(pass(f, ['--hours', `${pad(hour + 2)}-${pad(hour + 3)}`]).status).toBe(0)
    expect(lines(f).at(-1)).toMatch(/ wait: outside the hours \d\d-\d\d$/)
    expect(pass(f, ['--hours', '7-9']).status).toBe(2)
    expect(f.git(f.check, 'rev-parse', 'HEAD')).toBe(f.from)
  })

  it('honours the pause file and a pass that holds the lock', () => {
    const f = fixture()
    writeFileSync(f.pause, 'looking at it\n')
    const { status, output } = pass(f)
    expect(status).toBe(0)
    expect(output).toMatch(/ paused: looking at it /)
    const lock = join(f.backups, 'auto-update', 'lock')
    const held = spawnSync('flock', [lock, 'bash', ...args(f)], { encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } })
    expect(held.status).toBe(0)
    expect(lines(f).at(-1)).toMatch(/ busy: another pass runs$/)
    expect(f.git(f.check, 'rev-parse', 'HEAD')).toBe(f.from)
  })

  it('pauses itself when an update that stopped the daemon is unfinished', () => {
    const f = fixture()
    const dir = join(f.backups, '2026-10-24-before-base')
    mkdirSync(dir)
    writeFileSync(join(dir, 'live-update.state'), `from=${f.from}\ntarget=${f.target}\nphase=built\n`)
    const { status, output } = pass(f)
    expect(output, output).toContain('an update that stopped the daemon is unfinished')
    expect(status).toBe(1)
    expect(existsSync(f.pause)).toBe(true)
  })

  it('stops at the dry run when the live patch fails the target\'s system check, and pauses', () => {
    const f = fixture()
    const { status, output } = pass(f, [], { FAKE_CHECK: 'fail' })
    expect(output, output).toContain('the dry run refused')
    expect(status).toBe(1)
    expect(readFileSync(f.pause, 'utf8')).toContain('the dry run refused')
    // The target was built in the check worktree, stamped; the live checkout was never touched.
    expect(f.git(f.check, 'rev-parse', 'HEAD')).toBe(f.target)
    expect(readFileSync(join(f.check, 'packages', 'cli', 'lib', 'build-commit'), 'utf8').trim()).toBe(f.target)
    expect(f.git(f.live, 'rev-parse', 'HEAD')).toBe(f.from)
    expect(readdirSync(f.backups).sort()).toEqual(['.live-update.lock', 'auto-update'])
    const out = lines(f).at(-1)!.match(/\(output: (\S+)\)/)![1]!
    expect(readFileSync(out, 'utf8')).toContain('the profile does not pass the target\'s checks')
    // Paused: the next pass does nothing.
    expect(pass(f).status).toBe(0)
    expect(lines(f).at(-1)).toMatch(/ paused: the dry run refused /)
  })

  it('pauses itself after a live update that stopped, and never passes a patch', () => {
    const f = fixture()
    // No daemon: the dry run passes, and --apply stops before anything changes.
    const { status, output } = pass(f)
    expect(output, output).toContain('stopped or rolled back (exit 1)')
    expect(status).toBe(1)
    expect(readFileSync(f.pause, 'utf8')).toContain('stopped or rolled back')
    const out = readFileSync(lines(f).at(-1)!.match(/\(output: (\S+)\)/)![1]!, 'utf8')
    expect(out).toContain('Plan for --apply (this dry run changed nothing)')
    expect(out).toContain('the live patch stays')
    expect(out).toContain('the daemon is not running: start it')
    expect(f.git(f.live, 'rev-parse', 'HEAD')).toBe(f.from)
  })

  it('--branch dev takes the live install to dev\'s head and never reads main', () => {
    const f = fixture()
    const dev = devBranch(f)
    // No main on the upstream any more: a pass that fetched it would only wait.
    f.git(f.upstream, 'checkout', '-q', 'dev')
    f.git(f.upstream, 'branch', '-q', '-D', 'main')
    // No daemon, as above: the target is built and dry-run, and --apply stops before anything changes.
    const { status, output } = pass(f, ['--branch', 'dev'])
    expect(output, output).toContain('stopped or rolled back (exit 1)')
    expect(status).toBe(1)
    expect(lines(f)).toHaveLength(1)
    expect(lines(f).at(-1)).toMatch(new RegExp(` origin/dev stopped: the update to ${dev.slice(0, 12)} stopped or rolled back`))
    expect(lines(f).at(-1)).not.toContain('origin/main')
    expect(fetchHead(f)).toContain(dev)
    expect(fetchHead(f)).toContain("branch 'dev' of")
    expect(fetchHead(f)).not.toContain("'main'")
    expect(f.git(f.check, 'rev-parse', 'HEAD')).toBe(dev)
    expect(readFileSync(join(f.check, 'packages', 'cli', 'lib', 'build-commit'), 'utf8').trim()).toBe(dev)
    const out = readFileSync(lines(f).at(-1)!.match(/\(output: (\S+)\)/)![1]!, 'utf8')
    expect(out).toContain('Plan for --apply (this dry run changed nothing)')
    const notes = readFileSync(f.pause, 'utf8')
    expect(notes).toContain(`branch origin/dev, live ${f.from}, target ${dev}`)
    expect(f.git(f.live, 'rev-parse', 'HEAD')).toBe(f.from)
  })

  it('--branch dev has nothing to do once the live install is at dev\'s head, though main is behind it', () => {
    const f = fixture()
    const dev = devBranch(f)
    f.git(f.live, 'fetch', '-q', 'origin', 'dev')
    f.git(f.live, 'checkout', '-q', '--detach', dev)
    const { status, output } = pass(f, ['--branch', 'dev'])
    expect(status, output).toBe(0)
    expect(lines(f)).toHaveLength(1)
    expect(lines(f).at(-1)).toMatch(new RegExp(` origin/dev current: the live install is at origin/dev ${dev.slice(0, 12)}$`))
    expect(f.git(f.check, 'rev-parse', 'HEAD')).toBe(f.from)
    expect(existsSync(f.pause)).toBe(false)
  })

  it('refuses a branch name that is not a plain one before anything runs', () => {
    const f = fixture()
    // A git that only records: a refused pass must never start one.
    writeFileSync(join(f.bin, 'git'), `#!/bin/sh\necho "$*" >>${f.bin}/git-calls\nexit 99\n`)
    chmodSync(join(f.bin, 'git'), 0o755)
    const bad = ['', '-dev', '.dev', 'dev.', 'dev/', '/dev', 'a//b', 'dev..main', 'a/.b', 'a/-b', 'dev.lock', 'a.lock/b',
      'HEAD', 'dev main', 'dev\nmain', 'dev~1', 'dev^', 'dev:main', '@{-1}', 'dev@{1}', 'dev*', 'dev?', '[dev]', 'dev\\x',
      'dev;touch x', '$(id)', 'x'.repeat(201)]
    for (const name of bad) {
      const { status, output } = pass(f, ['--branch', name])
      expect(status, `${JSON.stringify(name)}: ${output}`).toBe(2)
      expect(output).toContain('not a plain branch name')
      expect(output).toMatch(/^usage: scripts\/live-auto-update\.sh \[--branch <name>\]/m)
    }
    const missing = spawnSync('bash', [...args(f), '--branch'], { encoding: 'utf8', env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } })
    expect(missing.status).toBe(2)
    expect(missing.stderr).toMatch(/^usage: /m)
    expect(existsSync(join(f.bin, 'git-calls'))).toBe(false)
    expect(existsSync(join(f.backups, 'auto-update'))).toBe(false)
    expect(existsSync(f.pause)).toBe(false)
  })

  it('follows main by default, whatever other branches move', () => {
    const f = fixture()
    const dev = devBranch(f)
    const { status, output } = pass(f)
    expect(output, output).toContain('stopped or rolled back (exit 1)')
    expect(status).toBe(1)
    expect(lines(f).at(-1)).toMatch(new RegExp(` origin/main stopped: the update to ${f.target.slice(0, 12)} `))
    expect(fetchHead(f)).toContain("branch 'main' of")
    expect(fetchHead(f)).not.toContain(dev)
    expect(f.git(f.check, 'rev-parse', 'HEAD')).toBe(f.target)
    expect(readFileSync(f.pause, 'utf8')).toContain(`branch origin/main, live ${f.from}, target ${f.target}`)
  })
})
