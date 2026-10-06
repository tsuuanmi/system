# System documentation

This directory is the canonical knowledge router for System.

System follows the documentation architecture used by the DNA project: current
truth, requirements, decisions, proposals, research, and implementation evidence
must not be mixed into one undifferentiated document tree. A fact should have one
canonical home and other documents should link to it.

## Current canonical areas

### [Architecture](architecture/README.md)

Owns current system structure, responsibility boundaries, dependency direction,
major runtime relationships, and cross-cutting invariants.

The architecture entry point is the canonical answer to **where responsibility
belongs**.

### [Philosophy](architecture/philosophy.md)

Owns the durable product and architecture principles that constrain design
choices.

Philosophy explains **how System should think about agents, control, reuse,
authority, evidence, cost, and complexity**.

### [Requirements](requirements/README.md)

Owns normative requirements and scope.

The first requirements document is [the MVP](requirements/mvp.md), which defines
what the first useful System must prove and what it deliberately defers.

### [Governance](governance/README.md)

Owns rules for how repository knowledge evolves.

The initial policy is
[Documentation Architecture](governance/documentation-architecture.md).

## Authority model

For the initial repository:

```text
requirements
    -> what must be true

architecture + philosophy
    -> where responsibilities belong
    -> durable constraints on solutions

source + tests
    -> executable reality

proposals / decisions / research
    -> added when real change, rationale, or exploration needs those homes
```

Do not create a category merely to make the tree look mature. New areas such as
`design/`, `decisions/`, `proposals/`, `research/`, `validation/`,
`engineering/`, `operations/`, `security/`, and `reference/` should be
introduced when System has real artifacts that belong there.
