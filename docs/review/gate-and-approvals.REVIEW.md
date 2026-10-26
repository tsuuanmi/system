---
paths:
  - packages/approvals-core/
  - packages/plugins/approvals/
  - packages/plugins/leases/
  - policies/
  - docs/design/approvals.md
owner: operator
version: 1
---
# Review guide: the gate, the autonomy policy, and approvals

## What failure looks like here
- A refusal that becomes a permission: a change that makes a denied call allowed, an `ALWAYS_ASK` class that can be `auto`, a listed command matched by pattern instead of its exact words, a shell metacharacter that no longer forbids.
- A policy that can loosen when a project or studio policy tightens it: strictest wins, always. A path map that makes an unmatched or unreadable path anything but heavy (ADR-0071).
- A decision with no record, or an approval not bound to the exact subject it approves (INV-5): approving a plan, a tree, or a policy set that has since changed.
- A request that can be answered by the Worker that raised it, or by a conversation instead of the operator (INV-6).
- A write to `policies/` that changes who decides, without a `policy-change` approval path and a version bump.

## What to check first
1. The truth table of the gate for the changed rule: every row of allow, ask, deny before and after.
2. Whether a lower layer (a project policy, a charter, a playbook) gained the power to loosen a higher one.
3. `check:tiers` still loads the map and matches every tracked path.
4. The tests assert the denial, not only the allowance.

## Paths to skip
- Generated policy reference tables; example policies under `docs/operations/examples/` unless a rule's meaning changed.

## Nit cap
At most 2 nits in all, then "and N more nits". A nit is never `important`.

## Evidence rule
Every finding names a file and a line and the call that changes outcome: "`policy.ts:88`: `rm -rf x` was `forbid`, is now `ask`". A finding without that call is a `nit`.

## Summary rule
Open with the count: "1 important, 1 nit, 0 pre-existing". The first sentence says whether any outcome moved toward permission.
