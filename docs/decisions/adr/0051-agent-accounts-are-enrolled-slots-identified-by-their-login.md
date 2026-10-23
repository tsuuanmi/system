# ADR-0051: Agent accounts are enrolled slots identified by their verified login; Workers are account × role

- **Status:** Proposed (written on the operator's acceptance of PROP-0012, D23)
- **Date:** 2026-10-24
- **Related:** [PROP-0012](../../proposals/0012-agent-accounts.md),
  [ADR-0024](0024-agent-workers-confined-for-reads.md),
  [ADR-0027](0027-provider-diversity-in-routing.md),
  [ADR-0035](0035-one-family-teams-keep-distinct-accounts.md),
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0043](0043-antigravity-cli-workers-gated-on-a-version-verified-live.md),
  [ADR-0052](0052-accounts-are-assigned-unless-pooling-is-recorded.md),
  REQ-ACC-1, REQ-ACC-7, REQ-ACC-11, REQ-TEAM-4,
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-8](../../architecture/invariants.md#inv-8-credentials-never-cross-upward),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in)

## Context

The operator holds three Claude Code, two Codex CLI, and three Antigravity CLI subscriptions, all
personal (D24), and wants each to serve as a Worker, managed by provider and account, without
naming accounts by hand. Today each agent runtime runs in one home, its probe and sign-in check
are cached per runtime kind, and nothing reads who is signed in: a home re-signed as another
person, or two homes signed in as one, would go unnoticed, and a team would count two roles of one
home as two accounts (REQ-TEAM-4). The evidence and the full design are in
[PROP-0012](../../proposals/0012-agent-accounts.md); the operator accepted it on 2026-10-23 (D23).

## Options

1. **Hand-named accounts per home** (`claude-1`, `claude-2`): a name says nothing about who is
   signed in.
2. **Slots as identities** (`claude-agent-sdk:1`): moving a login between slots changes its id and
   its history.
3. **Slots are homes only; the account id is derived from the verified login principal by a keyed
   hash; anything unverifiable is quarantined; Workers are account × role.**

## Decision

Option 3.

- **Slots are homes.** Each agent provider is configured with a number of slots; a slot is an
  owner-only home under the DSH home, which the read confinement hides from every agent child
  (ADR-0024). A run binds back only its own account's home. A slot's number never names, orders,
  or identifies an account.
- **The account id** is `<provider>:<h>`, `h` the first 16 hex characters of an HMAC-SHA256 over
  the provider and the principal's canonical parts, keyed by a per-install key kept in the
  credential vault. The full HMAC is kept on the `agent-account@1.0` record and compared; a short
  form shared by two different HMACs makes both `ambiguous`. The provider is the identity
  namespace: one person signed in through two runtimes is two accounts.
- **The `agentRuntimes` seam gains, all optional** (a capability seam: a versioned definition and
  its suite, ADR-0036):
  - `RunSpec.home` and `probe({ home })`: the home a run or probe uses. A provider that runs in a
    named home reports `RuntimeEvidence.homes`; one that does not refuses a run naming a home
    (`config_error`) before anything runs, never ignores it. `probeIn(provider, home)` probes a
    named home only on a provider that reports `homes`, and is unavailable otherwise.
  - `identity(home, key)`: who is signed in to that home, read under the same confinement as a run,
    returned as the keyed HMAC (`identityHmac`), the reader and the CLI version it is pinned to,
    and a masked hint; or `missing`, `ambiguous`, or `unverified` with why. No token and no raw
    principal leaves the provider (INV-8). A reader names the CLI versions a supervised check
    verified, as ADR-0043 pins agy's hook; on any other version the reading is `unverified`.
  - `loginCommand(home)`: the runtime's own sign-in command for that home, which the operator runs
    in their own terminal, without D-Bus, so the sign-in lands in the home's own files. The daemon
    runs no interactive sign-in.
  - Conformance: one login gives one HMAC across reads, restarts, and a re-login; two logins two;
    another key another; a home not signed in or unreadable is never `verified`; the reading holds
    no raw principal; the sign-in command sets the home and no session bus.
- **Quarantine.** An account is admitted only when `ready`: its runtime reports a sign-in and its
  principal equals the pinned one. `changed`, `ambiguous`, `duplicate` (both slots), and
  `unverified` are quarantined and their Workers read `unavailable` with the reason; a quarantine
  never clears by itself. The identity is read at enrollment, at each probe, and again before each
  run; a change between them fails the run unsubmitted. Every enrollment and status change is an
  `enrollment` decision (`decision@1.8`), whose inputs never include the principal.
- **Workers are account × role**: role templates defined once, assignments in configuration (the
  trusted envelope for account choice, INV-6), each Worker `agent:<accountId>/<role>`, its family
  still the runtime (ADR-0027). Per account: one scheduler (`maxConcurrentRunsPerAccount`), `load`
  and `reserve`, cooldowns, session affinity, and `siblings` (every Worker of the account).
- **Teams count accounts by siblings.** A member's held accounts are the siblings of each other
  member's held Worker, so two roles of one account are one account (REQ-TEAM-4). On today's single
  home per runtime, an agent Worker's siblings are every Worker of its runtime (PROP-0012 phase C).
- **Website accounts** keep their catalog ids (REQ-ACC-1); two whose `identityHash` collides are
  treated as `duplicate`: their Workers read `unavailable` and health names both (REQ-ACC-7).

## Consequences

- Phase B (this change) fixes the `agent-account@1.0` and `decision@1.8` shapes and the
  `agentRuntimes` additions with their suite, passed by a fake runtime with scripted homes; the four
  runtimes refuse a run naming a home until each gains a reader and home support (phase E). No
  Worker routes on a second agent account before then, and none before ADR-0052's assigned rules
  hold (PROP-0012 phase D lands before phase F).
- The `agent-workers` configuration changes shape at phase F (providers, roles, assignments),
  prepared by `system account migrate`, with no compatibility path. Records keep their old Worker
  and pool ids.
- Losing the per-install key changes every derived id; the key is backed up with the vault.
- Antigravity CLI accounts stay `unverified`, and route nothing, until a reader is verified on a
  pinned agy version (PROP-0012 open question 1).
- Revisit if a runtime offers a stable account id of its own that a supervised check shows equal
  across re-login and different across accounts: the reader then reads it, and the id stays keyed.
