/**
 * An operator's overlay changes the bundle's config, it does not replace it
 * (PLAN milestone B): objects merge as JSON Merge Patch (RFC 7386), and lists
 * of objects keyed by `ref` or `id` merge by that key, as Kubernetes'
 * strategic merge patch does (`$patch: delete` removes one,
 * `$patch: replace` takes the overlay's value whole). Composed by DSH's own
 * `composeEntries`, the call its boot makes.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const fromRoot = createRequire(new URL('../../../package.json', import.meta.url))
const fromDsh = createRequire(fromRoot.resolve('@deepseek-ai/dsh/package.json'))
// The bundle depends on no YAML parser; the work row's is the one System reads Workflow files with.
const { parse } = await import(pathToFileURL(createRequire(new URL('../../work/package.json', import.meta.url)).resolve('yaml')).href) as { parse: (text: string) => unknown }
const { composeEntries } = await import(pathToFileURL(fromDsh.resolve('@deepseek-ai/dsh-app-boot')).href) as { composeEntries: (layers: unknown[][]) => Entry[] }

interface Entry { id?: string; config?: any; disabled?: boolean }
const bundle = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')) as unknown[]
const flat = (entries: Entry[]): Entry[] => entries.flatMap((e) => [e, ...(Array.isArray(e.config) ? flat(e.config) : [])])
const agents = (overlay: string) => flat(composeEntries([bundle, parse(overlay) as unknown[]])).find((e) => e.id === 'agents')!.config as { attemptTimeoutMinutes?: number; accounts: { ref: string; capabilities?: string[]; models?: Record<string, string>; command?: string }[] }
const refs = (config: ReturnType<typeof agents>) => config.accounts.map((a) => a.ref)

test('an overlay account with a ref the bundle has changes only the fields it names', () => {
  const config = agents('- id: agents\n  config:\n    accounts:\n      - ref: codex/default\n        capabilities: [code-write, brainstorm.idea-b, research]\n')
  assert.deepEqual(refs(config), ['claude-code/default', 'codex/default'])
  const codex = config.accounts[1]!
  assert.deepEqual(codex.capabilities, ['code-write', 'brainstorm.idea-b', 'research'], 'a list of names is replaced whole')
  assert.equal(codex.models?.standard, 'gpt-6.1-sol', 'what the overlay does not name stays the bundle\'s')
  assert.equal(config.attemptTimeoutMinutes, 60)
})

test('an overlay account with a new ref is added after the bundle\'s; a scalar replaces; null removes a field', () => {
  const config = agents('- id: agents\n  config:\n    attemptTimeoutMinutes: 30\n    accounts:\n      - ref: chatgpt-web/second\n        runtime: chatgpt-web\n        capabilities: [research]\n      - ref: claude-code/default\n        models: null\n')
  assert.deepEqual(refs(config), ['claude-code/default', 'codex/default', 'chatgpt-web/second'])
  assert.equal(config.attemptTimeoutMinutes, 30)
  assert.equal('models' in config.accounts[0]!, false)
})

test('$patch: delete removes an account; $patch: replace takes the overlay whole, as before', () => {
  assert.deepEqual(refs(agents('- id: agents\n  config:\n    accounts:\n      - ref: codex/default\n        $patch: delete\n')), ['claude-code/default'])
  const replaced = agents('- id: agents\n  config:\n    $patch: replace\n    accounts:\n      - ref: claude-code/default\n        runtime: claude-code\n        capabilities: [research]\n')
  assert.deepEqual(replaced, { accounts: [{ ref: 'claude-code/default', runtime: 'claude-code', capabilities: ['research'] }] })
})

test('other entries are untouched, and an entry without config still takes the overlay\'s', () => {
  const entries = flat(composeEntries([bundle, parse('- id: fakes\n  disabled: false\n  config:\n    workers: [code-write]\n') as unknown[]]))
  const fakes = entries.find((e) => e.id === 'fakes')!
  assert.deepEqual([fakes.disabled, fakes.config.workers, fakes.config.verifiers], [false, ['code-write'], ['code.required-checks', 'research.citation-check']])
})
