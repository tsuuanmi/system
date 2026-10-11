# @tsuuanmi/system-leases

**`ctx.leases`**: token leases with a **monotonic generation per resource**
([design](../../../docs/design/scheduling-and-leases.md),
[INV-4](../../../docs/architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay)).

- **Owns:**
  - `acquire`: free or expired resources only; each new holder gets
    `generation + 1`.
  - `renew`: heartbeat; throws `LeaseLost`.
  - `release`.
  - `fence(resource, generation)`: call it inside the committing
    `ctx.store.transaction`; it throws `StaleGeneration`.
  - `invalidate`: fences every holder at once.
  - `current`.
- **Reuse:** the claim, heartbeat, and release by token follow
  `@gm-hz/agent-dag-workflow`. The generation fence is ours, because that package
  leaves fencing out of scope.
- **Injects:** `store`.
- **Config:** `maxTtlMs`.
