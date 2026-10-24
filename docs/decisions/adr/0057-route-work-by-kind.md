# ADR-0057: A step names its kind of work; a Worker the operator gives kinds takes only those

- **Status:** Accepted (from D35 and D36, 2026-10-24)
- **Date:** 2026-10-24 (accepted 2026-10-24, by the operator, D47)
- **Related:** [ADR-0027](0027-provider-diversity-in-routing.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0038](0038-confined-commands-for-claude-code-workers.md),
  [ADR-0049](0049-read-only-agent-workers-as-review-members.md),
  [ADR-0051](0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md),
  REQ-WRK-1, REQ-WRK-2, REQ-WRK-11,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in)

## Context

The operator decided to route by kind of work (D35): source-code updates on Claude Code; docs and
test work on the Codex CLI or the Antigravity CLI; brainstorms on website Workers plus those two
CLIs. D36 adds a writing Claude Code Worker on the system repository, a worktree per run.

What exists already chooses a Worker by what the work needs, never by what the work is about:

- **Capabilities** tell writing from reading (`develop` and `validate` need a `workspace-write`
  sandbox, `review` a `read-only` one), but a source-code change and a docs change both need
  `develop`. Two writers that both prove it are ordered by tier, quota class, load, and the
  `priority` list, the same for every step, so one of them takes every writing step.
- **Tiers** could keep one writer off a step by declaring it a lower tier than it is, but a tier
  is what the Worker's mode serves (REQ-WRK-9); declaring it falsely to steer work breaks
  escalation and the record.
- **Provider families** are compared for inequality only. A template step naming the families it
  may run on is what ADR-0027 refused (option 2): no template, profile, or routing code holds a
  family value, and a family is a vendor's identity.
- **Scoped offers** (ADR-0049) limit an offer to one kind of work, but an unscoped offer still
  proves its capability for every kind, so a scope admits a Worker to a kind of work and never
  keeps one out; and the only scope is `review-member`, named by the engine alone.
- **Roles and assignments** (ADR-0051) already let the operator say which accounts serve which
  settings; nothing lets a step say which of them it is for.

## Options

1. **Configuration only.** Not enough: with two writers no ordering key sends source-code steps
   to one and docs steps to the other.
2. **Steps name provider families.** Refused by ADR-0027; it names vendors in templates.
3. **Steps name Worker ids or roles** (`restrict`). Worker ids are per host (and per account
   once Workers are account × role), so a template could not carry them; a role is known to the
   `agents` source alone.
4. **Work kinds.** A step names the kind of work it is, an opaque label (`code`, `docs`,
   `tests`); the operator's Worker configuration lists the kinds a Worker takes. Admission
   compares them for equality. Which runtime or account takes a kind stays in the Worker
   configuration and assignments, where vendors are already named.

## Decision

Option 4.

- **Kinds are labels, not tools.** A kind matches `^[a-z][a-z0-9-]{0,31}$`
  (`schemas/common.v1.json` `workKind`). No routing, workflow, or profile code names a tool,
  model, family, or vendor for one (INV-11); a template naming `code` says what its step changes.
- **The step side.** A template step may name `kind`, and a variant may change it. The engine
  puts it in the step's work requirement (`work-requirement@1.2` `kind`) from the admitted spec,
  never from model text (INV-6): a planner's step has no kind, and a remediation fix has the kind
  of the step whose change it fixes. A team step and a source step have none.
- **The Worker side.** A Worker source may describe the kinds the operator gives a Worker
  (`capability-descriptor@1.6` `kinds`, at least one). The `agents` source takes them from the
  configuration: a hand-named Worker's `kinds`, or its role's. A review member's role has none
  (its steps name no kind).
- **The rule** (`takesKind`, check `capability`). A Worker given kinds takes only work whose
  requirement names one of them: never work of another kind, and never work that names none. A
  Worker given none takes any work, as before. So a deployment that gives no Worker kinds routes
  exactly as before, whatever kinds its templates name, and the operator who gives every writer
  kinds keeps each writer to its own work. A kind never proves a capability.
- **Recorded and fail closed.** A refused Worker says why (`takes code work only; this work is
  docs work`); with none left the admission fails, saying that no Worker that proves the
  capabilities takes that kind (INV-2). The route decision says which kind the chosen Worker took.
- **Additive.** Both fields are optional, on minor versions of their records; the workers seam
  gains the fields and `takesKind`, and its conformance suite the rule (ADR-0036: an additive,
  optional change).

## Consequences

- D35's code, docs, and test routing is configuration: kinds on the writers, and the
  `algorithm-development` template's steps (`develop:1` is `code` work, `validate:1` is `tests`
  work, and its `docs` and `tests` variants make `develop:1` that kind of work).
- A Worker given kinds takes no unkinded work: `agent-review`, the review step of
  `algorithm-development`, a digest, a planner's steps. The operator keeps a Worker without kinds
  for those, or they fail admission, saying so.
- D35's brainstorm part is not reached by kinds: a brainstorm member's step needs `reason`, which
  an agent Worker never offers outside a review member's steps (ADR-0049 keeps a brainstorm from
  them). Agent Workers as brainstorm members would supersede ADR-0049 in part and widen
  `workScope`; that is left to a decision of its own.
- A board task's next attempt resumes its earlier session only on a Worker that takes the kinds
  of the steps that would run in it; otherwise it starts fresh, given the brief.
- Kinds are compared for equality only; they are never ordered or preferred. Routing among the
  Workers that take a kind is unchanged.
