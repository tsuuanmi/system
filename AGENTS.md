# AGENTS.md

This file tells coding agents where to look and which repository-wide rules hold.
It stays short on purpose. Product knowledge belongs in canonical documentation
and in source-local `README.md` files, not here.

## Read before changing

For any non-trivial change:

1. Read the repository [README.md](README.md) for scope and status.
2. Read [docs/README.md](docs/README.md) to find the authoritative requirements,
   architecture, decisions, design, and engineering documents.
3. Read the nearest `README.md` in the affected source directory (once source exists)
   to understand what the module owns and which way its dependencies point.
4. Read the affected source and tests.
5. Read proposals and research only for context. They are not current authority.

Find documents by their role, not by filename. If source and normative
documentation disagree, raise the mismatch and reconcile it. Do not silently pick
one.

## Change invariants

- The system-wide invariants in
  [architecture/invariants.md](docs/architecture/invariants.md) are binding.
  Breaking one requires an ADR.
- Everything is a plugin. New behavior goes on a documented seam or event
  ([plugin model](docs/architecture/plugin-model.md)), never as a special case in
  a core path. Deployment-varying values are validated plugin `Config` fields.
- Never name a specific tool, model, or vendor in routing, team, workflow, or
  profile code. Reach tools only through seams
  ([INV-11](docs/architecture/invariants.md#inv-11-no-tool-lock-in)).
- Reuse or adapt an existing tool before building
  ([dependency register](docs/engineering/dependencies.md)).
- Make the smallest coherent production-quality change.
- Keep one authoritative implementation. Do not add parallel runtimes, fallback
  paths, or compatibility layers unless a requirement demands them.
- Do not add a speculative abstraction, protocol, configuration knob, or
  dependency without a concrete requirement. The protocol gates are in
  [ADR-0006](docs/decisions/adr/0006-protocol-introduction-gates.md).
- Research is non-normative until it is promoted.

Documentation is part of the change:

- code behavior change → update the affected canonical docs and tests;
- module responsibility or dependency change → update the nearest source README
  and [architecture/components.md](docs/architecture/components.md);
- seam added or changed → update the
  [seam catalog](docs/architecture/plugin-model.md#seam-catalog) and the seam's
  conformance suite;
- record shape changed → update the JSON Schema in `schemas/` (following the
  versioning rules in [reference/schemas.md](docs/reference/schemas.md)), its
  examples, and the reference semantics;
- new decision point → it must emit a decision artifact
  ([INV-13](docs/architecture/invariants.md#inv-13-every-decision-is-an-artifact));
- runtime dependency added or code ported → update the
  [dependency register](docs/engineering/dependencies.md);
- public API, schema, config, or CLI change → update reference material, requirements,
  and tests;
- durable architectural decision → add an ADR; supersede, never rewrite, an accepted one;
- research-only work → keep it under `docs/research/` until promotion.

Do not duplicate a fact. Give it one canonical home and link to it.

## Verification

Discover the required checks from CI and [engineering](docs/engineering/README.md).
Do not weaken, skip, or suppress a required gate to make a change pass.

## Final review

Before completion:

- inspect the complete diff;
- remove stale paths, dead documentation, and accidental compatibility layers;
- confirm source, tests, contracts, and documentation agree;
- report what changed, what was verified, and any remaining uncertainty.
