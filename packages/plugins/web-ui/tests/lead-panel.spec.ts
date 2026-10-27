import LeadInbox from '@tsuuanmi/system-lead-inbox'
import { issueLeadToken, leadTokens } from '@tsuuanmi/system-libs'
import { describe, expect, it, vi } from 'vitest'
import { boot } from './store-backed.ts'

// A project's Lead panel (D107): `GET /ui/api/lead?project=<id>` gives the unread notices, the recent
// digests, and the stats of that project's lead inbox: to the project's lead token (its own project only)
// and to the operator; 503 where the lead inbox is not mounted.
vi.setConfig({ testTimeout: 120_000 })

describe('web UI: the Lead panel', () => {
  it('is 503 without the lead inbox', async () => {
    const { call } = await boot()
    expect((await call('lead?project=p1')).status).toBe(503)
  })

  it('gives the lead its own project\'s unread notices and the operator any project\'s, and refuses another project to a lead', async () => {
    const { ctx, dir, call } = await boot()
    await ctx.plugin(LeadInbox, {})
    ctx.leadInbox.use({ projectOf: async (taskId) => (taskId === 'task-p1' ? 'p1' : 'p2'), projects: async () => ['p1', 'p2'], idle: async () => undefined })
    ctx.eventLog.append({ type: 'workflow.task.question', data: { taskId: 'task-p1', questions: 1 } })
    ctx.eventLog.append({ type: 'workflow.task.question', data: { taskId: 'task-p2', questions: 1 } })
    await ctx.leadInbox.pass()
    issueLeadToken(dir, 'p1')
    const lead = leadTokens(dir).get('p1')!
    const own = await call('lead', undefined, lead)
    expect(own.status).toBe(200)
    expect(own.value).toMatchObject({ project: 'p1', unread: [{ project: 'p1', kind: 'worker.question', subject: 'task-p1' }], digests: [], stats: { unread: 1 } })
    expect((await call('lead?project=p1', undefined, lead)).status).toBe(200)
    const other = await call('lead?project=p2', undefined, lead)
    expect(other.status).toBe(403)
    expect(JSON.stringify(other.value)).not.toContain('task-p2')
    const operator = await call('lead?project=p2')
    expect(operator.value).toMatchObject({ project: 'p2', unread: [{ project: 'p2', subject: 'task-p2' }] })
    expect((await call('lead')).status).toBe(400)
  })
})
