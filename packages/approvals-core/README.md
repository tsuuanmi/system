# @tsuuanmi/system-approvals-core

Gate **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[approvals](../../docs/design/approvals.md)). A guarantee seam: its contract changes only by an
ADR ([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.approvals` | abstract `Approvals` with `policy(projectId?)`, `check(action)`, `request(request, at?)`, `get`, `list(filter?)`, `batch(at?)`, `decide(verdicts, at?)`, `withdraw(requestId, at?)`, `sweep(at)`; `AutonomyPolicy`, `Action`, `AutonomyVerdict`, `ApprovalRequest`, `NewRequest`, `Verdict`, `VerdictResult`, `ApprovalsError`; `ALWAYS_ASK`, `MODES`, `APPROVALS_CONTRACT` (1.0) | the fake `FakeApprovals` only (B5 adds the real one) |

- The types mirror `autonomy-policy@1.0` and `approval-request@1.0`; the schemas in `schemas/`
  are canonical. It depends on nothing but Cordis.
- The conformance suite is [`conformance/approvals.ts`](conformance/approvals.ts), run through
  the [conformance runner](../libs/conformance/runner.ts) at contract 1.0:
  - the strictest mode of the studio and project policies, and a fail-closed default;
  - every classification an `autonomy` decision; required checks; the commands list, which a
    forbidden `command` class overrides;
  - a request only on a recorded `ask`; its bounded expiry; batching;
  - a verdict bound to the exact subject, written as `approval@1.0` by the operator; refusals that
    change nothing;
  - expiry rejects with `denied:expired`; withdrawal; listing.

  It also exports `FakeApprovals`, which passes it, over the policies in `POLICIES`.
