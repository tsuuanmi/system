# @tsuuanmi/system-provider-core

Provider-runtime **libraries**, not plugins, plus the abstract seams that provider
plugins implement. The libraries are ported from tsuuanmi/internet together with
their tests, which serve as the spec (TDD).

| Export | Design |
|---|---|
| `ProviderScheduler`, `ProviderLease` | per-account capacity, strict order within a session, an exclusive FIFO fence (`runExclusive`), generation invalidation ([scheduling](../../docs/design/scheduling-and-leases.md#per-account-scheduler)) |
| `waitForStableCompletion` and its types | two clocks: a hard `timeout` and a `provider_stalled` stall clock ([provider turns](../../docs/design/provider-turns.md#two-clock-completion)) |
| `reconcileTurn`, `responseHash`, `promptShown`, `TurnReceipt`, `TurnSnapshot`, `Reconciliation` | WAIT / RECOVER / RESUBMIT / AMBIGUOUS over `provider-turn-receipt@1.0`; `promptShown` tells whether a shown user turn carries the prompt (spacing ignored) ([reconciliation](../../docs/design/provider-turns.md#reconciliation)) |
| `sameWords` | whether an answer's Markdown, from the site's Copy button, is the rendered answer (REQ-PRV-5): its prose words in order; link texts, reference definitions, and citation chips (one chip may stand for several sources, "Name +2") may differ |
| `modePresets`, `completionOptions`, `bindingReporter`, `waitForReport`, `withSources`, `withMissingSources`, `withoutTracking`, `withoutTrackingLinks`, `ResearchState`, `TurnTimeouts` | turn mechanics every website driver shares, with no page in them: mode presets (an unknown name or default is `config_error`), the turn's two clocks, a conversation binding reported once, a Deep research report awaited (done but unreadable past `reportReadMs` is `ui_drift`), a `Sources:` list (of the links an answer's text lacks, compared as exact URLs), and `utm_*` tracking parameters dropped from sources and from Markdown link targets. Each driver keeps its own page reads |
| `ProviderError`, `dispositionOf`, `toProviderError`, `abortReason` | failure kind → retry disposition ([recovery](../../docs/design/workflow-engine.md#recovery)); `toProviderError` types a foreign failure (programming errors are `internal`, anything else `session_broken`); `abortReason` turns an abort signal's reason into an `aborted` failure unless it is the caller's own Error |
| `ProviderDriver`, `AskOptions`, `AskResult`, `AuthState`, `ConversationMode`, `ProviderFeature`, `ProviderMode` | the driver contract ([driver interface](../../docs/design/provider-turns.md#driver-interface)) |
| `PortableState` | an account's portable browser state (cookies, localStorage, IndexedDB for the driver's origins), shared by `ctx.accounts` and `ctx.browser` |
| `Browser` (abstract, `ctx.browser`; generic over page and context) | `openTurn`, `capture`, `captureProfile`, `close`, `openAccounts`, `executablePath`; provided by `@tsuuanmi/system-browser-patchright` |
| `ProviderRegistry` (abstract, `ctx.providers`) | `register`, `get`, `list`; provided by `@tsuuanmi/system-providers` |
| `Display` (abstract, `ctx.display`) | `prepare('invisible' \| 'visible')`; invisible never means headless; `visible` uses the operator's `DISPLAY` ([display modes](../../docs/design/browser-runtime.md#display-modes-ctxdisplay)); provided by `@tsuuanmi/system-display-virtual` |

**Conformance suites** (plugin rule 7) live in [`conformance/`](conformance/):
`display.ts`, `browser.ts`, and `providers.ts`. Every provider's tests run the
suite for its seam; the suites are not part of the built package.
