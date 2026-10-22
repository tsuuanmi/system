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
    artifact** that the receipt references (INV-13). Waiting is recorded once:
    a WAIT right after a WAIT reuses that decision, and any other outcome is
    recorded (INV-9).
  - `delete(identity)`: removes one turn's receipt when its turn is forgotten
    (the `turns` retention purge, INV-9).
- **Records:** validated against [`provider-turn-receipt@1.0`](../../../schemas/provider-turn-receipt.v1.json)
  on every write.
- **Injects:** `store`, `artifacts`.
- The conformance suite is [`conformance/turn-receipts.ts`](conformance/turn-receipts.ts):
  - `submit` persists a schema-valid `SUBMITTED` receipt, keyed by account,
    session, and request id, and refuses an empty part of that identity;
  - a reused request id with another prompt or boundary is refused; at most two
    resubmissions, then no RESUBMIT;
  - a conversation binds once; completion is idempotent and refuses conflicting
    content;
  - every reconciliation is a deterministic `reconciliation` decision naming all
    four outcomes and the snapshot hash, appended to the receipt; consecutive
    WAITs are one decision; rejected outcomes carry reasons;
  - RECOVER adopts a new response after the boundary; RESUBMIT only when nothing
    new follows it and the page does not show the prompt; an unobservable page,
    a contradicted completion, or a missing boundary is AMBIGUOUS;
  - `delete` removes one receipt and none of the session's others.
  - One scenario is baselined as a known failure, with its reason, in
    [`tests/conformance.spec.ts`](tests/conformance.spec.ts).
