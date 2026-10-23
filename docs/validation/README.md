# Validation

The evidence that `system` does what its requirements say.

| Document | Owns |
|---|---|
| [traceability.md](traceability.md) | every requirement, quality attribute, and invariant, with the tests that cite it. It is generated with `pnpm gen:traceability`, and CI fails when it is stale |
| [release-checklist.md](release-checklist.md) | the manual checks on live accounts that tests cannot make. A skipped item blocks a release |
| [self-build.md](self-build.md) | the record of `system` building itself: its team reviews of its own code, what they found, and what was fixed, before the measured [pilot](../operations/pilot.md) |
