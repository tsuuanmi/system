# ADR-0059: Each account's quota is read from its runtime's own usage report

- **Status:** Accepted
- **Date:** 2026-10-24 (accepted 2026-10-24, by the operator, D55: `get_usage` read only on the
  Claude Code versions whose format was checked, `limitReadSeconds` 600 by default, and Claude's
  five-hour and seven-day windows mapped)
- **Related:** [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0043](0043-antigravity-cli-workers-gated-on-a-version-verified-live.md),
  [ADR-0051](0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md),
  [ADR-0052](0052-accounts-are-assigned-unless-pooling-is-recorded.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-8](../../architecture/invariants.md#inv-8-credentials-never-cross-upward),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in); research:
  [quota built-ins](../../research/quota-builtins-2026-10-24.md)

## Context

The operator asked (2026-10-24, T96) to see each account's own quota, read from what each provider
already reports, instead of checking by hand: "used 42 % of 5 h, resets 14:20", per account.

One pool per account already exists: a pool template on the `resources` row, named by the
runtime's `agent-workers` provider entry, gives each enrolled, ready, assigned account its own pool
`<template>/<accountId>` ([pool templates](../../design/resources.md#pool-templates)), and the
roster shows each pool's windows ([roster](../../design/roster.md)). What is missing is the
readings: they come only from inside a run.

- Claude Code's `rate_limit_event` carries `utilization` only near or at a limit; an ordinary
  event names the binding window and its reset, with no share. That is why the live roster says
  the five-hour window's latest reading "gives no used share" (research,
  [why](../../research/quota-builtins-2026-10-24.md#why-the-five-hour-windows-used-share-is-unknown-live)).
- Codex's `exec` stream reports a limit only when a turn fails at it; agy's quota report is read
  only after a run that hit its quota ([limit readings](../../design/agent-runtimes.md#limit-readings)).
- Between runs, nothing is read, and an idle account's windows stay as its last run left them.

Each runtime has a built-in that reports every window of the signed-in account on request, without
a model turn: Claude Code's `get_usage` control request (SDK
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`), the Codex app server's
`account/rateLimits/read`, and agy's `--print=/usage --output-format json`.

## Decision

1. **A usage report on the `agentRuntimes` seam.** `AgentRuntimeProvider` gains an optional
   method, `limits?(options: { home?: string }, signal: AbortSignal): Promise<LimitReport>`, with
   `LimitReport = { limits: LimitObservation[] } | { unreadable: string }`. It reads the usage
   report of the account signed in to `home` (the provider's own home when absent; a provider
   without `homes` refuses a named home as a run does). It runs under the same read confinement
   and with the same scrubbed environment as the probe, starts no model turn, spends no quota a
   run would, and leaves no conversation behind; a runtime whose report cannot promise that does
   not implement it. It never throws for a report it cannot read: that is `unreadable`, with why.
   It reads a format only on a runtime version whose format was checked
   (`VERIFIED_LIMIT_VERSIONS`, as today); on another version it returns `unreadable`, naming the
   version. A capability seam: an additive, optional method, a minor contract version.
2. **The three readers.** Each converts its own units into `LimitObservation`
   (`usedPercentage` 0 to 100, `resetsAt` ISO 8601, a reset more than 400 days away dropped, a
   window that reports nothing left `rejected`):
   - **Claude Code:** a query in streaming-input mode that sends no prompt, with the probe's
     options and `persistSession: false`, asks `get_usage` with `skipBehaviors: true`, then is
     closed. Only `rate_limits_available: true` with `rate_limits` an object is read; each of its
     named windows whose `utilization` is a number is an observation of that window's name.
     `subscription_type`, `extra_usage`, `model_scoped`, and the session totals are not read.
   - **Codex:** `codex app-server` in the account's `CODEX_HOME`: `initialize`, then
     `account/rateLimits/read`, then exit. `primary` and `secondary` are each an observation of the
     window named by its length, `<windowDurationMins>m` (for example `300m`), because which of
     the two is the five-hour window is not fixed by name.
   - **The Antigravity CLI:** the report it already reads after a quota hit
     (`limitsFromUsage`), now behind `limits`; its run no longer reads it itself (one
     implementation).
3. **When the `agents` source reads.** For every ready, assigned account whose Workers draw on a
   declared pool, and whose runtime implements `limits`:
   - **during a run**, the runtime's own events, as now;
   - **after each metered run** of the account, once, before the run's usage is recorded and its
     reservation released, so the latest reading has the share and a reset read at a limit wins
     over the cooldown fallback;
   - **periodically**, every `limitReadSeconds` (on the provider entry; default 600, at least 60,
     `0` turns it off), skipped while a read of the account is less than that old; at most one
     read in flight per runtime, each bounded to 30 s and aborted on stop.
4. **How a report becomes readings.** Each observation is a `limit-state@1.0` reading of the pool
   window the provider's `windows` map names, `source: runtime-result` (what the agent runtime
   itself reports, [reference](../../reference/schemas.md#limit-state)), as a run's are: an
   unmapped window is skipped; `*` or an unmapped rejection closes every window; a rejection is
   `limited` until its reset, else for `limitCooldownSeconds`. **A report never opens a window
   that a `limited` reading closed before that reading's later of `resetsAt` and
   `cooldownUntil`**: such an `ok` observation is not recorded, and is logged. An `unreadable`
   report, a timeout, or a failure records nothing; it is logged, and the window keeps its last
   reading, whose `observedAt` the roster shows.
5. **The guarantee seam does not change.** `ctx.resources` (contract 1.1), `limit-state@1.0`, and
   `mcp-roster@1.1` stay as they are (ADR-0036). The Workers tab renders a window it already
   receives as "used 42 % of 5 h, resets 14:20 (read 14:05)".

## Consequences

- An idle account's windows are at most `limitReadSeconds` old, and each run ends with a reading
  that has the share; the operator stops checking accounts by hand.
- Each read is one runtime process (Claude Code, the Codex app server, or agy) per account per
  period: with the default 600 s and five accounts, thirty short processes an hour, none a model
  turn.
- Claude Code's `get_usage` is named experimental by its vendor. Pinning it to a checked version
  means an upgrade turns the shares unknown until the new version is checked; it never misreads
  them. Each reader is also a [release check](../../validation/release-checklist.md) on a live
  account.
- What stays unknown: absolute amounts (every report gives shares); windows a runtime does not
  report; an account on an API key (`rate_limits_available: false`), whose pool the operator
  configures `unknown: available` or not at all; the Antigravity CLI beyond its one home (no
  identity reader); website accounts (no pool, and their limits are read only at the limit); the
  Gemini API (at-limit notices only).
- 2026-10-25 (D70): a Claude Code account is judged by its five-hour window only; its report gives
  no seven-day reading (null server-side), a spent seven-day quota shows as an unusable five-hour
  window, and an unread window is never headroom, so a template declaring seven-day kept dispatch
  from ever picking a Claude account (fixed in the live patch that day).
- Local transcript reconstruction stays out: it is an estimate, and a `history-estimate` never
  opens a pool.

## Alternatives considered

- **Read the `@internal` `unifiedWindows` of Claude Code's `rate_limit_event`.** Free, on every
  response, but undeclared in the SDK's types and named internal: not a format to rely on, and it
  says nothing between runs.
- **Read the status line's `rate_limits`.** Documented, but only in the interactive TUI, per
  session; a Worker runs headless with no settings.
- **Call the providers' usage endpoints directly** (`/api/oauth/usage`, the ChatGPT backend). It
  needs the account's token outside its runtime (INV-8), and the endpoints are not public APIs.
- **Send `/usage` as a prompt in a session.** A session and a transcript per read.
- **A new `limit-state` source value (`usage-report`).** It would tell a report from a run's event,
  but it widens a record a guarantee seam accepts; the reference already defines
  `runtime-result` as what an agent runtime itself reports, and `observedAt` tells the operator
  how old a reading is. Left for the operator (open question).
- **Estimate from local transcripts (`ccusage`).** It knows neither the plan nor use elsewhere.
