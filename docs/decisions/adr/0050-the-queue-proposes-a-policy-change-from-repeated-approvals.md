# ADR-0050: The approval queue proposes, never applies, a policy change from repeated identical approvals

- **Status:** Accepted
- **Date:** 2026-10-23 (accepted 2026-10-23, by the operator, with the feature off by default)
- **Related:** [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0041](0041-policy-changes-through-the-approval-queue.md) (superseded in part: the operator
  is no longer the only one who proposes),
  [PROP-0008](../../proposals/0008-studio-operating-model.md#fewer-approvals-reliable-results),
  [PROP-0010](../../proposals/0010-base-version.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

PROP-0008 lists "turn repeated identical approvals into policy" among the ways to fewer
approvals: an operator who approves the same action again and again is being over-asked. B5 of
PROP-0010 leaves it open ([where a policy change leaves
room](../../design/approvals.md#where-a-policy-change-leaves-room)).

ADR-0041 takes a policy change through the queue: the operator proposes one record, the queue asks
on the exact hash of the set it makes, and only the operator's approval applies it. It also says
that today only the operator proposes, and to revisit that if changes should be proposed for the
operator. Letting anything but the operator propose touches INV-6 (authority from trusted
envelopes) and the rule that the safety layer never changes itself, so it needs a decision.

What a repeated approval can safely become is limited by what the autonomy policy can say. The
policy distinguishes an action by its class, its project, and, for a command, its exact argv
(a `commands` line is judged as `workspace-write`). A rule's mode applies to every action of a
class in a project, and a project policy can only narrow the studio's, so loosening a class for
the subject the operator kept approving loosens it for every other subject of that class too, and
often for every project. Only a `commands` line is as narrow as what was approved.

## Options

1. **Keep it off the queue.** The operator notices the pattern and proposes the change. Nothing
   reduces the asking that the queue itself can see.
2. **The queue proposes a class-wide change** (for example `merge` from `ask` to `notify`) after
   repeated approvals of that class. It widens beyond what was approved: every subject of the
   class, and, from the studio policy, every project.
3. **The queue proposes, never applies, exactly the repeated shape, through the ADR-0041 path.**
   The shape is a studio command's exact argv; the proposal adds that line, and nothing else, to
   the studio policy's commands list, as a `policy-change` request the operator approves or
   rejects like any other. Off by default.
4. **The queue applies the change itself** after repeated approvals. The safety layer would change
   itself, without a verdict on the exact set (INV-5, INV-6).

## Decision

Option 3. It supersedes ADR-0041 in part: the operator is no longer the only one who proposes a
policy change, since the queue may propose, never apply, the one shape below; only the operator's
approval applies a change, as before.

- **What counts as identical.** A request's shape is a studio `command` (no project), not
  `local-private`, judged as the `command` class (not already listed, not forbidden), whose argv
  is a valid commands line word for word (no empty word, no shell metacharacter, at most 200
  characters). The provider stores the shape with the request, in the transaction that writes it;
  any other request has none and is never counted.
- **When.** The operator approved one shape at least `approvals` times (default 5, from 3 to 100)
  among the requests made in the last `windowSeconds` (default a week, from an hour to 90 days),
  and none of the shape's requests in that window was rejected by a verdict or expired. Withdrawn
  and open ones count neither way.
- **What is proposed.** The studio policy in force at its next version with that one line appended
  to its `commands`, nothing else changed: only when the argv then runs as `workspace-write` under
  `auto` or `notify` (so it lowers what is asked), no class's effective mode moves, neither class
  always asks, the policy asks for `policy-change`, and the set loads under the configuration's
  rules. It goes through `proposePolicy`'s own path: a `policy-change@1.1` record whose optional
  `origin` names the rule, the shape, the approvals counted, the window, and the decision; an
  `approval-request@1.1` (requester `approvals`) on the exact hash of the set; applied only by the
  operator's approval while its base is still in force.
- **At most one.** No proposal while any policy change is asked; one per pass, the shape approved
  most often first.
- **Never again.** A shape whose queue proposal was asked, applied, retired, rejected, or expired
  is never proposed again (the operator can still propose it on the policy page); only a withdrawn
  one (its base no longer in force) may be proposed again on the set in force.
- **Recorded.** Each proposal is a `decision@1.6` `policy-change` (decider rule
  `approvals.repeated-approvals`: the proposed set selected, the set in force kept; its inputs the
  `autonomy` decision that said ask and the operator's approvals it counted) in the transaction that
  stores the change and its request (INV-13). The pass is deterministic from the store and runs in
  the queue's own clock after the sweep, so a restart or a second process proposes nothing twice; a
  pass that fails is logged and never stops the queue.
- **Off by default.** `repeatedApprovals.enabled` turns it on (validated plugin `Config`); the
  bundle leaves it off, and the operator turns it on for the studio in the `approvals` row
  (accepted that way, 2026-10-23).
- **The seam.** `approvals` stays at contract 1.1: no method changes, and `PolicyChange` gains the
  optional `origin` (`policy-change@1.1`, a minor). The fake provider and the conformance suite
  are unchanged: a provider need not propose anything.

## Consequences

- The operator is shown a proposal they did not make; its summary, consequences, and the `/ui`
  queue entry say the queue proposed it and why, and its decision cites the approvals.
- An approved proposal raises the studio policy's version, so open requests made under the old
  version are withdrawn and their requesters ask again, as for any studio change.
- Class-wide changes and project-scoped commands are never proposed: the policy cannot express
  them without widening beyond the approved shape. A project's command, or a command a project's
  own list does not hold, keeps asking there.
- A rejected or unanswered proposal ends the suggestion for that command for good; a cooldown
  would ask the operator again about what they already declined.
- Revisit if the policy gains a narrower rule (per subject or per project command), or if the
  operator wants a cooldown instead of a permanent bar.
