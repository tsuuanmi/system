// The live update's dry run, its refusals, and its upgrade checks' rules
// (docs/operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release). The script
// runs on a throwaway repository and DSH home, with no daemon: a dry run changes nothing, and every
// refusal comes before anything is written. --apply itself is rehearsed by hand on a throwaway
// worktree and home (the runbook says how), since it builds and starts a real profile.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { baselineProblems, type Health, healthProblems, runProblems } from './live-update-check.ts'

const SCRIPT = fileURLToPath(new URL('./live-update.sh', import.meta.url))

interface Fixture { root: string; live: string; home: string; backups: string; bin: string; from: string; target: string; git: (...args: string[]) => string }

/** A repository whose second commit adds the marker, checked out at the first; a profile; a stand-in pnpm. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'live-update-'))
  const live = join(root, 'live')
  mkdirSync(join(live, 'packages', 'cli', 'src'), { recursive: true })
  execFileSync('git', ['init', '-q', live], { stdio: 'pipe' })
  const git = (...args: string[]): string => execFileSync('git', ['-C', live, '-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], { encoding: 'utf8' }).trim()
  writeFileSync(join(live, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  writeFileSync(join(live, 'packages', 'cli', 'src', 'index.ts'), 'export const previous = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'previous')
  const from = git('rev-parse', 'HEAD')
  writeFileSync(join(live, 'packages', 'cli', 'src', 'index.ts'), 'export const previous = 1\nexport function hostPlugins(): void {}\n')
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
  return { root, live, home, backups, bin, from, target, git }
}

/** A checkout of the target, "built": its lib holds the marker, and its `system check` passes. */
function builtTarget(f: Fixture): string {
  const dir = join(f.root, 'target')
  execFileSync('git', ['clone', '-q', f.live, dir], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', f.target], { stdio: 'pipe' })
  mkdirSync(join(dir, 'packages', 'cli', 'lib'))
  writeFileSync(join(dir, 'packages', 'cli', 'lib', 'index.js'), 'export function hostPlugins() {}\n')
  writeFileSync(join(dir, 'packages', 'cli', 'lib', 'bin.js'), "console.log(`ok: 0 row(s) of the profile pass this code's checks (${process.argv[2]})`)\n")
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
    '--node-dir', dirname(process.execPath), '--pnpm-dir', f.bin, ...args], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
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

  it('refuses a marker that cannot tell the two builds apart', () => {
    const f = fixture()
    const { status, output } = run(f, f.target, '--marker', 'packages/cli/lib/index.js:previous')
    expect(status).toBe(1)
    expect(output).toContain('cannot tell the two builds apart')
  })

  it('a dry run checks the profile, with the patch candidate, by the target\'s code', () => {
    const f = fixture()
    const patch = join(f.root, 'candidate.yml')
    writeFileSync(patch, '- id: workflow\n  config:\n    allowSameFamily: true\n')
    const before = snapshot(f.home)
    const { status, output } = run(f, f.target, '--check-with', builtTarget(f), '--patch', patch)
    expect(output, output).toContain("ok: 0 row(s) of the profile pass this code's checks (check)")
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

describe('live-update-check: what the update may not make worse', () => {
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
