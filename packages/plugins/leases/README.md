# @tsuuanmi/system-leases

**`ctx.leases`**: token leases with a **monotonic generation per resource**
([design](../../../docs/design/scheduling-and-leases.md),
[INV-4](../../../docs/architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay)).

- **Owns:**
  - `acquire`: free or expired resources only; each new holder gets
    `generation + 1`.
  - `renew`: heartbeat; throws `LeaseLost`.
  - `release`.
  - `fence(lease)`: call it inside the committing `ctx.store.transaction`. It checks
    the token, the generation, and expiry, and throws `StaleGeneration` or
    `LeaseLost`.
  - `invalidate`: fences every holder at once.
  - `current`.
  - `hold(resource, ttlMs, body)`: the one lease loop every durable runner uses
    (website turns, agent runs, workflow runs, digest requests). It acquires, renews on a heartbeat
    every third of the TTL, aborts `lost` when a renewal fails, and releases when
    the body ends. While another holder's lease is live it runs nothing and returns
    when to look again: that lease's expiry plus a second, at least a second.
- **Reuse:** the claim, heartbeat, and release by token follow
  `@gm-hz/agent-dag-workflow`. The generation fence is ours, because that package
  leaves fencing out of scope.
- **Injects:** `store`.
- **Config:** `maxTtlMs`.
- The conformance suite is [`conformance/leases.ts`](conformance/leases.ts), run through the
  [conformance runner](../../libs/conformance/runner.ts) at contract 1.0 against this plugin
  over a real store:
  - one holder per resource, as a `lease@1.0` record;
  - a generation that rises on every new holder and every invalidation, and never falls on
    release;
  - renewal and release by token only; takeover of an expired lease;
  - a commit fenced by a stale generation, a foreign token, or an expired lease is refused and
    rolled back; invalidation fences every holder at once; the fence runs only inside the
    committing transaction;
  - TTLs capped at `maxTtlMs`, and a TTL that is not a positive integer rejected;
  - `hold`: release when the body ends or throws, when to look again while another lease is
    live, the heartbeat, and `lost` on invalidation.
