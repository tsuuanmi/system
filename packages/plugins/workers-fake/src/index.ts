/**
 * The `fake` Worker source (T323): scripted Workers for the `system-test` profile, so its canary
 * runs `ask`, `research`, and a board task through `algorithm-development` without a website or an
 * agent account. Each execution completes on the next turn of the event loop with a scripted answer
 * (and, for a board task's writing step, its evidence entry): an approving review for a step that names a
 * subject, a vote on every important finding a verification step is given, and otherwise the prompt
 * echoed. Nothing leaves the process (no network, no account, no model), and nothing is kept past
 * it: a restart forgets its executions, which suits a profile that is only ever staged. It is off in
 * the bundle; only the test profile turns it on.
 * @module @tsuuanmi/system-workers-fake
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@tsuuanmi/system-ledger-core'
import { sha256, startPrompt } from '@tsuuanmi/system-libs'
import type { ArtifactRef, CapabilityDescriptor, Tier, WorkerExecution, WorkerSource, WorkerStart } from '@tsuuanmi/system-workers-core'

export const name = 'workers-fake'
export const inject = ['artifacts', 'workers']

const SOURCE = 'fake'
const PROVES = ['reason', 'develop']
const TIERS: readonly Tier[] = ['economy', 'standard', 'frontier']

/** What each fake Worker proves: one per tier for `reason` and `develop`, then the roles a team or a review needs. */
const WORKERS: ReadonlyArray<{ id: string; tier: Tier; proves: string[] }> = [
  ...TIERS.map((tier) => ({ id: `fake:${tier}`, tier, proves: PROVES })),
  { id: 'fake:developer', tier: 'standard', proves: ['reason', 'develop', 'local-data', 'persistent-conversation', 'dossier', 'review'] },
  { id: 'fake:reviewer', tier: 'standard', proves: ['review', 'local-data'] },
  { id: 'fake:reviewer-2', tier: 'standard', proves: ['review', 'local-data'] },
]

/** A verification step's answer: a `confirm` on every important finding it lists, naming the subject it was given. */
function verification(prompt: string): string | undefined {
  if (!prompt.includes('## Verify these findings')) return undefined
  const subject = /^Verified subject: (\S+)$/m.exec(prompt)?.[1]
  const votes = [...prompt.matchAll(/^- (f\d+) important:/gm)].map((m) => ({ finding: m[1], vote: 'confirm', reason: 'scripted confirm' }))
  return '```json\n' + JSON.stringify({ subject, votes }) + '\n```'
}

/** The scripted answer to a rendered prompt. */
export function answerTo(prompt: string): string {
  const voted = verification(prompt)
  if (voted !== undefined) return voted
  const subject = /^Subject: (\S+)$/m.exec(prompt)?.[1]
  if (subject) return '```json\n' + JSON.stringify({ subject, verdict: 'approve', findings: [{ severity: 'nit', title: 'nothing to change', file: 'README.md' }] }) + '\n```'
  return `answer: ${prompt.slice(0, 80)}`
}

/** The evidence a fake writing step shows: it runs no command, and says so in the shape the gate reads. */
export const EVIDENCE = '$ (no command: a fake Worker runs none)\nThe fake Worker answered from its script for the stage canary (T323); no check ran, since none can on a fake Worker.'

/** The part of `ctx.workflow` the fake uses: a step's Worker's own dossier entry (ADR-0070). */
interface Dossiers {
  appendToDossier(caller: { runId: string; nodeId: string; execution: string }, input: { kind: 'evidence'; text: string }): unknown
}

/**
 * The fake source over `ctx`: Workers described at the time of each read, executions held in memory.
 * An execution completes on the next turn of the event loop, not at its start, so the engine has
 * recorded it as its step's execution by then: when the step is a writing step of a board task's run,
 * the fake first appends its {@link EVIDENCE} to the task's dossier, as a writing Worker does, so the
 * step's evidence gate passes on what the fake really did (nothing). For any other step the engine
 * refuses that entry, and the fake goes on without it.
 */
export function fakeSource(ctx: Context): WorkerSource {
  const executions = new Map<string, WorkerExecution>()
  const keys = new Map<string, string>()
  const sessions = new Map<string, { worker: string; handle: string }>()
  const waiters = new Map<string, Set<() => void>>()
  const pending = new Set<NodeJS.Immediate>()
  ctx.effect(() => () => {
    for (const timer of pending) clearImmediate(timer)
    pending.clear()
  })
  const finish = (start: WorkerStart, id: string, prompt: string): void => {
    const workflow = ctx.get('workflow') as Dossiers | undefined
    if (workflow && start.runId && start.step) {
      try {
        workflow.appendToDossier({ runId: start.runId, nodeId: start.step.node, execution: id }, { kind: 'evidence', text: EVIDENCE })
      } catch {
        // Not a writing step of a board task's run: it shows no evidence, and the engine asks none.
      }
    }
    const result = ctx.artifacts.put({
      kind: 'report', bodySchema: 'provider-answer@1.0', classification: start.requirement.data.classification, producer: { type: 'worker', ref: start.worker },
      body: { schema: 'provider-answer@1.0', provider: SOURCE, account: SOURCE, turnId: id, conversation: { mode: 'temporary' }, promptHash: sha256(prompt), text: answerTo(prompt) },
    }).id as ArtifactRef
    executions.set(id, { id, status: 'completed', submitted: true, result, decisions: [] })
    for (const wake of waiters.get(id) ?? []) wake()
    waiters.delete(id)
  }
  return {
    name: SOURCE,
    describe: async () => {
      const at = new Date().toISOString()
      return WORKERS.map((w): CapabilityDescriptor => ({
        schema: 'capability-descriptor@1.0', worker: w.id, provider: SOURCE, tier: w.tier, quotaClass: 'local', locality: 'local',
        capabilities: w.proves.map((capability) => ({ capability, evidence: { kind: 'conformance', at } })),
        state: 'ready', observedAt: at,
      }))
    },
    start: (start: WorkerStart): WorkerExecution => {
      const known = keys.get(start.key)
      if (known) return { ...executions.get(known)! }
      const { prompt } = startPrompt(start, (ref) => ctx.artifacts.get(ref), {})
      const id = `fake-${executions.size + 1}`
      if (start.sessionId && !sessions.has(start.sessionId)) sessions.set(start.sessionId, { worker: start.worker, handle: `fake-session-${start.sessionId}` })
      const execution: WorkerExecution = { id, status: 'running', submitted: true, decisions: [] }
      executions.set(id, execution)
      keys.set(start.key, id)
      const timer = setImmediate(() => {
        pending.delete(timer)
        finish(start, id, prompt)
      })
      pending.add(timer)
      return { ...execution }
    },
    get: (id) => {
      const execution = executions.get(id)
      return execution && { ...execution }
    },
    wait: (id, timeoutMs) => {
      const execution = executions.get(id)
      if (!execution || execution.status !== 'running') return Promise.resolve({ ...execution! })
      return new Promise((resolve) => {
        const set = waiters.get(id) ?? new Set()
        waiters.set(id, set)
        const done = (): void => {
          clearTimeout(timer)
          set.delete(done)
          resolve({ ...executions.get(id)! })
        }
        const timer = setTimeout(done, timeoutMs)
        timer.unref()
        set.add(done)
      })
    },
    cancel: () => false,
    affinity: (sessionId) => {
      const session = sessions.get(sessionId)
      return session ? [session.worker] : undefined
    },
    handle: (sessionId) => sessions.get(sessionId)?.handle,
    reset: (sessionId) => sessions.has(sessionId),
  }
}

export function apply(ctx: Context): void {
  ctx.workers.register(fakeSource(ctx))
}
