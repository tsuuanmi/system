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

    Both nodes use `acceptance.answer`. A live report can have no citation
    links, so a deployment that requires them configures `acceptance.cited`.
  - `review` is one node, `review:1`, requiring `review` and `local-data`. It
    routes to a local agent Worker (`agents` source), never to a website
    account.
  - `panel` is a team of two members over two rounds, on distinct accounts,
    and a cited synthesis (see Teams).
  - `investigate` is a planner, `plan:1`, then `synthesis:1`. The planner's plan
    adds the research steps (graph growth), and the synthesis answers from their
    findings (`{{grown}}`).
  - Config `templates` adds or replaces templates. A template is checked at
    load (preflight):
    - valid, unique node ids;
    - known dependencies, and no cycles;
    - a prompt may use only `{{input}}` and its own dependencies
      (`{{node:<id>}}`);
    - exactly one final node, whose result is the run's.
  - At `start`, every node's acceptance contract must be registered with
    `ctx.workers`; otherwise the run is refused before anything is sent.
- **Start (admission).**
  - The caller's options are applied, and the resolved spec is hashed. The run
    binds to that `specHash`.
  - Runs and nodes are written in one transaction. The engine issues the run's
    session id, so `research` returns its `runId` and `sessionId` at once
    (REQ-SES-8). A caller's `sessionId` must be one the engine issued.
  - `clientRequestId` makes `start` idempotent.
  - At most `maxActiveRuns` runs are unfinished at once (INV-9).
- **Nodes** are durable `workflow-node@1.0` records, validated on every write.
  - `WAITING` → `READY`: when every dependency is `COMPLETED`, the prompt is
    rendered from the dependencies' results. The input receipt binds
    `inputHash` (the node, the rendered prompt, and the dependency results)
    and its bundle.
  - A `worker` node declares capabilities, and its requirement (objective,
    capabilities, plus `persistent-conversation` in a session, classification,
    tier, and contract) is recorded at admission.
  - The engine routes it through `ctx.workers` (a session keeps its affinity),
    then starts it on the admitted Worker's source. A website Worker's source is
    the turn runtime. The request key is the run, node, attempt, and input hash,
    so a restart re-attaches to the same execution and never sends twice.
  - `RUNNING` carries the execution and its route decision. A stop while
    routing starts nothing.
  - An admission failure fails the node with nothing sent: `reauth_required`
    when there is no Worker or one was kept out only by its account's state,
    `egress_denied` for local-private work with no local Worker, `config_error`
    otherwise.
  - When the turn completes, `ctx.workers.accept` checks the result against
    the node's contract and records an `acceptance` decision. `COMPLETED`
    holds the output receipt (result plus acceptance).
  - **Escalation (REQ-WRK-9).** A rejected result runs again at the next tier
    above the one that served it, at most `maxEscalations` times (per node,
    default 1, at most 3). The run is a new execution of the same node: its
    requirement's tier becomes `{ min: next, source: decision }`, and its key
    carries the escalation count. The rejected result stays as evidence. The
    choice is an `escalation` decision either way, and `workflow.node.escalated`
    names it. With no tier left, or the bound reached, the node fails with
    `acceptance_rejected` (`NONE`).
- **Graph growth (REQ-WF-8, REQ-WF-10).**
  - A node with `grows` is a planner. Its accepted answer must carry a JSON
    plan, which is untrusted input checked against bounds:
    - short unique ids under the planner's prefix;
    - dependencies only among its own steps, and acyclic;
    - at most `maxNodes` steps (default 6);
    - capabilities only from `capabilities` (default reason, web-search, review,
      local-data), and a known tier.
  - A valid plan is stored as a `plan@1.0` artifact and recorded as a
    `graph-growth` decision. Its steps are appended after the planner, in the
    same transaction as the planner's completion, and the planner's dependents
    wait for them. A step's prompt is used literally; its tier comes from the
    decision.
  - An invalid plan fails the planner as `plan_rejected` (`NONE`), and nothing
    is appended.
- **Approval gate (REQ-WF-11).**
  - Steps that need a capability in `approvalRequired` (default `develop`) run
    behind a `gate` node, which waits `BLOCKED`. The run is parked, not failed,
    and its view shows `blocked { nodeId, plan }`.
  - `approve(runId, verdict)` (MCP `approve`, `system approve`) records an
    `approval@1.0` bound to that exact plan, then a `gate` decision. Approved,
    the steps run; rejected, the run fails as `plan_rejected`.
  - `autoApprovePlans` (default off) approves a high-confidence plan by policy.
- **Teams (REQ-TEAM-1..4, [design](../../../docs/design/teams.md)).**
  - A template node with `team: { members (2-5), rounds (1-3, default 2),
    distinctAccounts (default true), synthesisTier }` is unrolled at admission:
    - `id:m<k>:r1` per member: no dependency on a peer and no peer text. This
      is the independent-first barrier, made structural;
    - `id:m<k>:r<n>`: each depends on every member's previous round and reads
      the peers' answers (`{{peers}}`) to critique and revise;
    - a synthesis under the team node's own id, which reads every final answer
      (`{{members}}`).
  - Each member is one persistent session that the engine issues, so session
    affinity keeps one identity and one Worker for the team's lifetime
    (Model A).
  - With `distinctAccounts`, members route one at a time, each avoiding every
    account another member holds. Too few ready accounts fails closed
    (`config_error`).
  - The synthesis must pass `acceptance.team-synthesis`: it must have text and
    cite members as `[m<k>]` (REQ-TEAM-3).
- **Retries (REQ-WF-6).**
  - A failure is retried, up to `maxAttempts` and after
    `retryDelayMs × 2^(attempt−1)`, only when all of these hold:
    - its disposition is `IMMEDIATE`, `BACKOFF`, or `RECREATE_SESSION`;
    - attempts are left;
    - the prompt never reached the provider (the turn's `submitted` flag).
  - Once a prompt was sent, only the turn runtime may resubmit it, within its
    own bound. A retryable failure after sending fails the node as
    `USER_ACTION`, so the engine never causes a duplicate provider turn
    (INV-4).
  - Each choice is a `recovery` decision. It becomes the node's
    `lastDecision`, and the `retry` or `failed` event names it.
- **Ownership and restart (REQ-WF-4).**
  - A run advances under a `run:<id>` lease, and every node write is fenced.
  - A lost lease (a host that slept past it, or a takeover) re-arms the run,
    so it is taken back as soon as the lease is free.
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
    acceptance or recovery decisions with their reasons (REQ-ART-3). A node keeps
    its turn's decision ids, so the chain outlives the turn runtime's retention.
  - Node requirements carry the node's objective and tier provenance:
    `profile` for template tiers, `caller` when the caller's tier replaced one.
- **MCP tools** (they replace the built-in placeholders):
  - `ask` waits up to `waitSeconds` (≤ 55 s);
  - `run { template, input, … }` starts any template, and waits like `ask`;
  - `approve { runId, verdict, note? }` gives the operator's verdict on a waiting plan;
  - `stop`, `continue`, `delete`, and `supersede` are the operator controls above;
  - `research` returns at once;
  - `result` takes a `runId` and long-polls it;
  - `usage`;
  - `explain` takes a run id, or any artifact id (its input tree).
- **Operator control (REQ-WF-7).** Each action is recorded as the operator's
  `recovery` decision:
  - `stop(runId, reason)` halts the run's advance and cancels running executions
    through their sources (`cancel`). Every unfinished node fails as `stopped`.
    Nothing is resent.
  - `continue(runId, nodeId?)` reopens exactly one failed node, or a stopped
    run's stopped nodes, as a new attempt, and the run resumes. Work that was
    already sent may be sent again: that is the operator's call.
  - `delete(runId, updatedAt?)` previews without `updatedAt`. With the preview's
    `updatedAt`, it deletes a finished run's rows; a changed run is refused.
    Artifacts stay (append-only).
  - `supersede(runId, nodeId, { text, note })` is lineage invalidation. A
    completed node's result is replaced by an operator's correction, which
    supersedes the old artifact and must pass the node's contract. Every node
    downstream, transitively, is fenced and runs again: new inputs, new hashes,
    no stale reuse. Each records a `recovery` decision naming both artifacts.
    It is refused for a running run, and where re-planning would be needed.
  - `usage` lists runs, and `result` / `watch` follow one.
  - A request that arrives while a run's advance is still unwinding (for
    example `continue` right after the run failed) runs once that advance
    ends; it is never dropped.
- **Retention:** runs are deleted only by the operator (`delete`). After
  `retainDays`, a finished run's input text and rendered prompts are cleared.
- **Not yet:**
  - profile growth rules (growth comes only from plans);
  - team procedures beyond panel critique: a lead, and direct messages between
    members;
  - independent review with assessment artifacts;
  - re-planning after a superseded input.
- **Injects:** `store`, `artifacts`, `eventLog`, `leases`, `egress`, `workers`;
  `mcp` is optional.
