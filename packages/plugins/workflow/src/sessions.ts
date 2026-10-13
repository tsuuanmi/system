/**
 * Wake-on-message and long-running sessions (docs/design/sessions-and-messaging.md, REQ-SES-6):
 * an idle session takes one turn on its unread mail, its reply goes to the peers who wrote, and
 * past its budget it writes a handoff summary and continues in a fresh conversation.
 */
import { sha256 } from '@tsuuanmi/system-libs'
import { type Delivered, EXTERNAL_SENDERS } from '@tsuuanmi/system-worker-sessions'
import type { Engine } from './engine.ts'
import type { RunView } from './types.ts'

/**
 * Messages as prompt text, each under its sender's label and between fence lines derived from all
 * the bodies. A body cannot close its fence or pass as another sender's message (a client writing
 * a forged `### From [operator]` header), because the fence depends on that very body.
 */
export function messagesText(e: Engine, inbox: Delivered[], intent: string): string {
  const fence = sha256(inbox.map((m) => m.message.body).join('\0')).slice(-16)
  return inbox.map((m) => `### From [${e.ctx.workerSessions.session(m.from)?.role ?? m.from}] (${m.message.intent ?? intent}), between the lines ${fence}:\n${fence}\n${m.message.body}\n${fence}`).join('\n\n')
}

/** A rough token count of session context (no tokenizer for website models). */
const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/**
 * Wake-on-message (docs/design/sessions-and-messaging.md): an idle session with unread messages
 * takes one turn on them, on its own session and Worker (Model A), as an `ask` run. Its reply
 * goes back to the peers who wrote; the operator reads it as the run's answer. A session in a
 * running team is not woken: its rounds read the inbox. One wake per session at a time, and
 * one per (session, last message), so a repeated delivery starts nothing new.
 */
export function wake(e: Engine, sessionId: string): RunView | undefined {
  if (e.draining || e.stopped.signal.aborted) return undefined
  const sessions = e.ctx.workerSessions
  return e.ctx.store.transaction((db) => {
    const session = sessions.session(sessionId)
    if (!session || (session.state !== 'IDLE' && session.state !== 'INPUT_REQUIRED')) return undefined
    if (session.runId && e.get(session.runId)?.status === 'running') return undefined
    if (db.prepare('SELECT 1 FROM workflow_wakes WHERE session_id = ? AND done = 0').get(sessionId)) return undefined
    const inbox = sessions.inbox(sessionId)
    if (!inbox.length) return undefined
    // After a compaction the next turn opens a fresh conversation; until it binds, the last handle stands.
    if (!sessions.activate(sessionId, e.ctx.workers.handle(sessionId) ?? session.binding.nativeHandle).activated) return undefined
    const through = inbox.at(-1)!.seq
    const replyTo = [...new Set(inbox.map((m) => m.from).filter((from) => !EXTERNAL_SENDERS.includes(from) && from !== sessionId))]
    const handoff = db.prepare('SELECT artifact FROM session_handoffs WHERE session_id = ?').get(sessionId) as { artifact: string } | undefined
    const summary = handoff ? (e.ctx.artifacts.get(handoff.artifact)?.body as { summary?: string } | undefined)?.summary : undefined
    const prompt = [
      ...(summary ? [`You continue a long-running session. Your earlier conversation was compacted into this handoff summary:\n<handoff>\n${summary}\n</handoff>`] : []),
      `Messages for you (${session.role}), in order:`,
      messagesText(e, inbox, 'request'),
      replyTo.length ? 'Reply to them. Your reply is sent to each peer who wrote.' : 'Reply to them.',
      'If you cannot go on without input from the operator or a peer, start your reply with a line `INPUT_REQUIRED: <your question>`.',
    ].join('\n\n')
    const run = e.start({ template: 'ask', input: prompt, sessionId, clientRequestId: `wake:${sessionId}:${through}`, classification: 'operator-shared' })
    db.prepare("INSERT OR IGNORE INTO workflow_wakes (run_id, session_id, through_seq, reply_to, kind) VALUES (?, ?, ?, ?, 'wake')").run(run.runId, sessionId, through, JSON.stringify(replyTo))
    if (handoff) db.prepare('DELETE FROM session_handoffs WHERE session_id = ?').run(sessionId)
    return run
  })
}

export function wakeSafely(e: Engine, sessionId: string): void {
  try {
    wake(e, sessionId)
  } catch (error) {
    e.ctx.logger.warn(`workflow: could not wake session ${sessionId}: ${(error as Error).message}`)
  }
}

/**
 * A wake run finished: post the reply to the peers (an answer wakes nobody; a question the
 * session cannot go on without is `input-required`), acknowledge, settle. Then the session's
 * long-running bounds (REQ-SES-6): a checkpoint every few turns, and a compaction once its
 * context is past the threshold. A compaction run finished: store the handoff and continue the
 * session in a fresh conversation from it.
 */
export function settleWake(e: Engine, runId: string): void {
  const wake = e.ctx.store.db.prepare('SELECT session_id, through_seq, reply_to, kind FROM workflow_wakes WHERE run_id = ? AND done = 0').get(runId) as { session_id: string; through_seq: number; reply_to: string; kind: string } | undefined
  if (!wake) return
  const sessions = e.ctx.workerSessions
  const run = e.get(runId)
  const answer = run?.status === 'completed' ? run.answer?.trim() ?? '' : ''
  const result = run?.status === 'completed' ? e.records(runId).at(-1)?.outputReceipt?.result : undefined
  let compactNow = false
  e.ctx.store.transaction((db) => {
    if (wake.kind === 'compaction') {
      if (answer && result) {
        const session = sessions.session(wake.session_id)!
        const handoff = e.ctx.artifacts.put({
          kind: 'handoff', bodySchema: 'session-summary@1.0', inputs: [result], classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' },
          body: { schema: 'session-summary@1.0', sessionId: wake.session_id, reason: 'compaction', turns: session.usage?.turns ?? 0, generation: session.binding.generation,
            estimatedTokens: session.usage?.estimatedTokens ?? 0, summary: answer.slice(0, 32_000), refs: [result] },
        }).id
        sessions.settle(wake.session_id)
        e.ctx.workers.reset(wake.session_id)
        sessions.rebind(wake.session_id, estimateTokens(answer))
        db.prepare('INSERT OR REPLACE INTO session_handoffs (session_id, artifact) VALUES (?, ?)').run(wake.session_id, handoff)
      } else {
        sessions.settle(wake.session_id)
      }
    } else {
      const inputRequired = /^\s*INPUT_REQUIRED:/m.test(answer)
      if (answer) {
        for (const peer of JSON.parse(wake.reply_to) as string[]) {
          sessions.send({ from: wake.session_id, messageId: `wake:${runId}`, to: { session: peer }, intent: inputRequired ? 'input-required' : 'answer', body: answer.length > 32_000 ? `${answer.slice(0, 31_900)}\n…(truncated)` : answer })
        }
      }
      // A failed wake is acknowledged too: the failure is the run's, and the message is not retried in a loop.
      sessions.ack(wake.session_id, wake.through_seq)
      const handle = e.ctx.workers.handle(wake.session_id)
      const settled = sessions.settle(wake.session_id, { inputRequired, tokens: estimateTokens(`${e.runRow(runId)?.input ?? ''}${answer}`), ...(handle ? { nativeHandle: handle } : {}) })
      const turns = settled.usage?.turns ?? 0
      if (answer && result && settled.budgets.checkpointEveryTurns && turns % settled.budgets.checkpointEveryTurns === 0) {
        e.ctx.artifacts.put({
          kind: 'report', bodySchema: 'session-summary@1.0', inputs: [result], classification: 'operator-shared', producer: { type: 'system', ref: 'workflow' },
          body: { schema: 'session-summary@1.0', sessionId: wake.session_id, reason: 'checkpoint', turns, generation: settled.binding.generation,
            estimatedTokens: settled.usage?.estimatedTokens ?? 0, summary: answer.slice(0, 4000), refs: [result] },
        })
      }
      compactNow = !inputRequired && (settled.usage?.estimatedTokens ?? 0) >= (settled.budgets.compactAtTokens ?? Number.POSITIVE_INFINITY)
    }
    db.prepare('UPDATE workflow_wakes SET done = 1 WHERE run_id = ?').run(runId)
  })
  // Messages that arrived during the turn wake it again, after a compaction if one is due.
  e.ctx.store.afterCommit(() => (compactNow ? compact(e, wake.session_id) : wakeSafely(e, wake.session_id)))
}

/** Compaction (REQ-SES-6): the session writes its own handoff summary, in its own conversation, as one more turn. */
function compact(e: Engine, sessionId: string): void {
  try {
    e.ctx.store.transaction((db) => {
      const session = e.ctx.workerSessions.session(sessionId)
      if (!session || e.draining || e.stopped.signal.aborted) return
      if (!e.ctx.workerSessions.activate(sessionId, e.ctx.workers.handle(sessionId) ?? session.binding.nativeHandle).activated) return
      const run = e.start({
        template: 'ask', sessionId, classification: 'operator-shared', clientRequestId: `compact:${sessionId}:${session.binding.generation}`,
        input: 'Your context is getting long. Write a handoff summary for yourself to continue from: the decisions made, the open questions, the current state, and anything a peer is waiting on. Be complete but concise; this summary replaces the conversation.',
      })
      db.prepare("INSERT OR IGNORE INTO workflow_wakes (run_id, session_id, through_seq, reply_to, kind) VALUES (?, ?, 0, '[]', 'compaction')").run(run.runId, sessionId)
    })
  } catch (error) {
    e.ctx.logger.warn(`workflow: could not compact session ${sessionId}: ${(error as Error).message}`)
  }
}

/**
 * On start: a wake whose run finished before the reply was posted (a crash) is settled now; then
 * any session with unread mail is woken, so a message sent while the host was down is answered.
 */
export function recoverWakes(e: Engine): void {
  const wakes = e.ctx.store.db.prepare("SELECT w.run_id FROM workflow_wakes w JOIN workflow_runs r ON r.run_id = w.run_id WHERE w.done = 0 AND r.status != 'running'").all() as Array<{ run_id: string }>
  for (const { run_id } of wakes) settleWake(e, run_id)
  for (const id of e.ctx.workerSessions.pending()) wakeSafely(e, id)
}
