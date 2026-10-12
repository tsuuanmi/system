# Development

> Planned.

## Toolchain

The toolchain **mirrors DSH's own**, so `system` packages build, lint, and test
the same way as the DSH packages they run beside
([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)). **Bun is not used.**

| Concern | Tool (same as DSH) |
|---|---|
| runtime | Node `^22.19 \|\| >=24` (CI on 22 and 24) |
| package manager | pnpm workspaces (version pinned in `packageManager`) |
| host | DSH core, one exact pinned version; `system` bundle + profile |
| language | TypeScript, `strict`, project references like DSH's `tsconfig.base.json` |
| dev run | `tsx` (source); built `lib/` under plain `node` for smoke tests |
| build | `tsdown` |
| lint | `oxlint` + `oxlint-tsgolint` (type-aware), ESLint with `@stylistic` for formatting rules |
| typecheck | `tsc --noEmit` (or `tsgo`) |
| tests | Vitest (+ `@vitest/coverage-v8`, `fast-check` for property tests) |
| git hooks | `lefthook` |
| package hygiene | `publint`, `jscpd` (duplication) |
| browser automation | `patchright-core` against a system Chrome (CON-7) |

DSH packages and `@deepseek-ai/cordis` are declared as **`peerDependencies` +
`devDependencies` at one exact version**, as DSH requires for out-of-tree
plugins.

## Workspace

pnpm workspaces under `packages/`, following the layout in
[PROP-0001](../proposals/0001-unified-system-architecture.md#proposed-design).
Each package has a colocated `README.md` that says what it owns, what it does not
own, its entry points, and its dependency direction, and links back to
[components](../architecture/components.md).

## Composition

The host is DSH core, started with the `system` profile: only the `system`
bundle, which inserts the allow-listed DSH core rows (no `dsh-base`), then patch
files
([plugin model](../architecture/plugin-model.md#composition)).
Planned profiles: `default` (all layers), `headless` (no gateways or Web UI),
`gateway-only`, and `dev` (fakes for every external seam, so no accounts are
needed). The composed tree can be printed for inspection.

## Commands

The root [`package.json`](../../package.json) `scripts` are canonical:

```sh
pnpm install
pnpm check       # docs, schemas, reference freshness, oxlint, typecheck
pnpm gen:reference  # regenerate docs/reference/configuration.md after changing a plugin Config
pnpm test        # unit and integration tests (bare workspace imports resolve to src/)
pnpm build       # tsc → lib/ for every package
pnpm test:e2e    # build, then boot the real profile through dsh (packages/cli/tests)
```

Run it locally on Linux:

```sh
node packages/cli/lib/bin.js init              # profile with only @tsuuanmi/system-bundle
node packages/cli/lib/bin.js start             # loopback daemon; MCP on 127.0.0.1:47317/mcp
node packages/cli/lib/bin.js mcp-config claude # or codex (token via $SYSTEM_MCP_TOKEN)
```

After changing an MCP tool, regenerate its reference from a running profile:
`node packages/cli/lib/bin.js tools --markdown > docs/reference/mcp-tools.md`.

CI runs check, test, build, and e2e on Node 22 and 24
([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)).

## Data directory

Runtime state lives under `<DSH_HOME>/system/` (default `~/.dsh/system/`), with
directories `0700` and files `0600`. This includes the store, vault, blobs, MCP
discovery and token, login profiles, the managed Chrome, and UI overlays. The development profile uses a separate data directory and separate
provider accounts, so development never touches production state.
