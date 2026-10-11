# @tsuuanmi/system-provider-core

Provider-runtime **libraries**, not plugins. They are ported from tsuuanmi/internet
together with their tests, which serve as the spec (TDD).

| Export | Design |
|---|---|
| `ProviderScheduler` | per-account capacity, strict order within a session, an exclusive FIFO fence, generation invalidation ([scheduling](../../docs/design/scheduling-and-leases.md#per-account-scheduler)) |
| `waitForStableCompletion` | two clocks: a hard `timeout` and a `provider_stalled` stall clock ([provider turns](../../docs/design/provider-turns.md#two-clock-completion)) |
| `reconcileTurn`, `responseHash` | WAIT / RECOVER / RESUBMIT / AMBIGUOUS over `provider-turn-receipt@1.0` ([reconciliation](../../docs/design/provider-turns.md#reconciliation)) |
| `ProviderError`, `dispositionOf` | failure kind → retry disposition ([recovery](../../docs/design/workflow-engine.md#recovery)) |
