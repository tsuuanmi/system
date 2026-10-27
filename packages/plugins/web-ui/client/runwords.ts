// A run in words: its progress, its state, why it failed or needs a look, a step's name, and where a running run is now.
import type { Failure, LiveResponse, LiveRun, RunSummary } from '../src/api.js'
import { chip, clockOf, el, relative } from './dom.js'
import { api, asApiError } from './state.js'

/** A step's id as a person reads it: a team's steps by member ("member 1's answer"), the id beside it. */
export const stepWords = (nodeId: string): string | null => {
  const m = /^(.+):m(\d+):(propose|ballot:\d+)$/.exec(nodeId)
  if (m) return 'team member ' + m[2] + (m[3] === 'propose' ? '\'s answer' : '\'s vote')
  return /^(.+):tally:\d+$/.test(nodeId) ? 'the team\'s count of the votes' : null
}
export const stepName = (nodeId: string): string => stepWords(nodeId) ?? nodeId
/** "Team member 1's answer" / "Step id": a step as a sentence starts. */
export const stepStart = (nodeId: string): string => { const w = stepWords(nodeId); return w ? w.charAt(0).toUpperCase() + w.slice(1) : 'Step ' + nodeId }

/** A run's progress in one line: "2/3 steps", then the steps that failed, wait, or run, by name. */
export const stepsText = (run: RunSummary): string => {
  const named = (state: string) => run.nodes.filter((n) => n.state === state).map((n) => stepName(n.nodeId)), list = (ids: string[]) => ids.slice(0, 2).join(', ') + (ids.length > 2 ? ' and ' + (ids.length - 2) + ' more' : '')
  const parts = [named('COMPLETED').length + '/' + run.nodes.length + ' steps']
  for (const [state, word] of [['FAILED', 'failed'], ['BLOCKED', 'waiting'], ['RUNNING', 'running']] as const) if (named(state).length) parts.push(word + ': ' + list(named(state)))
  return parts.join(' · ')
}
const RUN_STATE: Record<string, [string, string]> = { running: ['Running', 'info'], completed: ['Completed', 'ok'], failed: ['Failed', 'bad'] }
export const runChip = (run: RunSummary): HTMLElement => {
  if (run.blocked) return chip('Needs your attention', 'warn')
  const [word, tone] = RUN_STATE[run.status] ?? [run.status, 'idle']
  return chip(word, tone)
}
const DISPOSITION: Record<string, string> = { USER_ACTION: 'it needs you', BACKOFF: 'it is tried again later', CODE_FIX: 'it needs a fix in the code or configuration', NONE: 'nothing more happens' }
const KIND_WORDS: Record<string, string> = {
  reauth_required: 'its account must sign in again', quota_exhausted: 'its account used up its quota', overloaded: 'the site was busy, or answered with its own error',
  timeout: 'it took longer than its limit', session_broken: 'its conversation broke off', provider_stalled: 'its Worker stopped answering', network: 'the network failed',
  challenge: 'the site asked for a human check', config_error: 'something is set up wrong', no_worker: 'no Worker could take it', stopped: 'you stopped it',
  plan_rejected: 'its plan was denied', budget_spent: 'its budget is spent', holder_lost: 'it lost its hold on the task', internal: 'the system failed inside',
}
/** A failure's reason in plain words, from its kind and its disposition. */
export const failureReason = (error: Partial<Failure>): string | null => {
  const kind = error.kind ? KIND_WORDS[error.kind] : undefined, next = error.disposition ? DISPOSITION[error.disposition] : undefined
  return kind ? kind + (next ? ' (' + next + ')' : '') : next ?? null
}
/** The same plain-words reason, then the system's own message. */
export const failureText = (error: Failure): string => { const reason = failureReason(error); return reason ? reason + ' — ' + error.message : error.message }
/** Why a run needs the operator's attention, as a label and, for a failure, its reason in plain words; or nothing. */
export const lookOf = (run: RunSummary): [label: string, why: string] | null =>
  run.blocked ? [run.blocked.kind === 'tie' ? 'Team vote tied' : run.blocked.kind === 'tool-call' ? 'Tool call awaiting approval' : run.blocked.approvalRequest ? 'Fix awaiting approval' : 'Plan awaiting approval', '']
    : run.status === 'failed' ? ['Run failed', run.error ? failureText(run.error) : 'no reason was recorded'] : null
export const needsLook = (run: RunSummary): string | null => { const l = lookOf(run); return l ? l[0] + (l[1] ? ' — ' + l[1] : '') : null }

// A running run as it moves (T124): its steps, their Workers and for how long, its last event, and a stall its source told.
const EVENT_WORDS: Record<string, string> = {
  'workflow.node.started': 'a step started', 'workflow.node.completed': 'a step finished', 'workflow.node.retry': 'a step is tried again', 'workflow.node.waiting': 'a step waits',
  'workflow.node.resent': 'a step is sent again in a new conversation',
  'workflow.node.blocked': 'a step waits for you', 'agent-workers.tool.notified': 'a tool call ran', 'agent-workers.tool.checks-pending': 'a tool call ran, its checks pending',
  'agent-workers.tool.denied': 'a tool call was denied', 'agent-workers.tool.deferred': 'a tool call waits for your verdict', 'agent-workers.tool.web': 'a web call was judged', 'agent-workers.run.stalled': 'its agent stalled',
}
export type Moving = { runs: Map<string, LiveRun> } | { unknown: string }
/** The running runs as they move, by id, or why they are unknown: a failed read is never shown as nothing running (T127). */
export const liveOf = async (): Promise<Moving> => {
  try {
    const { runs } = await api<LiveResponse>('runs/live')
    return 'value' in runs ? { runs: new Map(runs.value.map((r) => [r.runId, r])) } : { unknown: runs.unknown }
  } catch (error) { return { unknown: asApiError(error).message } }
}
export const liveRun = (moving: Moving | undefined, runId: string | undefined): LiveRun | undefined => moving && 'runs' in moving && runId ? moving.runs.get(runId) : undefined
export const lastText = (r: LiveRun): string => 'value' in r.lastEvent ? 'last event: ' + (EVENT_WORDS[r.lastEvent.value.type] ?? r.lastEvent.value.type) + ', ' + relative(r.lastEvent.value.at) : 'last event unknown (' + r.lastEvent.unknown + ')'
export const stalledOf = (r: LiveRun): HTMLElement | null => 'value' in r.stalled && r.stalled.value
  ? el('div', { class: 'state failed', role: 'alert' }, 'Stalled since ' + clockOf(r.stalled.value.since) + ': no activity past its source\'s bound. Stop run ends it.') : null
