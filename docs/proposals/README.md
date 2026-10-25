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
- [PROP-0004: Claude Code as the lead (MVP)](0004-claude-code-lead-mvp.md),
  **accepted**. Claude Code delegates research, brainstorm, and review to teams of
  website Workers on two providers that debate and decide by majority vote. Only
  the core templates remain, and retention also deletes the website chats
  `system` created.
- [PROP-0005: Session-bound website accounts](0005-session-bound-website-accounts.md),
  **accepted** ([ADR-0030](../decisions/adr/0030-session-bound-accounts-use-their-login-profile.md)). An account whose site ties its session to the browser that signed in runs its
  turns as tabs of its own persistent login profile instead of fresh contexts from copied state,
  behind a driver capability. Copies died on Gemini (2026-10-16) and on ChatGPT (2026-10-17) while
  the profiles stayed signed in. Gemini goes first.

- [PROP-0006: Model Workers keep sessions](0006-model-worker-sessions.md), **accepted** ([ADR-0031](../decisions/adr/0031-model-worker-sessions-by-replay.md)). A model
  Worker (an API or local model) keeps a session by replaying its transcript, a provider-neutral
  `history` on `ctx.models`, so it can be a team member, carry research's synthesis thread, and
  continue an `ask`. Bounded, durable, idempotent, and egress-checked.

- [PROP-0007: Account pools](0007-account-pools.md), **implemented** ([ADR-0033](../decisions/adr/0033-least-busy-routing.md), [ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md), [ADR-0035](../decisions/adr/0035-one-family-teams-keep-distinct-accounts.md)). Several accounts of one provider
  share its work: the least busy account takes the next turn, a site's usage limit puts the
  account (or one feature) in a cooldown routing respects, a node that failed before anything was
  sent moves to a sibling account, and one-provider teams keep distinct accounts before sharing
  one. Page opens are spaced per provider, background checks spread, browsers capped.

- [PROP-0008: `system` as a startup template](0008-studio-operating-model.md), **draft**.
  Purpose restated around five goals: use paid plans fully, fit existing workflows, delegate with
  confidence, evolve, and optimize accepted results per unit of operator attention. Projects run as
  startups from one template (charter, funding rounds, investor report). Adds the digest layer, a
  task board across runs, intake, tiers `none` and `reflex`, an autonomy matrix with batched
  approvals, a resource ledger with shadow prices, an optimization plugin bundle with a measured
  lifecycle, and an evolution loop.

- [PROP-0009: Core and plugin decomposition](0009-core-and-plugin-decomposition.md), **accepted** ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)).
  From first principles, a six-component core (ledger of record, work state machine, runner, gate,
  resource ledger and metering, plugin host) holds every guarantee; eight plugin families (Worker,
  decision, verification, digest, context, workflow, knowledge, surface) are replaceable behind
  versioned seams.

- [PROP-0010: The Base version](0010-base-version.md), **accepted**
  ([ADR-0037](../decisions/adr/0037-schema-and-protocol-first.md)). The next release: the six
  core components closed and specified by schema and protocol, Claude Code as the first Worker,
  and one multi-day pilot project measured against a baseline. Deep Research is future work;
  website and API Worker work follows Base.

- [PROP-0011: Feedback loop](0011-feedback-loop.md), **proposed**. Research, hypothesis,
  experiment, evaluation, and lesson as records in the ledger of record; a deterministic core
  evaluation engine under versioned objective contracts, offline and paired, with INCONCLUSIVE
  allowed; maker, reviewer, and evaluator of different provider families; a registry that never
  redoes an experiment blindly; promotion through the approval queue. First loop: worker
  agnosticism on the `review` template.

- [PROP-0012: Agent accounts](0012-agent-accounts.md), **accepted** (D23, D24; phases B, C, D, E, and F
  built, ADR-0051 and ADR-0052 proposed). Several sign-ins per agent
  runtime (three Claude Code, two Codex CLI, three Antigravity CLI): enrollment slots are only
  homes; the account id is derived from the verified login, never named; an unverified, changed,
  or duplicate identity is quarantined; Workers are account × role with per-account concurrency,
  pools, and siblings; and a per-provider `accounts: assigned | pooled`, assigned by default and
  required for personal plans, under which a limit makes an account's work wait instead of moving
  it to another account of that provider, website accounts included.

- [PROP-0013: Feedback from work](0013-feedback-from-work.md), **accepted** in part (D32: the
  liveness verdict and the completion gate, to be built; the code-host observer and landing
  deferred until the pilot produces PRs). Three ways for a
  board task's attempts to learn from the work, as facts the core acts on: a code-host observer
  (`scm-<host>`, egress declared) that records a bound PR's CI checks, reviews, and conflicts by
  conditional polling, bound to the head SHA, and briefs the next attempt with the actionable ones,
  with landing (merge or apply) on a `merge` approval bound to the base and head SHAs; a completion
  gate that runs the required checks at a Worker's stop boundary and feeds a failure back in the
  same session, bounded and failing closed; and a liveness verdict under which a failed probe is
  never death and no automation sends input to a session blocked on an approval.

- [PROP-0014: Dispatch by quota](0014-dispatch-by-quota.md), **proposed**. System starts ready
  board tasks on free Workers by itself instead of waiting for the lead. A dispatch sweep in the
  workflow engine takes the ready tasks of active projects by priority, then age. A new action
  class `dispatch` gates each start: the shipped studio policy asks, so the operator approves by
  button, and a project may set auto. The writing step's Worker is chosen among those routing
  admits by a versioned quota score: headroom above a reserve kept for the operator, a window
  about to reset used first, unknown readings after known ones, and metered pools last and only
  inside a cap. Each choice records a reason on every candidate. Parallel runs are bounded per
  account, per project, and in total, with one task per write subject. Starts are capped per
  hour, and dispatch can be paused per project.

Use [0000-template.md](0000-template.md) for new proposals. The
[roadmap](roadmap.md) is a non-normative queue of milestones, not a substitute for
a reviewed proposal.
