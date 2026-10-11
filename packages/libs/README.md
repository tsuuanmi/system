# @tsuuanmi/system-libs

Pure libraries shared by `system` plugins. These are **not plugins**: each has
exactly one correct answer per process
([plugin model](../../docs/architecture/plugin-model.md#what-is-not-a-plugin)).

| Export | Purpose |
|---|---|
| `canonicalJson`, `contentId`, `sha256` | canonical JSON and `sha256:` content addresses ([reference](../../docs/reference/schemas.md#artifact-envelope)) |
| `SchemaRegistry`, `SchemaError` | validate records against [`schemas/`](../../schemas/README.md) by tag (ADR-0014) |
| `dshHome`, `ensurePrivateDir`, `readOrCreateSecretFile` | harness-home paths and secret-file hygiene: `0700` dirs, `0600` regular single-link files, `O_NOFOLLOW` |

- **Depends on:** `@tsuuanmi/system-schemas`, `ajv`. It has no DSH dependency.
