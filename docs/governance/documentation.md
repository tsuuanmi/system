# Documentation policy

## Standard

`system` adopts the
[DNA Documentation Architecture Standard](https://github.com/tsuuanmi/DNA/blob/main/docs/governance/documentation-architecture.md)
by reference. The standard is not copied here. This file records only
`system`-specific choices.

## Adopted areas

The repository uses the minimum set (`requirements/`, `architecture/`,
`decisions/`, `engineering/`) plus `design/`, `proposals/`, `research/`,
`security/`, `reference/`, and `governance/`, because each already has real
content. Machine-readable schemas live in the root `schemas/` directory, which
has its own README. `validation/` and `operations/` will be added when
acceptance evidence and runtime procedures exist.

## Identifiers

| Id | Home | Stability |
|---|---|---|
| `REQ-<FAMILY>-<n>` | [requirements/SRS.md](../requirements/SRS.md) | never reused |
| `QA-<n>`, `CON-<n>` | [requirements](../requirements/README.md) | never reused |
| `INV-<n>` | [architecture/invariants.md](../architecture/invariants.md) | changed only through an ADR |
| `ADR-<nnnn>` | [decisions/adr](../decisions/adr/README.md) | append-only |
| `PROP-<nnnn>` | [proposals](../proposals/README.md) | status in front matter |

## Design-phase rule

Until code exists, canonical documents describe the target system and carry a
"Target state" header. When a component lands, the PR that adds it removes the
header from the documents it makes true, and corrects them wherever the
implementation differs.

## Enforcement

The documentation CI checks are defined in
[engineering/testing.md](../engineering/testing.md#ci-gates-planned) and arrive with
M0. Until then, reviewers check that:

- every `docs/**` directory has exactly one `README.md` router;
- every fact has one canonical home. Diagrams of the layer map live only in
  [architecture/README.md](../architecture/README.md);
- relative links resolve.
