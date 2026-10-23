# ADR-0045: Evaluation integrity and promotion integrity join the invariants

- **Status:** Proposed
- **Date:** 2026-10-23
- **Related:** [PROP-0011](../../proposals/0011-feedback-loop.md#invariant-candidates),
  [ADR-0044](0044-feedback-loop-guarantee-seams.md),
  [INV-4](../../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay),
  [INV-5](../../architecture/invariants.md#inv-5-exact-subject-binding),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)

## Context

INV-5 binds evidence, results, reviews, and approvals to the exact subject they were produced for.
The feedback loop (PROP-0011) produces a kind of evidence that is easy to misuse: an evaluation
showing that one candidate, under one contract and suite, did well. Reused for another candidate,
for a changed contract, or for a suite the candidate has seen, it would let `system` change itself
on evidence about something else. A promotion that rests on it moves a plugin to `default`, a
change of what runs everywhere. The proposal names two rules that apply INV-5 to
self-improvement, and says each would need an ADR to join the invariants.

## Options

1. **Leave them in the design documents** of the registry, the engine, and the plugin host. They
   would bind only the providers of today, and a later seam (a promotion path, shadow and canary
   runs) could ignore them without an ADR.
2. **Make them invariants**, INV-16 and INV-17, binding on all code, changeable only by ADR.

## Decision

Option 2, once the operator accepts this record. The two invariants, as `invariants.md` will hold
them:

**INV-16 Evaluation integrity.** An evaluation is valid only for its pinned candidate, baseline,
suite, objective contract, and environment. It never authorizes another candidate, a changed
objective, or a changed suite: a changed pin is a new experiment, and an evaluation whose pins or
seals moved while it ran is `invalid`.

**INV-17 Promotion integrity.** A promotion names the exact accepted evaluation and the subject it
evaluated. Applying it is atomic, authorized by an approval bound to that pair, and fenced against
concurrent lifecycle changes by a lease generation (INV-4).

## Consequences

- On acceptance, [invariants](../../architecture/invariants.md) gains INV-16 and INV-17 with these
  words, and the traceability page lists them with the tests that cite them.
- INV-16 is enforced from F1 by the engine's definition: the suite's scenarios refuse a start
  under changed pins or seals and make an evaluation `invalid` when they move mid-run
  ([evaluations](../../design/evaluations.md#fail-closed-rules)); the registry binds an
  evaluation record and a verdict to the experiment's exact identity.
- INV-17 has no code yet: the promotion request and its lifecycle record are F6. Whether the
  plugin host refuses a move to `default` that no approved promotion names is open (PROP-0011
  Q10); refusing it would change the `pluginHost` contract, with its own ADR.
- Revisit if online evaluation (shadow or canary runs) is built: its evidence binds to live work,
  and INV-16's pins would have to name it.
