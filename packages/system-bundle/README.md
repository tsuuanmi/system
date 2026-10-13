# @tsuuanmi/system-bundle

The `system` profile's **only** bundle. It inserts the allow-listed DSH core rows
and the `system` plugins, and it does not use `dsh-base`
([ADR-0019](../../docs/decisions/adr/0019-explicit-minimal-dsh-core.md)).

- **Owns:** the composition, which is [`cordis.patch.yml`](cordis.patch.yml).
- **Does not own:** plugin behavior. Each plugin package documents its own.
- **Allow-list:** [DSH core reuse map](../../docs/architecture/plugin-model.md#dsh-core-reuse-map).
  The e2e composition test asserts the exact row set.
- **Presets:** [`presets/`](presets/) holds named bundle layers that `system init
  --preset <name>` adds right after this bundle. [`api-first`](presets/api-first/cordis.patch.yml)
  disables every row that drives a website and both model gateways, and orders quota
  `local`, `metered`, `agent-plan`, `subscription-chat`
  ([ADR-0025](../../docs/decisions/adr/0025-api-first-composition.md)). A preset names
  no vendor, model, or tool. The e2e test asserts each preset's exact row set.
- **Crash suite:** [`tests/crash/`](tests/crash/) kills the engine at each external
  effect of the [effect register](../../docs/architecture/data-flow.md#effect-register)
  and restarts it (`pnpm test:crash`).
