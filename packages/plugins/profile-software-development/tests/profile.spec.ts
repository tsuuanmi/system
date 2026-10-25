import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Artifacts from '@tsuuanmi/system-artifacts'
import Egress from '@tsuuanmi/system-egress'
import EventLog from '@tsuuanmi/system-event-log'
import Leases from '@tsuuanmi/system-leases'
import Store from '@tsuuanmi/system-store'
import WorkerSessions from '@tsuuanmi/system-worker-sessions'
import WorkerRouter from '@tsuuanmi/system-workers'
import Workflow, { type NodeTemplate } from '@tsuuanmi/system-workflow'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as SoftwareDevelopment from '../src/index.ts'

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-profile-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, {}),
  ]
  await Promise.all(fibers)
  onTestFinished(async () => { for (const f of [...fibers].reverse()) await f.dispose() })
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  return ctx
}

const { profileConformance } = await import('../../workflow/conformance/profiles.ts')
profileConformance('software-development', async () => ({ ctx: await boot(), dispose: async () => undefined }), SoftwareDevelopment, {
  'agent-review': SoftwareDevelopment.AGENT_REVIEW, 'algorithm-development': SoftwareDevelopment.ALGORITHM_DEVELOPMENT,
})

describe('the profiles seam (REQ-WF-9)', () => {
  it('checks a contributed template like a configured one, and refuses a second one by the same name', async () => {
    const ctx = await boot()
    const review = SoftwareDevelopment.AGENT_REVIEW
    expect(() => ctx.workflow.template('Bad Name', review)).toThrow(/template name/)
    expect(() => ctx.workflow.template('broken', [{ ...review[0]!, dependsOn: ['missing'] }])).toThrow(/unknown node missing/)
    expect(() => ctx.workflow.template('ask', review)).toThrow(/already exists/)
    const withdraw = ctx.workflow.template('agent-review', review)
    expect(() => ctx.workflow.template('agent-review', review)).toThrow(/already exists/)
    withdraw()
    expect(ctx.workflow.templateNames()).not.toContain('agent-review')
  })
})

describe('the inputs each step of algorithm-development reads (docs/reference/workflow-templates.md#algorithm-development)', () => {
  it('gives the caller\'s input to the writing step only: the review and the validation read the task and the change, never the develop step\'s orders (T99 D4)', () => {
    const steps = new Map(SoftwareDevelopment.ALGORITHM_DEVELOPMENT.map((n) => [n.nodeId, n]))
    expect(steps.get('develop:1')!.prompt).toContain('{{input}}')
    for (const variant of Object.values(steps.get('develop:1')!.variants ?? {})) expect(variant.prompt).toContain('{{input}}')
    for (const id of ['review:1', 'validate:1']) {
      expect(steps.get(id)!.prompt, id).not.toContain('{{')
      expect(steps.get(id)!.dependsOn, id).toHaveLength(1)
    }
    expect(steps.get('validate:1')!.prompt).toContain('acceptance criteria')
  })
})

describe('the kind of work each step of algorithm-development names (ADR-0057)', () => {
  const kinds = (nodes: NodeTemplate[]) => Object.fromEntries(nodes.flatMap((n) => [
    [n.nodeId, n.kind ?? null], ...Object.entries(n.variants ?? {}).map(([variant, v]) => [`${n.nodeId} (${variant})`, v.kind ?? null]),
  ]))

  it('ships three writing kinds and validation for the step that only runs the checks; the review names none', () => {
    expect(kinds(SoftwareDevelopment.ALGORITHM_DEVELOPMENT)).toEqual({
      'develop:1': 'code', 'develop:1 (docs)': 'docs', 'develop:1 (tests)': 'tests', 'review:1': null, 'validate:1': 'validation',
    })
    expect(SoftwareDevelopment.Config({})).toEqual({ kinds: SoftwareDevelopment.DEFAULT_KINDS })
  })

  it('takes each step\'s kind from the row\'s configuration, the rest keeping theirs, and the review still none', async () => {
    expect(kinds(SoftwareDevelopment.algorithmDevelopment({ validate: 'tests', docs: 'writing' }))).toEqual({
      'develop:1': 'code', 'develop:1 (docs)': 'writing', 'develop:1 (tests)': 'tests', 'review:1': null, 'validate:1': 'tests',
    })
    const ctx = await boot()
    await ctx.plugin(SoftwareDevelopment, { kinds: { validate: 'checks' } })
    expect(ctx.workflow.templateSteps('algorithm-development')!.find((s) => s.nodeId === 'validate:1')).toMatchObject({ kind: 'checks' })
  })

  it('refuses a key that is not a step and a kind that is not a kind of work, at the check and at load (INV-2)', async () => {
    expect(SoftwareDevelopment.checkConfig({})).toEqual([])
    expect(SoftwareDevelopment.checkConfig({ kinds: { develop: 'code', validate: 'validation' } })).toEqual([])
    expect(SoftwareDevelopment.checkConfig({ kinds: { review: 'code' } } as never)).toEqual(['kinds.review is not a step; kinds takes develop, docs, tests, validate'])
    expect(SoftwareDevelopment.checkConfig({ kinds: { validate: '' } })).toEqual([`kinds.validate: "" is not a kind of work (${String(/^[a-z][a-z0-9-]{0,31}$/)})`])
    expect(SoftwareDevelopment.checkConfig({ kinds: { develop: 'Code' } })).toHaveLength(1)
    expect(SoftwareDevelopment.checkConfig({ kinds: ['code'] } as never)).toEqual(['kinds must be an object of steps (develop, docs, tests, validate), each naming a kind of work'])
    expect(() => SoftwareDevelopment.Config({ kinds: { validate: '' } })).toThrow(/kinds\.validate/)
    const ctx = await boot()
    await expect(ctx.plugin(SoftwareDevelopment, { kinds: { validation: 'validation' } } as never)).rejects.toThrow(/kinds\.validation is not a step/)
    expect(ctx.workflow.templateNames()).not.toContain('algorithm-development')
  })
})
