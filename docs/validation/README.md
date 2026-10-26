# Validation

The evidence that `system` does what its requirements say.

| Document | Owns |
|---|---|
| [traceability.md](traceability.md) | every requirement, quality attribute, and invariant, with the tests that cite it. It is generated with `pnpm gen:traceability`, and CI fails when it is stale |
| [release-checklist.md](release-checklist.md) | the manual checks on live accounts that tests cannot make. A skipped item blocks a release |
| [self-build.md](self-build.md) | the record of `system` building itself: its team reviews of its own code, what they found, and what was fixed, before the measured [pilot](../operations/pilot.md) |
| [experiments/](experiments/README.md) | experiments run on the live install, each written before it runs: its question, pass criteria or pre-registered hypothesis and metrics, protocol, and records; among them the [workflow eval](experiments/workflow-eval.md), which replays golden past board tasks to tell whether a process change holds up |
