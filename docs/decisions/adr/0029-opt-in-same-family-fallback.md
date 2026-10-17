# ADR-0029: An operator may let work run on one provider family when no other is available

- **Status:** Accepted; amended 2026-10-16 (its scope stated: any Worker source with sessions, and the live evidence)
- **Date:** 2026-10-16 (accepted 2026-10-16, by the operator)
- **Related:** [ADR-0027](0027-provider-diversity-in-routing.md) (superseded in part),
  [PROP-0004](../../proposals/0004-claude-code-lead-mvp.md),
  [INV-2](../../architecture/invariants.md),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

ADR-0027 makes a node that must differ from another (a team member, a second research branch, a
critique) fail admission when no Worker of another provider family is admitted: "routing never
silently falls back to the same family". Teams also require distinct accounts (REQ-TEAM-4).

On 2026-10-16 the second family of the live install, a Gemini web account, could not serve work.
Copies of its login session were signed out right after a turn, and Google then served its
unusual-traffic check (a reCAPTCHA) to the host, including the login profile itself. With one
family left, no team or research run could run at all. The operator chose to run teams on one
ChatGPT account, each member in its own conversation, until Gemini works again.

## Options

1. **Keep failing closed.** Teams and research stay unavailable until a second family returns.
2. **Allow the same family silently.** Breaks ADR-0027's guarantee that a record never claims a
   diversity the run did not have.
3. **An operator opt-in that falls back only when needed, and says so.**

## Decision

Option 3.

- **Opt-in.** The workflow configuration gains `allowSameFamily` (default `false`). With it off,
  ADR-0027 holds unchanged.
- **Only when needed.** A node routes with its family exclusion and its team's distinct-account
  rule first. Only when that admits no Worker does it route again without them. A session's own
  Worker still binds it. So once a second family is available again, teams and branches use it,
  with no change to the configuration.
- **Recorded, never silent.** The fallback is an `admission` decision (policy
  `workflow.same-family`, outcome `same-family`) naming the rules no Worker satisfied, kept among
  the node's decisions. A team with such a member records `members: same provider family` on its
  final decision, and its answer says so on its second line. Nothing says "independent".
- **Each member in its own session.** Members keep their own sessions (Model A), so two members
  on one Worker answer and vote in two native sessions, and each ballot is sealed as before.
- **General, not one provider's.** The fallback is in the workflow engine and names no provider
  (INV-11). It rests on the Worker session model of
  [ADR-0015](0015-worker-sessions-and-peer-messaging.md): every member is a system-owned session
  bound to its own native handle. A website account hosts one conversation per session; an agent
  runtime (over ACP, or an SDK) hosts one native session per session. So any Worker source that
  keeps sessions apart can serve several members of one team.
- **Live evidence (2026-10-16).** Two members on one website account, each in its own
  conversation: brainstorm `run_2380ceeefba5d628` and review `run_4846cd12f59e4bbd`, each
  recorded as same provider family.

## Consequences

- Supersedes, in part, ADR-0027's "routing never silently falls back to the same family": with
  `allowSameFamily` on, it falls back, recorded. Everything else in ADR-0027 stands.
- A same-family team is weaker evidence: one model judging itself. Its record and answer say so,
  and the Lead weighs it that way ([ADR-0028](0028-local-lead-final-authority.md)).
- Two members on one account use that account's quota twice per round; `system usage` shows both
  steps on the same account.
- The fix for the second family is separate (roadmap: run Gemini turns in its persistent login
  profile, a change to the browser runtime's rule that automated turns never use it).
