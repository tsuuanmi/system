# @tsuuanmi/system-bundle

The `system` profile's **only** bundle. It inserts the allow-listed DSH core rows
and the `system` plugins, and it does not use `dsh-base`
([ADR-0019](../../docs/decisions/adr/0019-explicit-minimal-dsh-core.md)).

- **Owns:** the composition, which is [`cordis.patch.yml`](cordis.patch.yml).
- **Does not own:** plugin behavior. Each plugin package documents its own.
- **Allow-list:** [DSH core reuse map](../../docs/architecture/plugin-model.md#dsh-core-reuse-map).
  The e2e composition test asserts the exact row set.
- **Off by default (PROP-0004):** the agent Worker rows (`agent-runtimes`, the
  `runtime-*` rows, `agent-workers`, `profile-software-development`) and both model
  gateways are `disabled: true`, not removed. An operator patch turns one back on
  ([runbook](../../docs/operations/runbooks.md#turn-an-off-row-back-on)); the e2e test
  proves that it mounts again.
- **Off until the approval queue exists (B5):** the [`board`](../plugins/board/README.md)
  row. The board asks for every approval through `ctx.approvals`, which no row provides
  yet, so the row stays `disabled: true`; with it off, runs work as today.
- **Presets:** [`presets/`](presets/) holds named bundle layers that `system init
  --preset <name>` adds right after this bundle. [`api-first`](presets/api-first/cordis.patch.yml)
  disables every row that drives a website and both model gateways, turns the agent
  Worker rows back on, and orders quota
  `local`, `metered`, `agent-plan`, `subscription-chat`
  ([ADR-0025](../../docs/decisions/adr/0025-api-first-composition.md)). A preset names
  no vendor, model, or tool. The e2e test asserts each preset's exact row set.
- **Crash suite:** [`tests/crash/`](tests/crash/) kills the engine at each external
  effect of the [effect register](../../docs/architecture/data-flow.md#effect-register)
  and restarts it (`pnpm test:crash`).
