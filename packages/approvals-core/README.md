# @tsuuanmi/system-approvals-core

Gate **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[approvals](../../docs/design/approvals.md)). A guarantee seam: its contract changes only by an
ADR ([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.approvals` | abstract `Approvals` with `policy(projectId?)`, `check(action)`, `request(request, at?)`, `get`, `list(filter?)`, `batch(at?)`, `decide(verdicts, at?)`, `withdraw(requestId, at?)`, `sweep(at)`, and at contract 1.1 the optional `proposePolicy(proposal, at?)` and `policyChanges(filter?)` and `policy()`'s `set`; `AutonomyPolicy`, `Action`, `AutonomyVerdict`, `ApprovalRequest`, `NewRequest`, `Verdict`, `VerdictResult`, `PolicyChange`, `PolicyChangeOrigin`, `PolicySetInForce`, `ModeChange`, `ContentHash`, `ApprovalsError`; `ActionClass` (since ADR-0064 with `dispatch`: System starting a ready board task's attempt by itself, not in `ALWAYS_ASK`; a policy that names no rule for it takes its `default`); `ALWAYS_ASK`, `MODES`, `SHELL_METACHARACTER`, `POLICY_SET_REF`, `APPROVALS_CONTRACT` (1.1); the pure `applyingPolicies` and `waitSeconds` (how long a wait for a person on a class lasts) | [`approvals`](../plugins/approvals/README.md) (store-backed), the fake `FakeApprovals` |

- The types mirror `autonomy-policy@1.0`, `approval-request@1.1`, and `policy-change@1.1` (its
  optional `origin`: a change the store-backed queue proposed itself from repeated approvals,
  [ADR-0050](../../docs/decisions/adr/0050-the-queue-proposes-a-policy-change-from-repeated-approvals.md);
  no method changes, so the contract stays 1.1); the schemas in `schemas/` are canonical. It depends on nothing but Cordis.
- Contract 1.1 adds a policy change through the queue
  ([approvals](../../docs/design/approvals.md#a-policy-change), ADR-0041): `proposePolicy` takes one
  policy record from the operator's channel only (INV-6), and asks one `policy-change` request on
  the exact hash of the whole set it makes (`POLICY_SET_REF`, requester `approvals` with its
  `policyChangeId`); only the operator's approval of that request, while the set it was proposed on
  is still in force, applies it, recorded as a `policy-change` decision with the old and new
  hashes, after which open requests are judged again. `policyChanges` lists the changes; `policy()`
  names the set in force (`set`). Both methods are optional: a provider at 1.0 has none, and its
  policy changes only by configuration and a restart.
- `check`'s `mode` is the mode once the required checks pass. Required checks are the result's:
  a caller that accepts or applies a result passes the checks it ran and treats a non-empty
  `failedChecks` as not yet allowed; one that gates work while it runs (readiness, a Worker's
  tool call) records them as pending, and they bind at acceptance
  ([approvals](../../docs/design/approvals.md#a-verdict-is-not-yet-a-permission)). `at` on
  the queue methods is a test seam; production callers fill it from the wall clock.
- The conformance suite is [`conformance/approvals.ts`](conformance/approvals.ts), run through
  the [conformance runner](../libs/conformance/runner.ts) at contract 1.1:
  - the strictest mode of the studio and project policies, and a fail-closed default;
  - every classification an `autonomy` decision with its policy set's hash; required checks; the
    commands list, matched by exact argv, which a forbidden `command` class overrides; an argv
    word with a shell metacharacter forbidden;
  - a request only on a recorded `ask` that judging the action again confirms (its class, its
    project's policies), on a subject with a version; its bounded expiry, the shortest applying
    rule's; batching;
  - a verdict bound to the exact subject, written as `approval@1.0` by the operator; refusals that
    change nothing;
  - expiry rejects with `denied:expired`; withdrawal; listing;
  - from 1.1: a proposed record asked as one `policy-change` request on the proposed set's hash,
    nothing changed until then, and a caller refused the queue's own requester; applied only on
    approval, as a `decision@1.6` naming the old and new hashes, then the open requests it no
    longer asks for withdrawn; a rejection or expiry changing nothing; a proposal the load-time
    rules, the version rule, or the one studio policy refuse queueing nothing; a change withdrawn
    once another set came into force.

  It also exports `FakeApprovals`, which passes it at 1.1, over the policies in `POLICIES`; it
  applies an approved policy change in memory, and its `reload(policies)` stands for a new
  configuration and a restart, after which it withdraws (cause
  `withdrawn`, decider rule `approvals.policy`) what the policies no longer ask for, as the
  store-backed provider does at load and on every sweep.
