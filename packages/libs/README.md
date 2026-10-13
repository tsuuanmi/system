# @tsuuanmi/system-libs

Pure libraries shared by `system` plugins. These are **not plugins**: each has
exactly one correct answer per process
([plugin model](../../docs/architecture/plugin-model.md#what-is-not-a-plugin)).

| Export | Purpose |
|---|---|
| `canonicalJson`, `contentId`, `sha256` | canonical JSON and `sha256:` content addresses ([reference](../../docs/reference/schemas.md#artifact-envelope)) |
| `SchemaRegistry`, `SchemaError` | validate records against [`schemas/`](../../schemas/README.md) by tag (ADR-0014) |
| `captureGitSubject`, `subjectId`, `GitSubject` | the exact subject of a git working tree: HEAD plus a hash of every change on top, with the verbatim diff (REQ-WF-5). A confined, read-only probe, not a command runner: fixed `git` argument lists, no shell, no hooks, no external diff or text conversion, no optional index writes, and bounded time and output |
| `dshHome`, `ensurePrivateDir`, `readOrCreateSecretFile` | the harness home by DSH's own rule (`resolveDshHome`), and secret-file hygiene: `0700` dirs, `0600` regular single-link files, `O_NOFOLLOW` |
| `sqliteRuntimeProblem`, `nodeVersionProblem`, `SUPPORTED_NODE` | the supported Node runtime ([CON-2](../../docs/requirements/constraints.md)): the version range, then a NUL round trip through `node:sqlite`; the store and `system init` / `start` refuse a runtime that fails either |

- **Depends on:** `@tsuuanmi/system-schemas`, `ajv`, the system `git` binary for subjects, and DSH's `@deepseek-ai/dsh-home-paths` (a path library with no runtime; its declared Cordis peer is satisfied by the workspace).
