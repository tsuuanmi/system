/**
 * Architecture tests: rules about the codebase itself, checked on every change
 * (docs/architecture/invariants.md, docs/architecture/plugin-model.md).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const packages = join(root, 'packages')
const plugins = join(packages, 'plugins')

function sources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (entry.endsWith('.ts')) out.push(path)
  }
  return out
}

/** Code without comments: what a rule about code must look at. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

describe('architecture rules', () => {
  it('routing, workflows, profiles, presets, the models seam, the client edge, and the gateways\' shared turns name capabilities, never a model, vendor, client, or browser, and set no provider family (INV-11, QA-13, ADR-0027)', () => {
    const governed = [
      join(packages, 'workers-core', 'src'), join(plugins, 'workers', 'src'), join(plugins, 'workflow', 'src'), join(packages, 'gateway-turns', 'src'),
      join(packages, 'models-core', 'src'), join(plugins, 'models', 'src'), join(packages, 'decision-core', 'src'),
      // The landing seam and its local provider name no code host; a host's provider is its own plugin (PROP-0017).
      join(packages, 'landing-core', 'src'), join(plugins, 'landing-local', 'src'),
      // The feedback loop's seams compare provider families for independence; they never name one.
      join(packages, 'feedback-core', 'src'),
      // The client edge and the other control-plane plugins: one MCP interface for every client (ADR-0011).
      join(packages, 'gateway-core', 'src'), join(plugins, 'mcp-server', 'src'), join(plugins, 'egress', 'src'), join(plugins, 'turns', 'src'),
      join(plugins, 'accounts', 'src'), join(plugins, 'agent-workers', 'src'), join(packages, 'agent-runtime-core', 'src'),
      // The surfaces that read the core for the operator and the lead.
      join(plugins, 'report', 'src'), join(plugins, 'notify', 'src'),
      ...readdirSync(plugins).filter((d) => d.startsWith('profile-')).map((d) => join(plugins, d, 'src')),
    ]
    const presets = join(packages, 'system-bundle', 'presets')
    const patches = readdirSync(presets).map((d) => join(presets, d, 'cordis.patch.yml'))
    expect(patches.length).toBeGreaterThan(0)
    const named = /\b(chatgpt|openai|anthropic|claude|gemini|codex|antigravity|patchright|chrome|chromium)\b/i
    // A preset turns rows off by their bundle ids (`- id: provider-…`); its configuration names nothing.
    const yaml = (text: string): string => text.split('\n').map((line) => (/^- id: [\w-]+$/.test(line) ? '' : line)).join('\n')
    const offenders = [...governed.flatMap((dir) => sources(dir)), ...patches].flatMap((file) => (file.endsWith('.yml') ? yaml(readFileSync(file, 'utf8')) : code(readFileSync(file, 'utf8'))).split('\n')
      .map((line, i) => (named.test(line) ? `${relative(root, file)}:${i + 1}: ${line.trim()}` : '')).filter(Boolean))
    expect(offenders).toEqual([])
    // ADR-0027: routing may compare provider families, but nothing it governs sets or names one.
    const familyLiteral = /\bfamil(?:y|ies)\s*:\s*\[?\s*['"`]/
    const families = governed.flatMap((dir) => sources(dir)).flatMap((file) => code(readFileSync(file, 'utf8')).split('\n')
      .map((line, i) => (familyLiteral.test(line) ? `${relative(root, file)}:${i + 1}: ${line.trim()}` : '')).filter(Boolean))
    expect(families).toEqual([])
  })

  it('keeps the repository reader\'s test seams in its own package: no other source names them, and the package does not export them (PROP-0004 Phase 6)', () => {
    const owner = join(packages, 'libs', 'src', 'repositories.ts')
    const seams = /\b(snapshotWithTestSeams|SnapshotTesting)\b/
    // Every package's own sources, whichever way they would import it (by package name or by path).
    const roots = [...readdirSync(packages).filter((d) => d !== 'plugins').map((d) => join(packages, d, 'src')), ...readdirSync(plugins).map((d) => join(plugins, d, 'src'))]
    const named = roots.flatMap((dir) => sources(dir)).filter((file) => file !== owner && seams.test(code(readFileSync(file, 'utf8'))))
    expect(named.map((file) => relative(root, file))).toEqual([])
    // Nothing reaches them through the package: its entry exports neither, and it exports only its entry.
    expect(code(readFileSync(join(packages, 'libs', 'src', 'index.ts'), 'utf8'))).not.toMatch(seams)
    expect(Object.keys((JSON.parse(readFileSync(join(packages, 'libs', 'package.json'), 'utf8')) as { exports: Record<string, unknown> }).exports)).toEqual(['.'])
  })

  it('keeps native protocol objects inside their own adapters: each protocol SDK is imported only where that protocol is spoken, and no gateway imports another (INV-7)', () => {
    // Each SDK's native types cross only their own boundary; everything else sees behavior.
    const speakers: Record<string, string[]> = {
      '@modelcontextprotocol/sdk': ['packages/gateway-core', 'packages/plugins/mcp-server', 'packages/cli'],
      '@agentclientprotocol/sdk': ['packages/plugins/runtime-acp'],
      '@openai/codex-sdk': ['packages/plugins/runtime-codex-sdk'],
      '@anthropic-ai/claude-agent-sdk': ['packages/plugins/runtime-claude-agent-sdk'],
    }
    const gateways = readdirSync(plugins).filter((d) => d.startsWith('gateway-'))
    const offenders: string[] = []
    const srcDirs = [
      ...readdirSync(packages).filter((d) => d !== 'plugins').map((d) => join(packages, d, 'src')),
      ...readdirSync(plugins).map((d) => join(plugins, d, 'src')),
    ]
    for (const file of srcDirs.flatMap((dir) => sources(dir))) {
      const where = relative(root, file)
      const text = code(readFileSync(file, 'utf8'))
      for (const [sdk, allowed] of Object.entries(speakers)) {
        if (new RegExp(`from '${sdk}[/']`).test(text) && !allowed.some((dir) => where.startsWith(`${dir}/`))) offenders.push(`${where}: ${sdk}`)
      }
      const own = gateways.find((g) => where.startsWith(`packages/plugins/${g}/`))
      for (const other of gateways.filter((g) => g !== own)) {
        if (own && text.includes(`@tsuuanmi/system-${other}'`)) offenders.push(`${where}: ${other}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('has one authoritative runtime per concern: each service is provided by exactly one package (INV-1)', () => {
    const providers = new Map<string, string[]>()
    for (const dir of readdirSync(plugins)) {
      for (const file of sources(join(plugins, dir, 'src'))) {
        for (const m of readFileSync(file, 'utf8').matchAll(/super\(ctx, '([A-Za-z]+)'\)/g)) providers.set(m[1]!, [...new Set([...(providers.get(m[1]!) ?? []), dir])])
      }
    }
    expect(providers.get('workflow')).toEqual(['workflow'])
    expect([...providers].filter(([, dirs]) => dirs.length > 1)).toEqual([])
  })

  it('composes every feature from configuration: each plugin is one bundle row a profile can disable or replace (REQ-HOST-4)', () => {
    const rows = [...readFileSync(join(packages, 'system-bundle', 'cordis.patch.yml'), 'utf8').matchAll(/- id: ([\w-]+)\n\s+name: '([^']+)'/g)].map((m) => ({ id: m[1]!, name: m[2]! }))
    const ours = rows.filter((r) => r.name.startsWith('@tsuuanmi/'))
    for (const dir of readdirSync(plugins)) {
      const { name } = JSON.parse(readFileSync(join(plugins, dir, 'package.json'), 'utf8')) as { name: string }
      expect(ours.filter((r) => r.name === name), name).toHaveLength(1)
    }
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  })

  it('defines every seam with a conformance suite its providers must pass, so each is replaceable behind it (QA-9)', () => {
    const cores = readdirSync(packages).filter((d) => d.endsWith('-core'))
    for (const core of cores) {
      const defines = sources(join(packages, core, 'src')).some((f) => /export abstract class/.test(readFileSync(f, 'utf8')))
      if (defines) expect(readdirSync(join(packages, core, 'conformance')).filter((f) => f.endsWith('.ts')).length, core).toBeGreaterThan(0)
    }
    expect(existsSync(join(plugins, 'workflow', 'conformance', 'profiles.ts'))).toBe(true)
    expect(existsSync(join(packages, 'decision-core', 'conformance', 'dispatch-advisor.ts'))).toBe(true)
    expect(existsSync(join(packages, 'landing-core', 'conformance', 'landing.ts'))).toBe(true)
  })

  it('holds every guarantee seam to a conformance suite at a pinned contract, so a worse provider cannot pass unnoticed (ADR-0036, ADR-0037)', () => {
    const suites: Record<string, string> = {
      store: 'ledger-core/conformance/store.ts', eventLog: 'ledger-core/conformance/event-log.ts', artifacts: 'ledger-core/conformance/artifacts.ts',
      turnReceipts: 'plugins/turn-receipts/conformance/turn-receipts.ts', leases: 'board-core/conformance/leases.ts', egress: 'workers-core/conformance/egress.ts',
      workerSessions: 'plugins/worker-sessions/conformance/worker-sessions.ts', workflow: 'plugins/workflow/conformance/workflow.ts', workers: 'workers-core/conformance/workers.ts',
      board: 'board-core/conformance/board.ts', approvals: 'approvals-core/conformance/approvals.ts', resources: 'resources-core/conformance/resources.ts',
      pluginHost: 'plugin-host-core/conformance/plugin-host.ts', experiments: 'feedback-core/conformance/experiments.ts',
      evaluations: 'feedback-core/conformance/evaluations.ts', landing: 'landing-core/conformance/landing.ts',
    }
    for (const [seam, file] of Object.entries(suites)) {
      const source = readFileSync(join(packages, file), 'utf8')
      // `workers` predates the runner; every other guarantee suite is defined through it, for its seam.
      if (seam !== 'workers') expect(source, seam).toMatch(new RegExp(`defineSuite<\\w+>\\(\\{\\s*seam: '${seam}'`))
    }
  })

  it('never lets a provider name select an account: a work requirement names capabilities, and has no provider field (REQ-ACC-2)', async () => {
    const { SchemaRegistry } = await import('../packages/libs/src/index.ts')
    const schemas = new SchemaRegistry()
    const requirement = {
      schema: 'work-requirement@1.0', objective: 'answer', capabilities: ['reason'], data: { classification: 'operator-shared', refs: [] },
      egressPolicy: 'default', tier: { min: 'standard', source: 'profile' }, acceptance: { contract: 'acceptance.answer' },
    }
    expect(() => schemas.assert('work-requirement@1.0', requirement)).not.toThrow()
    expect(() => schemas.assert('work-requirement@1.0', { ...requirement, provider: 'chatgpt-web' })).toThrow()
    expect(() => schemas.assert('work-requirement@1.0', { ...requirement, account: 'chatgpt-main' })).toThrow()
  })
})
