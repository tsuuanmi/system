# ADR-0062: A team member's first step is resent once, in a new conversation, after a site's own error

- **Status:** Accepted (2026-10-25, by the operator, D60)
- **Date:** 2026-10-25
- **Related:** T135 (from T125), [ADR-0005](0005-provider-runtime-interface.md),
  [ADR-0015](0015-worker-sessions-and-peer-messaging.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0049](0049-read-only-agent-workers-as-review-members.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

On the live host on 2026-10-24 a two-member team's Gemini member sent its first prompt, and the
site answered with its own error in place of an answer: "Sorry, something went wrong. Please try
your request again." The driver recognised it (`answer.site-error`) and failed the turn
`overloaded`. The prompt had been sent, so nothing resent it, and the run failed for the operator.
T125 found that `continue` cannot help: a team member keeps one conversation, and the conversation
reopened 30 minutes later showed an empty new chat, which reconciliation reads as not observed.
A member is never given a fresh conversation, so the run had to be started again
([runbook](../../operations/runbooks.md#a-review-member-fails-on-a-website)).

What constrains a resend:

- **Sent is never resent** (INV-4). The engine starts nothing again once the prompt may have
  reached the provider; the turn runtime resends only on RESUBMIT, on positive evidence that the
  prompt left no trace ([reconciliation](../../design/provider-turns.md#reconciliation)). Here
  the evidence is the other way: the site has the prompt, and answered it with its error.
- **A member keeps its conversation** ([teams](../../design/teams.md#membership-model-a)): the
  ballot and debate prompts rely on it holding the request, the material, and the member's own
  earlier answers.
- **Nothing written may be repeated.** A step that writes (a `develop` step in a worktree) or
  grows a plan may have done more than answer.
- **The `workflow` and `workers` seams are guarantee seams** (ADR-0036): their contracts change by
  additive, optional fields only, with an ADR.

The operator decided on 2026-10-25 (D60): a read-only team member (a brainstorm or review member,
whose step writes nothing) may be resent once, in a new conversation, recorded as a decision
naming why, the failed turn, and the new turn; never for any other step, never twice, never when
anything was written.

## Options

1. **The turn runtime resends in the same conversation** (a new reconciliation row, as the roadmap
   first framed it). The evidence exists only on the turn's own page, before it closes; the
   runtime knows nothing of teams or steps, so it would resend any step, a writing one too; and the
   site may answer the same conversation with the same error. Rejected.
2. **The turn runtime resends in a new conversation when its caller marks the start resendable.**
   A new field on `WorkerStart`, and a second send inside one execution, under one receipt that
   binds one conversation: the receipt would have to be rebound, which it never is. Rejected.
3. **The engine resends the step as a new attempt, in a new conversation of the member's session,
   on a site's error its source marks.** The source says what it saw (an optional
   `error.siteError` on the execution); the engine, which knows the step, decides by its rule and
   records the decision; the session's existing `reset` gives the new conversation; the member's
   identity, account, and Worker stay. Chosen.

Which steps:

4. **Every step of a team member.** A ballot or debate in a new conversation would answer without
   the request, the material, or its own proposal. Rejected.
5. **A team member's first step (`propose`) only.** Its prompt is the whole request and material,
   so a new conversation loses nothing, and the member's later steps go on in that conversation.
   Chosen: D60's "read-only team member", narrowed to the one step a new conversation cannot
   change, as teams.md's rule for continuations requires.

## Decision

Options 3 and 5.

1. **The source says what it saw.** `ProviderError` gains the optional `siteError`; the Gemini
   driver sets it on `answer.site-error` (the error read on the turn's own page after the send).
   The turn runtime keeps it on the turn's error only when the turn's receipt was written, and its
   Worker execution carries it: `WorkerExecution.error.siteError` (optional, additive). The
   runtime never resends.
2. **The engine decides, by rule, once.** On a failed execution that was `submitted` and marked
   `siteError`, the node is resent only when all of these hold, and fails as before otherwise:
   - it is a team member's `propose` step; it proves no `develop` and grows no plan;
   - it runs in a session of its own (the member's);
   - no `resend` decision of that node is on record (never twice);
   - an attempt is left (`maxAttempts`): the resend is that attempt;
   - `ctx.workers.reset(session)` succeeds: a source owns the session and starts its next work in a
     new native conversation (INV-2 otherwise).
3. **Recorded first, in one transaction** (INV-4, INV-13). A `recovery` decision with outcome
   `resend` (`decision@1.9`; rule `workflow.recovery` version 2), its `detail` naming the failed
   execution, the session, and the new attempt and the key its execution starts under; the
   session's reset; and the node made `READY` after the `overloaded` back-off: all in one store
   transaction. A restart finds all three or none, and the new attempt then runs once, as any
   retry does. A site's error that is not resent records the `fail` decision with a `resend`
   candidate saying why not.
4. **Seams.** `workers`: the optional `WorkerExecution.error.siteError` (additive, ADR-0036; the
   existing `reset` is used as it is). `workflow`: contract 1.8, whose conformance suite adds the
   scenarios `site-error-resend`, `site-error-not-resent`, and `site-error-resend-restart`; a
   source that never marks `siteError` sees every behaviour of 1.7. `providers`: the optional
   `ProviderError.siteError`. Schemas: `decision@1.9` adds the recovery outcome `resend`, a minor.

## Consequences

- T125's case costs one more turn on the same account, in a new conversation, instead of the run.
- The abandoned conversation stays in the conversation ledger, owned by the member's session, and
  is deleted with the session's other conversations when its run releases it.
- A second site error on the resent step, or one on a ballot or debate, still fails the run for the
  operator, who starts it again.
- A resend after a site's error is a second send of the same prompt to the same site. The site
  showed that it answered nothing; a site that recorded more than it showed is the risk accepted
  by D60, bounded to once per member's first step.
- Revisit if a site's error is seen on later member steps often enough to want a replay of the
  conversation into a new one, or if another site's driver can tell its own error after the send.
