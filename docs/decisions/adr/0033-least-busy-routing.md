# ADR-0033: Routing prefers the least busy of equally ranked Workers

- **Status:** Accepted; amended 2026-10-19 (pending admissions are counted by the Worker source per account; a describe timeout)
- **Date:** 2026-10-19 (accepted 2026-10-19, by the operator, with [PROP-0007](../../proposals/0007-account-pools.md))
- **Related:** REQ-WRK-2, REQ-ACC-7, [ADR-0030](0030-session-bound-accounts-use-their-login-profile.md),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

The operator runs several accounts of one provider and wants all of them to work. Routing orders
admitted Workers by tier, then quota class, then the `priority` list, then id, and takes the first.
Nothing marks a Worker `busy`. Every turn therefore queues on the first account while its siblings
stay idle.

A routed turn reaches its account's scheduler only when its node executes. Two routes in a row
(both literature branches of one run, or two runs started together) would both see the same empty
queue. Today the engine serializes routing within one run only.

## Options

1. **Round robin per pool.** Spreads the work, but ignores how busy each account is, and its
   position is hidden state.
2. **Fill first, then spill.** Serializes the work. The operator chose spread.
3. **Least busy, with load as a recorded input.**

## Decision

Option 3.

- **Load.** A Worker's load is the turns running and queued on its account's scheduler (reported by
  the Worker source, for website accounts `turns`) **plus** the admissions routed to it that have
  not reached that scheduler yet.
  - The router keeps the pending count in memory. It is released on every exit between route and
    enqueue: enqueued, failed to start, lease lost, cancelled, superseded, or aborted.
  - A restart drops it, and the schedulers rebuild the real load.
- **Busy.** A Worker at its account's concurrency limit reads `busy`. `busy` stays admissible.
- **Order.** Tier, quota class, **load**, `priority`, id. Tier and quota stay the operator's first
  preferences. Among equally ranked Workers the least busy wins, and among equally busy ones the
  configured order still decides. With one account per provider, routing chooses as before.
- **One routing lock.** `route()` runs under one lock across all runs, so two concurrent routes
  never read the same counts.
- **Recorded.** The `route` decision lists each candidate's load and pending count ("load 1 of 2, 1
  pending"). REQ-WRK-2 holds: routing is deterministic for a given configuration and input, and the
  load it read is part of the recorded input.

## Consequences

- Five accounts of one provider give up to five times one account's capacity, within the operator's
  tier and quota order.
- The capability descriptor gains `load` (a minor schema bump).
- A route waits for the lock while another route runs. Routing is cheap, so the wait is
  negligible.
- A leaked pending count would make an account look busy until restart. Every release path is
  tested, including a node whose execution fails right after routing.
- Revisit if a Worker source cannot report its load. Its load then reads 0, and it competes on
  `priority` as today.

## Amendment (2026-10-19): where pending admissions are counted

- **The Worker source counts them, per account.** An account's tiers share one scheduler, and the
  router cannot map a Worker to its account without parsing ids, which
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in) rules out.
- **What the router does.** It reserves the chosen Worker through the source's optional `reserve`
  and returns an idempotent `release` with the admission. The engine calls it on every exit before
  the turn is queued.
- **Unchanged.** The effect, the order, and the recorded "load 1 of 2, 1 queued, 1 pending" are as
  decided above.
- **Describe timeout.** Each source's `describe()` gets 5 s inside the routing lock. A silent source
  counts as describing no Workers, and the decisions name it, so one stuck source cannot block all
  routing.
