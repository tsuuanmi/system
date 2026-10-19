---
id: PROP-0007
type: proposal
status: implemented
owners: [operator]
created: 2026-10-19
related-requirements: [REQ-ACC-7, REQ-WRK-2, REQ-WRK-8, REQ-TEAM-4]
related-decisions: [ADR-0027, ADR-0029, ADR-0030, ADR-0032, ADR-0033, ADR-0034, ADR-0035]
implementation: [packages/workers-core, packages/plugins/workers, packages/plugins/turns, packages/plugins/workflow, packages/ui-ops, packages/plugins/browser-patchright, packages/plugins/login]
---

# Proposal: Several accounts of one provider share its work

## Problem

The operator wants to run up to five accounts of one provider, five Gemini accounts or five
ChatGPT accounts, and have the work use all of them. Declaring them already works:
[REQ-ACC-7](../requirements/SRS.md) allows any number of accounts per provider, and each one has
its own browser process, login profile, scheduler, and bindings
([ADR-0030](../decisions/adr/0030-session-bound-accounts-use-their-login-profile.md)). But the
accounts do not share the work:

- **First wins.** Routing orders admitted Workers by tier, then quota class, then the `priority`
  list, then id, and takes the first (`workers` `order()`). Nothing ever marks a Worker `busy`. So
  every turn queues on the first account while the other four stay idle. Five accounts are a
  manual spare, not five times the capacity.
- **A limit is never seen.** No UI map recognizes a site's usage-limit message, and nothing sets an
  account `quota-exhausted`, although [routing](../design/routing.md) describes a "limit reached"
  state and REQ-WRK-8 says exhausted accounts are excluded before admission. A limit surfaces as
  the site's own error (`overloaded`) or as a stall.
- **No move to a sibling.** `quota_exhausted`, `challenge`, and `reauth_required` are `USER_ACTION`,
  so the node fails even when nothing was sent and another account of the same provider is
  ready. An unsent `overloaded` is retried, but the retry may route to the same account again.
- **Teams pile onto one account.** With one provider family, the
  [ADR-0029](../decisions/adr/0029-opt-in-same-family-fallback.md) fallback drops the family rule
  *and* the distinct-account rule together. Every member then runs on the first account, though
  four others are free.
- **Costs grow with N.** Background sign-in checks (every 6 h) and feature probes (every 24 h) run
  one account after another and launch a browser each time an idle one was closed. Every account's
  page opens are spaced only within that account, while all five share the host's IP. Google's
  unusual-traffic check has already hit this host once (ADR-0029). Five headed browsers have no
  global cap, and the remote login uses one fixed port, so one account signs in at a time.

## Goals

1. Work of one provider spreads over its ready accounts: the least busy account takes the next
   turn. Ties are broken by the configured order, so routing stays deterministic for a given
   configuration, input, and recorded load (REQ-WRK-2).
2. A site's usage limit is recognized and puts the account (or only the limited feature) in a
   cooldown that routing respects before admission (REQ-WRK-8).
3. A node that failed **before anything was sent** moves to a sibling account of the same
   provider, and the move is a decision artifact (INV-13). A sent turn is never moved (INV-4,
   [routing](../design/routing.md)).
4. With one provider family, team members still land on distinct accounts while distinct accounts
   are available. They share one account only as the last step, as today.
5. Five accounts cost the host and the provider no more than they must: page opens are spaced per
   provider, background checks are spread over their interval, browsers have a cap, and several
   accounts can sign in at the same time.

## Non-goals

- Moving a started turn or a bound conversation to another account. A persistent session keeps its
  account. When that account is unavailable, the session fails as today (`USER_ACTION`); the Lead
  may start a new one.
- Pooling identities: two entries that sign in as the same person stay flagged (REQ-ACC-7), and a
  pool never counts them as two accounts.
- Estimating a site's remaining quota. Cooldowns come from what the site says, and are cleared by a
  probe or by time. They are not predicted from counts (CON-4).
- `system account add/remove` and a per-account usage view
  ([CLI](../reference/cli.md)). They are useful with five accounts, but they are separate changes.
- More provider families, or larger teams (roadmap P3).

## Evidence and research

- **Code survey on 2026-10-19 of `main` a12ebc2.**
  - `workers/src/index.ts` `order()` and `keys()`: first wins.
  - `workers-core` `WorkerState` includes `busy` and `quota-exhausted`, but neither is ever set.
  - `turns`: one scheduler per account with `maxConcurrentTurnsPerAccount`, a global
    `maxPendingTurns`, and `refreshProbes()` loops over the accounts one after another.
  - `provider-core/src/errors.ts`: the dispositions.
  - `workflow/src/engine.ts`: the same-family fallback lifts `restricted` (distinct accounts) along
    with the family exclusion.
  - `login`: each remote login has its own Xvfb and VNC server, held per account; `remotePort`
    defaults to 47318, and 0 picks a free port.
- **Live, 2026-10-16.** Google's reCAPTCHA hit the host and the login profile after copied
  sessions (ADR-0029). Page spacing per account (`pageGapMs`, ADR-0030) followed.
- **Live, 2026-10-19.** The first full `research --deep` run completed on one ChatGPT and one
  Gemini account (run_ca31a6d6207a38dd). A sixth run had stalled on a Gemini Deep research plan the
  page never rendered; the plan reload fixed it. Deep research is the scarcest quota, and a limit on
  it is the most likely limit an operator meets.

## Proposed design

Each part is generic. None names a provider, model, or site
([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)).

### Load as a routing input

- `turns` reports each account Worker's **load**: turns running plus turns queued on its account's
  scheduler. A Worker at its account's concurrency limit reads `busy`. Today `busy` is never set;
  `busy` stays admissible (health already counts it as available).
- The router adds one key **after** tier and quota class and **before** the `priority` list:
  lower load first. The full order becomes tier, quota class, load, `priority`, id. Tier and quota
  stay the operator's first preferences; among equal ones, the least busy account wins, and among
  equally busy ones the configured order still decides.
- **Pending admissions count too.** A routed turn reaches its account's scheduler only later,
  when the node executes. So two nodes routed back to back (both literature branches of one run,
  or two runs started together) would both read load 0 on the same account and pile onto it.
  - `workers` keeps an in-memory count of pending admissions per Worker. `route()` increments it,
    and the count is released when the execution is enqueued or fails to start.
  - Load is the scheduler's load plus the pending admissions.
  - `route()` runs under one lock across all runs: routing is cheap, and two concurrent routes must
    not read the same counts. Today the engine serializes routing within a single run only
    (`routingTurn`).
- The `route` decision records both numbers among each candidate's reasons ("load 1 of 2, 1
  pending"). The decision can then be reproduced from its own record (REQ-WRK-2: deterministic for
  a given configuration and input, where load is part of the input).
- The source is `turns` `describeWorkers()`, which already builds every website descriptor from the
  accounts. It adds the scheduler's running and queued counts.
- A pool is not a new object: it is the set of Workers of one provider at one tier. Nothing is
  configured to create one.

### Usage limits and cooldowns

A site shows a usage limit in one of two places, and the two are handled differently:

- **Before sending** (a banner, or a tool shown greyed with "limit reached"). The UI map's error
  rules already allow kind `quota_exhausted` (`ui-map.v1.json`), and they are guards checked before
  every action. A rule gains an optional `feature` property (a minor ui-map bump), and the operator
  overlay can add rules without a release (ADR-0021). The turn fails **unsent**, so it may fail
  over (below).
- **As the reply after sending** ("You've reached your Deep research limit…"). This is a **sent**
  turn. A map element for the limit answer classifies it `quota_exhausted` with its feature, the way
  a site's own error answer is classified today (`answer.site-error`). The turn fails and its node
  does **not** fail over (INV-4). The cooldown it sets steers later nodes elsewhere.

Either way, `accounts` keeps a **cooldown** per account and feature: `{ feature | "*", until,
source }`.

- The configured cooldown applies: `featureLimitCooldownMs` (default 6 h) or
  `accountLimitCooldownMs` (default 1 h). Reading the site's own reset time is left out until a live
  limit text shows its format; parsing it is locale- and format-specific.
- A cooldown clears when its time passes, when a turn that used the feature succeeds, or by the
  operator (`system account clear-cooldown <id> [feature]`). A feature probe does **not** clear it:
  a probe proves the tool entry exists, not that quota remains.
- A cooldown is state of the account's Workers, never the account's `status`. The account stays
  `ready`, so sign-in checks and probes still run, and health does not list it as needing the
  operator.
- A Worker in cooldown for every feature it proves (or under `*`) reads `quota-exhausted`. A
  requirement that needs a feature in cooldown does not admit that account (reason
  "deep-research limit until 18:40"). This makes REQ-WRK-8's "excluded before admission" true and
  removes the "nothing sets a Worker `quota-exhausted`" gap in [routing](../design/routing.md).
- `overloaded` stays `overloaded`. Repeated site errors are not guessed to be a limit; only the
  site's limit text is.

### Failover to a sibling account, unsent only

- **The decision is made in recovery, the exclusion is applied in the router.** Recovery
  (`failAttempt`) already knows whether the attempt was sent, the attempt budget, and records the
  `recovery` decision.
  - When a node failed with `quota_exhausted`, `challenge`, `reauth_required`, or `overloaded` and
    **nothing was sent**, recovery chooses a new outcome option, `failover`, within the same
    `maxAttempts`. Its detail names the failed Worker, the kind, and the proof that nothing was
    sent.
  - The first three kinds also change the account's state, so later routes exclude it anyway. The
    attempt exclusion also covers `overloaded`, which leaves the account `ready`.
- The exclusion is persisted on the node row beside `not_before`, so a restart keeps it (a restart
  is reconciliation). The router takes `excludeWorkers` in its route options, the same pattern as
  today's family `exclude`, and records it as a rejection reason ("attempt 2 failed on this account,
  unsent").
- Scope is workflow nodes. A bare `ask` has no recovery and fails as today.
- If the turn may have been sent (a receipt past `beforeSend`), nothing moves: reconciliation and
  the existing dispositions apply unchanged (INV-4).
- A node bound to a session's Worker (a team member's later rounds, a persistent `ask`) never
  moves. Its session keeps its account.

### Teams on one provider: a middle step

The same-family fallback gains a middle step. It is an amendment to ADR-0029, recorded in a new
ADR on acceptance:

1. Different family **and** distinct account, as ADR-0027 requires (today's first route).
2. With `allowSameFamily` on: same family allowed, **distinct account kept**. This is new.
3. Same family and a shared account, each member in its own conversation (today's fallback).

Steps 2 and 3 are each recorded as an `admission` decision of policy `workflow.same-family`. The
outcome is `same-family` for step 2 and `same-family-shared-account` for step 3. The team's final
record says which. A team on five accounts of one provider is still one model judging itself, and
says so (ADR-0029), but its members no longer share one account's quota and conversation history.

### Pacing, background checks, caps, and logins

- **Page opens per provider.** Besides `pageGapMs` per account (ADR-0030), a new
  `providerPageGapMs` (default 3 s) spaces page opens across all accounts of one provider. Several
  accounts of one site share the host's IP.
- **Background checks spread out.** Each account's sign-in check and feature probe is due at an
  offset within its interval, derived from its id (stable across restarts). At most one background
  operation per provider runs at a time. Turns keep priority, as today.
- **Browser cap.** `browser` gains `maxBrowsers`, the most account browsers open at once (default
  unlimited, so nothing changes until the operator sets it).
  - A turn that needs another browser over the cap closes the longest-idle browser that holds no
    turn.
  - When every open browser holds a turn, the new turn waits in the queue, which `maxPendingTurns`
    already bounds.
  - Health reports open browsers against the cap.
- **Parallel logins.** Each remote login already has its own Xvfb, VNC server, and login profile,
  and is held per account. Only the fixed port (`remotePort` 47318) stops a second one. The default
  becomes a free port (`remotePort: 0`), and the CLI prints its tunnel command with that port. A
  test proves two concurrent remote logins.

### Contract and documentation changes on acceptance

- **ADRs:**
  - least-busy routing, with pending admissions and a routing lock across runs;
  - unsent `USER_ACTION` and `overloaded` kinds retry with an account exclusion;
  - the distinct-account middle step, which amends ADR-0029.
- **Requirements:** REQ-WRK-2 notes load as a recorded input. REQ-WRK-8 stays and becomes true.
  REQ-TEAM-4 gains the middle step.
- **Schemas:** the capability descriptor's `load` (minor bump); the account's `cooldowns`; the
  error rule's optional `feature` in the UI map schema.
- **Reference:** configuration for `providerPageGapMs`, the two limit cooldowns, and `maxBrowsers`;
  playbooks for a cooldown; the [routing](../design/routing.md) and [teams](../design/teams.md)
  design pages.

## Alternatives considered

- **Round robin.** It spreads the work but ignores how busy each account is, and its position is
  state that a decision would have to record anyway. Least busy uses state the runtime already has.
- **Fill first, then spill.** This uses fewer accounts and may draw less attention from a site, but
  it serializes the work. The operator chose spread. `providerPageGapMs` and the spread checks
  address the attention risk instead.
- **Treat repeated `overloaded` as a limit.** It would guess. A site's own error and its usage
  limit have different remedies, and a false cooldown hides a ready account for hours.
- **Move sent turns too.** That would duplicate provider turns (INV-4). Rejected.
- **A pool object in configuration.** Provider and tier already define the pool, so there is
  nothing to configure and nothing to keep in step.

## Validation plan

- **Router conformance** (fake Workers):
  - the least-busy order;
  - pending admissions: two parallel nodes of one run, and two runs started together, land on two
    accounts;
  - the tie order by `priority`, then id;
  - load shown in the decision;
  - `busy` stays admissible;
  - tier and quota still come first.
- **Turns:**
  - load reported per account;
  - `busy` at the concurrency limit;
  - background checks spread out, one per provider at a time;
  - `providerPageGapMs` spacing across two accounts of one fake site.
- **Limits:**
  - a limit shown before sending fails unsent and fails over;
  - a limit given as the reply fails sent, does not fail over, and sets the cooldown;
  - the cooldown excludes that account for that feature only, and admits it for another;
  - a probe does not clear a cooldown; a successful turn with the feature, and the operator
    command, do;
  - the account stays `ready` and keeps its background checks;
  - an overlay rule works without a release.
- **Failover** (workflow e2e on the fake site, two accounts):
  - an unsent limit, challenge, or sign-out moves the node to the sibling, with one `recovery`
    decision whose outcome is `failover`;
  - the exclusion survives a restart;
  - a sent turn never moves;
  - a session-bound node never moves.
- **Teams:**
  - one provider and three accounts give three distinct accounts and step-2 records;
  - one provider and one account give step 3, as today.
- **Browser cap:** with `maxBrowsers: 2`, three accounts' turns run, and an idle browser is closed
  first.
- **Logins:** two concurrent remote logins on free ports.
- **Live, short first:**
  - a second account of one provider added by the operator;
  - two concurrent `ask`s land on two accounts;
  - a two-member brainstorm lands on two accounts;
  - one research run.
  - A Deep research limit is checked only when the operator meets one.

## Rollout and rollback

- Least-busy routing and the middle step take effect on upgrade. With one account per provider,
  routing chooses exactly as today: load ties are broken by the old order.
- `maxBrowsers` and `providerPageGapMs` default to no change and a 3 s gap. `limit` rules ship
  empty until a site's limit text is seen live; the operator overlay can add them.
- Rollback is a release downgrade. Cooldowns live in account state, so an older release ignores
  them (the account reads `ready`).

## Observability and operations

- `route` decisions show each candidate's load and pending admissions. A `recovery` decision with
  outcome `failover` names what moved and why.
- `system account list` shows cooldowns and their reset times. Health shows open browsers against
  the cap.
- **Playbook "an account hit its limit":** what the cooldown means, when it clears, and
  `system account clear-cooldown`.
- **Runbook:** with free login ports, the operator's `ssh -L` tunnel changes with every login, and
  the CLI prints it.

## Security and privacy

- No new data leaves the host. A limit rule matches site text locally. A cooldown stores only a
  feature name and a time.
- Spreading work over accounts spreads one operator's prompts over several of their own accounts,
  under the same egress policy (INV-12). Accounts that resolve to one identity stay flagged.
- Faster page opens across accounts could look more automated to a site. `providerPageGapMs` and
  the spread checks lower that risk, and the defaults stay conservative.

## Compatibility and migration

- The capability descriptor gains `load` (minor schema bump).
- Account state gains `cooldowns` (additive).
- Recovery decisions gain the `failover` outcome, and admission decisions the
  `same-family-shared-account` outcome. Old runs still explain, because these are new values and
  nothing is renamed.
- The node row gains its attempt exclusion (a forward migration).
- The ui-map error rule gains an optional `feature` (minor bump).
- No configuration needs to change.

## Decision

Owner direction (2026-10-19), on the questions this proposal raises:
- spread by least busy;
- failover only when nothing was sent;
- teams on one provider use distinct accounts of the same family;
- all four limits: pacing per provider, spread checks, a browser cap, and parallel logins.

Engineer review (2026-10-19) found these, all folded in:
- a routing race (pending admissions, a lock across runs);
- failover decided in recovery and excluded in the router;
- a limit before sending versus a limit as the reply;
- no reset-time parsing;
- no probe clearing a cooldown;
- a cooldown never as account status;
- parallel logins needing only the free port.

Accepted by the owner on 2026-10-19:
- [ADR-0033](../decisions/adr/0033-least-busy-routing.md): least-busy routing;
- [ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md): unsent failover and cooldowns;
- [ADR-0035](../decisions/adr/0035-one-family-teams-keep-distinct-accounts.md): one-family teams keep distinct accounts.

## Implementation

On `main` by 2026-10-19, each part gated in full:
- `37e0744`: load, pending admissions, the routing lock;
- `a3c67c8`: cooldowns, error rules with `feature` and `on`, the overlay adding elements and rules, the describe timeout;
- `4515356`: answer rules scoped to the answer just read;
- `f78fbf8`: unsent failover;
- `6d06bed`: every tier of the failed account left out;
- `cacadbf`: the team middle step;
- `d87f4b5`: pacing per provider, spread sign-in checks;
- `f9d2640`: `maxBrowsers`;
- `e218ae7`: free login ports.

Live checks wait for a second account of one provider:
- two concurrent `ask`s on two accounts;
- a two-member team on two accounts;
- a failover.
