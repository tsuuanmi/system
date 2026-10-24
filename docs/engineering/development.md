# Development

## Toolchain

`system` packages run beside DSH packages on the same Node and Cordis
([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)). **Bun is not used.**
The root [`package.json`](../../package.json) and each package's `package.json`
are canonical.

| Concern | Tool |
|---|---|
| runtime | Node `^24.18.1 \|\| >=26.5.1` (`engines`; [CON-2](../requirements/constraints.md)); the versions CI runs are in [CI gates](testing.md#ci-gates) |
| package manager | pnpm workspaces (version pinned in `packageManager`) |
| host | DSH core and `@deepseek-ai/cordis`, one exact pinned version; the `system` bundle and profile |
| language | TypeScript, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` |
| typecheck | `tsc --noEmit` over the whole workspace (root [`tsconfig.json`](../../tsconfig.json), whose `paths` map each package to its `src/`) |
| build | `tsc -p tsconfig.build.json` per package, into `lib/` ([`tsconfig.build.base.json`](../../tsconfig.build.base.json)) |
| lint | `oxlint` over `scripts/`, `spikes/`, and `packages/`, with its default rules (no configuration file) |
| tests | Vitest; bare workspace imports resolve to `src/` ([`vitest.config.ts`](../../vitest.config.ts)) |
| scripts | `tsx` for the checks and generators in [`scripts/`](../../scripts/), loaded in the process (`node --import tsx <script>`, never the `tsx` CLI, whose IPC pipe is a unix socket an agent's command sandbox refuses; [confined commands](../design/agent-runtimes.md#confined-commands)) |
| browser automation | `patchright-core` against a system or pinned managed Chrome (CON-7) |

DSH packages and `@deepseek-ai/cordis` are declared as **`peerDependencies` and
`devDependencies` at one exact version**, as DSH requires for out-of-tree
plugins.

## Workspace

pnpm workspaces ([`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)):

| Path | Holds |
|---|---|
| `schemas/` | the JSON Schemas, as the package `@tsuuanmi/system-schemas` |
| `packages/libs` | pure shared libraries: canonical JSON, content ids, schema validation, durable files |
| `packages/*-core` | seam definitions (abstract classes and conformance suites) and shared mechanisms, such as `provider-core`, `workers-core`, `agent-runtime-core`, and `gateway-core`; every package is in the [package graph](../architecture/packages.md) |
| `packages/ui-ops`, `packages/gateway-turns`, `packages/statistics` | libraries: the UI engine, the gateways' shared text tool protocol, and the evaluation engine's statistics |
| `packages/plugins/*` | every Cordis plugin, one package each |
| `packages/system-bundle` | the bundle that mounts the plugins ([`cordis.patch.yml`](../../packages/system-bundle/cordis.patch.yml)) |
| `packages/cli` | the `system` command |
| `scripts/`, `spikes/` | repository checks and generators; the test groups ([testing](testing.md#test-groups)); the release scripts ([releasing](releasing.md)); the live install's update ([runbook](../operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release)); the experiments' helpers ([experiments](../validation/experiments/README.md)); the statistics goldens' generator ([golden tests](../design/statistics.md#golden-tests)); the M0 spike |

Each package has a colocated `README.md` that says what it owns, what it does not
own, its entry points, and its dependency direction, and links back to
[components](../architecture/components.md).

## Composition

The host is DSH core, started with the `system` profile, which lists only the
`system` bundle. The bundle inserts the allow-listed DSH core rows (no
`dsh-base`) and every `system` plugin; the operator's patch file
(`<DSH_HOME>/profiles/system/cordis.patch.yml`) configures them
([plugin model](../architecture/plugin-model.md#composition)). There is one
shipped profile. Tests compose their own `cordis.yml` with fakes.

## Commands

The root [`package.json`](../../package.json) `scripts` are canonical:

```sh
pnpm install
pnpm build              # tsc → lib/ for every package
pnpm check              # docs, secrets, schemas; reference, packages, manifests, and traceability freshness; oxlint; typecheck
pnpm gen:reference      # regenerate docs/reference/configuration.md after changing a plugin Config
pnpm gen:packages       # regenerate docs/architecture/packages.md after changing a package or its seams
pnpm gen:manifests      # regenerate every plugin-manifest.json after changing a plugin's seams, Config, egress check, or package.json
pnpm gen:traceability   # regenerate docs/validation/traceability.md from test titles
pnpm test               # every *.spec.ts: unit, contract, driver, concurrency, and architecture tests: the whole suite
pnpm test:group <name>  # one functional group of it (testing.md#test-groups); no name lists them
pnpm test:affected      # the groups the change since origin/main affects (--base <ref>, --dry-run)
pnpm test:e2e           # build, then boot the real profile through dsh (packages/cli/tests)
pnpm test:crash         # build, then SIGKILL the engine at each crash point and restart it (testing.md)
pnpm changeset          # record a user-visible change for the next release (releasing.md)
pnpm version-packages   # apply the changesets and seed the release's upgrade fixture
pnpm release:artifacts  # tarballs, SBOMs, SHA256SUMS, and notes in dist/release/
```

A path after a test script goes to Vitest as a filter: `pnpm test scripts/checks.spec.ts`
runs one file. `pnpm test:e2e <file>` and `pnpm test:crash <file>` build first, then
run that file.

A root script that runs pnpm again (`check`, `build`, `test:e2e`, `test:crash`,
`audit:deps`) calls it as `"$npm_execpath"`, the pnpm that is running the script,
never a `pnpm` looked up on `PATH`. So every step of `pnpm check` runs on the same
pnpm, and on a host whose pnpm comes from corepack alone `corepack pnpm check`
works with no `pnpm` on `PATH`. A new root script that runs pnpm does the same.
Run the scripts through pnpm: started any other way, `npm_execpath` does not
name pnpm and the script fails. The product itself still needs one there:
`system init` installs the profile through DSH's plugin manager, which runs the
`pnpm` on `PATH`, so `test:e2e` (every suite of it boots `system init`) needs
one too (`corepack enable` puts it there).

Run it locally on Linux:

```sh
node packages/cli/lib/bin.js init              # profile with only @tsuuanmi/system-bundle
node packages/cli/lib/bin.js start             # loopback daemon; MCP on 127.0.0.1:47317/mcp
node packages/cli/lib/bin.js mcp-config claude # or codex
```

After changing an MCP tool, regenerate its reference from a running profile:
`node packages/cli/lib/bin.js tools --markdown > docs/reference/mcp-tools.md`.

## Data directory

Runtime state lives under `<DSH_HOME>/system/` (default `~/.dsh/system/`), with
directories `0700` and files `0600`. This includes the store, the vault and its
key, the MCP discovery file and the scope token files, login profiles, the managed Chrome, and
UI map overlays. For development, set `DSH_HOME` to another directory and use
separate provider accounts, so development never touches production state.
