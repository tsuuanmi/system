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
import { afterEach, describe, expect, it } from 'vitest'
import Workflow from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function engine(templates: Record<string, unknown>): Promise<{ error: Error | undefined; served: boolean; refused: Array<{ name: string; reason: string }> }> {
  const dir = mkdtempSync(join(tmpdir(), 'system-startup-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const ctx = new Context()
  const fibers = [ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}), ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {})]
  await Promise.all(fibers)
  const workflow = ctx.plugin(Workflow, { templates } as never)
  cleanups.push(async () => { for (const f of [workflow, ...fibers].reverse()) await f.dispose() })
  let error: Error | undefined
  try {
    await workflow
  } catch (e) {
    error = e as Error
  }
  const served = (ctx as unknown as { workflow?: Workflow }).workflow
  return { error, served: !!served, refused: served?.refusedTemplates() ?? [] }
}

const step = { nodeId: 'a', objective: 'x', prompt: 'p', capabilities: ['reason'], tier: 'standard', conversation: 'temporary', acceptance: 'acceptance.answer' }

describe('startup validation (REQ-HOST-2)', () => {
  it('refuses a configuration that breaks its schema, naming the exact path', async () => {
    const { conversation: _, ...missing } = step
    const outcome = await engine({ broken: [missing] })
    expect(outcome.served).toBe(false)
    expect(outcome.error?.message).toMatch(/templates\.broken\[0\]\.conversation missing required value/)
  })

  // A template that passes the schema but fails its own check is refused alone (INV-2): the engine
  // serves every other template, and health names the refused one.
  it('refuses a template whose result schema is unknown, alone (REQ-ART-5)', async () => {
    const outcome = await engine({ broken: [{ ...step, resultSchema: 'nothing@1.0' }], fine: [step] })
    expect(outcome).toMatchObject({ error: undefined, served: true, refused: [{ name: 'broken', reason: expect.stringMatching(/node a: unknown result schema nothing@1\.0/) }] })
  })

  it('refuses a template that fails preflight, alone, naming the template\'s problem', async () => {
    const outcome = await engine({ broken: [{ ...step, dependsOn: ['missing'] }] })
    expect(outcome).toMatchObject({ error: undefined, served: true, refused: [{ name: 'broken', reason: expect.stringMatching(/unknown node missing/) }] })
  })
})
