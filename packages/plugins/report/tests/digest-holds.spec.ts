// The digest's "Waits on the operator" lists each hold with the hours to its expiry (as of the digest's
// time) and flags the ones under N hours (T357). Fixed instants only.
import type { BoardTask } from '@tsuuanmi/system-board-core'
import { describe, expect, it } from 'vitest'
import { buildDigest, renderDigest } from '../src/index.ts'

const held = (taskId: string, expiresAt: string): BoardTask => ({
  schema: 'board-task@1.3', taskId, projectId: 'p1', title: `title of ${taskId}`, goal: 'g', acceptance: [], dependsOn: [], actionClass: 'workspace-write', state: 'review',
  attempts: { count: 1, max: 3 }, createdAt: '2026-10-20T00:00:00.000Z', revision: 1,
  waiting: { reason: 'operator-review', since: '2026-10-26T10:00:00.000Z', expiresAt },
})

const digest = () => buildDigest({
  asOf: '2026-10-26T12:00:00.000Z', projectId: 'p1', day: '2026-10-26',
  tasks: [held('near', '2026-10-26T14:30:00.000Z'), held('far', '2026-10-27T12:00:00.000Z')],
  events: [], requests: [], decisions: [], branch: { value: [] }, dailyChecks: { value: [] }, notes: [],
})

describe('Waits on the operator', () => {
  it('shows the hours to expiry of each hold, and flags those under the default 4 hours', () => {
    const lines = renderDigest(digest()).split('\n')
    const near = lines.find((l) => l.includes('near'))!
    const far = lines.find((l) => l.includes('far'))!
    expect(near).toContain('2.5 h to expiry')
    expect(near).toContain('EXPIRING SOON')
    expect(far).toContain('24 h to expiry')
    expect(far).not.toContain('EXPIRING SOON')
  })

  it('takes N as an argument', () => {
    const far = renderDigest(digest(), 30).split('\n').find((l) => l.includes('far'))!
    expect(far).toContain('EXPIRING SOON')
  })
})
