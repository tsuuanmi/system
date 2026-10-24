# @tsuuanmi/system-models-core

Capability **seam definition** for API and local models
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[models](../../docs/design/models.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.models` | abstract `Models` with `list()` (every catalog entry, ordered by id, with `available` and `detail`) and `complete(request, signal)`; `ModelEntry`, `ModelStatus`, `ModelRequest` (with an optional `history` of `ModelTurn`s, ADR-0031), `ModelCompletion`, `ModelError` with a provider-neutral `ModelFailure` | `@tsuuanmi/system-models` (`LlmModels`, over DSH `ctx.llm`) |

- A catalog entry carries what routing sees: `id`, `tier`, `quotaClass`
  (`metered` or `local`), `locality` (`remote` or `local`), `maxTokens`, the
  output bound of every call (INV-9), and an optional opaque `family`, the
  provider family of its Worker. How a provider reaches the model stays
  with the provider. It may also set its own session bounds
  (`maxSessionTurns`, `maxHistoryChars`) and `maxInputChars`, the longest prompt it is sent
  ([ADR-0032](../../docs/decisions/adr/0032-admission-refuses-input-longer-than-a-worker-takes.md)).
- A request's `history` is a session's earlier turns, in order, as user and
  assistant text. A provider sends them before the prompt.
- No vendor, model, or library is named here
  ([INV-11](../../docs/architecture/invariants.md#inv-11-no-tool-lock-in)).
- Depends on Cordis and the vocabulary of `@tsuuanmi/system-workers-core` (`Tier`).
- The conformance suite is [`conformance/models.ts`](conformance/models.ts), unversioned, so
  the seam's contract is 1.0:
  - the catalog listed by id with its routing attributes and availability, each
    entry with a family;
  - a completion with text, token usage, and finish;
  - the output bound never exceeded;
  - a request with a history, answered after it;
  - fail closed with `unknown-model`, `unavailable`, and `aborted`.

  It also exports `FakeModels`, a fake provider that passes the suite and can be
  scripted to hold or fail; the `models` Worker source is tested against it.
