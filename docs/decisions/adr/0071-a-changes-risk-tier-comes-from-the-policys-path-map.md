# ADR-0071: A change's risk tier comes from the policy's path map, and a heavy one needs a second family and the operator

- **Status:** Proposed
- **Date:** 2026-10-26
- **Related:** T237, [PROP-0016](../../proposals/0016-operating-model.md) §4 and its decision (D83, open
  question 4), [ADR-0027](0027-provider-diversity-in-routing.md),
  [ADR-0029](0029-opt-in-same-family-fallback.md),
  [ADR-0041](0041-policy-changes-through-the-approval-queue.md),
  [ADR-0063](0063-a-runs-required-checks-run-on-its-exact-result.md),
  [ADR-0067](0067-system-accepts-a-listed-branchs-result-on-its-review-and-checks.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

Every board task's change goes through one process today: one review, the run's required checks,
and, on a listed branch, acceptance by System (ADR-0067). A change to the documentation and a change
to the approval queue get the same review by one Worker and can both be accepted unattended.

PROP-0016 §4 (accepted, D83) tiers the process by risk: the tier of a change is decided by **what it
touches**, by a path map in the policy, never by a model's opinion; the highest tier among the
touched paths wins. The operator's answer to open question 4 fixes the heavy list (the gate and
approvals, dispatch and routing, confinement and credentials, the ledger's guarantees, schemas'
major versions, store migrations, invariants, ADRs) and that a path that cannot be read is heavy.

What constrains it:

- **Deterministic and reviewable:** the map is data the operator owns (handbook layer 2), versioned,
  changed through a `policy-change` approval (ADR-0041), and checked by `pnpm check`.
- **Fail closed** (INV-2): a path the map does not cover, a change that cannot be read, or a policy
  that cannot be read is heavy.
- **Families, never names** (ADR-0027): a second review is required to differ in provider family; no
  family is named or preferred.
- **Records, not accounts** (INV-13): the tier is a decision; the board reads the tier from that
  record, never from the acceptance's own claim.
- **Off until turned on:** with no map, nothing changes.

## Options

1. **A model classifies a change's risk.** Not reproducible and easy to sway (PROP-0016,
   alternatives). Rejected.
2. **A per-task tier set by the lead.** The lead is the party the tiers relieve, and a tier set at
   the start does not know what the change touched. Rejected.
3. **A path map in the autonomy policy, read against the change's paths as the Worker source tells
   them; the engine decides the tier when a review approves and again at acceptance, and acts on it.**
   Chosen.

## Decision

- **The map.** `autonomy-policy@1.1` adds the optional `riskTiers: { version, rules }`: each rule
  gives a list of repository-relative path patterns a tier (`light`, `normal`, `heavy`) and says why
  (`note`). `*` matches within one path segment, `**` any number of whole segments, and a pattern
  ending in `/` is that directory and everything below it. A pattern with a `..` segment, a leading
  `/`, or `**` inside a segment is refused when the policy loads. At most 200 rules of 64 patterns.
- **A path's tier** is the **highest** tier of the rules that match it, not the most specific one: a
  README in a heavy package is heavy. A path no rule matches is heavy.
- **A change's tier** is the highest of its paths' (a rename counts both paths), under every
  applying policy that carries a map (the studio's, then the project's: a project's map can only make
  a path stricter). A part of the change that cannot be read is a heavy path: a Worker source that
  could not read its worktree, files past the change's bound (`CHANGE_BOUNDS.files`), no source that
  holds a worktree of the run, or `ctx.workers.changes` failing. A policy that cannot be read makes
  the change heavy. With no applying map, tiering is off.
- **Decided, recorded.** The tier is a `gate` decision of rule `workflow.risk-tier` (version 1): the
  maps and their versions, how many paths got each tier, each path (at most 50 listed, the rest
  counted) with its tier, why, and the patterns that matched. It is decided when a review approves a
  change of a board task's run (under that review, before anything after the review is promoted), and
  again on the run's final change before its acceptance (on the run).
- **Heavy: a second review by another family.** When a review approves a heavy change and the
  exact tree has no approving reviews by Workers of two provider families yet, the engine grows a
  second review right after it: worded as that review, bound to the same change, and routed only to a
  Worker of another family (`differentFrom`, ADR-0027). It never runs on the same family for want of
  another, whatever `allowSameFamily` says (ADR-0029 does not apply): with one family the second
  review fails admission and the run fails. Whatever waited for the review waits for it too. Its
  blocking findings grow a fix and a re-review as any review's do, and the re-review's approval of
  the new tree needs another family's again.
- **Heavy: enforced at acceptance.** The task acceptance (`workflow.task-acceptance`, version 4)
  names the run-level tier decision among its inputs (`outcome.detail.risk`), and rejects a heavy
  result unless approving reviews of its exact tree by Workers of two provider families, read from the
  live descriptors, are recorded: the work goes back as another attempt.
- **Heavy: never accepted unattended.** The board holds an accepting decision of a heavy result for
  the operator, by the auto-accept rule (ADR-0067) and by the policy alike, the reason in the hold's
  decision (`detail.heavy`). It reads the tier from the `workflow.risk-tier` decision the acceptance
  names among its inputs; an acceptance that names a tier without that record is held too. Only the
  operator's acceptance accepts it. A rejection applies as before.
- **Light: the validation may be skipped.** A template step marked `riskSkip: ['light']` (only the
  final step, a Worker step that depends on another, never at `heavy`) is retired before it starts
  when the change is light and every check the policy requires of the result is a command that ran
  and passed on the exact tree the review approved (ADR-0063); a `graph-growth` decision of rule
  `workflow.risk-skip` records the skip, or why the step runs. `algorithm-development`'s `validate:1`
  is marked. The run's required checks still bind at acceptance.
- **Shown.** `explain` gives the run's latest tier and why (`risk`), the CLI prints it first, and the
  run's page on `/ui` lists it under *What happened*.
- **The system repository's map** is the `system` project's policy, `policies/system.json`; `pnpm
  check` (`check:tiers`) refuses it unless it loads, matches every tracked path, and names every
  package directory with a rule of its own, so a new package is classified on purpose before it
  lands. It reaches the live policy set through a `policy-change` approval.

## Consequences

- With a map in force, a documentation change can be done without a validation step; a change to
  the gate needs two families' approvals and the operator. With no map, nothing changes.
- **Seams for the later parts of I2.** The second review's wording is the review's own
  (`SECOND_REVIEW` in `workflow/src/risk.ts`), where the adversarial review prompt goes; the board's
  hold of a heavy result names the tier decision a decision brief will summarize. Neither is built
  here.
- **Known limits.** The tier reads paths, not content: a store migration written outside a
  `migrations.ts` file, or a schema's major written in place, is heavy only when its file is; the
  review and `check:migrations` and `check:schemas` remain the checks for those. A run's change is
  read from its worktrees by the Worker source; a run without one is heavy. The rollout PROP-0016
  proposes (labelled in shadow for 30 tasks) is the operator's choice of when to apply the map, not a
  mode of the engine.
- The `workflow.task-acceptance` decision moves to version 4 (`detail.risk`); `autonomy-policy`
  gains a minor version; no store migration.

## Rejected alternatives

The options above; also: the most specific rule wins (a narrower light rule could then lower a
heavy directory, and an ordering mistake would fail open); an unmatched path is normal, as PROP-0016
§4 first wrote (T237 makes it heavy, failing closed as D83 does for an unreadable path, and the
check keeps the map whole so only a new path is ever unmatched); and letting `allowSameFamily` lift the second review's family
rule (it would make the second review the same vendor talking to itself, what ADR-0027 ended).
