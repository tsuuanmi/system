# ADR-0035: One-family teams keep distinct accounts before sharing one

- **Status:** Accepted
- **Date:** 2026-10-19 (accepted 2026-10-19, by the operator, with [PROP-0007](../../proposals/0007-account-pools.md))
- **Related:** REQ-TEAM-4, [ADR-0027](0027-provider-diversity-in-routing.md),
  [ADR-0029](0029-opt-in-same-family-fallback.md) (superseded in part), [ADR-0033](0033-least-busy-routing.md)

## Context

With `allowSameFamily` on, ADR-0029 routes a node again, without its family exclusion *and* without
its team's distinct-account rule, when no Worker of another family is admitted. When one provider
has several ready accounts, that drops more than needed. Every member lands on the first account,
sharing its quota and its conversation list, while the other accounts are free.

## Options

1. **Keep ADR-0029 as is.** Members share an account even when others are free.
2. **Drop distinct accounts never.** A team on a provider with one account could not run at all,
   which undoes ADR-0029.
3. **A middle step: drop the family rule first, keep distinct accounts while possible, and share
   an account only last.**

## Decision

Option 3. With `allowSameFamily` on, a team member routes in up to three steps:

1. Different family and distinct account (ADR-0027).
2. Same family allowed, **distinct account kept**.
3. Same family and a shared account, each member in its own conversation (ADR-0029).

Steps 2 and 3 are each an `admission` decision of policy `workflow.same-family`, with outcome
`same-family` or `same-family-shared-account`. The team's final record and answer say which.
Nothing calls such a team independent: it is still one model family judging itself.

## Consequences

- Supersedes in part ADR-0029's single fallback, which lifted both rules together. Everything else
  in ADR-0029 stands: opt-in, only when needed, recorded, never silent.
- Among distinct accounts, step 2 picks by ADR-0033's order, so members spread over the least busy
  accounts.
- REQ-TEAM-4 gains the middle step when it is implemented.
- With one account per provider, behaviour is unchanged: step 2 admits nothing, and step 3 applies.
