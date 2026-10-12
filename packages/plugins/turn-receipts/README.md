# @tsuuanmi/system-turn-receipts

**`ctx.turnReceipts`**: provider turn receipts, persisted **before** a prompt is sent
([provider turns](../../../docs/design/provider-turns.md#turn-receipt), INV-4).
It is ported from tsuuanmi/internet's receipt store, and its tests were ported first.

- **Owns:**
  - `submit`: identity is account + session + request id. A drifted prompt or
    response boundary is refused, and resubmissions are bounded.
  - `bindConversation`: binds once and never rebinds.
  - `complete`: idempotent, and refuses conflicting content.
  - `reconcile`: WAIT, RECOVER, RESUBMIT, or AMBIGUOUS, **recorded as a decision
    artifact** that the receipt references (INV-13).
  - `delete(identity)`: removes one turn's receipt when its turn is forgotten
    (the `turns` retention purge, INV-9).
- **Records:** validated against [`provider-turn-receipt@1.0`](../../../schemas/provider-turn-receipt.v1.json)
  on every write.
- **Injects:** `store`, `artifacts`.
