# @tsuuanmi/system-provider-core

Provider-runtime **libraries**, not plugins, plus the abstract seams that provider
plugins implement. The libraries are ported from tsuuanmi/internet together with
their tests, which serve as the spec (TDD).

| Export | Design |
|---|---|
| `ProviderScheduler`, `ProviderLease` | per-account capacity, strict order within a session, an exclusive FIFO fence (`runExclusive`), generation invalidation ([scheduling](../../docs/design/scheduling-and-leases.md#per-account-scheduler)) |
| `waitForStableCompletion` and its types | two clocks: a hard `timeout` and a `provider_stalled` stall clock ([provider turns](../../docs/design/provider-turns.md#two-clock-completion)) |
| `reconcileTurn`, `responseHash`, `promptShown`, `boundaryMissing`, `TurnReceipt`, `TurnSnapshot`, `Reconciliation` | WAIT / RECOVER / RESUBMIT / AMBIGUOUS over `provider-turn-receipt@1.0`; `promptShown` tells whether a shown user turn carries the prompt (spacing ignored); `boundaryMissing` tells whether a loaded page lost the response the receipt's turn followed ([reconciliation](../../docs/design/provider-turns.md#reconciliation)) |
| `sameWords`, `compareWords`, `splitAfterLastFence` | whether an answer's Markdown, from the site's Copy button, is the rendered answer (REQ-PRV-5): its prose words in order; link texts, reference definitions, and citation chips (one chip may stand for several sources, "Name +2") may differ. `compareWords` gives the same comparison as counts only, which a refused Copy records. `splitAfterLastFence` cuts a Copy after its last closing code fence, so a driver's block pattern meets no unclosed fence (linear time) |
| `modePresets`, `completionOptions`, `bindingReporter`, `waitForReport`, `withSources`, `withMissingSources`, `withoutTracking`, `withoutTrackingLinks`, `ResearchState`, `TurnTimeouts` | turn mechanics every website driver shares, with no page in them: mode presets (an unknown name or default is `config_error`), the turn's two clocks, a conversation binding reported once, a Deep research report awaited (done but unreadable past `reportReadMs` is `ui_drift`), a `Sources:` list (of the links an answer's text lacks; URLs compared with tracking parameters, a final slash, and trailing punctuation set aside), and `utm_*` tracking parameters dropped from sources and from Markdown link targets. Each driver keeps its own page reads |
| `ProviderError`, `dispositionOf`, `toProviderError`, `abortReason` | failure kind → retry disposition ([recovery](../../docs/design/workflow-engine.md#recovery)); `toProviderError` types a foreign failure (programming errors are `internal`, anything else `session_broken`); `abortReason` turns an abort signal's reason into an `aborted` failure unless it is the caller's own Error |
| `promptOfStart` | what a Worker source sends for a start: its prompt, or its brief rendered (`startPrompt` in `@tsuuanmi/system-libs`), at the classification its egress check uses; a brief that cannot be rendered refuses the start as `invalid_input`, nothing sent ([briefs](../../docs/design/workflow-engine.md#briefs)) |
| `ProviderDriver`, `AskOptions`, `AskResult`, `AuthState`, `ConversationMode`, `ProviderFeature`, `ProviderMode` | the driver contract ([driver interface](../../docs/design/provider-turns.md#driver-interface)) |
| `PortableState` | an account's portable browser state (cookies, localStorage, IndexedDB for the driver's origins), shared by `ctx.accounts` and `ctx.browser` |
| `Browser` (abstract, `ctx.browser`; generic over page and context) | `openTurn` (a fresh context from portable state, or with `profile` a page of the account's login profile, ADR-0030), `reserveProfile`, `profileStates`, `browserCap`, `discardTab` (a session's kept tab), `capture`, `captureProfile`, `close`, `openAccounts`, `executablePath`; `OWNED_PROFILE_SWITCH` marks every browser `system` starts on a login profile, and only a process carrying it is ever stopped to free a profile; provided by `@tsuuanmi/system-browser-patchright` |
| `ProviderRegistry` (abstract, `ctx.providers`) | `register`, `get`, `list`; provided by `@tsuuanmi/system-providers` |
| `Display` (abstract, `ctx.display`) | `prepare('invisible' \| 'visible')`; invisible never means headless; `visible` uses the operator's `DISPLAY` ([display modes](../../docs/design/browser-runtime.md#display-modes-ctxdisplay)); provided by `@tsuuanmi/system-display-virtual` |

**Conformance suites** (plugin rule 7) live in [`conformance/`](conformance/):
`display.ts`, `browser.ts`, and `providers.ts`, each seam at contract 1.0. Every
provider's tests run the suite for its seam; the suites are not part of the built package.
Beside them, `deletion.ts` is the delete flow every website driver that deletes conversations
runs against its own fake site (PROP-0004 Phase 5).
