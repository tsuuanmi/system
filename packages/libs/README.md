# @tsuuanmi/system-libs

Pure libraries shared by `system` plugins. These are **not plugins**: each has
exactly one correct answer per process
([plugin model](../../docs/architecture/plugin-model.md#what-is-not-a-plugin)).

| Export | Purpose |
|---|---|
| `canonicalJson`, `contentId`, `sha256` | canonical JSON and `sha256:` content addresses ([reference](../../docs/reference/schemas.md#artifact-envelope)) |
| `renderBrief`, `startPrompt`, `bodyText`, `Brief`, `BriefError`, `NO_LOCAL_SANDBOX`, `BRIEF_LIMITS`, `questionsOf`, `QUESTION_LIMITS` | briefs (`brief@1.x`): the default text rendering a Worker source sends as its prompt, each pointer replaced by its artifact's text (`bodyText`: the body's `text`, else its canonical JSON, which a digest's quote check reads too); `startPrompt` takes a start's prompt or renders its brief, at the requirement's classification ([briefs](../../docs/design/workflow-engine.md#briefs)). A brief with `ask` (1.2) tells the Worker how to answer with questions instead, and `questionsOf` reads them: an answer that is wholly one `{"questions": [...]}` object, 1 to 8 of at most 500 characters, else none ([a question from a run](../../docs/design/workflow-engine.md#a-question-from-a-run)) |
| `SchemaRegistry`, `SchemaError` | validate records against [`schemas/`](../../schemas/README.md) by tag (ADR-0014), or a value against one of a schema's `$defs` (`assertDef`, an MCP tool's input or output) |
| `captureGitSubject`, `subjectId`, `GitSubject` | the exact subject of a git working tree: HEAD plus a hash of every change on top, with the verbatim diff (REQ-WF-5). A confined, read-only probe, not a command runner: fixed `git` argument lists, no shell, no hooks, no external diff or text conversion, no optional index writes, and bounded time and output |
| `snapshotRepository`, `selectFiles`, `SnapshotError`, `GIT_FLOOR`, `pinnedTo` | the files of a public repository at one pinned commit, for a team review: only the chosen blobs are read, in a fixed order within file and byte bounds, and every other file is listed as unread, with why ([sources](../../docs/design/teams.md#sources)). The same kind of confined probe as subjects, over https to an allowed public host only, with git pinned to every address checked (`GIT_FLOOR`: git 2.37, else it fails closed; [controls](../../docs/security/threat-model.md#threats-and-controls)). It takes no test seam; this package's own tests use `snapshotWithTestSeams` from source, which no other source may name |
| `dshHome`, `ensurePrivateDir`, `readOrCreateSecretFile` | the harness home by DSH's own rule (`resolveDshHome`), and secret-file hygiene: `0700` dirs, `0600` regular single-link files, `O_NOFOLLOW` |
| `registerSecretPath`, `secretPaths` | the process's secret paths outside the always-hidden places: the plugin that owns one registers it for as long as it exists, and agent Workers never read a registered path ([ADR-0024](../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)) |
| `sqliteRuntimeProblem`, `nodeVersionProblem`, `SUPPORTED_NODE` | the supported Node runtime ([CON-2](../../docs/requirements/constraints.md)): the version range, then a NUL round trip through `node:sqlite`; the store and `system init` / `start` refuse a runtime that fails either |

- **Depends on:** `@tsuuanmi/system-schemas`, `ajv`, the system `git` binary for subjects and repository snapshots, and DSH's `@deepseek-ai/dsh-home-paths` (a path library with no runtime; its declared Cordis peer is satisfied by the workspace).
