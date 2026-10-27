/**
 * `system project new` (PROP-0016 §6, I5 part 0; docs/design/packaging.md): a project from a
 * template by kind. The template is data (`templates/<kind>/`); this module renders it with the
 * given values, checks what it rendered against the schemas and the plugins' own load-time checks,
 * and lists every write. Nothing is applied: the charter and the policy change go to the approval
 * queue, the profile patch fragment is printed and written for the operator to merge, and the only
 * directory written is the project's coordination directory.
 * @module @tsuuanmi/system-cli/project
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const require = createRequire(import.meta.url)

/** The templates shipped with the CLI, one directory per kind (`src/` and `lib/` both sit beside it). */
export const TEMPLATES_DIR = fileURLToPath(new URL('../templates/', import.meta.url))

/** A project id: a board id that is also a role prefix (`<id>-develop`, at most 32 characters) and a directory name. */
export const PROJECT_ID = /^[a-z][a-z0-9-]{0,23}$/

/** The files of the coordination directory, in the order they are listed and written. */
export const COORDINATION_FILES = ['LEAD.md', 'lessons.md', 'decisions.md', 'charter.json', 'policy-change.json', 'profile-patch.yml'] as const

/** A refusal: the command stops before anything is written or asked, saying why. */
export class ProjectRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectRefusal'
  }
}

export interface ProjectNewArgs {
  kind: string
  id: string
  repository: string
  targetBranch?: string
  coordination?: string
  dryRun: boolean
}

/** `system project new` flags, or undefined when they are not the command's (the usage is printed). */
export function parseProjectNew(args: readonly string[]): ProjectNewArgs | undefined {
  const values: Record<string, string> = {}
  let dryRun = false
  const flags = ['--kind', '--id', '--repository', '--target-branch', '--coordination']
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--dry-run') {
      if (dryRun) return undefined
      dryRun = true
      continue
    }
    const value = args[i + 1]
    if (!flags.includes(arg) || value === undefined || value.startsWith('--') || arg in values) return undefined
    values[arg] = value
    i++
  }
  const { '--kind': kind, '--id': id, '--repository': repository } = values
  if (!kind || !id || !repository) return undefined
  return {
    kind, id, repository, dryRun,
    ...(values['--target-branch'] ? { targetBranch: values['--target-branch'] } : {}),
    ...(values['--coordination'] ? { coordination: values['--coordination'] } : {}),
  }
}

/** The kinds the templates directory holds: each directory with a `template.json`. */
export function projectKinds(dir: string = TEMPLATES_DIR): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'template.json'))).map((e) => e.name).sort()
}

/** A git checkout's top level (real path) and the branch checked out there, if any (none on a detached HEAD). */
export interface Checkout { root: string; branch?: string }

/**
 * The checkout `path` is the top level of, or a refusal: not absolute, not there, or not a git
 * checkout's top level. git never looks above `path` (`GIT_CEILING_DIRECTORIES`), so a directory
 * inside a checkout, or under one, is refused as none: a project's repository is its own checkout.
 */
export function gitCheckout(path: string): Checkout {
  if (!isAbsolute(path)) throw new ProjectRefusal(`--repository ${path} is not an absolute path`)
  if (!existsSync(path)) throw new ProjectRefusal(`--repository ${path} does not exist`)
  const real = realpathSync(path)
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: dirname(real) }
  const top = spawnSync('git', ['-C', real, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env })
  if (top.error) throw new ProjectRefusal(`cannot run git to read ${path}: ${top.error.message}`)
  const root = top.status === 0 ? realpathSync(top.stdout.trim()) : undefined
  if (root !== real) throw new ProjectRefusal(`--repository ${path} is not a git checkout's top level`)
  const head = spawnSync('git', ['-C', real, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8', env })
  const branch = head.status === 0 ? head.stdout.trim() : ''
  return branch ? { root, branch } : { root }
}

/** An `autonomy-policy@1.x` record, as far as this module reads and writes one. */
export interface Policy {
  schema: string
  id: string
  version: number
  scope: 'studio' | 'project'
  projectId?: string
  narrows?: string
  rules: Array<Record<string, unknown>>
  default: string
  commands?: string[]
  expiry: { defaultSeconds: number; maxSeconds: number }
  [key: string]: unknown
}

interface Toolchain {
  id: string
  marker: string
  setup: string[]
  views?: Array<Record<string, unknown>>
  checks: Record<string, string>
  dependencyFiles?: string[]
  checkScratch?: string[]
  generated?: { paths: string[]; commands: string[] }
}

interface TemplateManifest {
  kind: string
  version: number
  description: string
  workflowTemplate: string
  toolchains: Toolchain[]
  role: Record<string, unknown>
  policy: { rules: Policy['rules']; default: string; expiry: Policy['expiry']; commandRules?: Array<Record<string, unknown>> }
  autoAccept: { enabled: boolean }
}

interface CharterDraft {
  title: string
  objective: string
  scope: string[]
  nonGoals: string[]
  doneWhen: Array<Record<string, unknown>>
  budget: Array<Record<string, unknown>>
  stopRules: Array<Record<string, unknown>>
  milestones: Array<Record<string, unknown>>
}

/** What a template is rendered with. */
export interface RenderInput {
  kind: string
  id: string
  /** The checkout's top level (real path). */
  repository: string
  targetBranch: string
  /** The project's coordination directory (absolute). */
  coordination: string
  /** The operator's home, for host paths such as the pnpm store. */
  home: string
  /** The studio policy in force (or the bundle's, when no profile answers). */
  studio: Policy
  now: Date
  templatesDir?: string
}

/** A template rendered: the requests, the policy records, the patch fragment, and the coordination directory's files. */
export interface Rendered {
  kind: string
  templateVersion: number
  toolchain: string
  /** The `board_charter` input: a charter request on the approval queue. */
  charter: Record<string, unknown>
  /** Every command the project's setup, checks, and generated files run, in order, once each. */
  commands: string[]
  /** The commands the studio policy does not list yet. */
  missing: string[]
  /** The studio policy at its next version with the missing commands added, or undefined when none is missing. */
  studio?: Policy
  /** The project's own policy, narrowing the studio's: its commands list is exactly the project's. */
  project: Policy
  role: Record<string, unknown>
  worktreeSetup: Record<string, unknown>
  /** The profile patch fragment (YAML), never applied by the command. */
  patch: string
  /** The coordination directory's files, by name ({@link COORDINATION_FILES}). */
  files: Array<{ name: string; text: string }>
}

/** Every `{{name}}` in a string replaced by its value; a name with no value is the template's fault, and refused. */
function fill(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{([a-zA-Z]+)\}\}/g, (_, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`the template names {{${name}}}, which has no value`)
    return value
  })
}

/** A JSON value with every string filled. */
function fillJson<T>(value: T, values: Readonly<Record<string, string>>): T {
  if (typeof value === 'string') return fill(value, values) as T
  if (Array.isArray(value)) return value.map((v) => fillJson(v, values)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillJson(v, values)])) as T
  return value
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

/** The template of a kind, read from its directory; an unknown kind is refused, naming the kinds there are. */
function templateOf(kind: string, dir: string): { manifest: TemplateManifest; charter: CharterDraft; dir: string } {
  const kinds = projectKinds(dir)
  if (!kinds.includes(kind)) throw new ProjectRefusal(`unknown kind ${kind}: the templates are ${kinds.join(', ') || 'none'}`)
  const at = join(dir, kind)
  return { manifest: readJson<TemplateManifest>(join(at, 'template.json')), charter: readJson<CharterDraft>(join(at, 'charter.json')), dir: at }
}

/** The YAML of the profile patch fragment: what to merge, never applied by the command. */
function patchText(input: RenderInput, manifest: TemplateManifest, role: Record<string, unknown>, setup: Record<string, unknown>, generated: boolean): string {
  const rows = stringifyYaml([{ id: 'agent-workers', config: { roles: [role], worktreeSetup: [setup] } }], { lineWidth: 0 })
  return [
    `# Profile patch fragment for project ${input.id} (system project new, template ${manifest.kind} v${manifest.version}).`,
    '# Never applied by the command. A patch that targets a row replaces its whole config: merge each',
    '# part into the row your profile patch already has (the agent-workers row\'s roles and worktreeSetup',
    '# beside the ones there), then `system check` and a live update.',
    rows.trimEnd(),
    '# The account(s) that serve the role, in the same row:',
    `#   assignments: [{ account: <accountId from system account list>, roles: [${String(role.id)}] }]`,
    ...generated ? [] : [
      '# The repository\'s generated files, when it has any, in its worktreeSetup entry above (T166);',
      '# their commands go on the policy\'s commands list too:',
      '#     generated:',
      '#       paths: [<repository-relative path>]',
      '#       commands: [<command that regenerates them>]',
    ],
    '# Auto-accept (ADR-0067) is off for this project. To turn it on, in the board row\'s config:',
    `#   autoAccept: { projects: [..., ${input.id}], branches: [..., ${input.targetBranch}] }`,
    '',
  ].join('\n')
}

/**
 * Render a template with the given values. Pure but for reading the template and the repository's
 * top-level entries (the toolchain is chosen by its lockfile): nothing is written or asked.
 */
export function renderProject(input: RenderInput): Rendered {
  const { manifest, charter: draft, dir } = templateOf(input.kind, input.templatesDir ?? TEMPLATES_DIR)
  const toolchain = manifest.toolchains.find((t) => existsSync(join(input.repository, t.marker)))
  if (!toolchain) throw new ProjectRefusal(`no toolchain of the ${manifest.kind} template matches ${input.repository}: it looks for ${manifest.toolchains.map((t) => t.marker).join(', ')} at its top level`)
  const values: Record<string, string> = {
    id: input.id,
    kind: manifest.kind,
    templateVersion: String(manifest.version),
    repository: input.repository,
    repositoryName: basename(input.repository),
    targetBranch: input.targetBranch,
    coordination: input.coordination,
    home: input.home,
    pnpmStore: join(input.home, '.local/share/pnpm/store/v11'),
    date: input.now.toISOString().slice(0, 10),
  }
  const chain = fillJson(toolchain, values)
  const setup: Record<string, unknown> = {
    repository: input.repository,
    commands: chain.setup,
    ...chain.views ? { views: chain.views } : {},
    checks: chain.checks,
    ...chain.dependencyFiles ? { dependencyFiles: chain.dependencyFiles } : {},
    ...chain.checkScratch ? { checkScratch: chain.checkScratch } : {},
    ...chain.generated ? { generated: chain.generated } : {},
  }
  const commands = [...new Set([...chain.setup, ...Object.values(chain.checks), ...chain.generated?.commands ?? []])]
  const listed = new Set(input.studio.commands ?? [])
  const missing = commands.filter((c) => !listed.has(c))
  // The template's command rules (autonomy-policy@1.4) are in force only where the studio policy holds
  // them too (a project policy only narrows): the ones it lacks, or holds otherwise, go into its change.
  const rules = manifest.policy.commandRules ? fillJson(manifest.policy.commandRules, values) : []
  const held = (input.studio.commandRules ?? []) as Array<Record<string, unknown>>
  const missingRules = rules.filter((rule) => !held.some((h) => JSON.stringify(h) === JSON.stringify(rule)))
  const studio = missing.length || missingRules.length
    ? {
        ...input.studio, version: input.studio.version + 1, commands: [...input.studio.commands ?? [], ...missing],
        ...missingRules.length ? { schema: 'autonomy-policy@1.4', commandRules: [...held.filter((h) => !missingRules.some((r) => r.id === h.id)), ...missingRules] } : {},
      }
    : undefined
  const project: Policy = {
    // The template's command rules (autonomy-policy@1.4): the routine reads, tests, and edits of a run's own worktree run unasked from the first day.
    schema: manifest.policy.commandRules ? 'autonomy-policy@1.4' : 'autonomy-policy@1.0',
    id: `${input.id}.policy`,
    version: 1,
    scope: 'project',
    projectId: input.id,
    narrows: input.studio.id,
    rules: fillJson(manifest.policy.rules, values),
    default: manifest.policy.default,
    commands,
    expiry: manifest.policy.expiry,
    ...rules.length ? { commandRules: rules } : {},
  }
  const role = fillJson(manifest.role, values)
  role.workspace = input.repository
  const c = fillJson(draft, values)
  const charter: Record<string, unknown> = {
    projectId: input.id,
    title: c.title,
    template: manifest.workflowTemplate,
    charter: {
      version: 1,
      intent: c.objective,
      criteria: c.doneWhen,
      constraints: { notes: [...c.scope.map((s) => `scope: ${s}`), ...c.nonGoals.map((n) => `non-goal: ${n}`)] },
      stopRules: c.stopRules,
      budget: { pools: c.budget },
    },
    milestones: c.milestones,
    clientRequestId: `project-new:${input.id}`,
  }
  const patch = patchText(input, manifest, role, setup, !!chain.generated)
  const policyChange = {
    note: 'The studio policy lists the commands the project runs unasked (a command runs unasked only when every applying commands list holds it), and holds the command rules (a rule is in force only when the studio holds it, and the project policy the same rule); the project policy narrows it to exactly them. Both rest on the set in force: file the project policy once the studio change is decided, and add its riskTiers path map when the repository\'s layout is known.',
    studio: studio
      ? { filed: true, adds: missing, ...missingRules.length ? { addsCommandRules: missingRules.map((r) => r.id) } : {}, policy: studio }
      : { filed: false, adds: [], why: 'the studio policy already lists every command and holds every command rule' },
    project: { filed: !studio, policy: project },
  }
  const text = (name: string): string => fill(readFileSync(join(dir, name), 'utf8'), values)
  const files = [
    { name: 'LEAD.md', text: text('LEAD.md') },
    { name: 'lessons.md', text: text('lessons.md') },
    { name: 'decisions.md', text: text('decisions.md') },
    { name: 'charter.json', text: `${JSON.stringify(charter, null, 2)}\n` },
    { name: 'policy-change.json', text: `${JSON.stringify(policyChange, null, 2)}\n` },
    { name: 'profile-patch.yml', text: patch },
  ]
  return { kind: manifest.kind, templateVersion: manifest.version, toolchain: toolchain.id, charter, commands, missing, ...studio ? { studio } : {}, project, role, worktreeSetup: setup, patch, files }
}

/** A plugin module as the preflight reads one: its config schema and its own load-time check. */
export interface PluginModule { [name: string]: unknown }

/** The plugins whose checks judge what a template renders: the approval queue's (policies) and the agent Workers' (roles, worktreeSetup). */
export interface PluginChecks { approvals: PluginModule; agentWorkers: PluginModule }

/** A plugin's problems with a config: its `Config` schema, then its `checkConfig`, as `system check` runs them. */
export function pluginProblems(mod: PluginModule, config: unknown, check: unknown = config): string[] {
  const plugin = ((mod as { default?: unknown }).default ?? mod) as Record<string, unknown>
  const schema = (plugin.Config ?? mod.Config) as ((value: unknown) => unknown) | undefined
  // Copies: a schema may fill defaults into what it is given, and what was rendered stays as rendered.
  try {
    if (typeof schema === 'function') schema(structuredClone(config))
  } catch (error) {
    return [(error as Error).message]
  }
  const checkConfig = (mod.checkConfig ?? plugin.checkConfig) as ((value: unknown) => string[]) | undefined
  if (typeof checkConfig !== 'function') return ['the plugin exports no checkConfig to check it with']
  return checkConfig(structuredClone(check))
}

/**
 * Every problem with what was rendered: the charter request against `mcp-board@1`'s
 * board-charter-input, each policy against `autonomy-policy@1`, the policy set it would make against
 * the approval queue's load-time rules, and the role and worktree setup against the agent Workers'
 * config schema and load-time rules (the setup checked beside a Worker of that workspace with a
 * worktree per run, as it must be to ever run). Empty when all of it validates.
 */
export function renderedProblems(rendered: Rendered, studioNow: Policy, plugins: PluginChecks, schemas: SchemaRegistry = new SchemaRegistry()): string[] {
  const problems: string[] = []
  const schema = (label: string, run: () => void): void => {
    try {
      run()
    } catch (error) {
      problems.push(`${label}: ${(error as Error).message}`)
    }
  }
  schema('the charter request', () => schemas.assertDef('mcp-board@1.0', 'board-charter-input', rendered.charter))
  const studio = rendered.studio ?? studioNow
  for (const policy of [studio, rendered.project]) schema(`the policy ${policy.id}`, () => schemas.assert(policy.schema, policy))
  for (const p of pluginProblems(plugins.approvals, { policies: [studio, rendered.project] })) problems.push(`the policy set: ${p}`)
  const setup = rendered.worktreeSetup
  const worker = { id: 'template-check', runtime: 'template-check', workspace: setup.repository, sandbox: 'workspace-write', tier: 'standard', worktreePerRun: true }
  for (const p of pluginProblems(plugins.agentWorkers, { roles: [rendered.role], worktreeSetup: [setup] }, { workers: [worker], worktreeSetup: [setup] })) problems.push(`the worktree setup: ${p}`)
  return problems
}

/** The approval queue's and agent Workers' plugins as this install's bundle ships them (as `system check` loads them). */
export async function bundlePlugins(): Promise<PluginChecks> {
  const fromBundle = createRequire(require.resolve('@tsuuanmi/system-bundle/package.json'))
  const load = async (name: string): Promise<PluginModule> => (await import(pathToFileURL(fromBundle.resolve(name)).href)) as PluginModule
  return { approvals: await load('@tsuuanmi/system-approvals'), agentWorkers: await load('@tsuuanmi/system-agent-workers') }
}

/** The studio policy the bundle ships (its `approvals` row), for a dry run with no profile to ask. */
export function bundleStudioPolicy(patchFile: string = join(dirname(require.resolve('@tsuuanmi/system-bundle/package.json')), 'cordis.patch.yml')): Policy {
  const patch = parseYaml(readFileSync(patchFile, 'utf8')) as Array<{ insert?: Array<{ id: string; config?: { policies?: Policy[] } }> }>
  const row = patch.flatMap((op) => op.insert ?? []).find((r) => r.id === 'approvals')
  const studio = row?.config?.policies?.find((p) => p.scope === 'studio')
  if (!studio) throw new Error(`${patchFile} has no studio policy in its approvals row`)
  return studio
}

/** What the command asks of the running profile; undefined in {@link ProjectDeps} when none answers. */
export interface ProjectHost {
  /** Every project id on the board, of every state. */
  projectIds(): Promise<string[]>
  /** The studio policy, then the project's when it has one (MCP `approvals_policy`). */
  policies(projectId: string): Promise<Policy[]>
  /** File the charter request (MCP `board_charter`). */
  charter(input: Record<string, unknown>): Promise<{ projectId: string; approvalRequest?: string }>
  /** File a policy-change request (MCP `approvals_policy_propose`). */
  proposePolicy(policy: Policy, note: string): Promise<{ requestId?: string }>
}

type Call = (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string; structured: Record<string, unknown> | undefined }>

/** The running profile through its MCP tools, as the operator. */
export function profileHost(call: Call): ProjectHost {
  const tool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const outcome = await call(name, args)
    if (outcome.isError) throw new Error(`${name}: ${outcome.text}`)
    return outcome.structured ?? {}
  }
  return {
    async projectIds() {
      const ids: string[] = []
      let after: string | undefined
      for (let page = 0; page < 1000; page++) {
        const out = await tool('board_projects', { limit: 100, ...after ? { after } : {} })
        ids.push(...((out.projects ?? []) as Array<{ projectId: string }>).map((p) => p.projectId))
        after = typeof out.next === 'string' ? out.next : undefined
        if (!after) break
      }
      return ids
    },
    async policies(projectId) {
      return ((await tool('approvals_policy', { projectId })).policies ?? []) as Policy[]
    },
    async charter(input) {
      return (await tool('board_charter', input)) as { projectId: string; approvalRequest?: string }
    },
    async proposePolicy(policy, note) {
      const out = await tool('approvals_policy_propose', { policy, note })
      const requestId = (out.request as { requestId?: string } | undefined)?.requestId
      return requestId ? { requestId } : {}
    },
  }
}

export interface ProjectDeps {
  /** The running profile, or undefined when none answers. */
  host: ProjectHost | undefined
  plugins: () => Promise<PluginChecks>
  /** The studio policy to use when no profile answers. */
  bundleStudio: () => Policy
  home?: string
  now?: Date
  templatesDir?: string
}

/** What the command did or would do, line by line; the files it wrote and the requests it filed (none on a dry run). */
export interface ProjectOutcome { lines: string[]; written: string[]; requests: string[] }

/**
 * `system project new`: refuse an unknown kind, a repository that is not a git checkout's top
 * level, or an id in use (its coordination directory exists, the board knows it, or the policy set
 * holds a policy for it); render the template; refuse what does not validate; then, unless
 * `dryRun`, write the coordination directory (and nothing else) and file the charter and the policy
 * change on the approval queue. Every write and request is listed; a dry run prints every file.
 */
export async function projectNew(args: ProjectNewArgs, deps: ProjectDeps): Promise<ProjectOutcome> {
  const templatesDir = deps.templatesDir ?? TEMPLATES_DIR
  const kinds = projectKinds(templatesDir)
  if (!kinds.includes(args.kind)) throw new ProjectRefusal(`unknown kind ${args.kind}: the templates are ${kinds.join(', ') || 'none'}`)
  if (!PROJECT_ID.test(args.id)) throw new ProjectRefusal(`--id ${args.id} is not a project id: a lowercase letter, then up to 23 lowercase letters, digits, or -`)
  const checkout = gitCheckout(args.repository)
  // A landing merges into the repository's checked-out branch (ADR-0060): no configuration names
  // another, so the target branch is the checked-out one, and a different one is refused.
  if (!checkout.branch) throw new ProjectRefusal(`${checkout.root} has no branch checked out (a detached HEAD): a landing merges into the checked-out branch, so check out the branch results land on there first`)
  if (args.targetBranch !== undefined && args.targetBranch !== checkout.branch) {
    throw new ProjectRefusal(`--target-branch ${args.targetBranch} is not the branch checked out in ${checkout.root} (${checkout.branch}): a landing merges into the checked-out branch, so check out ${args.targetBranch} there first, or leave --target-branch out`)
  }
  const targetBranch = checkout.branch
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(targetBranch) || targetBranch.includes('..')) throw new ProjectRefusal(`the branch ${targetBranch} is not a branch name the template can carry`)
  const home = deps.home ?? homedir()
  const coordination = resolve(args.coordination ?? join(home, 'workspaces', `${args.id}-coordination`))
  if (existsSync(coordination)) {
    // A creation whose requests were not all filed is completed by running the command again.
    if (existsSync(join(coordination, REQUESTS_FILE))) return resumeProject(args, coordination, deps)
    throw new ProjectRefusal(`the id ${args.id} is in use: its coordination directory ${coordination} exists`)
  }
  const notes: string[] = []
  let studio: Policy
  if (deps.host) {
    if ((await deps.host.projectIds()).includes(args.id)) throw new ProjectRefusal(`the id ${args.id} is in use: the board has a project ${args.id}`)
    const policies = await deps.host.policies(args.id)
    if (policies.some((p) => p.scope === 'project')) throw new ProjectRefusal(`the id ${args.id} is in use: the policy set holds a policy for project ${args.id}`)
    const inForce = policies.find((p) => p.scope === 'studio')
    if (!inForce) throw new Error('the running profile answered with no studio policy')
    studio = inForce
  } else {
    if (!args.dryRun) throw new ProjectRefusal('no running profile\'s board answers: it must run, with its board, to file the charter and the policy change (system start); --dry-run renders without it')
    studio = deps.bundleStudio()
    notes.push('no running profile\'s board answered: the board was not asked whether the id is in use, and the studio policy is the bundle\'s, not the one in force')
  }
  const rendered = renderProject({ kind: args.kind, id: args.id, repository: checkout.root, targetBranch, coordination, home, studio, now: deps.now ?? new Date(), templatesDir })
  const problems = renderedProblems(rendered, studio, await deps.plugins())
  if (problems.length) throw new ProjectRefusal(`the ${args.kind} template rendered for ${args.id} does not validate, so nothing was written or asked:\n${problems.map((p) => `  ${p}`).join('\n')}`)

  const paths = rendered.files.map((f) => join(coordination, f.name))
  const policyRequest = rendered.studio
    ? `approvals_policy_propose: studio policy ${rendered.studio.id} v${rendered.studio.version}, adding ${rendered.missing.length} command(s): ${rendered.missing.join('; ')}`
    : `approvals_policy_propose: project policy ${rendered.project.id} v1 (the studio policy already lists every command)`
  const lines = [
    `project ${args.id}: template ${rendered.kind} v${rendered.templateVersion} (toolchain ${rendered.toolchain}), repository ${checkout.root}, landing on ${targetBranch}${args.dryRun ? ' (dry run: nothing is written or asked)' : ''}`,
    `writes, only in ${coordination}:`,
    ...paths.map((p) => `  ${p}`),
    `  ${join(coordination, REQUESTS_FILE)} (which requests were filed; the command run again files the rest)`,
    'requests on the approval queue (nothing applies until you approve it):',
    `  board_charter: project ${args.id}, charter v1`,
    `  ${policyRequest}`,
    ...rendered.studio ? [`  later, once that is decided: the project policy ${rendered.project.id} (policy-change.json; both rest on the set in force)`] : [],
    `never applied: the profile patch fragment ${join(coordination, 'profile-patch.yml')}: merge it into your profile patch, then system check and a live update`,
    ...notes.map((n) => `note: ${n}`),
  ]
  if (args.dryRun) {
    for (const [i, file] of rendered.files.entries()) lines.push('', `--- ${paths[i]} ---`, file.text.trimEnd())
    return { lines, written: [], requests: [] }
  }
  const note = `system project new: ${rendered.kind} v${rendered.templateVersion} for project ${args.id} (${checkout.root})${rendered.studio ? ': the commands its setup and checks run' : ''}`
  const ledger: RequestLedger = { schema: REQUESTS_SCHEMA, projectId: args.id, charter: { filed: false }, policy: { id: (rendered.studio ?? rendered.project).id, note, filed: false } }
  const ledgerPath = join(coordination, REQUESTS_FILE)
  // The ledger validated before anything is written: one that would not validate stops the run here.
  let first: string
  try {
    first = ledgerText(ledger)
  } catch (error) {
    throw new ProjectRefusal(`the creation ledger for ${args.id} does not validate, so nothing was written or asked: ${(error as Error).message}`)
  }
  // Only the coordination directory: created here, each file new (`wx`), so nothing is overwritten.
  mkdirSync(coordination, { recursive: true })
  for (const [i, file] of rendered.files.entries()) writeFileSync(paths[i]!, file.text, { flag: 'wx' })
  writeFileSync(ledgerPath, first, { flag: 'wx' })
  const requests = await fileRequests(deps.host!, ledger, ledgerPath, rendered.charter, rendered.studio ?? rendered.project)
  lines.push('filed:', ...requests.map((r) => `  ${r}`), '', `--- ${join(coordination, 'profile-patch.yml')} ---`, rendered.patch.trimEnd())
  return { lines, written: [...paths, ledgerPath], requests }
}

/** The file in the coordination directory that records which of a creation's requests were filed. */
export const REQUESTS_FILE = 'requests.json'

/** The ledger's schema tag (`schemas/project-requests.v1.json`). */
export const REQUESTS_SCHEMA = 'project-requests@1.0'

/** A creation's requests (`project-requests@1.0`): the charter and the one policy change, each filed or not yet. */
interface RequestLedger {
  schema: typeof REQUESTS_SCHEMA
  projectId: string
  charter: { filed: boolean; approvalRequest?: string }
  policy: { id: string; note: string; filed: boolean; requestId?: string }
}

/** The ledger as written, validated against its schema first: an invalid one is never written. */
function ledgerText(ledger: RequestLedger): string {
  new SchemaRegistry().assertRecord(ledger)
  return `${JSON.stringify(ledger, null, 2)}\n`
}

/**
 * The ledger as read, validated against the schema its tag names before anything is filed: one that
 * does not parse, has no tag, names a major version this install does not know, or does not
 * validate is refused (fail closed, INV-14).
 */
export function readLedger(path: string): RequestLedger {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new ProjectRefusal(`${path} is not a creation ledger this command can read, so nothing was filed: ${(error as Error).message}`)
  }
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('it is not a JSON object')
    const tag = (value as { schema?: unknown }).schema
    if (typeof tag !== 'string' || !tag.startsWith('project-requests@')) throw new Error(`its schema is ${JSON.stringify(tag)}, not project-requests@1.x`)
    new SchemaRegistry().assertRecord(value as { schema: string })
  } catch (error) {
    throw new ProjectRefusal(`${path} is not a creation ledger this command can read, so nothing was filed: ${(error as Error).message}`)
  }
  return value as RequestLedger
}

/**
 * File the requests the ledger does not hold as filed, in order, recording each in the ledger as
 * soon as it is filed. A failure stops there, naming what was filed; the command run again with the
 * same values files only the rest (the charter's request is retry-safe by its clientRequestId too).
 */
async function fileRequests(host: ProjectHost, ledger: RequestLedger, ledgerPath: string, charter: Record<string, unknown>, policy: Policy): Promise<string[]> {
  const requests: string[] = []
  try {
    if (!ledger.charter.filed) {
      const filed = await host.charter(charter)
      ledger.charter = { filed: true, ...filed.approvalRequest ? { approvalRequest: filed.approvalRequest } : {} }
      writeFileSync(ledgerPath, ledgerText(ledger))
      requests.push(`board_charter: project ${filed.projectId}, approval request ${filed.approvalRequest ?? '(none named)'}`)
    }
    if (!ledger.policy.filed) {
      const proposed = await host.proposePolicy(policy, ledger.policy.note)
      ledger.policy = { ...ledger.policy, filed: true, ...proposed.requestId ? { requestId: proposed.requestId } : {} }
      writeFileSync(ledgerPath, ledgerText(ledger))
      requests.push(`approvals_policy_propose: ${policy.id}, approval request ${proposed.requestId ?? '(none named)'}`)
    }
  } catch (error) {
    throw new Error(`${(error as Error).message}\nfiled before it: ${requests.join('; ') || 'nothing'}; ${ledgerPath} records what was filed: run the same command again to file the rest`)
  }
  return requests
}

/**
 * Complete a creation whose requests were not all filed: its coordination directory holds the
 * ledger, the charter request, and the policy change as first rendered, and only the requests not
 * filed yet are filed now, those same records. The project the first run put on the board is this
 * creation's own, so it is not an id in use; a ledger of another id, or with every request filed, is.
 */
async function resumeProject(args: ProjectNewArgs, coordination: string, deps: ProjectDeps): Promise<ProjectOutcome> {
  const ledgerPath = join(coordination, REQUESTS_FILE)
  const ledger = readLedger(ledgerPath)
  if (ledger.projectId !== args.id) throw new ProjectRefusal(`the id ${args.id} is in use: its coordination directory ${coordination} exists, and records the creation of project ${ledger.projectId}`)
  const outstanding = [...ledger.charter.filed ? [] : ['board_charter'], ...ledger.policy.filed ? [] : [`approvals_policy_propose: ${ledger.policy.id}`]]
  if (!outstanding.length) throw new ProjectRefusal(`the id ${args.id} is in use: its coordination directory ${coordination} exists, and every request of its creation was filed`)
  const charter = readJson<Record<string, unknown>>(join(coordination, 'charter.json'))
  const change = readJson<{ studio: { filed: boolean; policy?: Policy }; project: { policy: Policy } }>(join(coordination, 'policy-change.json'))
  const policy = change.studio.filed && change.studio.policy ? change.studio.policy : change.project.policy
  if (policy.id !== ledger.policy.id) throw new Error(`${ledgerPath} names the policy ${ledger.policy.id}, and policy-change.json files ${policy.id}: the coordination directory was changed by hand`)
  const lines = [
    `project ${args.id}: completing its creation from ${coordination}${args.dryRun ? ' (dry run: nothing is written or asked)' : ''}`,
    `writes, only in ${coordination}:`,
    `  ${ledgerPath}`,
    'requests still to file on the approval queue (nothing applies until you approve it):',
    ...outstanding.map((r) => `  ${r}`),
  ]
  if (args.dryRun) return { lines, written: [], requests: [] }
  if (!deps.host) throw new ProjectRefusal('no running profile\'s board answers: it must run, with its board, to file the outstanding requests (system start)')
  const requests = await fileRequests(deps.host, ledger, ledgerPath, charter, policy)
  lines.push('filed:', ...requests.map((r) => `  ${r}`))
  return { lines, written: [ledgerPath], requests }
}
