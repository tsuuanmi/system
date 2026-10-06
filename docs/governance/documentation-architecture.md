# Documentation architecture

System adopts the documentation architecture principles used by the DNA project,
adapted to the needs of this repository.

The goal is a **knowledge system**, not a large `docs/` tree.

## Core rules

### One fact, one canonical home

A fact has one authoritative document. Other documents link to it instead of
copying it.

### Documentation changes with the system

Changes to behavior, contracts, architecture, ownership, runtime expectations, or
validation must update the affected canonical documentation in the same change.

### Do not mix knowledge lifecycles

Keep these classes distinct:

- **canonical / living** — what is true now;
- **historical / durable** — why a durable decision was made;
- **evolutionary** — a change being proposed;
- **exploratory** — evidence and experiments not yet accepted;
- **executable reality** — source and tests.

A proposal is not production truth. Research is not architecture. An ADR is not
a mutable current-state design document.

## Initial System layout

The initial repository intentionally starts small:

```text
docs/
├── README.md
├── architecture/
│   ├── README.md
│   └── philosophy.md
├── requirements/
│   ├── README.md
│   └── mvp.md
└── governance/
    ├── README.md
    └── documentation-architecture.md
```

This is not the final required tree.

Add a category only when real knowledge needs that lifecycle.

Likely future categories include:

```text
design/
decisions/
  adr/
proposals/
research/
validation/
engineering/
operations/
security/
reference/
```

Do not create empty or speculative categories merely for symmetry.

## Current ownership

### `requirements/`

Owns what must be true.

The MVP lives here because it is normative scope and acceptance intent.

### `architecture/`

Owns where responsibilities belong, dependency direction, semantic boundaries,
runtime placement, and cross-cutting invariants.

System philosophy currently lives beside architecture because it constrains
architectural choices directly.

### `governance/`

Owns how repository knowledge evolves.

It must remain small and stable.

## Future knowledge areas

When introduced:

### `design/`

Own current implementation-facing mechanisms.

### `decisions/`

Own append-only durable rationale, commonly ADRs. A changed decision should
supersede the prior record rather than rewriting history.

### `proposals/`

Own reviewable changes that are not yet current truth.

### `research/`

Own experiments, ecosystem analysis, alternatives, and evidence that may support
a proposal or decision but is not normative itself.

### `validation/`

Own how important claims are demonstrated beyond individual test files.

### `engineering/`

Own how System is developed, tested, built, and released.

### `operations/`

Own real operational procedures and incident learning when a production
operational boundary exists.

### `security/`

Own trust boundaries, secrets policy, threat models, and supply-chain/security
requirements when those artifacts become real.

### `reference/`

Own exact lookup material such as configuration, schemas, protocol contracts, and
stable command/API semantics.

## README files are routers

A README orients the reader and points to canonical knowledge. It should not
become a second copy of the underlying documents.

The repository README answers:

- what System is;
- the core mental model;
- where to read next.

`docs/README.md` routes by knowledge role.

Folder READMEs explain ownership and canonical entry points.

## Implementation documentation

Do not create a hand-maintained shadow of the source tree under `docs/`.

When implementation modules exist, colocated source-directory READMEs may explain:

- what the boundary owns;
- what it does not own;
- primary entry points;
- dependency direction;
- local invariants;
- links to canonical architecture/design/reference/tests.

Fine-grained API detail belongs in language-native documentation and source.

## Knowledge flow

A substantial future change may flow through:

```text
need / requirement
      |
      v
research
      |
      v
proposal
      |
      v
decision when durable rationale is needed
      |
      v
architecture / design / reference
      |
      v
source + tests
      |
      v
validation
```

Not every change needs every stage.

The important rule is that a lower-authority exploratory artifact cannot silently
become current truth.

## TDD and documentation

Behavioral changes use Red -> Green -> Refactor.

Tests are executable behavioral specifications, while documentation owns the
semantic and architectural context that individual tests should not duplicate.

When a behavioral change alters a documented invariant, the documentation and
tests change together.

## Source standard

This policy is adapted from the reusable standard in
[`tsuuanmi/DNA/docs/governance/documentation-architecture.md`](https://github.com/tsuuanmi/DNA/blob/main/docs/governance/documentation-architecture.md).

System deliberately copies the **knowledge architecture principles**, not
DNA-specific product or scientific content.
