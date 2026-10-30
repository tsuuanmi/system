// Policy drift in the live update's notes (T352): after an update, each policy file the repository
// ships at the installed commit that the live set does not hold is listed with the policy change it
// needs, and nothing is proposed. The check runs as the script runs it: a real process, a real
// repository, and a stand-in CLI module whose `callTool` answers `approvals_policy`.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'

const CHECK = fileURLToPath(new URL('./live-update-check.ts', import.meta.url))
const SCRIPT = fileURLToPath(new URL('./live-update.sh', import.meta.url))
const RULE = { id: 'read-cat', program: 'cat', positionals: [{ kind: 'path', scope: 'repository-read', min: 1, max: 20 }] }
const LIVE = { schema: 'autonomy-policy@1.4', id: 'p1.policy', version: 4, scope: 'project', projectId: 'p1', narrows: 'studio-default', rules: [{ actionClass: 'merge', mode: 'ask' }], default: 'ask', expiry: { defaultSeconds: 86_400, maxSeconds: 1_209_600 } }

/** A repository whose commit ships `policies/<name>.json`, and a stand-in CLI answering `approvals_policy` with `live`. */
function fixture(shipped: Record<string, unknown>, live: unknown[]): { repo: string; commit: string; cli: string; home: string; out: string } {
  const root = mkdtempSync(join(tmpdir(), 'policy-drift-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'policies'), { recursive: true })
  execFileSync('git', ['init', '-q', repo])
  for (const [name, record] of Object.entries(shipped)) writeFileSync(join(repo, 'policies', name), `${JSON.stringify(record, null, 2)}\n`)
  const git = (...args: string[]): string => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' }).trim()
  git('add', '-A')
  git('commit', '-q', '-m', 'ships')
  const commit = git('rev-parse', 'HEAD')
  // A later change of the working tree is not what the install runs: the commit's files are read.
  writeFileSync(join(repo, 'policies', 'later.json'), '{}\n')
  const cli = join(root, 'cli.mjs')
  writeFileSync(cli, `export async function callTool(name, args) {\n  if (name !== 'approvals_policy') return { isError: true, text: 'unknown tool', structured: undefined }\n  return { isError: false, text: '', structured: { policies: ${JSON.stringify(live)}, effective: [] } }\n}\n`)
  const home = join(root, 'home')
  mkdirSync(home)
  const out = join(root, 'notes')
  mkdirSync(out)
  return { repo, commit, cli, home, out }
}

const drift = (f: ReturnType<typeof fixture>) => {
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHECK, 'policy-drift', f.cli, f.home, f.repo, f.commit, f.out], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('live-update-check policy-drift (T352)', () => {
  it('lists a file that adds a command rule, with the policy change it needs, and proposes nothing', () => {
    const f = fixture({ 'p1.json': { ...LIVE, commandRules: [RULE] } }, [{ schema: 'autonomy-policy@1.0', id: 'studio-default', version: 1, scope: 'studio' }, LIVE])
    const { status, output } = drift(f)
    expect(status, output).toBe(0)
    expect(output).toContain('policy drift: p1.policy v4 in force differs from policies/p1.json (v4) at the install\'s commit in commandRules')
    expect(output).toContain('approvals_policy_propose')
    expect(output).toContain(`${f.out}/policy-p1.policy-v5.json`)
    expect(output).not.toContain('later.json')
    // The record to propose is the file's content at a version past the live one; it is written, never filed.
    expect(readdirSync(f.out)).toEqual(['policy-p1.policy-v5.json'])
    expect(JSON.parse(readFileSync(join(f.out, 'policy-p1.policy-v5.json'), 'utf8'))).toEqual({ ...LIVE, commandRules: [RULE], version: 5 })
  })

  it('says nothing needs proposing when the content is equal, whatever the version', () => {
    const f = fixture({ 'p1.json': { ...LIVE, version: 6 } }, [LIVE])
    const { status, output } = drift(f)
    expect(status, output).toBe(0)
    expect(output).toContain('no policy drift')
    expect(output).not.toContain('policy drift:')
    expect(readdirSync(f.out)).toEqual([])
  })

  it('names a shipped policy the live set does not hold, and a live set it cannot read', () => {
    const f = fixture({ 'p1.json': LIVE }, [])
    expect(drift(f).output).toContain('policies/p1.json (p1.policy v4) is shipped, and no policy p1.policy is in force')
    expect(existsSync(join(f.out, 'policy-p1.policy-v4.json'))).toBe(true)
    const unread = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CHECK, 'policy-drift', f.cli, f.home, join(f.repo, 'nowhere'), f.commit, f.out], { encoding: 'utf8' })
    expect(unread.status).toBe(1)
    expect(`${unread.stdout}${unread.stderr}`).toContain('policy drift could not be read')
  })
})

describe('live-update.sh reports the drift after a verified update (T352)', () => {
  it('prints it into its notes once the update is done, and files no policy change', () => {
    const script = readFileSync(SCRIPT, 'utf8')
    expect(script).toMatch(/report_policy_drift\(\) \{.*?check_tool policy-drift "\$LIVE" "\$TARGET" "\$ATTEMPT".*?tee -a "\$LOG_FILE"/s)
    expect(script.indexOf('\nreport_policy_drift\n')).toBeGreaterThan(script.indexOf('\nset_phase verified'))
    // It reads and says; the proposal is the operator's.
    expect(script).not.toContain("check_tool policy-propose")
  })
})
