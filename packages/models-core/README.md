# @tsuuanmi/system-models-core

Capability **seam definition** for API and local models
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[models](../../docs/design/models.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.models` | abstract `Models` with `list()` (every catalog entry, ordered by id, with `available` and `detail`) and `complete(request, signal)`; `ModelEntry`, `ModelStatus`, `ModelRequest`, `ModelCompletion`, `ModelError` with a provider-neutral `ModelFailure` | `@tsuuanmi/system-models` (`LlmModels`, over DSH `ctx.llm`) |

- A catalog entry carries what routing sees: `id`, `tier`, `quotaClass`
  (`metered` or `local`), `locality` (`remote` or `local`), and `maxTokens`, the
  output bound of every call (INV-9). How a provider reaches the model stays
  with the provider.
- No vendor, model, or library is named here
  ([INV-11](../../docs/architecture/invariants.md#inv-11-no-tool-lock-in)).
- Depends on Cordis and the vocabulary of `@tsuuanmi/system-workers-core` (`Tier`).
- The conformance suite is [`conformance/models.ts`](conformance/models.ts):
  - the catalog listed by id with its routing attributes and availability;
  - a completion with text, token usage, and finish;
  - the output bound never exceeded;
  - fail closed with `unknown-model`, `unavailable`, and `aborted`.

  It also exports `FakeModels`, a fake provider that passes the suite and can be
  scripted to hold or fail; the `models` Worker source is tested against it.
