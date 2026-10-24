# ADR-0055: A provider's personal accounts may be pooled when the operator records that they accept the risk

- **Status:** Proposed (written on operator decision D33, 2026-10-24); supersedes
  [ADR-0052](0052-accounts-are-assigned-unless-pooling-is-recorded.md) in part, for when a
  provider may be `pooled`
- **Date:** 2026-10-24
- **Related:** [ADR-0052](0052-accounts-are-assigned-unless-pooling-is-recorded.md),
  [ADR-0034](0034-unsent-failover-to-a-sibling-account.md),
  [PROP-0012](../../proposals/0012-agent-accounts.md), REQ-ACC-10, REQ-WRK-8,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

ADR-0052 made every provider's accounts `assigned` by default and allowed `pooled` only on the
operator's recorded confirmation that the provider's terms allow pooling; since all the operator's
accounts are personal paid subscriptions (D24), it said that personal subscriptions never qualify.
Rotating personal accounts around their usage limits is restricted or prohibited by the providers'
terms (PROP-0012 research H4); nothing since has shown that any of these terms allow it.

On 2026-10-24 the operator decided (D33) to turn back on handing work to another account of the
same provider, `accounts: pooled`, for `chatgpt-web`, `gemini-web`, and `claude-agent-sdk`, all of
them personal subscriptions: work moves between the operator's own accounts of a provider when one
is busy or at its limit, and the operator accepts the risk under the personal-plan terms.

The mechanism ADR-0052 built does not change. What does is what a `pooledTerms` record may say:
under ADR-0052 it could only be read as "the terms allow it", which for these providers would be
false.

## Options

1. **Keep ADR-0052's rule.** The operator's decision cannot be configured; refused.
2. **Record the operator's decision as a confirmation of the terms.** It would make the record
   claim a reading of the terms that nobody made; refused.
3. **`pooled` on the operator's recorded decision, whatever its basis**: `pooledTerms` records who
   decided to pool the provider, when, and on which terms: either that the terms allow it, or, for
   a personal subscription, that the operator accepts the risk under its terms. The record states
   its basis in its own words and never claims a reading it is not.

## Decision

Option 3. It replaces only the condition for `pooled` in ADR-0052's decision ("`pooled` is refused
at load unless the provider's settings carry `pooledTerms` (who confirmed, when, which terms they
read) ... Personal subscriptions never qualify (D24)"):

- **`pooled` is the operator's recorded decision.** It is refused at load unless the provider's
  settings carry whole `pooledTerms` (INV-2): `confirmedBy`, who decided; `confirmedAt`, when; and
  `terms`, which terms and on what basis. A personal subscription qualifies when the operator
  records that they accept the risk under its terms, saying so, not that the terms allow it. The
  configuration's shape is unchanged.
- **The `gate` decision recorded at each start** names the record, not a conclusion: "the operator
  recorded pooling for this provider: <terms>" (INV-13). The source claims nothing about what the
  provider's terms allow.
- **`assigned` stays the default**, for every provider not set `pooled`, as ADR-0052 decided. Under
  D33, the `codex-sdk` and `antigravity-cli` accounts stay assigned.
- Everything else in ADR-0052 stands, for both modes: the `assignment` check, the `wait` outcome
  and its bound, no failover inside an assigned group, parallel use, and pool templates. Under
  `pooled`, ADR-0034 stands as accepted. Routing still compares the account's `id` and `group` for
  equality only and never names a provider (INV-11).

## Consequences

- The operator sets the three providers `pooled` in configuration, each with a `pooledTerms` whose
  `terms` says it is not a reading that the provider's terms allow pooling, that D33 is the
  decision, and that the operator accepts the risk under the personal-plan terms
  ([runbook](../../operations/runbooks.md#pool-a-providers-accounts)). Each start records it.
- For those providers, a limit, challenge, sign-out, or site error on one account moves unsent
  work to another of its accounts again (ADR-0034), and cooldowns steer new work to the least busy
  one; no work waits for an account's reset while another account of the provider can take it.
- The risk under the providers' terms is the operator's, as recorded; `system` does not assess it.
- Messages and documentation stop saying that personal subscriptions are never pooled, and that
  `pooledTerms` confirms what the terms allow.
- Revisit if the operator withdraws D33 (set the providers `assigned` again), or if a provider
  restricts or suspends a pooled account.
