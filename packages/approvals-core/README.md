# @tsuuanmi/system-approvals-core

Gate **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[approvals](../../docs/design/approvals.md)). A guarantee seam: its contract changes only by an
ADR ([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.approvals` | abstract `Approvals` with `policy(projectId?)`, `check(action)`, `request(request, at?)`, `get`, `list(filter?)`, `batch(at?)`, `decide(verdicts, at?)`, `withdraw(requestId, at?)`, `sweep(at)`; `AutonomyPolicy`, `Action`, `AutonomyVerdict`, `ApprovalRequest`, `NewRequest`, `Verdict`, `VerdictResult`, `ApprovalsError`; `ALWAYS_ASK`, `MODES`, `SHELL_METACHARACTER`, `APPROVALS_CONTRACT` (1.0) | [`approvals`](../plugins/approvals/README.md) (store-backed), the fake `FakeApprovals` |

- The types mirror `autonomy-policy@1.0` and `approval-request@1.0`; the schemas in `schemas/`
  are canonical. It depends on nothing but Cordis.
- `check`'s `mode` is the mode once the required checks pass. Required checks are the result's:
  a caller that accepts or applies a result passes the checks it ran and treats a non-empty
  `failedChecks` as not yet allowed; one that gates work while it runs (readiness, a Worker's
  tool call) records them as pending, and they bind at acceptance
  ([approvals](../../docs/design/approvals.md#a-verdict-is-not-yet-a-permission)). `at` on
  the queue methods is a test seam; production callers fill it from the wall clock.
- The conformance suite is [`conformance/approvals.ts`](conformance/approvals.ts), run through
  the [conformance runner](../libs/conformance/runner.ts) at contract 1.0:
  - the strictest mode of the studio and project policies, and a fail-closed default;
  - every classification an `autonomy` decision with its policy set's hash; required checks; the
    commands list, matched by exact argv, which a forbidden `command` class overrides; an argv
    word with a shell metacharacter forbidden;
  - a request only on a recorded `ask` that judging the action again confirms (its class, its
    project's policies), on a subject with a version; its bounded expiry, the shortest applying
    rule's; batching;
  - a verdict bound to the exact subject, written as `approval@1.0` by the operator; refusals that
    change nothing;
  - expiry rejects with `denied:expired`; withdrawal; listing.

  It also exports `FakeApprovals`, which passes it, over the policies in `POLICIES`.
