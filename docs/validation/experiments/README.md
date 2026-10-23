# Experiments

Experiments the operator runs on the live install, each written down before it runs: the
question, what passes, what to record, and an executable protocol. Their results are evidence
about `system` itself, beside the [self-build](../self-build.md) record and the
[pilot](../../operations/pilot.md).

| Experiment | Question | State |
|---|---|---|
| [Lead agnosticism](lead-agnosticism.md) | Can a lead of another provider family carry on a project another lead started, through `system`'s MCP tools alone, with no step lost or repeated? | ready, once the live install is updated |

## How an experiment is written and run

- **Written before it runs.** The question, the pass criteria or the hypothesis and its metrics,
  and the protocol are committed before the first call. A change after the first trial is a new
  revision, cited, never an edit ([records](records/README.md)).
- **Records.** One JSON document per record in [records](records/README.md).
- **Evidence outside the repository.** Run exports and transcripts stay in the experiment's
  directory on the host (`~/experiments/<experiment id>/`); the committed record names each file
  with its sha256.
- **Results.** The operator fills the record and commits it. A check the run also verifies goes into
  the [release checklist](../release-checklist.md), its one home for live verification.
