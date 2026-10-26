# Experiments

Experiments the operator runs on the live install, each written down before it runs: the
question, what passes, what to record, and an executable protocol. Their results are evidence
about `system` itself, beside the [self-build](../self-build.md) record and the
[pilot](../../operations/pilot.md).

| Experiment | Question | State |
|---|---|---|
| [Lead agnosticism](lead-agnosticism.md) | Can a lead of another provider family carry on a project another lead started, through `system`'s MCP tools alone, with no step lost or repeated? | ready, once the live install is updated |
| [Worker agnosticism on `review`](worker-agnosticism.md) | Does swapping one review member's Worker (ChatGPT website for Codex CLI, beside a fixed Antigravity CLI member) leave the team's outcomes within pre-registered margins? The first record of PROP-0011's feedback loop | pre-registered 2026-10-23; not run: its [preconditions](worker-agnosticism.md#preconditions) are open |
| [Workflow eval](workflow-eval.md) | Does a change to System's own process hold up? Golden past board tasks replayed under a named process variant, at least twice each, offline from live work, graded by the tasks' own checks, with the tasks that flipped between variants | the runner, the set's format, and three tasks (2026-10-26); not run: its [preconditions](workflow-eval.md#preconditions) are open |
| [Reviewer eval](reviewer-eval.md) | Does the reviewer still find what it found? Past changes that let a defect escape (a commit pair and the expected important finding) and clean changes, run on every change to the review template, its prompts, or the reviewer's tier or model; recall and false-important rate | the runner, its gate in `pnpm check`, five escapes and three clean changes, every ref pinned (2026-10-26); no measured run recorded: its [preconditions](reviewer-eval.md#preconditions) are open |

## How an experiment is written and run

- **Written before it runs.** The question, the pass criteria or the hypothesis and its metrics,
  and the protocol are committed before the first call. A change after the first trial is a new
  revision, cited, never an edit ([records](records/README.md)).
- **Records.** One JSON document per record in [records](records/README.md). The worker-agnosticism
  records follow PROP-0011's field lists and are not yet converted to its schemas (F1).
- **Evidence outside the repository.** Run exports and transcripts stay in the experiment's
  directory on the host (`~/experiments/<experiment id>/`); the committed record names each file
  with its sha256.
- **Helpers.** Pure, tested scripts under [`scripts/experiments/`](../../../scripts/experiments/);
  they read the live install only through the `system` CLI, and write nothing to it.
- **Results.** The operator fills the record and commits it. A check the run also verifies goes into
  the [release checklist](../release-checklist.md), its one home for live verification.
