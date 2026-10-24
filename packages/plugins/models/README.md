# @tsuuanmi/system-models

API and local models as **Workers** ([models](../../../docs/design/models.md),
REQ-WRK-10). One row, `models`, mounts two parts from one configuration:

- **`LlmModels`** provides `ctx.models` ([definition](../../models-core/README.md))
  over DSH `ctx.llm`. Each catalog entry names an `llm` provider route (an
  `llm-pi-ai` `providers` key) and a model on it.
  - **Availability** is a probe without a model call: the route is mounted and
    resolves the model.
  - **A call** streams one request and returns the visible text, the provider's
    token usage, and the finish. Output tokens are at most the entry's
    `maxTokens`.
  - **A stalled stream:** an attempt whose stream is silent for `idleTimeoutMs`
    (default 5 min) is stopped and fails as DSH `TIMEOUT`, saying how many
    events and characters it got. A slow answer that keeps streaming is not
    stopped.
  - **Re-attempts:** a failure the route's retry policy calls transient is sent
    again with that policy's backoff, at most `maxRetries` times (default 2,
    at most 5), even under an unbounded route policy.
  - **Keys** never pass through here: the route resolves its `apiKeyEnv`
    reference through `ctx.credentials` per request.
- **`ModelWorkers`** registers the `models` Worker source with `ctx.workers`. It
  reaches models only through `ctx.models`.
  - **Workers:** `model:<id>` per entry. It proves `reason` (evidence `probe`)
    while available; otherwise it is `unavailable`. Tier, quota class, and
    locality come from the entry, and so does its provider family
    (`family`, by default the route; give two routes to one vendor the same
    family), and its `description` (`capability-descriptor@1.6`, for the roster only). It proves `persistent-conversation` too (evidence `conformance`):
    it keeps sessions itself. It never proves `local-data`.
  - **Calls** (`start`, `get`, `wait`, `cancel`): durable at once in
    `model_calls`, idempotent by key.
  - **Sessions** ([ADR-0031](../../../docs/decisions/adr/0031-model-worker-sessions-by-replay.md),
    `affinity`, `handle`, `reset`, `release`):
    - each turn replays the session's earlier turns from `model_session_turns`,
      exactly the turns it was accepted with (a hash);
    - one turn in flight per session;
    - `maxSessionTurns` and `maxHistoryChars` are bounds per row or entry: past
      one, the turn fails and nothing is cut;
    - a session stays within its model's family;
    - egress covers the history as sent, at its highest classification;
    - the transcript ends with the session, never with a call's retention.
  - **Briefs:** a start that names a `brief@1.x` is rendered at start with the
    default text rendering, its pointers resolved to their artifacts' text
    ([briefs](../../../docs/design/workflow-engine.md#briefs)); one that cannot be
    rendered refuses the call as `invalid_input`, nothing sent.
  - **Egress (INV-12):** the exact prompt is checked by `ctx.egress` before it
    is sent, as Worker class `model`, or `model-local` for a local entry. The
    decision joins the call's decision chain. A denial fails the call as
    `egress_denied`, never sent.
  - **Bounds (INV-9):** `maxConcurrentCalls` (default 4), the requirement's
    `budget.maxTokens`, and `callTimeoutMs`, the ceiling over every attempt and
    back-off (default 15 min; failure `timeout`).
  - **Result:** a `report` artifact, `model-answer@1.0`, with the requirement's
    classification and the token usage, which the usage report shows.
  - **Cancel (REQ-WRK-4):** a running call is aborted, a queued one never sent.
  - **Restart (INV-4):** a model call is safe to repeat with a bounded cost. A
    call that was running is sent once more; a call already sent twice fails as
    `reconciliation_failed`. Each is a recorded `reconciliation` decision and a
    `models.call.resent` or `models.call.abandoned` event; egress is checked
    before every send.
  - **Retention:** finished calls and their prompts go after `retainDays`
    (default 30). A call whose lease another process holds is looked
    at again when that lease would expire.
- **`model_key`** (MCP tool, operator scope; `system model key <NAME>`): stores a
  route's API key, encrypted, under the credential reference its `apiKeyEnv`
  names. Nothing is returned or logged.
- **Config:** `models` (the catalog; empty by default, so no Workers; an entry
  may set `maxSessionTurns` and `maxHistoryChars`, and `maxInputChars`, the
  longest prompt it takes, declared to admission
  ([ADR-0032](../../../docs/decisions/adr/0032-admission-refuses-input-longer-than-a-worker-takes.md))), `maxRetries`,
  `maxConcurrentCalls`, `callTimeoutMs`, `idleTimeoutMs`, `retainDays`, `maxSessionTurns`,
  `maxHistoryChars`
  ([catalog](../../../docs/reference/configuration.md#models)).
- **Injects:** `LlmModels` `llm`; `ModelWorkers` `store`, `artifacts`, `leases`,
  `workers`, `egress`, `models`; the tool, optionally, `mcp` and `credentials`.
- **Tests:** the DSH rows mounted alone against a fake OpenAI-compatible server
  ([`tests/fake-openai.ts`](tests/fake-openai.ts)), the `ctx.models` conformance
  suite on `LlmModels`, and the Worker source on the seam's fake. The crash case
  is [`model.crash.ts`](../../system-bundle/tests/crash/model.crash.ts).
