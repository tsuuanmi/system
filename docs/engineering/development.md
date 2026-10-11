# Development

> Planned.

## Toolchain

| Concern | Tool |
|---|---|
| runtime / package manager | Bun ([ADR-0002](../decisions/adr/0002-typescript-on-bun.md)) |
| language | TypeScript, `strict` |
| lint / format | Biome |
| typecheck | `tsc --noEmit` (or `tsgo`) |
| tests | `bun test` |
| browser automation | `patchright-core` against a system Chrome (CON-7) |

## Workspace

Bun workspaces under `packages/`, following the layout in
[PROP-0001](../proposals/0001-unified-system-architecture.md#proposed-design).
Each package has a colocated `README.md` that says what it owns, what it does not
own, its entry points, and its dependency direction, and links back to
[components](../architecture/components.md).

## Composition

The host is started with a profile. A profile is an ordered list of bundles plus
patch files ([plugin model](../architecture/plugin-model.md#composition)).
Planned profiles: `default` (all layers), `headless` (no gateways or Web UI),
`gateway-only`, and `dev` (fakes for every external seam, so no accounts are
needed). The composed tree can be printed for inspection.

## Commands (planned)

```sh
bun install
bun run check     # biome + typecheck + doc checks
bun test          # unit and contract tests
bun run verify    # check + test + build + smoke (CI entry point)
```

The definitive list will be the `scripts` in the root `package.json` once M0 lands.
This document will then point there instead of repeating it.

## Data directory

Runtime state lives under `~/.system/` by default (directories 0700, credential
files 0600). The development profile uses a separate data directory and separate
provider accounts, so development never touches production state.
