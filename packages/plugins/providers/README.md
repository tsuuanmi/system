# @tsuuanmi/system-providers

**`ctx.providers`**: the provider driver registry
([ADR-0005](../../../docs/decisions/adr/0005-provider-runtime-interface.md)).

- Driver plugins call `register(driver)` on load. The driver is removed when that
  plugin unloads. A provider name registers once; a second driver for it is refused.
- `get(provider)` returns the driver for an account's provider, or throws
  `config_error`. The runtime never branches on provider names.
- `list()` returns the registered provider names, which `status` reports.
- Two drivers register today: `chatgpt-web`
  ([`provider-chatgpt-web`](../provider-chatgpt-web/README.md)) and `gemini-web`
  ([`provider-gemini-web`](../provider-gemini-web/README.md)).
- The `ProviderDriver` contract lives in
  [`@tsuuanmi/system-provider-core`](../../provider-core/README.md)
  ([driver interface](../../../docs/design/provider-turns.md#driver-interface),
  which lists its members).
- `ctx.providers` is at contract 1.0; the
  [conformance suite](../../provider-core/conformance/providers.ts) runs against this
  plugin.
- **Injects:** nothing.
