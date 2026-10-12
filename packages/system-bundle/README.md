# @tsuuanmi/system-bundle

The `system` profile's **only** bundle. It inserts the allow-listed DSH core rows
and the `system` plugins, and it does not use `dsh-base`
([ADR-0019](../../docs/decisions/adr/0019-explicit-minimal-dsh-core.md)).

- **Owns:** the composition, which is [`cordis.patch.yml`](cordis.patch.yml).
- **Does not own:** plugin behavior. Each plugin package documents its own.
- **Allow-list:** [DSH core reuse map](../../docs/architecture/plugin-model.md#dsh-core-reuse-map).
  The e2e composition test asserts the exact row set.
