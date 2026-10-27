# ADR-0075: A review finding has a severity and its evidence, and only an important one a second reviewer confirmed blocks

- **Status:** Accepted (2026-10-27; built in T266, `67991500`; with T267, `c524543e`, and T287, `21f1bec1`)
- **Date:** 2026-10-26
- **Related:** T266 (operator, D93), T232 (findings to the author's session), T233 /
  [ADR-0070](0070-workers-that-share-no-session-work-through-a-tasks-dossier.md) (the dossier),
  T237 / [ADR-0071](0071-a-changes-risk-tier-comes-from-the-policys-path-map.md) (risk tiers),
  [ADR-0067](0067-system-accepts-a-listed-branchs-result-on-its-review-and-checks.md) (auto-accept),
  [ADR-0027](0027-provider-diversity-in-routing.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

A review's assessment had three severities (`blocking`, `warning`, `info`), and any `blocking` finding
grew a fix round. Measured on 2026-10-26: 51 runs for about 35 tasks, 33 fix rounds (median 7 minutes,
p90 21), while the review step itself takes a median 1.2 minutes; T245 was held a round for one stray
export. A reviewer's single unchecked claim decides a round, a style remark can be called blocking,
and a re-review read the whole change again and could raise what was already answered.

Anthropic's account of its code review ("Solving code review") reports the shape that converges:
several detectors, a separate verifier voting on each finding, severities *Important* / *Nit* /
*Pre-existing*, re-review of the new diff only, no repeated findings, and class-level flags. Their
mean reviews to pass fell from 2.08 to 1.32, and changes needing five or more rounds from 8.9% to 1.5%.

What constrains it:

- **Records, not accounts** (INV-13): who voted what, and why, is a decision the readers take.
- **Exact subject** (INV-5): a vote binds to the tree the review read.
- **Fail closed where it matters, never on the author:** a finding nobody could verify must not cost a
  round; a defect a verifier confirmed must.
- **Additive:** stored assessments, team reviews, and the board's readers keep working.

## Options

1. **Keep one reviewer's word, and ask for fewer blocking findings in the prompt.** No check on a
   wrong claim, and nothing stops repeats. Rejected.
2. **A team review (two families voting) for every change.** Doubles the review on every change,
   most of which have no important finding. Rejected as the default; teams stay available.
3. **Severity with evidence; a verification step only for important findings; diff-only re-review
   with the open and answered findings.** Chosen.

## Decision

- **Severity.** A finding is `important` (a real defect this change introduces: wrong behaviour, a
  broken invariant, a security or data risk, a missing required test or doc), `nit` (style, naming,
  wording, a small improvement), or `pre-existing` (a defect the change did not introduce). It carries
  its evidence: `file`, `line`, and `evidence` (what fails, and how that line shows it), and may name
  its `class`. An important or pre-existing finding without a file, a line, and evidence is read as a nit
  (`demoted: no-evidence`). The old severities are read as `blocking` → `important`, `warning` and
  `info` → `nit`, so a reviewer cannot skip verification by writing `blocking`.
- **Assessment 1.1** (`assessment@1.1`, additive): finding `id` (`f1`…), `line`, `evidence`, `class`,
  `demoted`, `repeated`, `verification { vote, reason, node, worker }`; the assessment's `summary`,
  which opens with the count (`2 important, 3 nits`, or `no issues`), `said` (the reviewer's verdict
  when the engine's reading changed it), and `approach`. Its `verdict` is `changes-requested` only while
  a confirmed important finding stands (one waiting for its vote requests nothing, and the risk tier
  counts no approval until it is voted on); nits and pre-existing findings alone always approve.
- **Verification.** A review with an important finding grows `<review>:verify`: the review's
  capabilities, in a session of its own, `differentFrom` the review with `diversity: preferred` (another
  provider family where one is free, else the review's family in a fresh conversation, recorded as
  `workflow.diversity`; a review whose Worker declares no family does not fail it). It is bound to the
  exact tree the review read, is given the important findings as data and the change, and votes
  `confirm` or `reject` with a reason on each. Its gate records a `workflow.verification` decision
  (confirmed, rejected, unverified, each reason), stores the review's assessment again with the votes,
  and records a new exact-subject gate on the review naming it: the review's latest assessment is what
  the risk tier, the acceptance, and auto-accept read. A finding it did not vote on, or an answer on
  another subject, is unverified (`vote: none`). The tree having moved fails it as a stale subject.
- **Only a confirmed important finding blocks.** It alone makes the verdict `changes-requested` and
  grows the fix, the gate, and the re-review, after the verification. Rejected and unverified ones are
  recorded and shown, never sent as work. The fix's prompt holds the confirmed findings with their
  evidence and the verifier's reason, the class ("fix every instance"), and the review's nits once, as
  optional notes the author takes or leaves with one dossier response line each. When no fix runs (no
  important finding, or none confirmed), the nits reach the author once as a dossier entry. A nit never
  starts a fix round and never holds auto-accept. The 3-cycle bound (`maxReviewCycles`) is unchanged;
  the verification is not a cycle.
- **Pre-existing findings** each propose a follow-up board task in the task's project, after the
  review's transaction: proposed (the lead or the operator decides it), naming the finding, its
  evidence, the review, run, and task, never a dependency of the task. Once per finding, a
  `workflow.follow-up` decision records the task or why none was proposed; the dossier's evidence entry
  links it.
- **Convergence.** A re-review is shown only the change since the tree the last review read (the review
  history's commits, T232), plus the open findings (confirmed in the last round, to check) and the
  answered ones (every other finding of the earlier rounds: never raise them again). The whole change
  is shown only when no commit holds the last subject. A finding that repeats an answered one (same
  file and title) is marked `repeated`, shown, and never counted, verified, or sent; one still open is
  never an answered one. From cycle 3 on, the reviewer is asked whether the approach should change,
  and answers in `approach`.
- **Shown.** The dossier's review entry opens with the summary and lists the findings by severity with
  their votes; `explain` gives each review step's latest assessment (`review`: summary, findings by
  severity, vote, reason), and the CLI prints it under the step; `/ui`'s review lists the summary and
  the findings by severity with their votes.

## Consequences

- A change whose review found only nits, or whose important findings did not hold, is accepted in one
  round; a verification step costs a second review only when an important finding is raised.
- The board's auto-accept (ADR-0067) counts a confirmed important finding (or an `assessment@1.0`
  `blocking` one) as blocking, never a nit or an unverified finding.
- Readers of `assessment@1.0` keep working: the readers count blocking with one rule (`blocks`).
- **Known limits.** The verifier is one Worker, not a vote of several; a single-family verification is
  recorded, not refused. A repeat is matched by file and title, so a reworded repeat is counted (the
  re-review is told the answered findings, which is the main guard). The follow-up proposal is made
  once per finding by its decision; a crash between the proposal and its decision can propose it twice.
- No store migration; the assessment schema gains a minor version.

## Rejected alternatives

The options above; also: verifying every finding (nits do not need a second reader), blocking on an
unverified important finding when no verifier answers (the round it costs is what this ends), and
keeping `blocking` as a bypass for verification.
