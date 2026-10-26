# Experiment records

The records of the [experiments](../README.md): plain JSON documents, one per record. Those of
the worker-agnosticism experiment follow the field lists of
[PROP-0011's records](../../../proposals/0011-feedback-loop.md#records). F1's schemas
(`objective-contract@1.0`, `hypothesis@1.0`, `experiment@1.0`, `evaluation@1.0`, and the `verdict`
decision of `decision@1.7`) are in [`schemas/`](../../../../schemas/README.md), but these files are
not converted to them yet, so nothing validates them. Each is converted to its schema field by
field, its hashes are recomputed by the registry, and the conversion is recorded as the next
revision.

| File | Record | State |
|---|---|---|
| [review-objective-contract.v1.json](review-objective-contract.v1.json) | objective contract `review-workflow`, version 1: what "better" means for `review` | pre-registered, 2026-10-23 |
| [review-worker-agnostic.hypothesis.json](review-worker-agnostic.hypothesis.json) | hypothesis `review-worker-agnostic` | pre-registered, 2026-10-23; its fingerprint hash is filled at the freeze |
| [review-worker-agnostic-1.experiment.json](review-worker-agnostic-1.experiment.json) | experiment `review-worker-agnostic-1`: arms, suite, metrics, protocol, stopping rule, budget, seed, independence, registry answer | `proposed`: its [preconditions](../worker-agnosticism.md#preconditions) are open; the operator fills its pins, then [freezes](../worker-agnosticism.md#2-pin-and-freeze) it. Once agent Workers are moved to accounts × roles, it is first revised with the Worker ids the move prints ([runbook](../../../operations/runbooks.md#migrate-agent-workers-to-accounts--roles), step 7) |
| [review-suite.v1.json](review-suite.v1.json) | the suite: two pinned commits, nine labels, the request text, the matching rule (PROP-0011 F5's suite) | labels proposed by the maker's family; the operator confirms them before the freeze |
| [workflow-golden-set.v1.json](workflow-golden-set.v1.json) | the [workflow eval](../workflow-eval.md)'s golden set, version 1: past board tasks, each pinned to its base commit, with its goal, criteria, and grader | three tasks (T184, T187, T188); their graders not yet calibrated. A change is the next version, never an edit: a plan binds the set's hash |
| [workflow-variants.v1.json](workflow-variants.v1.json) | the workflow eval's process variants: `current` ready; `fix-in-author-session` and `no-validate-step` planned | a changed variant refuses the next command of an eval planned with it |
| [lead-agnosticism-1.record.json](lead-agnosticism-1.record.json) | the [lead-agnosticism](../lead-agnosticism.md) run: a pass/fail check, outside PROP-0011 (no objective contract) | planned |

The evaluation and the `verdict` are written by the [helper](../worker-agnosticism.md#4-collect-adjudicate-evaluate)
into the experiment's trials directory and copied here when the experiment closes; the lesson that
follows is the operator's.

- **Append-only once frozen.** A change to a frozen record is a new revision (`revision` + 1,
  `supersedes` naming the old one), never an edit: the helper refuses to collect or evaluate
  records that differ from what was frozen.
- **Evidence stays outside the repository.** Raw run exports and session transcripts are kept in
  the experiment's directory on the host; a record names each file with its sha256.
