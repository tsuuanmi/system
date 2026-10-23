# @tsuuanmi/system-bundle

The `system` profile's **only** bundle. It inserts the allow-listed DSH core rows
and the `system` plugins, and it does not use `dsh-base`
([ADR-0019](../../docs/decisions/adr/0019-explicit-minimal-dsh-core.md)).

- **Owns:** the composition, which is [`cordis.patch.yml`](cordis.patch.yml).
- **Does not own:** plugin behavior. Each plugin package documents its own.
- **Allow-list:** [DSH core reuse map](../../docs/architecture/plugin-model.md#dsh-core-reuse-map).
  The e2e composition test asserts the exact row set.
- **Claude Code on by default (PROP-0010 B3):** `agent-runtimes`,
  `runtime-claude-agent-sdk`, and `agent-workers` are on, with no Worker: a Worker's
  workspace is a repository the operator names
  ([runbook](../../docs/operations/runbooks.md#agent-workers)). A host without Claude
  Code, bubblewrap, or a sign-in still boots; its Workers are unavailable, and the probe
  says why.
- **Off by default (PROP-0004):** `runtime-codex-sdk` and `runtime-acp` (they cannot ask
  a tool gate before each tool call, so no Worker of theirs is admitted),
  `profile-software-development`, and both model gateways are `disabled: true`, not
  removed. An operator patch turns one back on
  ([runbook](../../docs/operations/runbooks.md#turn-an-off-row-back-on)); the e2e test
  proves that it mounts again.
- **The approval queue and the board (B5):** the [`approvals`](../plugins/approvals/README.md)
  row carries the default studio policy, conservative: a read runs, a workspace write runs
  once tests and lint pass, and everything else asks, expiring after a day (at most 14) in
  batches of up to 10 shown within an hour. A patch that targets the row replaces its whole
  config, so it carries the policies too; `system check` names a missing or invalid one. The
  [`board`](../plugins/board/README.md) row asks for every approval through it and is mounted
  only with it; with the board off, runs work as before.
- **Presets:** [`presets/`](presets/) holds named bundle layers that `system init
  --preset <name>` adds right after this bundle. [`api-first`](presets/api-first/cordis.patch.yml)
  disables every row that drives a website and both model gateways, turns every agent
  Worker row on (Codex, ACP, and the software-development profile included), and orders quota
  `local`, `metered`, `agent-plan`, `subscription-chat`
  ([ADR-0025](../../docs/decisions/adr/0025-api-first-composition.md)). A preset names
  no vendor, model, or tool. The e2e test asserts each preset's exact row set.
- **Crash suite:** [`tests/crash/`](tests/crash/) kills the engine at each external
  effect of the [effect register](../../docs/architecture/data-flow.md#effect-register)
  and restarts it (`pnpm test:crash`).
