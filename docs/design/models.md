# Models (API and local models as Workers)

> Target state. Seam: `ctx.models` ([plugin model](../architecture/plugin-model.md#seam-catalog)).
> Requirements: REQ-WRK-10, REQ-WRK-7, REQ-WRK-8, REQ-WRK-4. Decision:
> [ADR-0025](../decisions/adr/0025-api-first-composition.md). Purpose:
> [P3](../requirements/purpose.md#p3-right-worker-right-job-with-local-data-staying-local),
> [P4](../requirements/purpose.md#p4-cheap-models-do-low-level-work-strong-models-do-hard-work).
>
> Implemented in [`models-core`](../../packages/models-core/README.md) and
> [`models`](../../packages/plugins/models/README.md); differs from target: usage is the
> provider's token counts per step, not priced; no API or local model has been verified live
> ([release checklist](../validation/release-checklist.md)).

A **model Worker** is one entry of the operator's model catalog: an API model or a model served
on this machine. It answers one prompt with text, and runs no tools. It keeps a session by
replaying the session's transcript
([ADR-0031](../decisions/adr/0031-model-worker-sessions-by-replay.md)), so it proves `reason`
and `persistent-conversation`, and can be a team member or carry a run's conversation.

## Composition

| Row | Package | Role |
|---|---|---|
| `llm` | DSH `@deepseek-ai/dsh-llm` | `ctx.llm`: the provider-neutral model-call service |
| `llm-pi-ai` | DSH `@deepseek-ai/dsh-llm-pi-ai` | provider routes: each key of its `providers` config is a route with an endpoint, a wire protocol, and a credential reference (`apiKeyEnv`) |
| `models` | `@tsuuanmi/system-models` | `ctx.models` over `ctx.llm`, and the `models` Worker source over `ctx.models` |

The DSH rows need only `ctx.credentials`: no `dsh-base`, telemetry row, vendor default-model row,
or `attachments` service. `llm-retry` is not mounted: it injects the DSH agent loop and session
log (`agents`, `sessionProjections`), which `system` never inserts, and it retries only agent-loop
steps; a direct `ctx.llm.stream()` call is one attempt. The `models` row bounds its own
re-attempts instead (below).

With an empty catalog the `models` row contributes no Worker.

## Seam contract

```ts
abstract class Models extends Service {             // ctx.models
  abstract list(): Promise<ModelStatus[]>;          // every catalog entry, ordered by id
  abstract complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelCompletion>;
}

interface ModelEntry { id; tier; quotaClass: "metered" | "local"; locality: "remote" | "local"; maxTokens; family?; maxSessionTurns?; maxHistoryChars?; maxInputChars? }
interface ModelStatus extends ModelEntry { available: boolean; detail: string }
interface ModelRequest { model: string; prompt: string; history?: ModelTurn[]; maxTokens?: number }   // cut to the entry's bound
interface ModelTurn { role: "user" | "assistant"; text: string }   // a session's earlier turns, sent before the prompt
interface ModelCompletion { model; text; usage: { inputTokens; outputTokens }; finish: "stop" | "max-tokens"; maxTokens }
```

A failure is a `ModelError` with a provider-neutral reason: `unknown-model`, `unavailable`,
`credential`, `quota`, `rate-limit`, `transient`, `timeout`, `invalid-request`, or `aborted`.
The seam names no vendor, model, or library
([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)); its conformance suite
(`models-core/conformance/models.ts`) runs against a fake and against the `llm` provider wired
to a fake OpenAI-compatible server.

## The catalog and the routes

The operator configures two rows in the profile's `cordis.patch.yml`
([runbook](../operations/runbooks.md#api-and-local-models)):

- `llm-pi-ai` `providers`: one route per endpoint. A route names its key by **reference**
  (`apiKeyEnv`), never by value.
- `models` `models`: one entry per Worker, `{ id, route, model, tier, quotaClass, locality,
  maxTokens, family }`. `route` and `model` say how to reach it; the rest is what routing sees.
  `family` is the Worker's opaque provider family
  ([provider diversity](routing.md#provider-diversity)); it defaults to the route, so an
  operator gives two routes to one vendor the same family, and `list()` always reports one.

The entry's `tier` is the operator's claim, as for website modes and agent Workers. Nothing in
routing, profiles, or presets names a model ([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)).

## Keys

`llm-pi-ai` resolves a route's `apiKeyEnv` per request through `ctx.credentials`, which
`system-credentials-vault` provides. The vault reads the process environment first, then its
encrypted references. The documented path is the vault: the operator tool `model_key` (`system
model key <NAME>`, value from stdin) stores the key under that reference. A key exported in the
daemon's environment also works and shadows the vault. A missing key fails the call as
`credential` before anything reaches the provider; the call still counts as sent (one of its two
sends), since the send is counted before the adapter resolves the key. A refused key fails with a
fixed message: a provider can echo part of a key in its error text.

## Worker

| Field | Value |
|---|---|
| id | `model:<id>` |
| capabilities | `reason` with evidence kind `probe`: the route is mounted and resolves the model, without a model call; and `persistent-conversation` with evidence kind `conformance`, since the source keeps sessions itself (below). None when the route does not serve the model |
| state | `ready`, or `unavailable` (route missing or model unknown on it) |
| tier, quotaClass, locality, family | from the catalog entry (`family`: by default its route) |

A model on this machine does not prove `local-data`: it reads nothing in place. Its `local`
locality is what admits `local-private` work to it
([routing](routing.md#data-locality-policy)).

## A call

1. **Start** (`start`): durable at once in the `model_calls` table, idempotent by key; a key
   reused with another prompt or session is refused. A session's turn records the history it is
   accepted with ([sessions](#sessions)).
2. **Egress** ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)): the exact
   prompt is checked by `ctx.egress` before it is sent, for Worker class `model` (remote, default
   `public` and `operator-shared`) or `model-local` (local, the same default: `local-private`
   needs the operator to widen the class too, since nothing checks that a `local` route's address
   is this machine's). The
   decision joins the call's decision chain. A denial fails the call as `egress_denied`, never sent.
3. **Bounds** ([INV-9](../architecture/invariants.md#inv-9-everything-is-bounded)): at most
   `maxConcurrentCalls` calls in flight; output tokens at most the entry's `maxTokens` and the
   requirement's `budget.maxTokens`; a hard deadline `callTimeoutMs` (failure `timeout`).
4. **Re-attempts:** a failure the route's retry policy calls transient (DSH codes such as
   `RATE_LIMIT`, `SERVER`, `TIMEOUT`) is sent again with its backoff, at most `maxRetries` times
   (default 2), whatever the route policy allows; a refused credential, a spent quota, or an invalid
   request is never re-attempted, whatever the policy. Each request may be billed.
5. **Result:** a `report` artifact `model-answer@1.0` with the catalog id, the prompt's hash, the
   finish (`max-tokens` when cut at the bound), the bound, the sends and attempts, and the token
   usage of the request that answered. At worst a call is billed `sends × attempts` times: six
   with the defaults (two sends of up to three requests each). The usage report
   (`system usage`) shows the step's tokens beside its quota class.

| Seam failure | Engine failure class | Disposition |
|---|---|---|
| `credential` | `reauth_required` | `USER_ACTION` |
| `quota` | `quota_exhausted` | `USER_ACTION` |
| `rate-limit` | `overloaded` | `BACKOFF` |
| `transient` | `network` | `BACKOFF` |
| `timeout` | `timeout` | `BACKOFF` |
| `unknown-model`, `unavailable` | `config_error` | `CODE_FIX` |
| `invalid-request` | `invalid_input` | `NONE` |
| `aborted` | `aborted` | `NONE` |

## Sessions

[ADR-0031](../decisions/adr/0031-model-worker-sessions-by-replay.md). A model has no native
session, so the source keeps the transcript:

- **Turns.** A session's completed turns live in `model_session_turns`: prompt, answer text,
  and classification.
  - The session itself is in `model_sessions` from its first turn: its model, family, locality,
    tier, and a generation.
  - A turn joins in the transaction that completes its call, and only into the session it was
    accepted for. One that ended (released), started over (reset, a new generation), or moved on
    since takes nothing (`models.session.turn-dropped`), while the call still completes.
- **One turn at a time.** A session's next turn is refused (`overloaded`, retried) while one is in
  flight, so two turns never replay the same history.
- **Exactly what was accepted.** A turn's call records its history: the last turn's sequence
  number and a hash of the turns. A re-send after a restart replays exactly that. A session reset
  since then fails the turn (`invalid_input`), and it is never replayed as if nothing happened.
- **Bounds (INV-9).** `maxSessionTurns` (default 100) and `maxHistoryChars` (default 320,000,
  about 80k tokens) on the `models` row. A catalog entry may set its own, fitted to its context
  window.
  - The defaults sit above the session layer's own turn budget and its compaction point
    (`compactAtTokens`, 60k). So a long session is compacted into a handoff, and reset, before a
    bound fails it.
  - An entry with a smaller bound needs a smaller `compactAtTokens` too.
  - Past a bound the turn fails as `invalid_input` before anything is sent. Nothing is cut or
    summarized.
- **Affinity.** A session stays on its first model.
  - Only an escalation moves it, to a Worker of the same family and locality at a higher tier,
    which replays the history after its own bounds and egress are checked.
  - The source enforces this itself at `start`, not only routing.
  - It knows each Worker's family from the last `describe`, which routing runs before it starts
    anything.
- **Egress.** The prompt and the replayed turns, serialized as the turns sent in order, are
  checked at the highest classification of the prompt and of every replayed prompt and answer.
  The answer's artifact and its stored turn carry that classification too (REQ-WRK-7).
- **End.**
  - A reset (a compaction) deletes the turns and keeps the session on its model, at a new
    generation.
  - A release (the run deleted or expired) deletes the session and its turns.
  - A call's own retention never removes a turn that a live session still replays.

## Cancel and restart

- **Cancel** (REQ-WRK-4): a running call is aborted through its signal, a queued one is never
  sent; both fail as `aborted`.
- **Restart** ([INV-4](../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay)):
  a model call has no effect beyond its cost, so it is **safe to repeat with a bounded cost**. A
  queued call starts. A call that was running is sent once more, or, already sent twice, fails as
  `reconciliation_failed` and is never sent a third time; either way a `reconciliation` decision
  and a `models.call.resent` or `models.call.abandoned` event record it. Egress is checked before
  every send, since the route may have changed. A stop counts too: it aborts a call in flight, so
  the next start sends it again. Finished calls and their prompts go after `retainDays`
  (default 30). The
  [effect register](../architecture/data-flow.md#effect-register) has the row and its crash test.

## The `api-first` preset

[ADR-0025](../decisions/adr/0025-api-first-composition.md): a bundle layer
(`@tsuuanmi/system-preset-api-first`, shipped in the system bundle's `presets/api-first/`) that
turns off every row that drives a website and both model gateways, turns on the agent Worker
rows and the software-development profile (off in the base composition), and sets
`quotaPreference: [local, metered, agent-plan, subscription-chat]`. `system init --preset
api-first` adds it to the profile's bundle list after the system bundle; the operator's own
`cordis.patch.yml` is never rewritten. Templates that need `web-search` or `deep-research` then
fail admission with `no Worker proves …`
([templates](../reference/workflow-templates.md#presets)).
