# ADR-0041: A policy change goes through the approval queue, and the stored set yields only to the configuration it came from

- **Status:** Accepted; superseded in part by [ADR-0050](0050-the-queue-proposes-a-policy-change-from-repeated-approvals.md) (the queue may also propose, never apply, one commands line from repeated identical approvals; off by default)
- **Date:** 2026-10-23 (accepted 2026-10-23, by the operator)
- **Related:** [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0039](0039-base-guarantee-seam-contract-changes.md),
  [PROP-0010](../../proposals/0010-base-version.md),
  [PROP-0008](../../proposals/0008-studio-operating-model.md#fewer-approvals-reliable-results),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

The autonomy policy decides which actions need a person. Until now a new policy version took
effect only by editing the profile patch and restarting, although `policy-change` is one of the
classes that always ask and the [record semantics](../../reference/schemas.md#autonomy-policy) say
a new version takes effect only through an operator approval. B5 of PROP-0010 lists "a
`policy-change` approval instead of a restart" as open.

Two questions need a decision. The `approvals` seam is a guarantee seam: changing its contract
needs an ADR (ADR-0036). And once an approved set is kept in the store, two sources of the policy
exist, the configuration and the store; which one wins at a start must be fixed and must fail
closed.

## Options

1. **Keep configuration only.** The operator edits the patch and restarts. No approval records the
   change, the queue's own rule for `policy-change` is never used, and the change is not bound to
   what the operator was shown.
2. **A policy change through the queue, kept in the store, the configuration always winning at a
   start.** Simple, but a restart after any edit of the patch, or an upgrade that changes the
   bundle's default policy, would silently drop a change the operator approved.
3. **A policy change through the queue, kept in the store, which applies only while the
   configuration it was derived from is unchanged; on a mismatch neither applies until the
   configuration names the stored set it replaces.**
4. **The stored set always winning.** A changed configuration would be ignored with no sign, and
   the operator would have no way back to it short of editing the store.

## Decision

Option 3.

**`approvals` contract 1.1**, additive and optional for every existing caller and provider:

- `proposePolicy({policy, note?}, at?)`: the operator proposes one `autonomy-policy@1.0` record, a
  policy of the set at a higher version (same scope and project) or the first policy of a
  project. The whole set it makes must load under the configured set's rules, or nothing is
  stored. `policy-change` is judged like any action; on `ask` the queue stores a
  `policy-change@1.0` record and opens one `approval-request@1.1` (requester `approvals`, naming the
  change) on `{content, autonomy-policy-set, <the proposed set's hash>}`. Only the operator's
  channels call it: the web UI and MCP `approvals_policy_propose` at operator scope (INV-6).
- The set comes into force only when the operator approves that request, while the set it was
  proposed on is still in force (otherwise the verdict is refused as `subject-changed` and the
  request is withdrawn; INV-5), in the verdict's transaction, recorded first as a
  `decision@1.6` `policy-change` whose candidates are the old and the new hash (INV-13). Every open
  request is then judged again exactly as at load, and the board puts its own waits to the new
  policy on its next sweep, as it already does on a withdrawal.
- `policyChanges(filter?)` lists the changes; `policy()` gains the optional `set`: the hash of
  the set in force, its source, the configured set's hash, and the projects with a policy.
- A provider at 1.0 has none of these; its policy changes by configuration and a restart. The
  web UI answers `501` for a proposal to such a queue.

**Which set is in force at a start:** the latest applied change's set, while it is not retired,
its `configHash` equals the hash of the configured set (or its own hash does: the configuration is
that set), and it still loads; otherwise the configured set when no change was applied. A stored
set whose configuration changed is never used and never dropped silently: the plugin is refused,
naming both hashes, so no `ctx.approvals` is provided and every action that needs a person waits
(INV-2). The operator either restores the configuration it was derived from, or names the stored
set's exact hash in the row's `supersedes`; the change is then retired with a `policy-change`
decision (decider `approvals.configuration`) and the configuration is in force.

## Consequences

- `approval-request@1.1` (the requester `approvals` and `policyChangeId`), `policy-change@1.0`,
  `decision@1.6`, and `mcp-approvals` 1.2 are added; every other request stays `@1.0`.
- The conformance suite moves to contract 1.1 with five scenarios, which the store-backed provider
  and the fake pass. The fake applies an approved change in memory.
- An upgrade whose bundle changes the default policy refuses the queue on a host where the
  operator approved a change, until the operator decides between the two sets. This is
  deliberate: the alternative is a silent choice between two sets the operator approved.
- `system check` cannot see the store, so it does not report a mismatch before a start; the
  refusal is logged at start with the remedy.
- Revisit if a project's policy must change without touching the studio's set hash, or if
  changes should be proposed by the lead for the operator (today only the operator proposes).
