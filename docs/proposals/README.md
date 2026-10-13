# Proposals

Proposals describe **changes under consideration**. They are evolutionary, not
current truth.

## Lifecycle

```text
draft -> proposed -> accepted -> implementing -> implemented
                  \-> rejected
accepted/implemented -> superseded
```

- [Research](../research/README.md) provides evidence. A proposal frames a
  concrete change, its alternatives, validation, rollout, and risks.
- Accepting a proposal does not change production behavior by itself. Current
  truth changes only when requirements, design, source, and tests change.
- Architecturally significant choices are recorded as
  [ADRs](../decisions/adr/README.md).

## Active proposals

- [PROP-0001: Unified system architecture](0001-unified-system-architecture.md),
  **implementing**. Our own harness built on DSH core
  ([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md), which superseded in
  part the standalone host of ADR-0001). It unifies AgentOS routing and teams,
  internet's provider durability and workflows, and the model gateways that
  codex-chatgpt-web pioneered (built anew, ADR-0022).
- [PROP-0002: Decision-assisted routing](0002-decision-assisted-routing.md),
  **draft**. A `ctx.decisions` seam, with the Jev decision model as a first
  provider, infers the tier and capability need for undeclared work. It runs in
  shadow mode first.
- [PROP-0003: Production readiness](0003-production-readiness.md), **draft**.
  Hardening for a per-user deployment: scoped control credentials, agent Workers
  confined for reads, health and drift alerts, bounded retention and tested
  upgrades, versioned releases with provenance, and an `api-first` preset.

Use [0000-template.md](0000-template.md) for new proposals. The
[roadmap](roadmap.md) is a non-normative queue of milestones, not a substitute for
a reviewed proposal.
