# @tsuuanmi/system-provider-core

Provider-runtime **libraries**, not plugins, plus the abstract seams that provider
plugins implement. The libraries are ported from tsuuanmi/internet together with
their tests, which serve as the spec (TDD).

| Export | Design |
|---|---|
| `ProviderScheduler` | per-account capacity, strict order within a session, an exclusive FIFO fence, generation invalidation ([scheduling](../../docs/design/scheduling-and-leases.md#per-account-scheduler)) |
| `waitForStableCompletion` | two clocks: a hard `timeout` and a `provider_stalled` stall clock ([provider turns](../../docs/design/provider-turns.md#two-clock-completion)) |
| `reconcileTurn`, `responseHash` | WAIT / RECOVER / RESUBMIT / AMBIGUOUS over `provider-turn-receipt@1.0` ([reconciliation](../../docs/design/provider-turns.md#reconciliation)) |
| `ProviderError`, `dispositionOf` | failure kind → retry disposition ([recovery](../../docs/design/workflow-engine.md#recovery)) |
| `Browser` (abstract, `ctx.browser`; generic over page and context) | `openTurn`, `capture`, `captureProfile`, `close`, `openAccounts`, `executablePath`; provided by `@tsuuanmi/system-browser-patchright` |
| `ProviderRegistry` (abstract, `ctx.providers`) | `register`, `get`, `list`; provided by `@tsuuanmi/system-providers` |
| `Display` (abstract, `ctx.display`) | `prepare('invisible' \| 'visible')`; invisible never means headless; `visible` uses the operator's `DISPLAY` ([display modes](../../docs/design/browser-runtime.md#display-modes-ctxdisplay)); provided by `@tsuuanmi/system-display-virtual` |

**Conformance suites** (plugin rule 7) live in [`conformance/`](conformance/):
`display.ts`, `browser.ts`, and `providers.ts`. Every provider's tests run the
suite for its seam; the suites are not part of the built package.
