# system documentation

This is the canonical knowledge router for humans and coding agents.

The documentation follows the
[DNA Documentation Architecture Standard](https://github.com/tsuuanmi/DNA/blob/main/docs/governance/documentation-architecture.md),
as adopted in [governance](governance/README.md). Each document is organized by
**role, authority, lifecycle, and ownership**. Each fact has one canonical home, and
other documents link to it instead of repeating it.

## Read order for a change

1. [Purpose](requirements/purpose.md) and [requirements](requirements/README.md):
   why `system` exists and what must be true.
2. [Architecture](architecture/README.md): where responsibilities and invariants belong.
3. [Design](design/README.md): how current mechanisms work.
4. [Decisions](decisions/README.md): why durable choices were made.
5. [Proposals](proposals/README.md) and [research](research/README.md): changes
   and evidence that are not yet current truth.
6. [Reference](reference/README.md) and [`schemas/`](../schemas/README.md): exact contracts.
7. Source and tests, once they exist.
8. [Engineering](engineering/README.md) and [security](security/README.md): how
   the system is delivered and how its trust boundaries are protected.
9. [Governance](governance/README.md): lifecycle, ids, and documentation policy.

## Authority and durability

| Area | Role | Class |
|---|---|---|
| [Requirements](requirements/README.md) | normative intended behavior | canonical / living |
| [Architecture](architecture/README.md) | structure, boundaries, invariants | canonical / living |
| [Design](design/README.md) | current mechanisms | canonical / living |
| [Reference](reference/README.md) + [`schemas/`](../schemas/README.md) | exact contracts and schemas | canonical / living |
| source + tests | executable behavior and evidence | executable reality |
| [Engineering](engineering/README.md) | development and delivery process | canonical / living |
| [Security](security/README.md) | trust boundaries and controls | canonical / living |
| [Governance](governance/README.md) | lifecycle and documentation policy | canonical / living |
| [Decisions](decisions/README.md) | historical rationale | historical / durable |
| [Proposals](proposals/README.md) | reviewed change under evolution | evolutionary |
| [Research](research/README.md) | evidence, analysis of external systems | exploratory |

**Design-phase note.** No source exists yet. Until
[PROP-0001](proposals/0001-unified-system-architecture.md) is accepted and
implemented, the requirements, architecture, and design documents describe the
**target** system. Each one states this in its header. They become current truth
once code realizes them.

## Directory layout

```text
docs/
├── README.md
├── requirements/
├── architecture/
├── design/
├── decisions/
│   └── adr/
├── proposals/
├── research/
├── engineering/
├── security/
├── reference/
└── governance/
schemas/              # machine-readable JSON Schemas (repository root)
```

`validation/` and `operations/` will be created when there are acceptance
evidence and runtime procedures to put in them.
