# Experiments

Experiments the operator runs on the live install, each written down before it runs: the
question, what passes, what to record, and an executable protocol. Their results are evidence
about `system` itself, beside the [self-build](../self-build.md) record and the
[pilot](../../operations/pilot.md).

| Experiment | Question | State |
|---|---|---|
| [Lead agnosticism](lead-agnosticism.md) | Can a lead of another provider family carry on a project another lead started, through `system`'s MCP tools alone, with no step lost or repeated? | ready, once the live install is updated |
| [Worker agnosticism on `review`](worker-agnosticism.md) | Does swapping one review member's Worker (ChatGPT website for Codex CLI, beside a fixed Antigravity CLI member) leave the team's outcomes within pre-registered margins? The first record of PROP-0011's feedback loop | pre-registered 2026-10-23; blocked: agent Workers cannot be `review` members on this code |

## How an experiment is written and run

- **Written before it runs.** The question, the pass criteria or the hypothesis and its metrics,
  and the protocol are committed before the first call. A change after the first trial is a new
  revision, cited, never an edit ([records](records/README.md)).
- **Records.** One JSON document per record in [records](records/README.md). The worker-agnosticism
  records follow PROP-0011's field lists, to be converted when its schemas (F1) land.
- **Evidence outside the repository.** Run exports and transcripts stay in the experiment's
  directory on the host (`~/experiments/<experiment id>/`); the committed record names each file
  with its sha256.
- **Helpers.** Pure, tested scripts under [`scripts/experiments/`](../../../scripts/experiments/);
  they read the live install only through the `system` CLI, and write nothing to it.
- **Results.** The operator fills the record and commits it. A check the run also verifies goes into
  the [release checklist](../release-checklist.md), its one home for live verification.
