---
"@tsuuanmi/system-feedback-core": minor
---

Clean-up (PROP-0018 T12, O2): `experiments-core`, `evaluations-core`, and `statistics` are one package, `feedback-core`, with the same seams, contracts, suites, and conformance; one manifest, one README, and no package edge between them. The `STATISTICS` pin an experiment records is unchanged (`@tsuuanmi/system-statistics`, version 1). The statistics method type is now `SignFlipMethod`, and its `Interval` is the evaluations' own.
