// The lead brief reads the optional rows through structural types (lead-inbox/src/brief-sources.ts). Its unit
// tests use fakes of them; this keeps each fake honest: every method the brief calls is a public, async-or-sync
// method of the real service, and the one that once did not exist (`workflow.projectOf`, private) is not called.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AgentWorkers } from '@tsuuanmi/system-agent-workers'
import { StoreApprovals } from '@tsuuanmi/system-approvals'
import { StoreBoard } from '@tsuuanmi/system-board'
import { Workflow } from '@tsuuanmi/system-workflow'
import { describe, expect, it } from 'vitest'

const AsyncFunction = (async () => {}).constructor

describe('the lead brief\'s sources match the real services', () => {
  it('calls only methods the real board, approvals, workflow, and agent-workers have', () => {
    const board = StoreBoard.prototype as unknown as Record<string, unknown>
    for (const m of ['project', 'task', 'taskPage', 'counts']) expect(typeof board[m], `board.${m}`).toBe('function')
    expect(board['project']).toBeInstanceOf(AsyncFunction)
    expect(board['task']).toBeInstanceOf(AsyncFunction)
    const approvals = StoreApprovals.prototype as unknown as Record<string, unknown>
    for (const m of ['list', 'projectOfRequest', 'leadMay']) expect(approvals[m], `approvals.${m}`).toBeInstanceOf(AsyncFunction)
    const workflow = Workflow.prototype as unknown as Record<string, unknown>
    // Read synchronously by the brief: never async, or a Promise would stand in for the value.
    for (const m of ['openLandings', 'get']) {
      expect(typeof workflow[m], `workflow.${m}`).toBe('function')
      expect(workflow[m], `workflow.${m}`).not.toBeInstanceOf(AsyncFunction)
    }
    for (const m of ['taskPage', 'counts']) expect(board[m], `board.${m}`).not.toBeInstanceOf(AsyncFunction)
    expect(workflow['projectOfRun'], 'workflow.projectOfRun').toBeInstanceOf(AsyncFunction)
    expect((AgentWorkers.prototype as unknown as Record<string, unknown>)['runWorktrees'], 'agentWorkers.runWorktrees').toBeInstanceOf(AsyncFunction)
  })

  it('gives the health table and dispatch the agent-workers methods they call (T345)', () => {
    const agents = AgentWorkers.prototype as unknown as Record<string, unknown>
    expect(agents['worktreeCounts'], 'agentWorkers.worktreeCounts').toBeInstanceOf(AsyncFunction)
    // Read synchronously by the health table and by dispatch's pass: never async, or a Promise would stand in for the value.
    for (const m of ['diskStatus', 'diskFloorRefusal']) {
      expect(typeof agents[m], `agentWorkers.${m}`).toBe('function')
      expect(agents[m], `agentWorkers.${m}`).not.toBeInstanceOf(AsyncFunction)
    }
  })

  it('never calls the workflow\'s private projectOf', () => {
    const source = readFileSync(fileURLToPath(new URL('../../plugins/lead-inbox/src/brief-sources.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/workflow\.projectOf\(/)
    expect(source).toContain('workflow.projectOfRun(')
  })
})
