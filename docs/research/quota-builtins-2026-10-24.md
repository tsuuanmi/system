# Per-account quota from each provider's own readings (T96 research, 2026-10-24)

Non-normative research for the operator's request of 2026-10-24: "Each Claude account has a
different quota and different usage. Use the built-ins that already exist to check quota for each
Worker and provider, instead of checking by hand." The design it leads to is
[ADR-0059](../decisions/adr/0059-quota-readings-from-each-accounts-own-usage-report.md) (proposed)
and [resources: readings from an account's usage report](../design/resources.md#readings-from-an-accounts-usage-report).

How it was checked: the SDK types in `node_modules`, strings of the installed Claude Code binary
(never run: the session's permissions refused `claude --help`), the repository's fixtures and code,
and public pages (cited, marked secondhand where they are). No account was used, no credential or
token file was read, and no provider command was run against a home. `~/.dsh` (where the Codex
binary and the Workers' homes live) was not touched, so the Codex app server's shape rests on the
check recorded on 2026-10-24 in [limit readings](../design/agent-runtimes.md#limit-readings).

## What already exists in `system`

- **One pool per account** is built (PROP-0012 phase F,
  [pool templates](../design/resources.md#pool-templates)): the operator configures a template once
  (`templates` on the `resources` row), the `agent-workers` provider entry names it (`pool`, with
  `windows` mapping the runtime's window names to the template's), and the `agents` source declares
  each ready, assigned account: pool `<template>/<accountId>`. Enrolling a new account and assigning
  it a role gives its Workers their own pool with no further configuration. A limit on one account
  never closes another's.
- **The roster** (`system roster`, the Workers tab) shows each account's pools, each window's
  state, `used` (the latest reading's `usedPercentage`), `resets`, `observedAt`, and `source`
  ([roster](../design/roster.md)).
- **What feeds the pools is the gap.** Readings come only from a run: each `rate_limit_event` of a
  Claude Code run, Codex's limit message when a turn fails at its limit, and agy's `/usage` report
  read after a run that hit a quota. Between runs, and for every share the event does not carry,
  the roster says *unknown*.

## Why the five-hour window's used share is unknown live

The roster's *"its latest reading gives no used share"* (`gateway-core/src/roster.ts`) is what the
live run `run_3ad9aa617604f360` showed. The cause is in what Claude Code puts in a
`rate_limit_event`, seen in the installed binary (2.1.309; the reader is pinned to 2.1.308, whose
code was not separately inspected):

- For every API response, the CLI builds the event from the response's
  `anthropic-ratelimit-unified-*` headers: `status` (`allowed_warning` is folded into `allowed`
  first), `resetsAt` from `…-unified-reset`, and `rateLimitType` from
  `…-unified-representative-claim` (the window currently binding, for example `five_hour`).
- `utilization` (and `surpassedThreshold`) is set only on the **early-warning** path, when a
  window's `…-5h-surpassed-threshold` / `…-7d-surpassed-threshold` header is present: status
  `allowed_warning`, with that window's utilization. An ordinary `allowed` event carries no
  `utilization`.
- So the runtime records `five_hour` `ok`, with its reset, and no share: exactly the roster's
  unknown. A share appears only near or at the limit.
- The binary also attaches an `unifiedWindows` object (`five_hour`, `seven_day`, and a per-model
  weekly window, each `{ utilization, resetsAt }`) to the event. Its schema says
  `@internal`, and the SDK's public types (`SDKRateLimitInfo`, 0.3.296) do not declare it, so it is
  not a format `system` may rely on.

A second effect: a later run's share-less `allowed` reading replaces an earlier reading that had a
share, because the ledger keeps the latest reading per window.

## Per provider

### Claude Code / Claude Agent SDK (SDK 0.3.296; Claude Code 2.1.308 pinned, 2.1.309 on PATH)

| Source | Fields | Always or at limit | Per account? | How `system` reads it now |
|---|---|---|---|---|
| `rate_limit_event` (`SDKRateLimitInfo`, public) | `status` (`allowed`, `allowed_warning`, `rejected`), `resetsAt` (Unix **seconds**), `rateLimitType` (`five_hour`, `seven_day`, two per-model weekly windows, `seven_day_overage_included`, `overage`), `utilization` (a **fraction**), overage fields, `surpassedThreshold` | every response, but `utilization` only near the limit (warning) or at it; the window named is the binding one only | yes: the run's home | read: each event is an observation of its window (runtime README); the share is usually missing |
| `rate_limit_event.unifiedWindows` | per window `{ utilization, resetsAt }` | every response | yes | not read: `@internal`, undeclared in the SDK's types |
| `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors })`, control request `get_usage` (public types, marked experimental) | `subscription_type`; `rate_limits_available` (false for API keys and third-party clouds, or a token without the profile scope); `rate_limits`: `five_hour`, `seven_day`, `seven_day_oauth_apps`, two per-model weekly windows, each `{ utilization` **0–100** or null, `resets_at` **ISO 8601** or null `}`; `model_scoped[]` (`display_name`, `utilization`, `resets_at`); `extra_usage` (`is_enabled`, `monthly_limit`, `used_credits`, `utilization`, `currency`) | **always**, on request, for every window, from the claude.ai usage endpoint (`/api/oauth/usage`, the account-level figure) | yes: the home the query runs in | not read |
| `/usage` in a session: `usage_report` on the synthetic assistant message (`SDKUsageReport`, experimental) | `rate_limits.limits[]`: `kind` (`session`, `weekly_all`, `weekly_scoped`, …), `group`, `percent` 0–100, `resets_at` ISO, `scope`, `severity`, `is_active`; `extra_usage` | always, but only by sending `/usage` as a prompt in a session | yes | not read |
| status line JSON `rate_limits` (documented in the binary's own help text) | `five_hour` and `seven_day`: `used_percentage` 0–100, `resets_at` Unix seconds | interactive TUI only, after the first response; per session, from its last response (secondhand reports show it drifting between concurrent terminals) | yes | not usable: a Worker runs headless with `settingSources: []` |
| `claude auth status`, `claude sandbox status` | sign-in and sandbox state | — | — | the probe and identity reader use `auth status`; neither gives quota. No `claude usage` command exists in 2.1.309 |
| `/api/oauth/usage` called directly | the same as `get_usage` | always | yes | not usable: it needs the OAuth token, which never leaves the runtime (INV-8) |

Units differ between sources (a fraction in the event, a percentage in `get_usage`; Unix seconds
versus ISO 8601), so each reader converts its own.

`get_usage` is the built-in that answers the operator's question for every window at once, without
a model turn: the SDK drives the CLI's control protocol, and the CLI fetches the account's figures
from the same endpoint `/usage` renders. Its caveats: the method is named experimental and "may
change or be removed in any release"; it needs a live query (streaming input) in the account's
home, so one Claude Code process per read; and it was not yet called on this host.

### Codex CLI / SDK (Codex 0.164.0 pinned; SDK 0.162.1)

| Source | Fields | Always or at limit | How `system` reads it now |
|---|---|---|---|
| `codex exec --experimental-json` (what the SDK drives) | `turn.completed` token usage only; `turn.failed { message }` | at limit only: the message names the reset to the minute in the child's local time | read (T53): the reset of a `quota_exhausted` turn, window `*`, version-pinned, zone-aware |
| `codex app-server`: `account/rateLimits/read`, notification `account/rateLimits/updated` (`RateLimitSnapshot`, seen with `codex app-server generate-ts` on 0.164.0) | `primary` and `secondary`, each `usedPercent` (0–100), `windowDurationMins`, `resetsAt` (Unix seconds) | always, on request | not read (rejected in T53 as one more Codex process per reading) |
| the SDK's types | no rate-limit field at all | — | — |
| the Codex session transcript (`token_count` events) | community tools read `rate_limits` there | not verified on 0.164.0 | not read |

Which of `primary` and `secondary` is the five-hour window is not fixed by name; the window's own
`windowDurationMins` says. Third-party documentation agrees on the shape (used percentage 0–100, a
window length, an epoch reset) but names fields differently, so only the installed binary's schema
counts.

### Antigravity CLI (agy 1.4.6)

| Source | Fields | Always or at limit | How `system` reads it now |
|---|---|---|---|
| a run's stream and its quota errors | no reset | at limit | the failure only |
| `agy --print=/usage --output-format json` (also `/quota`; answered without an agent turn or quota, per its changelog) | `command.data.groups[].buckets[]`: `id`, `name`, `window`, `disabled`, `remaining_fraction` (0–1), `remaining_amount` (integer), `reset_time` (RFC 3339, UTC) | always, on request | read (T53) only after a run that hit a quota, version-pinned (`limitsFromUsage`) |
| `/credits` | credits | — | not read |

The report gives what is **left**, so the share used is `100 × (1 − remaining_fraction)`. agy runs
in its own home only, and has no identity reader, so it has one account and one pool.

### ChatGPT and Gemini websites; the Gemini API

- **ChatGPT web:** no counter of messages left; at the limit the page says so, sometimes with a
  time. A secondhand report says hovering a model in the picker shows when its weekly limit resets,
  with no count. The driver recognizes a limit only by its `quota_exhausted` error rules on an
  answer (`ui-map@1.4`, [UI operations](../design/ui-operations.md)), and its accounts have no pool.
- **Gemini web:** no usage page was found for the consumer app.
- **Gemini API:** no rate-limit headers were found in public material; a 429
  `RESOURCE_EXHAUSTED` body carries `QuotaFailure` (the quota id and limit) and `RetryInfo`
  (`retryDelay`), which forum reports say is unreliable for daily caps. That is an at-limit
  notice only (`limit-notice`).

Reading a limit note from a website would mean new UI-map elements and a page visit per account per
read: a new behaviour of the website drivers, after Base by the roadmap's priorities.

### Local tools (fallback evidence only)

`ccusage`-style reconstruction sums tokens from local transcripts. It knows neither the account's
plan nor use from other machines, and the newer `ccusage` package itself takes its figures from
`/api/oauth/usage`. In `system` it can only ever be a `history-estimate` reading, which never opens
a pool, and it is the metering oracle of [resources: conformance](../design/resources.md#conformance),
not a quota source. Not proposed here.

## Summary table

| Provider | Built-in | Fields | Always / at limit | Read by `system` now | Gap |
|---|---|---|---|---|---|
| Claude Code | `rate_limit_event` | status, resetsAt (s), rateLimitType, utilization (fraction) | every response; share only near or at the limit | yes, per run | the share is missing except near the limit; one window per event |
| Claude Code | `get_usage` control request (experimental) | every window's utilization (%) and resets_at (ISO), subscription type, extra usage | always, on request | no | to read, version-pinned, after each run and periodically |
| Claude Code | status line `rate_limits` | used_percentage, resets_at (s) | interactive only | no | unusable headless |
| Codex | `turn.failed` message | reset to the minute | at limit | yes (T53) | no share, no window |
| Codex | app server `account/rateLimits/read` | primary/secondary usedPercent, windowDurationMins, resetsAt (s) | always, on request | no | to read, version-pinned, periodically and after each run |
| agy | `--print=/usage --output-format json` | buckets: remaining_fraction, remaining_amount, reset_time (RFC 3339) | always, on request | after a quota hit only | to read periodically and after each run |
| ChatGPT web | limit banner; picker hover (secondhand) | a reset time, sometimes | at limit | as a failure only | no pool; a page reading is new driver behaviour |
| Gemini web | none found | — | — | as a failure only | none to read |
| Gemini API | 429 `QuotaFailure`, `RetryInfo` | quota id, retryDelay | at limit | not metered (no API Worker live) | at-limit only |
| local logs | transcript sums | tokens | — | no | an estimate, never a pool's state |

## Side findings

- `~/.local/bin/claude` resolves to Claude Code **2.1.309**, while the identity reader and the
  reset reading are pinned to **2.1.308** (`VERIFIED_IDENTITY_VERSIONS`). If the live daemon runs
  that executable, every Claude Code account reads `unverified`. The live configuration was not
  read; the operator should check `executable` on the live row.

## Adopted (proposed in ADR-0059)

- Claude Code's `get_usage` control request, through the SDK, in the account's home,
  version-pinned and shape-checked: after each metered run and on a bounded period.
- The Codex app server's `account/rateLimits/read`, in the account's home, version-pinned: the same
  cadence.
- agy's `/usage` JSON report, already read after a quota hit: the same cadence.
- The `rate_limit_event` stays read as now, during a run.

## Not adopted

- `unifiedWindows` on the event: `@internal`.
- The status line's `rate_limits`: interactive only, per session.
- Calling `/api/oauth/usage` (or any provider endpoint) directly: it needs the account's token
  outside the runtime (INV-8).
- `/usage` sent as a prompt in a session: a session per read, with a transcript.
- The Codex transcript's `token_count` rate limits: not verified on the pinned version.
- A website page reading (ChatGPT's picker note): new driver behaviour, after Base.
- `ccusage`-style reconstruction as a quota source: an estimate; never a pool's state.

## Sources

- SDK types: `@anthropic-ai/claude-agent-sdk` 0.3.296 `sdk.d.ts` (`SDKRateLimitInfo`,
  `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, `SDKControlGetUsageResponse`,
  `SDKUsageReport`); `@openai/codex-sdk` 0.162.1 `dist/index.d.ts`.
- Claude Code 2.1.309 binary strings: the header parser, the early-warning path, the
  `unifiedWindows` schema description (`@internal`), the status line help text, the `get_usage`
  handler.
- Repository: `runtime-claude-agent-sdk/src/index.ts` (`limitFrom`), `agent-workers/src/index.ts`
  (`observe`), `gateway-core/src/roster.ts`, `runtime-antigravity-cli/src/limits.ts` and its
  fixture, [limit readings](../design/agent-runtimes.md#limit-readings).
- Secondhand, not authoritative: [status line rate limits (blog)](https://skoula.cz/blog/2026/6/how-to-display-context-and-5h-7d-limits-in-the-claude-code-status-bar/),
  [status line drift across terminals (issue)](https://claudeissues.com/issue/75408-statusline-rate-limits-five-hour-used-percentage-drifts-across-concurrently-open),
  [ccusage on PyPI](https://pypi.org/project/ccusage/),
  [Codex usage models (codexbar)](https://www.mintlify.com/steipete/codexbar/api/usage-models),
  [Codex App Server as the supported boundary (pi-spark)](https://cdn.jsdelivr.net/npm/pi-spark@0.22.0/docs/openai-codex-banked-rate-limit-resets.md),
  [Gemini 429 bodies (forum)](https://discuss.ai.google.dev/t/429-errors-despite-waiting-after-retrydelay/96899),
  [ChatGPT picker reset date (TechRadar)](https://www.techradar.com/computing/artificial-intelligence/openai-just-gave-chatgpt-plus-a-massive-boost-with-generous-new-usage-limits).
