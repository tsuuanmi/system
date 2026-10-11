# @tsuuanmi/system-workflow

**`ctx.workflow`**: the single workflow engine
([design](../../../docs/design/workflow-engine.md),
[ADR-0012](../../../docs/decisions/adr/0012-dag-execution-model.md)). This is the
MVP subset. Every MCP `ask` and `research` call is a run on it; there is no
second execution path (INV-1).

- **Templates are configuration.**
  - `ask` is one node, `ask:1`. It takes the caller's tier and session.
  - `research` is two nodes:
    1. `research:1` runs Deep research on `frontier` in a persistent session.
    2. `compact:1` gets the report verbatim and compacts it on `economy` in a
       temporary chat.
  - Config `templates` adds or replaces templates. A template is checked at
    load (preflight):
    - valid, unique node ids;
    - known dependencies, and no cycles;
    - a prompt may use only `{{input}}` and its own dependencies
      (`{{node:<id>}}`);
    - exactly one final node, whose result is the run's.
- **Start (admission).**
  - The caller's options are applied, and the resolved spec is hashed. The run
    binds to that `specHash`.
  - Runs, nodes, and the run's persistent session are written in one
    transaction, so `research` returns its `runId` and `sessionId` at once
    (REQ-SES-8).
  - `clientRequestId` makes `start` idempotent.
  - At most `maxActiveRuns` runs are unfinished at once (INV-9).
- **Nodes** are durable `workflow-node@1.0` records, validated on every write.
  - `WAITING` → `READY`: when every dependency is `COMPLETED`, the prompt is
    rendered from the dependencies' results. The input receipt binds
    `inputHash` (the node, the rendered prompt, and the dependency results)
    and its bundle.
  - A `worker` node becomes a turn on `ctx.turns`. The turn's request key is
    the run, node, attempt, and input hash, so a restart re-attaches to the
    same turn and never sends twice.
  - The node stays `READY` until the turn is routed. `RUNNING` carries the
    execution and its route decision.
  - When the turn completes, `ctx.workers.accept` checks the result against
    the node's contract and records an `acceptance` decision. `COMPLETED`
    holds the output receipt (result plus acceptance). A rejection fails the
    node with `acceptance_rejected` (`NONE`).
- **Retries (REQ-WF-6).** A failure that is `IMMEDIATE`, `BACKOFF`, or
  `RECREATE_SESSION` is retried up to `maxAttempts`, after
  `retryDelayMs × 2^(attempt−1)`. Any other failure fails the run.
- **Ownership and restart (REQ-WF-4).**
  - A run advances under a `run:<id>` lease, and every node write is fenced.
  - On start, unfinished runs resume. The turn runtime reconciles their turns.
  - A scheduler exception fails the run as `internal` (`CODE_FIX`) and never
    loops.
- **Events:** `workflow.run.started|completed|failed` and
  `workflow.node.started|running|retry|completed|failed`. A completed node's
  event carries the Worker, tier, and quota class that served it.
- **Read side:**
  - `get`, `wait`, and `records` read a run and its node records.
  - `usage` lists recent runs with each step's Worker, tier, and quota class
    (the usage report).
  - `explain` gives each step's egress, tier, route (or admission), and
    acceptance decisions with their reasons (REQ-ART-3).
- **MCP tools** (they replace the built-in placeholders):
  - `ask` waits up to `waitSeconds` (≤ 55 s);
  - `research` returns at once;
  - `result` takes a `runId` and long-polls it;
  - `usage`;
  - `explain` takes a run id, or any artifact id (its input tree).
- **Retention:** runs are deleted only by the operator (no command yet). After
  `retainDays`, a finished run's input text and rendered prompts are cleared.
- **Not yet:** graph growth, plan approval gates, teams, lineage invalidation,
  tier escalation, and the operator commands `stop`, `continue`, and `delete`.
- **Injects:** `store`, `artifacts`, `eventLog`, `leases`, `turns`, `workers`;
  `mcp` is optional.
