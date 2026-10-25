# ADR-0066: Every route orders Workers by their accounts' quota headroom, one implementation of it

- **Status:** Accepted (2026-10-26, by the operator's go-ahead for PROP-0014 D3, T185, under D61)
- **Date:** 2026-10-26
- **Related:** [PROP-0014](../../proposals/0014-dispatch-by-quota.md) (increment D3; D63, D66, D70),
  [ADR-0033](0033-least-busy-routing.md), [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0052](0052-accounts-are-assigned-unless-pooling-is-recorded.md),
  [ADR-0059](0059-quota-readings-from-each-accounts-own-usage-report.md),
  [ADR-0064](0064-system-starts-ready-work-under-the-dispatch-action-class.md), REQ-WRK-8,
  REQ-WRK-12, [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

ADR-0064 (D1) chose a dispatched task's Worker by `quota-score@1`, and kept the reserve
(`quota.reservePercent`, 20 % of every window, D63) as a gate on dispatched starts only. Every other
route (every later step of a dispatched run, every step of a run the lead or the operator starts)
still ordered by tier, quota class, load, the priority list, and id, blind to how much of each
window was left. A plan window's unused share is lost at its reset, and an account the operator also
uses personally was drawn into its reserve by any route that happened to land on it.

Two pieces of code computed a window's headroom and the order free Workers are taken in: dispatch's
`quotaScoreOf` (`libs`) and the roster's capacity summary (`gateway-core`, T152, its own window pick
and "left per minute to reset" order). They could disagree on which account has the most to use.

PROP-0014's increment D3 ("quota in every route") proposed the score as an order key after quota
class and before load, for every step of every run, behind `quota.routeOrder` until its ADR; ADR-0064
deferred it to its own ADR. The `workers` seam is a guarantee seam (ADR-0036): how it orders changes
by ADR.

What constrains it:

- **Readings are the ledger's** (ADR-0059); a missing, stale, or unknown one is missing, never
  headroom (INV-2).
- **Assigned accounts** (D24, ADR-0052): work never moves around a limit to a sibling account;
  choosing by headroom for *new* work moves nothing (D66).
- **A turn in flight is never moved.** Routing chooses before a step starts.
- **The canonical gauge** of an account is the windows its pool lists, configured by the operator;
  a Claude Code plan lists only its five-hour window (operator D70).

## Options

1. **Keep quota in dispatch only** (ADR-0064 as is). Every non-dispatched step stays blind to
   quota, and the reserve protects nothing outside dispatched starts. Rejected.
2. **Make the reserve an admission check** (refuse a Worker over it). A run with only that Worker
   admitted would fail or wait though the operator could let it run; it moves the reserve from an
   order to a refusal on every route. Rejected.
3. **Headroom after quota class, before load, with the reserve inside that position.** A Worker
   over its reserve would still win on a lower tier, so the reserve would protect the operator's use
   only among Workers of one tier. Rejected.
4. **One headroom function in `libs`; every route orders by it, the reserve key first, the rest of
   the headroom order after quota class and before load; recorded per candidate; on by default.**
   Chosen.

## Decision

1. **One implementation.** `libs` holds the one implementation of a pool's headroom and its order
   (`accountQuotaOf`, `headroomOrderOf`, `headroomKeysOf`, `compareHeadroom`). `quotaScoreOf`
   (now `quota-score@2`), routing, and the roster's capacity now all call it; none computes headroom
   or orders by it on its own. A window is **known** when its latest reading is at most
   `staleReadingSeconds` old, reads `ok`, gives a used share, and its reset (when it names one) is
   still ahead; its **headroom** is `100 − used − reservePercent`; an unread window (no reading,
   stale, `unknown`, no used share, or from before its reset) never counts as headroom. An account
   is **over its reserve** when a window reads `limited`, or is known with no headroom (used above
   `100 − reservePercent` %).
2. **Every route orders by it**, for every step of every run, dispatched or not. The router reads
   the ledger's `pools()` and `quota()` once per route, inside the routing lock. The order, each key
   compared only when every key before it ties:
   1. an account over its reserve last, while another admitted Worker's account is free (every
      window known with headroom); when none is, this key ties;
   2. tier, lowest admissible first;
   3. quota class (`budget.preferQuota`, then `quotaPreference`);
   4. known before configured-available (`unknown: available`) before unknown or stale: an unknown
      reading is never preferred to a known one;
   5. use it or lose it: a window resetting within `useSoonMinutes` with at least
      `minHeadroomPercent` headroom in the binding window first, the earlier reset first;
   6. headroom in the binding window, most first, in `headroomBucketPercent`-point buckets;
   7. load (ADR-0033), the priority list, then id.
3. **The reserve orders, it never refuses, and it precedes tier.** This changes D63's "the reserve
   gates starts only" for routing: a Worker over its reserve gets no new step, writing or not, while
   another admitted Worker has headroom, whatever its tier; it is still admitted, and runs when no
   other Worker is free. A run already on it keeps its turn in flight; its next step routes by this
   order. Dispatch's own free test (ADR-0064 decision 5) is unchanged.
4. **Recorded** (INV-13). The route decision (`workers.route.deterministic` version 2) lists every
   admitted Worker's score and the quota key a Worker lost on; its inputs include the readings the
   order read.
5. **No ledger, no change.** With no resource ledger mounted every quota key ties, and routing
   orders exactly as before; a ledger that cannot be read leaves every account's quota unknown,
   never headroom.
6. **On by default.** D3 ships without `quota.routeOrder`; this ADR is the acceptance the proposal
   gated it on. Reverting is a release that drops the keys.
7. **The canonical gauge** is the windows an account's pool lists; a Claude Code plan's pool lists
   only its five-hour window (D70).

## Consequences

- In the operator's case of two accounts, one at 85 % of its window and one at 10 %, every step
  goes to the one at 10 %; with both unread, routing orders as before by load and id.
- `quota-score@2`: a reading from before its reset is not known, and an account over its reserve
  ranks last while another is free. A dispatch ask opened under `@1` is asked again after the
  upgrade.
- Capacity now (`mcp-roster@1.7`) lists free Workers in the same order, each with its `headroom`;
  `resetsAt` is optional when a reading names no reset.
- The `workers` seam's contract is unchanged in shape: it gains an order, read from the optional
  `resources` `quota()` (contract 1.2). No invariant changes.
- Since the reserve key precedes tier and quota class, a step may now go to a higher tier, or a
  later quota class, than before when the lower one's account is over its reserve and the other's
  is free; among Workers on the same side of the reserve, tier and quota class order as before.
- Not built: the reserve shown on each window of the Workers tab.
- Revisit when the live install shows the reserve-first key starving a tier the work needs, or a
  window's readings too stale for the order to mean anything.
