# Code quality

> Planned.

- **Layering is enforced.** A package imports only from packages in the same layer
  or a lower one ([layer map](../architecture/README.md#layer-map)). A lint rule
  or dependency check in CI enforces this.
- **Small modules.** Provider drivers, brokers, and engines are split by
  mechanism. A file that grows past roughly 800 lines is a design smell to address.
  The reference repos' multi-thousand-line files are the counterexample.
- **Typed failures.** Errors carry a failure class that maps to a retry
  disposition ([workflow-engine](../design/workflow-engine.md#recovery)).
  Throwing bare strings is not allowed.
- **No silent fallback** ([INV-2](../architecture/invariants.md#inv-2-fail-closed)).
- **Narrow public surface.** Each package exports its contract, not its internals.
  Don't re-export everything from the root.
- **Dependencies:** follow the reuse ladder
  ([ADR-0010](../decisions/adr/0010-reuse-before-build.md)) and record each choice
  in the [dependency register](dependencies.md). The lockfile is committed. Build
  output and vendored binaries are not.
- **Plugins:** follow the [plugin rules](../architecture/plugin-model.md#plugin-rules).
  In particular: no hardcoded tunables, a disposer for every registration, and
  seam definitions written as abstract `Service` classes.
- **Schemas:** persisted records and wire payloads have strict parsers with a
  schema version.
