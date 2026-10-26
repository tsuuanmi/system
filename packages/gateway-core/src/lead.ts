/**
 * The lead principal's rights (ADR-0076, PROP-0016 §7 and I2): each project's lead acts on its own
 * token (`@tsuuanmi/system-libs` holds the token files), and what it may decide is a closed list,
 * checked by the code that records each decision ({@link leadMayDecide}), never by the lead's own
 * scripts.
 */
import { leadId } from '@tsuuanmi/system-libs'

export { issueLeadToken, LEAD_PROJECT, leadId, leadTokenFile, leadTokens, listLeads, revokeLeadToken } from '@tsuuanmi/system-libs'

/**
 * The lead's rights, a closed list (PROP-0016 §7, ADR-0076). Anything not on it is refused for a
 * lead token, and stays the operator's: policy and charter changes, merges or pushes to a protected
 * branch, deploys beyond the dev live update, security alert dismissals, external sends, issuing tokens.
 */
export const LEAD_RIGHTS = [
  'approve or deny a command or a dispatch start of its project',
  'accept or reject a result that lands on one of its project\'s listed dev branches',
  'approve a merge into one of its project\'s listed dev branches',
  'move its project\'s board tasks and answer Workers',
] as const

/** What a lead is asked to decide, as the decision's own record says it. */
export interface LeadDecision {
  /** The project whose lead decides. */
  project: string
  /** The project of the thing decided (a request's requester, a task's board project); undefined when it names none. */
  of: string | undefined
  /** The action class of an approval request, or `acceptance` for a result under review. */
  action: string
  /** The branch the thing lands on (a merge's base branch, an accepted result's target); undefined when it cannot be read. */
  branch?: string | undefined
  /** The branches the project lists as dev branches. */
  devBranches: readonly string[]
}

/** The action classes of the approval queue a lead decides alone, in its own project. */
export const LEAD_QUEUE_CLASSES: readonly string[] = ['command', 'dispatch']

/**
 * Whether the lead of `project` may make a decision, or the reason it may not. Fails closed: an
 * action class off the list, a decision of another project, a branch not listed (or not read) is refused.
 */
export function leadMayDecide(d: LeadDecision): { ok: true } | { ok: false; reason: string } {
  const who = leadId(d.project)
  const listed = LEAD_QUEUE_CLASSES.includes(d.action) || d.action === 'merge' || d.action === 'acceptance'
  if (!listed) return { ok: false, reason: `${who} may not decide ${d.action}: only the operator decides it (the lead decides commands, dispatch starts, and merges and results on its dev branches)` }
  if (d.of !== d.project) return { ok: false, reason: `${who} decides only for project ${d.project}; this belongs to ${d.of === undefined ? 'no project' : `project ${d.of}`}, so it stays the operator's` }
  if (LEAD_QUEUE_CLASSES.includes(d.action)) return { ok: true }
  // A merge or an acceptance: on a listed dev branch only.
  const what = d.action === 'merge' ? 'a merge' : 'a result'
  if (d.branch === undefined) return { ok: false, reason: `${who} decides ${what} only on a listed dev branch, and the branch it lands on could not be read, so it stays the operator's` }
  if (!d.devBranches.includes(d.branch)) {
    return { ok: false, reason: `${who} decides ${what} only on a listed dev branch (${d.devBranches.length ? d.devBranches.join(', ') : 'none listed for the project'}); ${d.branch} is not one, so it stays the operator's` }
  }
  return { ok: true }
}
