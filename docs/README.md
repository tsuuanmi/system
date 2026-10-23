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
3. [Design](design/README.md): how the mechanisms work.
4. [Decisions](decisions/README.md): why durable choices were made.
5. [Proposals](proposals/README.md) and [research](research/README.md): changes
   and evidence that are not yet current truth.
6. [Reference](reference/README.md) and [`schemas/`](../schemas/README.md): exact contracts.
7. Source and tests, starting from the nearest package `README.md`.
8. [Engineering](engineering/README.md) and [security](security/README.md): how
   the system is delivered and how its trust boundaries are protected.
9. [Validation](validation/README.md) and [operations](operations/README.md):
   the acceptance evidence, and how the built system is run.
10. [Governance](governance/README.md): lifecycle, ids, and documentation policy.

## Find a document by task

| To … | Read |
|---|---|
| run or recover the built system | [operations](operations/README.md): runbooks (first start, a waiting board task, a review, an expired request, a policy change, a limited pool, a run's worktree) and playbooks (a stuck run, quota, a provider UI change) |
| know what the Base release (v0.8) must deliver, and what is built | [release scope](requirements/release-scope.md#base-v08), [PROP-0010](proposals/0010-base-version.md), the [roadmap](proposals/roadmap.md) |
| understand the board, the approval queue, or the resource ledger | [board](design/board.md), [approvals](design/approvals.md), [resources](design/resources.md), their [record semantics](reference/schemas.md), and the package READMEs they name |
| understand the feedback loop (experiments, evaluations, verdicts, lessons) | [PROP-0011](proposals/0011-feedback-loop.md), [experiments](design/experiments.md), [evaluations](design/evaluations.md), [statistics](design/statistics.md), [ADR-0045](decisions/adr/0045-feedback-loop-guarantee-seams.md), [ADR-0046](decisions/adr/0046-evaluation-and-promotion-integrity.md) |
| call a tool or use the operator page | [MCP tools](reference/mcp-tools.md), [web UI API](reference/web-ui.md), [CLI](reference/cli.md) |
| run an experiment on the live install | [experiments](validation/experiments/README.md): lead agnosticism, worker agnosticism on `review` (its pre-registered records) |
| see why the core is shaped this way | [ADR-0036](decisions/adr/0036-guarantee-core-and-capability-plugins.md) to [ADR-0039](decisions/adr/0039-base-guarantee-seam-contract-changes.md) |

## Authority and durability

| Area | Role | Class |
|---|---|---|
| [Requirements](requirements/README.md) | normative intended behavior | canonical / living |
| [Architecture](architecture/README.md) | structure, boundaries, invariants | canonical / living |
| [Design](design/README.md) | mechanisms (target, with a link to what is implemented) | canonical / living |
| [Reference](reference/README.md) + [`schemas/`](../schemas/README.md) | exact contracts and schemas | canonical / living |
| source + tests | executable behavior and evidence | executable reality |
| [Engineering](engineering/README.md) | development and delivery process | canonical / living |
| [Security](security/README.md) | trust boundaries and controls | canonical / living |
| [Governance](governance/README.md) | lifecycle and documentation policy | canonical / living |
| [Validation](validation/README.md) | acceptance evidence: traceability, release checklist, experiments | canonical / living |
| [Operations](operations/README.md) | runbooks and playbooks for the built system | canonical / living |
| [Decisions](decisions/README.md) | historical rationale | historical / durable |
| [Proposals](proposals/README.md) | reviewed change under evolution | evolutionary |
| [Research](research/README.md) | evidence, analysis of external systems | exploratory |

## Status ownership

Each kind of status has one home, so it is never stated twice:

| Status | Home |
|---|---|
| what a package does **now** | the package's own `README.md` |
| what was **verified live**, and on which date | the [release checklist](validation/release-checklist.md) only |
| which milestones are done, and what remains | the [roadmap](proposals/roadmap.md), as a short table |
| the **target** mechanism | the design document, which says it describes the target and adds one line, "Implemented in [package]; differs from target: …" |

Requirements, architecture, and design documents describe the **target** system
and say so in their headers. Architecture documents carry no status narrative.
A seam's status is one word: **built**, **planned**, or **not planned**.

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
├── validation/
├── operations/
└── governance/
schemas/              # machine-readable JSON Schemas (repository root)
```
