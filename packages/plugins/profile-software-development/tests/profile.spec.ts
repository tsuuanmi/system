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
import Workflow from '@tsuuanmi/system-workflow'
import { afterEach, describe, expect, it } from 'vitest'
import * as SoftwareDevelopment from '../src/index.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'system-profile-'))
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, {}), ctx.plugin(Egress, {}),
    ctx.plugin(WorkerRouter, {}), ctx.plugin(WorkerSessions, {}), ctx.plugin(Workflow, {}),
  ]
  await Promise.all(fibers)
  cleanups.push(async () => { for (const f of [...fibers].reverse()) await f.dispose() }, () => rmSync(dir, { recursive: true, force: true }))
  return ctx
}

const { profileConformance } = await import('../../workflow/conformance/profiles.ts')
profileConformance('software-development', async () => ({ ctx: await boot(), dispose: async () => undefined }), SoftwareDevelopment, { 'agent-review': SoftwareDevelopment.AGENT_REVIEW })

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
