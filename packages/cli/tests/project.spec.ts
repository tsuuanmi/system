import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { bundleStudioPolicy, COORDINATION_FILES, parseProjectNew, type PluginChecks, type Policy, type ProjectHost, projectKinds, projectNew, ProjectRefusal, renderedProblems, renderProject, REQUESTS_FILE, TEMPLATES_DIR } from '../src/project.ts'

const NOW = new Date('2026-10-26T09:00:00Z')
/** The System repository's top level, where its docs are. */
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The plugins' own checks, from their source (the CLI loads the same modules from the bundle). */
const plugins = async (): Promise<PluginChecks> => ({
  approvals: await import('../../plugins/approvals/src/index.ts') as unknown as PluginChecks['approvals'],
  agentWorkers: await import('../../plugins/agent-workers/src/index.ts') as unknown as PluginChecks['agentWorkers'],
})

const git = (cwd: string, ...args: string[]): void => {
  const ran = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (ran.status !== 0) throw new Error(ran.stderr)
}

/** A scratch root holding the operator's home and a fixture repository (a pnpm one, on branch main). */
function fixture(): { root: string; home: string; repository: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'system-project-')))
  dirs.push(root)
  const home = join(root, 'home')
  const repository = join(root, 'src', 'dna')
  mkdirSync(home, { recursive: true })
  mkdirSync(repository, { recursive: true })
  git(repository, 'init', '-q', '-b', 'main')
  writeFileSync(join(repository, 'package.json'), '{"name":"dna","private":true}\n')
  writeFileSync(join(repository, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  return { root, home, repository }
}

/** Every path under a directory with its size and modification time: what a run that writes nothing leaves as it was. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry)
      const stat = statSync(path)
      out[relative(dir, path)] = `${stat.isDirectory() ? 'd' : stat.size}:${stat.mtimeMs}`
      if (stat.isDirectory()) walk(path)
    }
  }
  walk(dir)
  return out
}

/** A running profile's board and queue, recording what was filed. */
function fakeHost(state: { projects?: string[]; policies?: Policy[]; failPolicy?: number } = {}): ProjectHost & { filed: Array<{ tool: string; input: unknown }> } {
  const filed: Array<{ tool: string; input: unknown }> = []
  const projects = state.projects ?? ['system']
  let failPolicy = state.failPolicy ?? 0
  return {
    filed,
    projectIds: async () => [...projects],
    policies: async () => state.policies ?? [bundleStudioPolicy()],
    charter: async (input) => {
      filed.push({ tool: 'board_charter', input })
      // The board now holds the project, as board_charter makes it (proposed until approved).
      if (!projects.includes(String(input.projectId))) projects.push(String(input.projectId))
      return { projectId: String(input.projectId), approvalRequest: 'apr-charter' }
    },
    proposePolicy: async (policy, note) => {
      if (failPolicy > 0) {
        failPolicy--
        throw new Error('approvals_policy_propose: the queue did not answer')
      }
      filed.push({ tool: 'approvals_policy_propose', input: { policy, note } })
      return { requestId: 'apr-policy' }
    },
  }
}

const deps = (home: string, host?: ProjectHost) => ({ host, plugins, bundleStudio: () => bundleStudioPolicy(), home, now: NOW })

describe('system project new (PROP-0016 I5 part 0)', () => {
  it('ships the software-repository template', () => {
    expect(projectKinds()).toContain('software-repository')
    for (const file of ['template.json', 'charter.json', 'LEAD.md', 'lessons.md', 'decisions.md']) expect(existsSync(join(TEMPLATES_DIR, 'software-repository', file))).toBe(true)
  })

  it('renders software-repository for a fixture repository, and what it renders validates against the schemas and the plugins\' load-time checks', async () => {
    const { home, repository, root } = fixture()
    const studio = bundleStudioPolicy()
    const rendered = renderProject({ kind: 'software-repository', id: 'dna', repository, targetBranch: 'main', coordination: join(root, 'coord'), home, studio, now: NOW })
    const store = join(home, '.local/share/pnpm/store/v11')
    const setup = `corepack pnpm install --frozen-lockfile --offline --store-dir=${store} --package-import-method=copy`
    expect(rendered.toolchain).toBe('pnpm')
    expect(rendered.worktreeSetup).toEqual({
      repository,
      commands: [setup],
      views: [{ path: store, copy: ['index.db', 'index.db-wal'], readOnly: ['files'] }],
      checks: { tests: 'corepack pnpm test', lint: 'corepack pnpm lint' },
      checkScratch: ['node_modules/.vite'],
    })
    expect(rendered.role).toEqual({ id: 'dna-develop', sandbox: 'workspace-write', tier: 'standard', worktreePerRun: true, description: 'Writes the dna project\'s changes in a worktree of its repository', workspace: repository })
    // The policy layer: the commands the setup and checks run, added to the studio list as a change, and a project policy narrowing to them.
    expect(rendered.commands).toEqual([setup, 'corepack pnpm test', 'corepack pnpm lint'])
    expect(rendered.missing).toEqual(rendered.commands)
    expect(rendered.studio).toMatchObject({ id: studio.id, version: studio.version + 1, commands: rendered.commands })
    expect(rendered.project).toMatchObject({ id: 'dna.policy', scope: 'project', projectId: 'dna', narrows: studio.id, commands: rendered.commands })
    // The charter: objective, scope, non-goals, done-when, budget lines.
    const charter = rendered.charter.charter as Record<string, unknown>
    expect(rendered.charter).toMatchObject({ projectId: 'dna', title: 'dna: the dna repository', template: 'algorithm-development', clientRequestId: 'project-new:dna' })
    expect(charter.intent).toContain(repository)
    expect((charter.constraints as { notes: string[] }).notes.some((n) => n.startsWith('scope: '))).toBe(true)
    expect((charter.constraints as { notes: string[] }).notes.some((n) => n.startsWith('non-goal: '))).toBe(true)
    expect((charter.criteria as unknown[]).length).toBeGreaterThan(0)
    expect(charter.budget).toEqual({ pools: [{ pool: 'dna', unit: 'runs', amount: 100 }] })
    expect(renderedProblems(rendered, studio, await plugins())).toEqual([])
    // The coordination directory: the lead's onboarding pointing at the playbook, an empty lessons file within T220's bounds, decisions.
    expect(rendered.files.map((f) => f.name)).toEqual([...COORDINATION_FILES])
    const file = (name: string): string => rendered.files.find((f) => f.name === name)!.text
    expect(file('LEAD.md')).toContain('`docs/operations/lead-playbook.md` in the System')
    expect(file('LEAD.md')).not.toMatch(/\{\{/)
    expect(file('lessons.md').split('\n').filter((l) => l.startsWith('- '))).toEqual([])
    expect(file('lessons.md')).toMatch(/at most 30/)
    expect(file('decisions.md')).toContain('D1 (2026-10-26, operator)')
    // The profile patch fragment parses, holds the role and the setup, and leaves auto-accept off (commented).
    const patch = parseYaml(rendered.patch) as Array<{ id: string; config: Record<string, unknown[]> }>
    expect(patch).toEqual([{ id: 'agent-workers', config: { roles: [rendered.role], worktreeSetup: [rendered.worktreeSetup] } }])
    expect(rendered.patch).toMatch(/^# Auto-accept \(ADR-0067\) is off for this project/m)
    expect(rendered.patch).toMatch(/^# {5}generated:/m)
  })

  it('onboards the lead on the playbook T252 landed: LEAD.md names the playbook\'s file and carries its onboarding checklist as written', () => {
    const { home, repository, root } = fixture()
    const rendered = renderProject({ kind: 'software-repository', id: 'dna', repository, targetBranch: 'main', coordination: join(root, 'coord'), home, studio: bundleStudioPolicy(), now: NOW })
    const lead = rendered.files.find((f) => f.name === 'LEAD.md')!.text
    const named = [...lead.matchAll(/`(docs\/[^`]+\.md)`\s+in\s+the\s+System/g)].map((m) => m[1]!)
    expect(named).toEqual(['docs/operations/lead-playbook.md', 'docs/operations/examples/LEAD.md'])
    for (const path of named) expect(existsSync(join(REPOSITORY, path))).toBe(true)
    // The checklist's items, links reduced to their text and lines joined: the same, in the same order.
    const items = (text: string): string[] => text.split(/\n(?=\d+\. \[ \] )/).filter((part) => /^\d+\. \[ \] /.test(part)).map((item) => item.split(/\n(?!\s)/)[0]!.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim())
    const onboarding = items(readFileSync(join(REPOSITORY, 'docs/operations/examples/LEAD.md'), 'utf8'))
    expect(onboarding).toHaveLength(9)
    expect(items(lead)).toEqual(onboarding)
  })

  it('renders a Cargo repository (the DNA pilot\'s toolchain): its offline setup, its checks with target as their scratch, and it validates', async () => {
    const { home, repository, root } = fixture()
    rmSync(join(repository, 'pnpm-lock.yaml'))
    rmSync(join(repository, 'package.json'))
    writeFileSync(join(repository, 'Cargo.toml'), '[workspace]\nmembers = []\n')
    writeFileSync(join(repository, 'Cargo.lock'), 'version = 4\n')
    writeFileSync(join(repository, '.gitignore'), '/target/\n')
    const studio = bundleStudioPolicy()
    const rendered = renderProject({ kind: 'software-repository', id: 'dna', repository, targetBranch: 'main', coordination: join(root, 'coord'), home, studio, now: NOW })
    expect(rendered.toolchain).toBe('cargo')
    expect(rendered.worktreeSetup).toEqual({
      repository,
      commands: ['cargo fetch --locked --offline'],
      checks: { tests: 'cargo test --workspace --locked --offline', lint: 'cargo clippy --workspace --locked --offline --all-targets -- -D warnings' },
      dependencyFiles: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'rust-toolchain'],
      checkScratch: ['target'],
    })
    expect(rendered.project.commands).toEqual(['cargo fetch --locked --offline', 'cargo test --workspace --locked --offline', 'cargo clippy --workspace --locked --offline --all-targets -- -D warnings'])
    expect(renderedProblems(rendered, studio, await plugins())).toEqual([])
  })

  it('does not render a template whose fragments would not load: the checks bite', async () => {
    const { home, repository, root } = fixture()
    const templates = join(root, 'templates')
    cpSync(TEMPLATES_DIR, templates, { recursive: true })
    const manifest = join(templates, 'software-repository', 'template.json')
    const broken = JSON.parse(readFileSync(manifest, 'utf8')) as { toolchains: Array<{ setup: string[]; checks: Record<string, string> }> }
    broken.toolchains[0]!.setup = ['corepack pnpm install;rm -rf /']
    broken.toolchains[0]!.checks = { tests: 'corepack pnpm test', format: 'corepack pnpm format' }
    writeFileSync(manifest, JSON.stringify(broken))
    const studio = bundleStudioPolicy()
    const rendered = renderProject({ kind: 'software-repository', id: 'dna', repository, targetBranch: 'main', coordination: join(root, 'coord'), home, studio, now: NOW, templatesDir: templates })
    const problems = renderedProblems(rendered, studio, await plugins())
    expect(problems.some((p) => p.startsWith('the policy set: ') && p.includes('shell metacharacter'))).toBe(true)
    expect(problems.some((p) => p.startsWith('the worktree setup: '))).toBe(true)
    await expect(projectNew({ kind: 'software-repository', id: 'dna', repository, dryRun: true, coordination: join(root, 'coord') }, { ...deps(home), templatesDir: templates })).rejects.toThrow(/does not validate, so nothing was written or asked/)
    expect(existsSync(join(root, 'coord'))).toBe(false)
  })

  it('--dry-run prints every write, request, and file, and writes and asks nothing', async () => {
    const { home, repository, root } = fixture()
    const before = tree(root)
    const host = fakeHost()
    const outcome = await projectNew({ kind: 'software-repository', id: 'dna', repository, dryRun: true }, deps(home, host))
    expect(tree(root)).toEqual(before)
    expect(host.filed).toEqual([])
    expect(outcome.written).toEqual([])
    const coordination = join(home, 'workspaces', 'dna-coordination')
    const text = outcome.lines.join('\n')
    for (const name of COORDINATION_FILES) {
      expect(text).toContain(`  ${join(coordination, name)}`)
      expect(text).toContain(`--- ${join(coordination, name)} ---`)
    }
    expect(text).toMatch(/dry run: nothing is written or asked/)
    expect(text).toMatch(/board_charter: project dna, charter v1/)
    expect(text).toMatch(/approvals_policy_propose: studio policy studio-default v2, adding 3 command\(s\)/)
    expect(text).toMatch(/never applied: the profile patch fragment/)
  })

  it('renders with no running profile on --dry-run, and says what it could not ask', async () => {
    const { home, repository } = fixture()
    const outcome = await projectNew({ kind: 'software-repository', id: 'dna', repository, dryRun: true }, deps(home))
    expect(outcome.lines.join('\n')).toMatch(/note: no running profile's board answered/)
  })

  it('writes only the coordination directory, files the charter and the policy change, and never applies the patch', async () => {
    const { home, repository, root } = fixture()
    const before = tree(root)
    const host = fakeHost()
    const coordination = join(root, 'coord', 'dna')
    const outcome = await projectNew({ kind: 'software-repository', id: 'dna', repository, dryRun: false, coordination }, deps(home, host))
    expect(outcome.written).toEqual([...COORDINATION_FILES, REQUESTS_FILE].map((name) => join(coordination, name)))
    expect(readdirSync(coordination).sort()).toEqual([...COORDINATION_FILES, REQUESTS_FILE].sort())
    expect(JSON.parse(readFileSync(join(coordination, REQUESTS_FILE), 'utf8'))).toMatchObject({ projectId: 'dna', charter: { filed: true, approvalRequest: 'apr-charter' }, policy: { id: 'studio-default', filed: true, requestId: 'apr-policy' } })
    const after = tree(root)
    const changed = Object.keys(after).filter((path) => after[path] !== before[path])
    expect(changed.every((path) => path === 'coord' || path.startsWith(`coord/`))).toBe(true)
    expect(Object.keys(before).every((path) => path in after)).toBe(true)
    expect(host.filed.map((f) => f.tool)).toEqual(['board_charter', 'approvals_policy_propose'])
    expect(host.filed[0]!.input).toMatchObject({ projectId: 'dna', clientRequestId: 'project-new:dna' })
    expect((host.filed[1]!.input as { policy: Policy }).policy).toMatchObject({ id: 'studio-default', version: 2 })
    expect(outcome.requests).toEqual(['board_charter: project dna, approval request apr-charter', 'approvals_policy_propose: studio-default, approval request apr-policy'])
    expect(outcome.lines.join('\n')).toContain(readFileSync(join(coordination, 'profile-patch.yml'), 'utf8').trimEnd())
  })

  it('completes a creation whose policy request failed after its charter was filed: the same command again files only the outstanding request', async () => {
    const { home, repository, root } = fixture()
    const host = fakeHost({ failPolicy: 1 })
    const coordination = join(root, 'coord')
    const args = { kind: 'software-repository', id: 'dna', repository, dryRun: false, coordination }
    await expect(projectNew(args, deps(home, host))).rejects.toThrow(/filed before it: board_charter: project dna, approval request apr-charter; .*requests\.json records what was filed: run the same command again to file the rest/)
    expect(host.filed.map((f) => f.tool)).toEqual(['board_charter'])
    // The board now holds the project the first run made: the retry is not refused as an id in use.
    expect(await host.projectIds()).toContain('dna')
    const ledger = join(coordination, REQUESTS_FILE)
    expect(JSON.parse(readFileSync(ledger, 'utf8'))).toMatchObject({ charter: { filed: true }, policy: { filed: false } })
    const files = Object.fromEntries(COORDINATION_FILES.map((name) => [name, readFileSync(join(coordination, name), 'utf8')]))
    // A dry run of the retry names what is outstanding and changes nothing.
    const preview = await projectNew({ ...args, dryRun: true }, deps(home, host))
    expect(preview.lines.join('\n')).toMatch(/requests still to file[^\n]*\n {2}approvals_policy_propose: studio-default$/)
    expect(host.filed.map((f) => f.tool)).toEqual(['board_charter'])
    const retried = await projectNew(args, deps(home, host))
    expect(host.filed.map((f) => f.tool)).toEqual(['board_charter', 'approvals_policy_propose'])
    expect((host.filed[1]!.input as { policy: Policy }).policy).toMatchObject({ id: 'studio-default', version: 2 })
    expect(retried.requests).toEqual(['approvals_policy_propose: studio-default, approval request apr-policy'])
    expect(retried.written).toEqual([ledger])
    expect(JSON.parse(readFileSync(ledger, 'utf8'))).toMatchObject({ charter: { filed: true }, policy: { filed: true, requestId: 'apr-policy' } })
    for (const name of COORDINATION_FILES) expect(readFileSync(join(coordination, name), 'utf8')).toBe(files[name])
    // Once every request is filed, the id is in use.
    await expect(projectNew(args, deps(home, host))).rejects.toThrow(/the id dna is in use: .* every request of its creation was filed/)
    await expect(projectNew({ ...args, id: 'rna' }, deps(home, host))).rejects.toThrow(/records the creation of project dna/)
  })

  it('validates the creation ledger it writes, and refuses one that does not validate or is of an unknown major version before anything is filed', async () => {
    const { home, repository, root } = fixture()
    const host = fakeHost({ failPolicy: 1 })
    const coordination = join(root, 'coord')
    const args = { kind: 'software-repository', id: 'dna', repository, dryRun: false, coordination }
    await expect(projectNew(args, deps(home, host))).rejects.toThrow(/run the same command again/)
    const ledgerPath = join(coordination, REQUESTS_FILE)
    const written = JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>
    expect(written.schema).toBe('project-requests@1.0')
    new SchemaRegistry().assertRecord(written as { schema: string })
    const filedBefore = host.filed.length
    const refusedWith = async (ledger: string, pattern: RegExp): Promise<void> => {
      writeFileSync(ledgerPath, ledger)
      const before = tree(root)
      const error = await projectNew(args, deps(home, host)).then(() => undefined, (e: unknown) => e)
      expect(error).toBeInstanceOf(ProjectRefusal)
      expect((error as Error).message).toMatch(pattern)
      expect(host.filed.length).toBe(filedBefore)
      expect(tree(root)).toEqual(before)
    }
    await refusedWith(JSON.stringify({ ...written, schema: 'project-requests@2.0' }), /not a creation ledger this command can read, so nothing was filed: .*unsupported major version/)
    await refusedWith(JSON.stringify({ ...written, charter: { filed: 'yes' } }), /not a creation ledger this command can read/)
    await refusedWith(JSON.stringify({ projectId: 'dna', charter: { filed: true }, policy: written.policy }), /its schema is undefined, not project-requests@1.x/)
    await refusedWith('{ not json', /not a creation ledger this command can read/)
    // The valid ledger back: the retry files the outstanding request.
    writeFileSync(ledgerPath, JSON.stringify(written))
    await projectNew(args, deps(home, host))
    expect(host.filed.map((f) => f.tool)).toEqual(['board_charter', 'approvals_policy_propose'])
  })

  it('files the project policy when the studio policy already lists every command', async () => {
    const { home, repository, root } = fixture()
    const studio = bundleStudioPolicy()
    const listed = renderProject({ kind: 'software-repository', id: 'dna', repository, targetBranch: 'main', coordination: join(root, 'c'), home, studio, now: NOW }).commands
    const host = fakeHost({ policies: [{ ...studio, commands: listed }] })
    await projectNew({ kind: 'software-repository', id: 'dna', repository, dryRun: false, coordination: join(root, 'coord') }, deps(home, host))
    expect((host.filed[1]!.input as { policy: Policy }).policy).toMatchObject({ id: 'dna.policy', scope: 'project', commands: listed })
  })

  describe('refusals, each before anything is written or asked', () => {
    const refused = async (args: Partial<Parameters<typeof projectNew>[0]>, host?: ProjectHost, at?: { home: string; repository: string; root: string }): Promise<string> => {
      const f = at ?? fixture()
      const before = tree(f.root)
      const error = await projectNew({ kind: 'software-repository', id: 'dna', repository: f.repository, dryRun: false, ...args }, deps(f.home, host ?? fakeHost())).then(() => undefined, (e: unknown) => e)
      expect(error).toBeInstanceOf(ProjectRefusal)
      expect(tree(f.root)).toEqual(before)
      return (error as Error).message
    }

    it('an unknown kind', async () => {
      expect(await refused({ kind: 'research-programme' })).toMatch(/^unknown kind research-programme: the templates are software-repository/)
    })

    it('a repository that is not a git checkout, or not its top level', async () => {
      const f = fixture()
      const plain = join(f.root, 'plain')
      mkdirSync(plain)
      expect(await refused({ repository: plain }, undefined, f)).toMatch(/is not a git checkout's top level$/)
      const inner = join(f.repository, 'sub')
      mkdirSync(inner)
      expect(await refused({ repository: inner }, undefined, f)).toMatch(/is not a git checkout's top level$/)
      expect(await refused({ repository: join(f.root, 'missing') }, undefined, f)).toMatch(/does not exist/)
      expect(await refused({ repository: 'src/dna' }, undefined, f)).toMatch(/not an absolute path/)
    })

    it('an id in use: its coordination directory exists, the board has it, or the policy set holds a policy for it', async () => {
      const f = fixture()
      const coordination = join(f.root, 'taken')
      mkdirSync(coordination)
      expect(await refused({ coordination }, undefined, f)).toMatch(/the id dna is in use: its coordination directory .* exists/)
      expect(await refused({}, fakeHost({ projects: ['system', 'dna'] }))).toMatch(/the board has a project dna/)
      const studio = bundleStudioPolicy()
      const project: Policy = { schema: 'autonomy-policy@1.0', id: 'dna.policy', version: 1, scope: 'project', projectId: 'dna', narrows: studio.id, rules: [{ actionClass: 'merge', mode: 'ask' }], default: 'ask', expiry: studio.expiry }
      expect(await refused({}, fakeHost({ policies: [studio, project] }))).toMatch(/the policy set holds a policy for project dna/)
    })

    it('a target branch the landing cannot honour: not the checked-out branch, or a detached HEAD', async () => {
      const f = fixture()
      expect(await refused({ targetBranch: 'dev' }, undefined, f)).toMatch(/--target-branch dev is not the branch checked out in .* \(main\): a landing merges into the checked-out branch/)
      git(f.repository, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'first')
      expect(await projectNew({ kind: 'software-repository', id: 'dna', repository: f.repository, dryRun: true, targetBranch: 'main' }, deps(f.home)).then((o) => o.lines[0])).toMatch(/landing on main/)
      git(f.repository, 'checkout', '-q', '--detach')
      expect(await refused({ targetBranch: 'main' }, undefined, f)).toMatch(/has no branch checked out \(a detached HEAD\)/)
    })

    it('an id that is not one, a repository with no toolchain the template knows, and a real run with no running profile', async () => {
      expect(await refused({ id: 'DNA project' })).toMatch(/is not a project id/)
      const f = fixture()
      rmSync(join(f.repository, 'pnpm-lock.yaml'))
      expect(await refused({ dryRun: true }, undefined, f)).toMatch(/no toolchain of the software-repository template matches/)
      const g = fixture()
      const before = tree(g.root)
      await expect(projectNew({ kind: 'software-repository', id: 'dna', repository: g.repository, dryRun: false }, deps(g.home))).rejects.toThrow(/no running profile's board answers/)
      expect(tree(g.root)).toEqual(before)
    })
  })

  it('parses its flags, and refuses anything else', () => {
    expect(parseProjectNew(['--kind', 'software-repository', '--id', 'dna', '--repository', '/r', '--dry-run'])).toEqual({ kind: 'software-repository', id: 'dna', repository: '/r', dryRun: true })
    expect(parseProjectNew(['--kind', 'k', '--id', 'i', '--repository', '/r', '--target-branch', 'dev', '--coordination', '/c'])).toEqual({ kind: 'k', id: 'i', repository: '/r', targetBranch: 'dev', coordination: '/c', dryRun: false })
    expect(parseProjectNew(['--kind', 'k', '--id', 'i'])).toBeUndefined()
    expect(parseProjectNew(['--kind', 'k', '--id', 'i', '--repository', '/r', '--force'])).toBeUndefined()
    expect(parseProjectNew(['--kind', 'k', '--kind', 'l', '--id', 'i', '--repository', '/r'])).toBeUndefined()
    expect(parseProjectNew(['--kind', '--id', 'i', '--repository', '/r'])).toBeUndefined()
  })
})
