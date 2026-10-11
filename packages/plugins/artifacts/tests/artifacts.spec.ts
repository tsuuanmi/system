import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it } from 'vitest'
import Artifacts, { type Decision } from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot(): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'system-artifacts-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const store = ctx.plugin(Store, { path: join(dir, 'system.db') })
  const artifacts = ctx.plugin(Artifacts, {})
  await Promise.all([store, artifacts])
  cleanups.push(() => store.dispose())
  return ctx
}

const route: Omit<Decision, 'schema'> = {
  decisionType: 'route',
  question: 'Which Worker runs research:1?',
  inputs: [],
  candidates: [
    { option: 'worker:chatgpt-main/deep-research', selected: true, reasons: ['capabilities proven'] },
    { option: 'worker:chatgpt-2/deep-research', selected: false, reasons: ['reauth-required'] },
  ],
  decider: { type: 'policy', id: 'routing.default', version: '1' },
  outcome: { option: 'worker:chatgpt-main/deep-research' },
  deterministic: true,
}
const producer = { type: 'policy', ref: 'routing.default' } as const

describe('ctx.artifacts', () => {
  it('stores a decision with a computed content id and deduplicates identical content', async () => {
    const ctx = await boot()
    const first = ctx.artifacts.recordDecision(route, { producer, runId: 'run-1', nodeId: 'research:1' })
    expect(first.id).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(ctx.artifacts.recordDecision(route, { producer, runId: 'run-1', nodeId: 'research:1' }).id).toBe(first.id)
    expect(ctx.artifacts.list({ decisionType: 'route' })).toHaveLength(1)
  })

  it('rejects a decision whose selected candidate differs from the outcome', async () => {
    const ctx = await boot()
    expect(() => ctx.artifacts.recordDecision({ ...route, outcome: { option: 'worker:chatgpt-2/deep-research' } }, { producer })).toThrow(/outcome/)
  })

  it('rejects a body that does not match its schema', async () => {
    const ctx = await boot()
    expect(() => ctx.artifacts.recordDecision({ ...route, candidates: [] }, { producer })).toThrow(/decision@1.0/)
  })

  it('never classifies a derived artifact below its strictest input', async () => {
    const ctx = await boot()
    const secret = ctx.artifacts.recordDecision(route, { producer, classification: 'local-private' })
    const derived = ctx.artifacts.recordDecision({ ...route, inputs: [secret.id], question: 'derived' }, { producer, classification: 'public' })
    expect(derived.classification).toBe('local-private')
  })

  it('explains the decision chain behind an artifact', async () => {
    const ctx = await boot()
    const tier = ctx.artifacts.recordDecision(
      { ...route, decisionType: 'tier', question: 'tier?', candidates: [{ option: 'frontier', selected: true, reasons: ['profile'] }], outcome: { option: 'frontier' } },
      { producer },
    )
    const routed = ctx.artifacts.recordDecision({ ...route, inputs: [tier.id] }, { producer })
    expect(ctx.artifacts.explain(routed.id)).toMatchObject({
      summary: 'route: worker:chatgpt-main/deep-research',
      inputs: [{ summary: 'tier: frontier', inputs: [] }],
    })
  })
})

describe('review fixes (PR #3 kernel review)', () => {
  const tierOf = (n: number) => ({ ...route, decisionType: 'tier', question: `q${n}`, candidates: [{ option: `t${n}`, selected: true, reasons: [] }], outcome: { option: `t${n}` } })

  it('explains a diamond-shaped graph in linear time with shared nodes', async () => {
    const ctx = await boot()
    let layer = [ctx.artifacts.recordDecision(tierOf(0), { producer }).id]
    let n = 1
    for (let depth = 0; depth < 15; depth++) {
      layer = [0, 1, 2, 3].map(() => ctx.artifacts.recordDecision({ ...tierOf(n++), inputs: layer }, { producer }).id)
    }
    const top = ctx.artifacts.recordDecision({ ...tierOf(n++), inputs: layer }, { producer })
    const started = Date.now()
    const tree = ctx.artifacts.explain(top.id)!
    expect(Date.now() - started).toBeLessThan(1000)
    const unique = new Set<string>()
    const walk = (node: { id: string; inputs: unknown[] }): void => {
      if (unique.has(node.id)) return
      unique.add(node.id)
      for (const input of node.inputs as { id: string; inputs: unknown[] }[]) walk(input)
    }
    walk(tree)
    expect(unique.size).toBe(n)
  })

  it('rejects unknown input references (the classification floor cannot fail open)', async () => {
    const ctx = await boot()
    expect(() => ctx.artifacts.recordDecision({ ...route, inputs: [`sha256:${'9'.repeat(64)}`] }, { producer })).toThrow(/unknown input/)
  })

  it('refuses to downgrade on deduplication', async () => {
    const ctx = await boot()
    ctx.artifacts.recordDecision(route, { producer, classification: 'public' })
    expect(() => ctx.artifacts.recordDecision(route, { producer, classification: 'local-private' })).toThrow(/classification/)
  })

  it('hashes the body schema and treats inputs as a set', async () => {
    const ctx = await boot()
    const a = ctx.artifacts.recordDecision(tierOf(1), { producer })
    const b = ctx.artifacts.recordDecision(tierOf(2), { producer })
    const ab = ctx.artifacts.recordDecision({ ...tierOf(3), inputs: [a.id, b.id] }, { producer })
    const ba = ctx.artifacts.recordDecision({ ...tierOf(3), inputs: [b.id, a.id] }, { producer })
    expect(ba.id).toBe(ab.id)
  })

  it('lists identical content under every run that produced it', async () => {
    const ctx = await boot()
    ctx.artifacts.recordDecision(route, { producer, runId: 'run-1' })
    ctx.artifacts.recordDecision(route, { producer, runId: 'run-2' })
    expect(ctx.artifacts.list({ runId: 'run-2' })).toHaveLength(1)
  })

  it('requires a model decider to be non-deterministic', async () => {
    const ctx = await boot()
    expect(() => ctx.artifacts.recordDecision({ ...route, decider: { type: 'model', id: 'm', version: '1' } }, { producer })).toThrow()
  })
})
