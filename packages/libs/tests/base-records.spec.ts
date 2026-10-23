// The Base records (PROP-0010, ADR-0037) refuse what their protocols forbid. Each case starts from
// a valid example in schemas/examples and breaks one rule.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SchemaRegistry } from '../src/index.ts'

const registry = new SchemaRegistry()
type Json = Record<string, any>
const example = (name: string): Json => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../schemas/examples/${name}.json`, import.meta.url)), 'utf8')) as Json
const valid = (tag: string, value: unknown): boolean => {
  try {
    registry.assert(tag, value)
    return true
  } catch {
    return false
  }
}
const call = (family: string, value: Json): boolean => valid(`${family}@1.0`, value)

describe('autonomy-policy@1.0', () => {
  const policy = example('autonomy-policy.studio')
  const withRule = (rule: Json) => ({ ...policy, rules: [rule] })

  it('never lets an irreversible action or an investor decision run unasked (INV-2)', () => {
    for (const actionClass of ['external-send', 'deploy', 'delete-data', 'spend', 'charter', 'funding', 'policy-change', 'promotion']) {
      expect(valid('autonomy-policy@1.0', withRule({ actionClass, mode: 'auto' })), actionClass).toBe(false)
      expect(valid('autonomy-policy@1.0', withRule({ actionClass, mode: 'notify' })), actionClass).toBe(false)
      expect(valid('autonomy-policy@1.0', withRule({ actionClass, mode: 'ask' })), actionClass).toBe(true)
    }
    expect(valid('autonomy-policy@1.0', withRule({ actionClass: 'read', mode: 'auto' }))).toBe(true)
  })

  it('fails closed for an action class no rule names (INV-2)', () => {
    expect(valid('autonomy-policy@1.0', { ...policy, default: 'auto' })).toBe(false)
    expect(valid('autonomy-policy@1.0', { ...policy, default: 'notify' })).toBe(false)
  })

  it('names the studio policy a project policy narrows, and only a project policy narrows one', () => {
    const project = example('autonomy-policy.project')
    expect(valid('autonomy-policy@1.0', project)).toBe(true)
    const { narrows: _, ...orphan } = project
    expect(valid('autonomy-policy@1.0', orphan)).toBe(false)
    expect(valid('autonomy-policy@1.0', { ...policy, narrows: 'studio-default' })).toBe(false)
  })
})

describe('approval-request@1.0', () => {
  const open: Json = (() => {
    const { batchId: _, ...request } = example('approval-request.batched')
    return { ...request, state: 'open' }
  })()
  const expired = example('approval-request.expired')

  it('approves only by an operator verdict with its approval artifact (INV-6)', () => {
    expect(valid('approval-request@1.0', { ...expired, state: 'approved' })).toBe(false)
    expect(valid('approval-request@1.0', { ...expired, state: 'approved', resolution: { ...expired.resolution, cause: 'verdict' } })).toBe(false)
    expect(valid('approval-request@1.0', { ...expired, state: 'approved', resolution: { ...expired.resolution, cause: 'verdict', approval: expired.policy.decision } })).toBe(true)
  })

  it('resolves expiry to rejected, with no approval artifact (INV-2)', () => {
    expect(valid('approval-request@1.0', expired)).toBe(true)
    expect(valid('approval-request@1.0', { ...expired, resolution: { ...expired.resolution, approval: expired.policy.decision } })).toBe(false)
  })

  it('keeps an open request unresolved and a batched one in its batch, and always has an expiry (INV-9)', () => {
    expect(valid('approval-request@1.0', open)).toBe(true)
    expect(valid('approval-request@1.0', { ...open, state: 'batched' })).toBe(false)
    expect(valid('approval-request@1.0', { ...open, resolution: expired.resolution })).toBe(false)
    const { expiresAt: _, ...unbounded } = open
    expect(valid('approval-request@1.0', unbounded)).toBe(false)
  })

  it('names the work waiting on it, so the request is withdrawn when that work ends', () => {
    expect(valid('approval-request@1.0', { ...open, requester: { component: 'board' } })).toBe(false)
    expect(valid('approval-request@1.0', { ...open, requester: { component: 'workflow', runId: 'run-1' } })).toBe(true)
  })
})

describe('approval-request@1.1 and policy-change@1.0', () => {
  const asked = example('approval-request.policy-change')
  const change = example('policy-change.applied')

  it('asks a policy change only as the queue\'s own request, naming the change it applies, on @1.1 (INV-6)', () => {
    expect(valid('approval-request@1.1', asked)).toBe(true)
    expect(valid('approval-request@1.1', { ...asked, schema: 'approval-request@1.0' })).toBe(false)
    expect(valid('approval-request@1.1', { ...asked, requester: { component: 'approvals', projectId: 'p1' } })).toBe(false)
    expect(valid('approval-request@1.1', { ...asked, requester: { component: 'board', policyChangeId: asked.requester.policyChangeId } })).toBe(false)
    expect(valid('approval-request@1.1', { ...asked, action: { ...asked.action, class: 'merge' } })).toBe(false)
    // Every other request keeps its 1.0 shape, valid at either tag.
    const { batchId: _, ...open } = example('approval-request.batched')
    expect(valid('approval-request@1.1', { ...open, state: 'open', schema: 'approval-request@1.1' })).toBe(true)
  })

  it('holds the whole set it applies, bound to its hash, and is applied only with its decision (INV-5, INV-13)', () => {
    expect(valid('policy-change@1.0', change)).toBe(true)
    const { applied: _, ...unrecorded } = change
    expect(valid('policy-change@1.0', unrecorded)).toBe(false)
    expect(valid('policy-change@1.0', { ...unrecorded, state: 'asked' })).toBe(true)
    expect(valid('policy-change@1.0', { ...change, state: 'asked' })).toBe(false)
    expect(valid('policy-change@1.0', { ...unrecorded, state: 'declined', declined: { at: change.proposedAt, cause: 'expired', decision: change.applied.decision } })).toBe(true)
    expect(valid('policy-change@1.0', { ...change, state: 'retired' })).toBe(false)
    expect(valid('policy-change@1.0', { ...change, state: 'retired', retired: change.applied })).toBe(true)
    expect(valid('policy-change@1.0', { ...change, hash: 'v2' })).toBe(false)
    expect(valid('policy-change@1.0', { ...change, policies: [] })).toBe(false)
  })

  it('records a policy change as a decision@1.6 naming the old and new set hashes (INV-13)', () => {
    const decision = example('decision.policy-change')
    expect(valid('decision@1.6', decision)).toBe(true)
    expect(valid('decision@1.6', { ...decision, schema: 'decision@1.5' })).toBe(false)
  })
})

describe('board-task@1.0', () => {
  const review = example('board-task.review')
  const waiting = example('board-task.waiting-for-approval')

  it('is done only with its run, its result subject, and an acceptance decision, and holds no lease once done', () => {
    const { holder: _, ...released } = review
    const accepted: Json = { ...released, state: 'done', result: { ...review.result, acceptance: review.lastDecision } }
    expect(valid('board-task@1.0', { ...released, state: 'done' })).toBe(false)
    expect(valid('board-task@1.0', accepted)).toBe(true)
    expect(valid('board-task@1.0', { ...accepted, holder: review.holder })).toBe(false)
    const { run: __, ...runless } = accepted
    expect(valid('board-task@1.0', runless)).toBe(false)
    const { subject: ___, ...unbound } = review.result
    expect(valid('board-task@1.0', { ...review, result: unbound })).toBe(false)
  })

  it('records the run before running, and the holder while claimed (INV-4, INV-15)', () => {
    const { run: _, ...noRun } = review
    expect(valid('board-task@1.0', { ...noRun, state: 'running' })).toBe(false)
    const { holder: __, ...noHolder } = review
    expect(valid('board-task@1.0', { ...noHolder, state: 'claimed' })).toBe(false)
  })

  it('waits for approval only on an approval request, and every wait expires (INV-9)', () => {
    expect(valid('board-task@1.0', waiting)).toBe(true)
    const { approvalRequest: _, ...noRequest } = waiting.waiting
    expect(valid('board-task@1.0', { ...waiting, waiting: noRequest })).toBe(false)
    expect(valid('board-task@1.0', { ...waiting, waiting: { ...waiting.waiting, reason: 'question' } })).toBe(false)
    const { expiresAt: __, ...unbounded } = waiting.waiting
    expect(valid('board-task@1.0', { ...waiting, waiting: unbounded })).toBe(false)
    expect(valid('board-task@1.0', { ...waiting, state: 'waiting-for-input', waiting: { ...noRequest, reason: 'question', questions: ['Which band width?'] } })).toBe(true)
    expect(valid('board-task@1.0', { ...waiting, state: 'ready' })).toBe(false)
  })

  it('names why a cancelled task was cancelled, and every move but the first names its decision (INV-13)', () => {
    expect(valid('board-task@1.0', { ...waiting, state: 'cancelled', waiting: undefined })).toBe(false)
    const { waiting: _, ...rest } = waiting
    for (const reason of ['input-expired', 'forbidden', 'dependency-cancelled']) {
      expect(valid('board-task@1.0', { ...rest, state: 'cancelled', cancellation: { reason, at: '2026-10-23T07:02:00Z' } }), reason).toBe(true)
    }
    const { lastDecision: __, ...undecided } = rest
    expect(valid('board-task@1.0', { ...undecided, state: 'ready' })).toBe(false)
    expect(valid('board-task@1.0', { ...undecided, state: 'proposed' })).toBe(true)
  })
})

describe('board-task@1.1', () => {
  const funded = example('board-task.funding')

  it('carries a spent budget\'s funding ask and its raises only at @1.1, so a reader on @1.0 never meets one', () => {
    expect(valid('board-task@1.1', funded)).toBe(true)
    expect(valid('board-task@1.0', { ...funded, schema: 'board-task@1.0' })).toBe(false)
    const { funding: _, ...asking } = funded
    expect(valid('board-task@1.0', { ...asking, schema: 'board-task@1.0' })).toBe(false)
    const { funding: __, ...plainWait } = funded.waiting
    expect(valid('board-task@1.0', { ...funded, schema: 'board-task@1.0', waiting: plainWait })).toBe(false)
    expect(valid('board-task@1.1', { ...asking, waiting: plainWait })).toBe(true)
  })

  it('asks for funding only on a budget-spent wait, for at least one line, and names each raise\'s approval and decision (INV-5, INV-13)', () => {
    expect(valid('board-task@1.1', { ...funded, waiting: { ...funded.waiting, reason: 'reconciliation-failed' } })).toBe(false)
    expect(valid('board-task@1.1', { ...funded, waiting: { ...funded.waiting, funding: [] } })).toBe(false)
    const { approval: _, ...unapproved } = funded.funding[0]
    expect(valid('board-task@1.1', { ...funded, funding: [unapproved] })).toBe(false)
    const { decision: __, ...undecided } = funded.funding[0]
    expect(valid('board-task@1.1', { ...funded, funding: [undecided] })).toBe(false)
    expect(valid('board-task@1.1', { ...funded, funding: [{ ...funded.funding[0], lines: [] }] })).toBe(false)
  })
})

describe('project@1.0', () => {
  const project = example('project.active')

  it('is active only under an approved charter, and closed only with its closure', () => {
    const { approval: _, ...unapproved } = project.charter
    expect(valid('project@1.0', { ...project, charter: unapproved })).toBe(false)
    expect(valid('project@1.0', { ...project, state: 'proposed', charter: unapproved })).toBe(true)
    expect(valid('project@1.0', { ...project, state: 'closed' })).toBe(false)
    expect(valid('project@1.0', { ...project, state: 'closed', closure: { outcome: 'achieved', decision: project.lastDecision, at: '2026-11-05T17:00:00Z' } })).toBe(true)
  })

  it('needs stop rules and a budget by pool before funds are released, and funds a milestone by approval', () => {
    expect(valid('project@1.0', { ...project, charter: { ...project.charter, stopRules: [] } })).toBe(false)
    expect(valid('project@1.0', { ...project, charter: { ...project.charter, budget: { pools: [] } } })).toBe(false)
    const [m1, ...others] = project.milestones
    const { funding: _, ...unfunded } = m1
    expect(valid('project@1.0', { ...project, milestones: [unfunded, ...others] })).toBe(false)
  })
})

describe('usage-record@1.0 and limit-state@1.0', () => {
  const usage = example('usage-record.api-call')
  const limit = example('limit-state.five-hour')

  it('counts tokens or turns, and keeps the price version a cost was computed with', () => {
    const { usage: _, ...nothing } = usage
    expect(valid('usage-record@1.0', nothing)).toBe(false)
    expect(valid('usage-record@1.0', { ...nothing, turns: 1, cost: undefined })).toBe(true)
    expect(valid('usage-record@1.0', { ...usage, cost: { amount: 1, currency: 'USD', basis: 'price-table' } })).toBe(false)
    expect(valid('usage-record@1.0', { ...usage, source: 'model-self-report' })).toBe(false)
  })

  it('tolerates a reading without its percentage or reset, but a limit hit says until when', () => {
    const { usedPercentage: _, resetsAt: __, ...bare } = limit
    expect(valid('limit-state@1.0', bare)).toBe(true)
    expect(valid('limit-state@1.0', { ...bare, state: 'limited' })).toBe(false)
    expect(valid('limit-state@1.0', { ...bare, state: 'limited', resetsAt: '2026-10-22T13:00:00Z' })).toBe(true)
  })
})

describe('brief@1.0 and digest@1.0', () => {
  const brief = example('brief.task')
  const digest = example('digest.test-run')

  it('points at artifacts by content id and never carries their content (INV-12)', () => {
    expect(valid('brief@1.0', { ...brief, artifacts: [{ ...brief.artifacts[0], content: 'the charter text' }] })).toBe(false)
    expect(valid('brief@1.0', { ...brief, artifacts: [{ ...brief.artifacts[0], ref: 'charter.md' }] })).toBe(false)
  })

  it('names the workspace a writing run is confined to', () => {
    const { workspace: _, ...sandbox } = brief.sandbox
    expect(valid('brief@1.0', { ...brief, sandbox })).toBe(false)
    expect(valid('brief@1.0', { ...brief, sandbox: { ...sandbox, mode: 'read-only' } })).toBe(true)
  })

  it('1.1 places pointers in its instructions by index, never content, and refuses instructions before 1.1 (INV-14)', () => {
    const node = example('brief.node')
    expect(valid('brief@1.1', node)).toBe(true)
    expect(valid('brief@1.1', { ...node, schema: 'brief@1.0' })).toBe(false)
    expect(valid('brief@1.1', { ...node, instructions: [{ text: 'a' }, { artifact: 0, text: 'the report' }] })).toBe(false)
    expect(valid('brief@1.1', { ...node, instructions: [{ artifact: 64 }] })).toBe(false)
    expect(valid('brief@1.1', { ...node, instructions: [{ text: '' }] })).toBe(false)
    expect(valid('brief@1.1', { ...brief, schema: 'brief@1.1' })).toBe(true)
  })

  it('1.2 offers the Worker a bounded way to ask instead of answering, and refuses it before 1.2 (INV-9, INV-14)', () => {
    const attempt = example('brief.task-attempt')
    expect(valid('brief@1.2', attempt)).toBe(true)
    expect(valid('brief@1.2', { ...attempt, schema: 'brief@1.1' })).toBe(false)
    expect(valid('brief@1.2', { ...attempt, ask: { maxQuestions: 9 } })).toBe(false)
    expect(valid('brief@1.2', { ...attempt, ask: { maxQuestions: 0 } })).toBe(false)
    expect(valid('brief@1.2', { ...attempt, ask: {} })).toBe(false)
    // Its files stay under .system/, one name each, pointed at by content id.
    for (const path of ['TASKS.md', '.system/../x.md', '.system/a/b.md', '.system/.gitignore', '/tmp/x.md']) {
      expect(valid('brief@1.2', { ...attempt, files: [{ ...attempt.files[0], path }] }), path).toBe(false)
    }
    expect(valid('brief@1.2', { ...attempt, files: [{ ...attempt.files[0], ref: 'TASKS.md' }] })).toBe(false)
    expect(valid('brief@1.2', { ...attempt, files: Array.from({ length: 5 }, () => attempt.files[0]) })).toBe(false)
    const { ask: _, files: __, ...plain } = attempt
    expect(valid('brief@1.2', { ...plain, schema: 'brief@1.1' })).toBe(true)
    expect(valid('brief@1.2', { ...plain, files: attempt.files, schema: 'brief@1.1' })).toBe(false)
    expect(valid('board-projection@1.0', example('board-projection.tasks-md'))).toBe(true)
  })

  it('cites one artifact with a verbatim quote for every claim (INV-13)', () => {
    const [claim] = digest.claims
    const { quote: _, ...unquoted } = claim.citation
    expect(valid('digest@1.0', { ...digest, claims: [{ ...claim, citation: unquoted }] })).toBe(false)
    const { citation: __, ...uncited } = claim
    expect(valid('digest@1.0', { ...digest, claims: [uncited] })).toBe(false)
  })
})

describe('plugin-manifest@1.0', () => {
  const manifest = example('plugin-manifest.digest-provider')

  it('is either a core component or a plugin family, never both', () => {
    expect(valid('plugin-manifest@1.0', { ...manifest, class: { kind: 'core', component: 'gate', family: 'digest' } })).toBe(false)
    expect(valid('plugin-manifest@1.0', { ...manifest, class: { kind: 'family' } })).toBe(false)
  })

  it('keeps the lifecycle in the host-owned _meta, with a share only for a canary', () => {
    expect(valid('plugin-manifest@1.0', { ...manifest, lifecycle: 'default' })).toBe(false)
    expect(valid('plugin-manifest@1.0', { ...manifest, _meta: { lifecycle: { ...manifest._meta.lifecycle, state: 'default' } } })).toBe(false)
    const { share: _, ...lifecycle } = manifest._meta.lifecycle
    expect(valid('plugin-manifest@1.0', { ...manifest, _meta: { lifecycle: { ...lifecycle, state: 'default' } } })).toBe(true)
  })

  it('plugin-manifest@1.1 adds the seams a definition package defines, refused before 1.1 (INV-14)', () => {
    const definition = example('plugin-manifest.definition')
    expect(valid('plugin-manifest@1.1', definition)).toBe(true)
    expect(valid('plugin-manifest@1.0', { ...definition, schema: 'plugin-manifest@1.0' })).toBe(false)
    expect(valid('plugin-manifest@1.1', { ...definition, defines: [] })).toBe(false)
    expect(valid('plugin-manifest@1.1', { ...manifest, schema: 'plugin-manifest@1.1' })).toBe(true)
  })
})

describe('minor versions of existing records', () => {
  it('agent-result@1.2 adds the model and token usage, refused before 1.2 (INV-14)', () => {
    const result = example('agent-result.usage')
    expect(valid('agent-result@1.2', result)).toBe(true)
    expect(valid('agent-result@1.1', { ...result, schema: 'agent-result@1.1' })).toBe(false)
    expect(valid('agent-result@1.0', example('agent-result.review'))).toBe(true)
  })

  it('decision@1.4 adds the autonomy, approval, board, and budget decisions, refused before 1.4 (INV-14)', () => {
    const decision = example('decision.approval-expired')
    expect(valid('decision@1.4', decision)).toBe(true)
    expect(valid('decision@1.3', { ...decision, schema: 'decision@1.3' })).toBe(false)
    expect(valid('decision@1.4', { ...example('decision.retention'), schema: 'decision@1.4' })).toBe(false)
  })

  it('decision@1.5 adds the plugin host\'s lifecycle decision, refused before 1.5 (INV-13, INV-14)', () => {
    const decision = example('decision.lifecycle')
    expect(valid('decision@1.5', decision)).toBe(true)
    expect(valid('decision@1.4', { ...decision, schema: 'decision@1.4' })).toBe(false)
    expect(valid('decision@1.5', { ...example('decision.approval-expired'), schema: 'decision@1.5' })).toBe(false)
  })
})

describe('MCP tool calls', () => {
  it('never takes a charter approval from a tool call (INV-6)', () => {
    const charter = example('mcp-board.charter')
    expect(call('mcp-board', charter)).toBe(true)
    expect(call('mcp-board', { ...charter, input: { ...charter.input, charter: { ...charter.input.charter, approval: example('project.active').charter.approval } } })).toBe(false)
  })

  it('binds every verdict to the exact subject the operator saw (INV-5)', () => {
    const decide = example('mcp-approvals.decide')
    const { subject: _, ...unbound } = decide.input.verdicts[0]
    expect(call('mcp-approvals', { ...decide, input: { verdicts: [unbound] } })).toBe(false)
  })

  it('takes a policy change as one autonomy-policy record, and answers with the change and its request', () => {
    const propose = example('mcp-approvals.policy-propose')
    expect(call('mcp-approvals', propose)).toBe(true)
    expect(call('mcp-approvals', { ...propose, input: { policy: { ...propose.input.policy, default: 'auto' } } })).toBe(false)
    expect(call('mcp-approvals', { ...propose, input: { policies: [propose.input.policy] } })).toBe(false)
    const { request: _, ...unasked } = propose.output
    expect(call('mcp-approvals', { ...propose, output: unasked })).toBe(false)
  })

  it('takes a digest request of raw artifacts by content id only, and answers with the request as it stands', () => {
    const request = example('mcp-digests.request')
    expect(call('mcp-digests', request)).toBe(true)
    expect(call('mcp-digests', { ...request, input: { ...request.input, sources: ['the test log'] } })).toBe(false)
    expect(call('mcp-digests', { ...request, input: { ...request.input, sources: [] } })).toBe(false)
    expect(call('mcp-digests', { ...request, output: { ...request.output, state: 'accepted' } })).toBe(false)
    expect(call('mcp-digests', { tool: 'digests_get', input: { requestId: request.output.requestId }, output: request.output })).toBe(true)
  })

  it('names a report\'s period by since or by days, never both and at most 366 days, and answers with counts only (INV-9, INV-14)', () => {
    const week = example('mcp-report.week')
    expect(call('mcp-report', week)).toBe(true)
    expect(call('mcp-report', { ...week, input: { ...week.input, since: '2026-10-01T00:00:00Z' } })).toBe(false)
    expect(call('mcp-report', { ...week, input: { days: 367 } })).toBe(false)
    expect(call('mcp-report', { ...week, input: { since: 'last week' } })).toBe(false)
    expect(call('mcp-report', { ...week, output: { ...week.output, tasks: { ...week.output.tasks, done: -1 } } })).toBe(false)
    expect(call('mcp-report', { ...week, output: { ...week.output, summary: 'written by a model' } })).toBe(false)
  })

  it('checks a call against its own tool, not another', () => {
    const claim = example('mcp-board.claim')
    expect(call('mcp-board', { ...claim, tool: 'board_cancel' })).toBe(false)
    expect(call('mcp-board', { ...claim, tool: 'board_unknown' })).toBe(false)
  })
})
