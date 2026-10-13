/**
 * Generates docs/architecture/packages.md: every workspace package under packages/ and
 * packages/plugins/, its layer, the seam it defines or provides, its bundle row, the seams it
 * consumes, and the workspace packages it imports, plus a Mermaid graph of the seam edges grouped
 * by layer. Everything is read from the code: `inject` lists (`static inject`, `export const
 * inject`), optional consumption (`ctx.inject([...])`, `ctx.get('…')`), `super(ctx, '<key>')` in
 * service classes, `package.json` dependencies, and the rows of the bundle's `cordis.patch.yml`.
 * Only the layer of each package is stated here, in LAYER_OF: a new package must be placed there
 * or the generator fails. `--check` fails when the checked-in page is out of date (CI).
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(root, 'docs', 'architecture', 'packages.md')
const BUNDLE = join(root, 'packages', 'system-bundle')

/** Layers, top to bottom ([layer map](../docs/architecture/README.md#layer-map)). */
export const LAYERS = ['gateways', 'orchestration', 'routing', 'capabilities', 'provider runtime', 'kernel', 'host and libraries'] as const
export type Layer = (typeof LAYERS)[number]

/** The one hand-kept fact: which layer each package belongs to, by directory name. */
export const LAYER_OF: Record<string, Layer> = {
  // host and libraries
  'libs': 'host and libraries',
  'system-bundle': 'host and libraries',
  // kernel
  'store': 'kernel',
  'event-log': 'kernel',
  'leases': 'kernel',
  'artifacts': 'kernel',
  'credentials-vault': 'kernel',
  // provider runtime
  'provider-core': 'provider runtime',
  'ui-ops': 'provider runtime',
  'display-virtual': 'provider runtime',
  'browser-patchright': 'provider runtime',
  'accounts': 'provider runtime',
  'login': 'provider runtime',
  'providers': 'provider runtime',
  'provider-chatgpt-web': 'provider runtime',
  'provider-gemini-web': 'provider runtime',
  'turn-receipts': 'provider runtime',
  // capabilities: the Worker sources and the runtimes behind them
  'turns': 'capabilities',
  'agent-runtime-core': 'capabilities',
  'agent-runtimes': 'capabilities',
  'runtime-claude-agent-sdk': 'capabilities',
  'runtime-codex-sdk': 'capabilities',
  'runtime-acp': 'capabilities',
  'agent-workers': 'capabilities',
  'models-core': 'capabilities',
  'models': 'capabilities',
  // routing
  'workers-core': 'routing',
  'workers': 'routing',
  'egress': 'routing',
  // orchestration
  'workflow': 'orchestration',
  'worker-sessions': 'orchestration',
  'profile-software-development': 'orchestration',
  'profile-scientific-research': 'orchestration',
  // gateways
  'gateway-core': 'gateways',
  'gateway-turns': 'gateways',
  'gateway-anthropic': 'gateways',
  'gateway-responses': 'gateways',
  'mcp-server': 'gateways',
  'web-ui': 'gateways',
  'cli': 'gateways',
}

export interface Pkg {
  dir: string
  name: string
  path: string
  plugin: boolean
  layer: Layer
  defines: string[]
  provides: string[]
  required: string[]
  optional: string[]
  imports: string[]
  mountId?: string
  dsh?: boolean
}

function sources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

/** Code without comments, so a commented-out `inject` or `super` never counts. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

const listOf = (text: string): string[] => [...text.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]!)

interface ClassDecl { name: string; abstract: boolean; base: string; key?: string }

/** Class declarations with the service key their own constructor passes to `super`, if any. */
function classes(text: string): ClassDecl[] {
  const decls = [...text.matchAll(/(abstract\s+)?class\s+(\w+)(?:<[^>{]*>)?\s+extends\s+(\w+)/g)]
  return decls.map((m, i) => {
    const body = text.slice(m.index, decls[i + 1]?.index ?? text.length)
    const key = /super\(ctx,\s*['"]([A-Za-z]+)['"]\)/.exec(body)?.[1]
    return { name: m[2]!, abstract: !!m[1], base: m[3]!, ...(key ? { key } : {}) }
  })
}

/** Local name → [module, exported name] for every value import. */
function importsOf(text: string): Map<string, [string, string]> {
  const out = new Map<string, [string, string]>()
  for (const m of text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (m[1]) continue
    for (const spec of m[2]!.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type '))) {
      const [exported, local = exported] = spec.split(/\s+as\s+/)
      out.set(local!, [m[3]!, exported!])
    }
  }
  return out
}

/** Bundle rows in order: `- id: x` followed by `name: '…'`. */
export function bundleRows(): Array<{ id: string; name: string }> {
  const text = readFileSync(join(BUNDLE, 'cordis.patch.yml'), 'utf8')
  return [...text.matchAll(/- id: ([\w-]+)\n\s+name: '([^']+)'/g)].map((m) => ({ id: m[1]!, name: m[2]! }))
}

/** The service keys a non-workspace package (a DSH row) registers, read from its entry file. */
function externalKeys(name: string): string[] {
  const file = createRequire(join(BUNDLE, 'package.json')).resolve(name)
  return [...new Set([...readFileSync(file, 'utf8').matchAll(/super\(ctx,\s*['"]([A-Za-z]+)['"]\)/g)].map((m) => m[1]!))]
}

export function scan(): Pkg[] {
  const problems: string[] = []
  const dirs = [
    ...readdirSync(join(root, 'packages')).filter((d) => d !== 'plugins').map((d) => ({ dir: d, path: join(root, 'packages', d), plugin: false })),
    ...readdirSync(join(root, 'packages', 'plugins')).map((d) => ({ dir: d, path: join(root, 'packages', 'plugins', d), plugin: true })),
  ].filter((p) => existsSync(join(p.path, 'package.json'))).sort((a, b) => a.dir.localeCompare(b.dir))

  for (const dir of Object.keys(LAYER_OF)) if (!dirs.some((p) => p.dir === dir)) problems.push(`LAYER_OF names ${dir}, which is not a package`)
  const texts = new Map(dirs.map((p) => [p.dir, sources(join(p.path, 'src')).map((f) => code(readFileSync(f, 'utf8')))]))
  const names = new Map<string, string>()
  for (const p of dirs) names.set((JSON.parse(readFileSync(join(p.path, 'package.json'), 'utf8')) as { name: string }).name, p.dir)

  // Abstract seam definitions anywhere in the workspace: package name → class name → key.
  const definitions = new Map<string, Map<string, string>>()
  for (const p of dirs) {
    const pkgName = [...names].find(([, d]) => d === p.dir)![0]
    for (const text of texts.get(p.dir)!) {
      for (const c of classes(text)) {
        if (c.abstract && c.key) definitions.set(pkgName, new Map([...(definitions.get(pkgName) ?? []), [c.name, c.key]]))
      }
    }
  }

  const rows = bundleRows()
  const pkgs: Pkg[] = dirs.map((p) => {
    const json = JSON.parse(readFileSync(join(p.path, 'package.json'), 'utf8')) as { name: string; dependencies?: Record<string, string>; peerDependencies?: Record<string, string> }
    const layer = LAYER_OF[p.dir]
    if (!layer) problems.push(`package ${p.dir} has no layer: place it in LAYER_OF in scripts/gen-packages.ts`)
    const required = new Set<string>()
    const optional = new Set<string>()
    const defines = new Set<string>()
    const provides = new Set<string>()
    for (const text of texts.get(p.dir)!) {
      for (const m of text.matchAll(/(?:static\s+inject|export\s+const\s+inject)\s*=\s*\[([^\]]*)\]/g)) for (const k of listOf(m[1]!)) required.add(k)
      for (const m of text.matchAll(/\bctx\.inject\(\s*\[([^\]]*)\]/g)) for (const k of listOf(m[1]!)) optional.add(k)
      for (const m of text.matchAll(/\bctx\.get\(\s*['"]([A-Za-z]+)['"]\s*\)/g)) optional.add(m[1]!)
      const imported = importsOf(text)
      for (const c of classes(text)) {
        if (c.abstract) {
          if (c.key) defines.add(c.key)
          continue
        }
        if (c.key) {
          provides.add(c.key)
          continue
        }
        const from = imported.get(c.base)
        if (!from) continue
        const [module, exported] = from
        const key = definitions.get(module)?.get(exported)
        if (key) provides.add(key)
        else if (!names.has(module) && module.startsWith('@deepseek-ai/')) {
          const keys = externalKeys(module)
          if (keys.length === 1) provides.add(keys[0]!)
          else if (keys.length > 1) problems.push(`${p.dir}: ${c.name} extends ${exported} from ${module}, which registers ${keys.join(', ')}; cannot tell which`)
        }
      }
    }
    for (const k of required) optional.delete(k)
    // Imports: workspace packages this one depends on. The bundle's dependencies are its rows
    // (the mount ids), not imports; `libs`, the shared foundation, is listed but not drawn.
    const deps = Object.keys({ ...json.dependencies, ...json.peerDependencies }).filter((d) => names.has(d)).map((d) => names.get(d)!)
    const all = texts.get(p.dir)!.join('\n')
    const imports = p.dir === 'system-bundle' ? [] : deps.filter((d) => {
      if (!dirs.find((x) => x.dir === d)!.plugin) return true
      // A plugin package counts only when its code is imported, not only its types.
      const pkgName = [...names].find(([, x]) => x === d)![0]
      return [...all.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)]
        .some((m) => m[3] === pkgName && !m[1] && m[2]!.split(',').map((s) => s.trim()).some((s) => s && !s.startsWith('type ')))
    })
    const row = rows.find((r) => r.name === json.name)
    return {
      dir: p.dir, name: json.name, path: relative(root, p.path), plugin: p.plugin, layer: layer ?? 'host and libraries',
      defines: [...defines].sort(), provides: [...provides].sort(), required: [...required], optional: [...optional].sort(), imports: imports.sort(),
      ...(row ? { mountId: row.id } : {}),
    }
  })

  for (const row of rows) {
    if (pkgs.some((p) => p.name === row.name)) continue
    if (row.name.startsWith('@tsuuanmi/')) problems.push(`bundle row ${row.id} names ${row.name}, which is not a workspace package`)
    else pkgs.push({ dir: row.id, name: row.name, path: '', plugin: true, layer: 'host and libraries', defines: [], provides: externalKeys(row.name), required: [], optional: [], imports: [], mountId: row.id, dsh: true })
  }
  for (const p of pkgs) if (p.plugin && !p.dsh && !p.mountId) problems.push(`plugin ${p.dir} has no row in packages/system-bundle/cordis.patch.yml`)
  const providerOf = new Map<string, string[]>()
  for (const p of pkgs) for (const k of p.provides) providerOf.set(k, [...(providerOf.get(k) ?? []), p.dir])
  for (const p of pkgs) {
    for (const k of [...p.required, ...p.optional]) if (!providerOf.has(k)) problems.push(`${p.dir} consumes ctx.${k}, which no package or bundle row provides`)
  }
  for (const [k, by] of providerOf) if (by.length > 1) problems.push(`ctx.${k} is provided by ${by.join(', ')}`)
  if (problems.length) throw new Error(`gen-packages:\n  ${problems.join('\n  ')}`)
  return pkgs
}

const id = (dir: string): string => dir.replace(/[^A-Za-z0-9]/g, '_')
const seams = (keys: string[], mark = ''): string[] => keys.map((k) => `\`${k}\`${mark}`)

export function render(pkgs: Pkg[] = scan()): string {
  const providerOf = new Map<string, Pkg>()
  for (const p of pkgs) for (const k of p.provides) providerOf.set(k, p)
  const byLayer = (layer: Layer): Pkg[] => pkgs.filter((p) => p.layer === layer)
  const rank = (p: Pkg): number => LAYERS.indexOf(p.layer)

  const table = LAYERS.flatMap((layer) => byLayer(layer).map((p) => {
    const link = p.dsh ? `\`${p.name}\` (DSH row)` : `[${p.dir}](../../${p.path}/README.md)`
    const provided = [...p.defines.map((k) => `defines \`${k}\``), ...seams(p.provides)].join(', ') || '—'
    const consumes = [...seams(p.required), ...seams(p.optional, ' (optional)')].join(', ') || '—'
    const imports = p.imports.map((d) => `\`${d}\``).join(', ') || '—'
    return `| ${link} | ${layer} | ${provided} | ${p.mountId ? `\`${p.mountId}\`` : '—'} | ${consumes} | ${imports} |`
  }))

  const seamEdges: string[] = []
  const upward: string[] = []
  for (const p of pkgs) {
    for (const [keys, arrow, kind] of [[p.required, '-->', 'required'], [p.optional, '-.->', 'optional']] as const) {
      for (const k of keys) {
        const to = providerOf.get(k)!
        seamEdges.push(`  ${id(p.dir)} ${arrow} ${id(to.dir)}`)
        if (rank(to) < rank(p)) upward.push(`| \`${p.dir}\` (${p.layer}) | \`${k}\` | \`${to.dir}\` (${to.layer}) | ${kind} |`)
      }
    }
  }
  const importEdges = pkgs.flatMap((p) => p.imports.filter((d) => d !== 'libs').map((d) => `  ${id(p.dir)} --> ${id(d)}`))

  const graph = (edges: string[], include: (p: Pkg) => boolean): string[] => [
    '```mermaid',
    'flowchart TB',
    ...LAYERS.flatMap((layer) => {
      const members = byLayer(layer).filter(include)
      if (!members.length) return []
      return [
        `  subgraph ${id(layer)} ["${layer}"]`,
        ...members.map((p) => `    ${id(p.dir)}["${p.dir}${p.provides.length ? `<br/>${p.provides.map((k) => `ctx.${k}`).join(', ')}` : ''}${p.defines.length ? `<br/>defines ${p.defines.join(', ')}` : ''}"]`),
        '  end',
      ]
    }),
    ...edges,
    '```',
  ]
  const inSeamGraph = new Set(seamEdges.flatMap((e) => e.trim().split(/\s+-\.?->\s+/)))
  const inImportGraph = new Set(importEdges.flatMap((e) => e.trim().split(/\s+-->\s+/)))

  return [
    '# Packages and dependencies',
    '',
    '> Generated by `pnpm gen:packages` (`scripts/gen-packages.ts`) from each package\'s source and',
    '> `package.json` and the rows of `packages/system-bundle/cordis.patch.yml`; do not edit by hand.',
    '> CI fails when it is out of date. The layer of each package is the one hand-kept fact, in',
    '> `LAYER_OF` in the script: a new package must be placed there, or the generator fails.',
    '',
    'The layers are those of the [layer map](README.md#layer-map); seams are described in the',
    '[seam catalog](plugin-model.md#seam-catalog). **Defines** marks the abstract `Service` class that',
    'owns a key; **provides** is the plugin that registers it. **Consumes** is the `inject` list;',
    '*optional* seams are taken with `ctx.inject([...])` or `ctx.get(...)` and used only when present.',
    '**Imports** are workspace packages whose code is imported (a plugin package imported only for',
    'its types is not listed).',
    '',
    '## Packages',
    '',
    '| Package | Layer | Defines / provides | Bundle row | Consumes | Imports |',
    '|---|---|---|---|---|---|',
    ...table,
    '',
    '## Seam graph',
    '',
    'An arrow runs from a consumer to the package that provides the seam; a dotted arrow is an optional',
    'seam. Rows of DSH core appear under host and libraries.',
    '',
    ...graph(seamEdges, (p) => inSeamGraph.has(id(p.dir))),
    '',
    '### Seam edges that point up a layer',
    '',
    'Dependencies point down, except where a lower plugin registers into a registry above it or asks a',
    'policy above it. Each such edge is listed here so a new one is a visible change.',
    '',
    '| Consumer | Seam | Provider | Kind |',
    '|---|---|---|---|',
    ...upward.sort(),
    '',
    '## Library imports',
    '',
    'An arrow runs from a package to a workspace package whose code it imports; `libs`, imported by',
    'almost every package, is not drawn.',
    '',
    ...graph(importEdges, (p) => inImportGraph.has(id(p.dir))),
    '',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const text = render()
  if (process.argv.includes('--check')) {
    const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
    if (current !== text) {
      console.error('docs/architecture/packages.md is out of date: run `pnpm gen:packages`')
      process.exit(1)
    }
    console.log('packages: up to date')
  } else {
    writeFileSync(OUT, text)
    console.log(`wrote ${OUT}`)
  }
}
