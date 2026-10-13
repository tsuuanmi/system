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
  - **Re-attempts:** a failure the route's retry policy calls transient is sent
    again with that policy's backoff, at most `maxRetries` times (default 2,
    at most 5), even under an unbounded route policy.
  - **Keys** never pass through here: the route resolves its `apiKeyEnv`
    reference through `ctx.credentials` per request.
- **`ModelWorkers`** registers the `models` Worker source with `ctx.workers`. It
  reaches models only through `ctx.models`.
  - **Workers:** `model:<id>` per entry. It proves `reason` (evidence `probe`)
    while available; otherwise it is `unavailable`. Tier, quota class, and
    locality come from the entry. It never proves `local-data` or
    `persistent-conversation`.
  - **Calls** (`start`, `get`, `wait`, `cancel`): durable at once in
    `model_calls`, idempotent by key; a session is refused.
  - **Egress (INV-12):** the exact prompt is checked by `ctx.egress` before it
    is sent, as Worker class `model`, or `model-local` for a local entry. The
    decision joins the call's decision chain. A denial fails the call as
    `egress_denied`, never sent.
  - **Bounds (INV-9):** `maxConcurrentCalls` (default 4), the requirement's
    `budget.maxTokens`, and `callTimeoutMs` (default 5 min; failure `timeout`).
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
- **Config:** `models` (the catalog; empty by default, so no Workers),
  `maxRetries`, `maxConcurrentCalls`, `callTimeoutMs`
  ([catalog](../../../docs/reference/configuration.md#models)).
- **Injects:** `LlmModels` `llm`; `ModelWorkers` `store`, `artifacts`, `leases`,
  `workers`, `egress`, `models`; the tool, optionally, `mcp` and `credentials`.
- **Tests:** the DSH rows mounted alone against a fake OpenAI-compatible server
  ([`tests/fake-openai.ts`](tests/fake-openai.ts)), the `ctx.models` conformance
  suite on `LlmModels`, and the Worker source on the seam's fake. The crash case
  is [`model.crash.ts`](../../system-bundle/tests/crash/model.crash.ts).
