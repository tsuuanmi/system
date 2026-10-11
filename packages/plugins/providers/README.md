# @tsuuanmi/system-providers

**`ctx.providers`**: the provider driver registry
([ADR-0005](../../../docs/decisions/adr/0005-provider-runtime-interface.md)).

- Driver plugins call `register(driver)` on load. The driver is removed when that
  plugin unloads.
- `get(provider)` returns the driver for an account's provider, or throws
  `config_error`. The runtime never branches on provider names.
- `list()` returns the registered provider names, which `status` reports.
- The `ProviderDriver` contract (`checkAuth`, `identity`, `ask`, `loginUrl`,
  `stateOrigins`) lives in `@tsuuanmi/system-provider-core`.
