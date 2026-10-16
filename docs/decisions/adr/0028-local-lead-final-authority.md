# ADR-0028: The calling agent is the Lead; a team's outcome is advice to it

- **Status:** Accepted
- **Date:** 2026-10-16 (accepted 2026-10-16)
- **Related:** [PROP-0004](../../proposals/0004-claude-code-lead-mvp.md),
  [ADR-0011](0011-mvp-integration-via-mcp.md), [ADR-0027](0027-provider-diversity-in-routing.md),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [INV-15](../../architecture/invariants.md#inv-15-one-writer-per-subject), REQ-TEAM-6, REQ-TEAM-7

## Context

In the MVP, a local coding agent calls `system` over MCP. Examples are Claude Code
and Codex, and any other MCP client works the same way. `system` then asks
website Workers to research, brainstorm, and review, and returns results,
evidence, and team outcomes.

The docs say that a team "decides", and a review's `blocking-finding` method
"decides `changes`". Nothing says who acts on that outcome, or whether it permits
anything. A reader could take a majority of `pass` to mean that the code is
correct, or that it may be merged.

A team's outcome is a statement made by models. Its evidence is checked, but its
judgement is not. Two website Workers that agree can both be wrong.

## Options

1. **The team's outcome authorizes.** For example, a `pass` review lets `system`
   merge, or lets the agent proceed without judging the outcome itself.
2. **The outcome is advice to the caller.** The calling agent is the Lead and makes
   the final decision. `system` still enforces its deterministic rules.

## Decision

Option 2.

- **The Lead.** The agent that started the run (the MCP caller) is the Lead. The
  Lead decides what to change, implements it, verifies it, and merges it. It
  answers to its own user and sandbox, not to `system`.
- **Advice, bounded to the run.** A team outcome is recorded as a decision artifact
  (INV-13) and returned to the caller. This holds for every method: `team-majority`,
  `caller-tiebreak`, `inconclusive`, and `blocking-finding`.
  - The outcome authorizes no effect outside the run: no change to the caller's
    code, no merge, push, publish, or message.
  - Inside the run, it selects only what the template already defines: which
    option the run reports, and for a review, the remediation rule
    ([workflow engine](../../design/workflow-engine.md)).
- **Five distinct facts.** They are kept apart in records, results, and docs, and
  none implies the next:
  1. a Worker's result was **accepted** (its contract passed);
  2. a team **reached a majority** (its ballots were counted);
  3. a review's findings were **verified** (a quote matched the subject at its
     `path:line`);
  4. a review was **approved**, which only a person or the Lead does, outside
     `system`'s team outcome;
  5. the **Lead decided**.
  A majority of `pass` means that most members found nothing they judged blocking.
  It does not mean the code is correct.
- **Deterministic rules still bind.** `system` enforces its own deterministic checks,
  whatever the models or the caller say, for example:
  - acceptance contracts;
  - quote verification;
  - exact-subject binding (REQ-WF-5);
  - the blocking-finding rule;
  - admission;
  - egress;
  - bounds.
  These rules can refuse, fail, or flag work. They never grant authority outside
  the run.
- **The caller's vote** (REQ-TEAM-7) breaks a tie inside the run. It is the Lead
  choosing among the team's options, recorded as `by: client`. It grants nothing
  either.
- **Wording.** Docs and tool descriptions say that a team *reaches* an outcome or
  *recommends*. "Decides" is kept only for a deterministic rule.

## Consequences

- The MVP's division of labor holds:
  - `system` saves the Lead tokens on research, brainstorm, and review;
  - the Lead keeps every write and every judgement that matters.
- A review that `system` returns is input to the Lead's own review, never a
  substitute for it.
- The remediation rule is the one place where a review's outcome starts work
  inside a run. It needs a writing step, which only agent Workers provide, so it is
  off in the website-only MVP (agent Worker rows are disabled by default).
  - Before agent Workers serve real work, remediation should wait for the Lead's or
    the operator's approval, as a plan's steps do (INV-15). This is a follow-up in
    the [roadmap](../../proposals/roadmap.md#follow-ups-from-the-reliability-review).
- Revisit if `system` is ever to act on its own outcomes: an unattended mode that
  merges on a team's `pass`. That would need its own ADR and an explicit,
  per-subject approval.
