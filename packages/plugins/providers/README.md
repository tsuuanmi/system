# @tsuuanmi/system-providers

**`ctx.providers`**: the provider driver registry
([ADR-0005](../../../docs/decisions/adr/0005-provider-runtime-interface.md)).

- Driver plugins call `register(driver)` on load. The driver is removed when that
  plugin unloads.
- `get(provider)` returns the driver for an account's provider, or throws
  `config_error`. The runtime never branches on provider names.
- `list()` returns the registered provider names, which `status` reports.
- Two drivers register today: `chatgpt-web`
  ([`provider-chatgpt-web`](../provider-chatgpt-web/README.md)) and `gemini-web`
  ([`provider-gemini-web`](../provider-gemini-web/README.md)).
- The `ProviderDriver` contract lives in
  [`@tsuuanmi/system-provider-core`](../../provider-core/README.md)
  ([driver interface](../../../docs/design/provider-turns.md#driver-interface)):
  - `provider`, `loginUrl`, and `stateOrigins` (the origins whose state is kept);
  - `capabilities` the driver's tests prove, and `features` an account may
    offer, with `probeFeatures(page)` to read them without sending anything;
  - `checkAuth(page)` and `identity(page)`;
  - `ask(page, prompt, options)`, with `beforeSend` (the receipt is written
    there) and `onBinding`;
  - `snapshot(page, binding)` for reconciliation;
  - optional `signIn(page, credentials, code)` for credential login.
- **Injects:** nothing.
