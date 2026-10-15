# @tsuuanmi/system-workflow

**`ctx.workflow`**: the single workflow engine
([design](../../../docs/design/workflow-engine.md),
[ADR-0012](../../../docs/decisions/adr/0012-dag-execution-model.md)). This is the
MVP subset. Every MCP `ask` and `research` call is a run on it; there is no
second execution path (INV-1).

- **Templates are data.** The built-in ones are `ask` and `panel` (until a team
  `brainstorm` replaces it, PROP-0004); profiles add theirs, such as `research`
  and `agent-review`; config `templates` adds or replaces any. Each one's nodes,
  and the templates PROP-0004 removed, are listed in the
  [workflow templates](../../../docs/reference/workflow-templates.md) reference.
  - `ask` is one node, `ask:1`. It takes the caller's tier and session.
  - `panel` is a team of two members over two rounds, on distinct accounts,
    and a cited synthesis (see Teams).
  - **Variants.** A node may declare `variants`; the caller picks one at start
    (`variant`), and its fields replace the node's own before the spec is hashed.
    An unknown variant is refused as `invalid_input`
    ([design](../../../docs/design/workflow-engine.md#variants)).
  - **Exact-subject review (REQ-WF-5).**
    - When a step that proves `review` depends on an agent result whose
      workspace is a git working tree, the engine captures that tree's
      subject at promotion: `git:<HEAD>:<hash of every change on top>`.
    - It appends the subject, the verbatim diff, and the request to the
      review's prompt, and asks for a JSON assessment that names the subject.
    - On completion, an exact-subject `gate` decision passes only if the
      assessment names that subject and the working tree is still it. The
      `assessment@1.0` artifact is then stored, bound to the subject.
      Otherwise the step fails as `stale_subject`.
  - **Remediation cycles** (an engine rule for every template, keyed on the
    `review` capability).
    - When a step that proves `review` is bound to an exact subject, and its
      assessment requests changes with blocking findings, the engine appends a
      fix step, on the capabilities of the step that wrote the change. Its
      prompt is engine-composed and quotes the findings as data.
    - It then appends a re-review bound to the new subject. Whatever waited
      for the review waits for both.
    - Cycles stop at the engine config `maxReviewCycles` reviews (default 3,
      the first included). Each choice, the bound included, is a
      `graph-growth` decision (`workflow.remediation`).
  - **Structured results (REQ-ART-5).** A node with `resultSchema: <tag>`:
    - the engine checks at load that the registry holds the schema;
    - the schema goes into the work requirement
      (`acceptance.resultSchema`);
    - the schema is appended verbatim to the node's prompt;
    - acceptance checks the answer's JSON against the schema before the
      contract runs, and the result is rejected, with why, if it fails.
  - **Profiles (REQ-WF-9).** A profile plugin contributes templates with
    `ctx.workflow.template(name, nodes)` for its lifetime. Each is checked like
    a configured one. Admitted runs keep their resolved spec, so withdrawing a
    template never touches them: they still answer `explain` and `result`, and
    a new run of it is refused (`unknown workflow template`). `templateNames()`
    lists what is served. The seam's conformance suite is
    [`conformance/profiles.ts`](conformance/profiles.ts).
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
  - `approve(runId, { verdict, note?, plan? })` (MCP `approve`,
    `system approve`) records an `approval@1.0` bound to that exact plan, then a
    `gate` decision. Approved, the steps run; rejected, the run fails as
    `plan_rejected`.
  - The verdict is bound to the plan the operator read: `plan` names it, and the
    gate is read under the run's lease. Without `plan` the run must wait on
    exactly one plan; with several waiting, the call is refused and lists them,
    so a plan that arrived later is never approved unseen.
  - `autoApprovePlans` (default off) approves a high-confidence plan by policy.
- **Teams (REQ-TEAM-1..4, [design](../../../docs/design/teams.md)).**
  - A template node with `team: { members (2-5), rounds (1-3, default 2),
    distinctAccounts (default true), synthesisTier }` is unrolled at admission:
    - `id:m<k>:r1` per member: no dependency on a peer and no peer text. This
      is the independent-first barrier, made structural;
    - `id:m<k>:r<n>`: each depends on every member's previous round, and reads
      its own inbox (`{{inbox}}`) to critique and revise;
    - a synthesis under the team node's own id, which reads every final answer
      (`{{members}}`).
  - Each member is one persistent session that the engine issues, so session
    affinity keeps one identity and one Worker for the team's lifetime
    (Model A).
  - Members talk through `ctx.workerSessions`. The run forms one group per team
    with its barrier closed, and each member joins at its first admission. An
    accepted answer is posted as that member's message, in the same
    transaction as its completion. A `To m<k>: …` line is a direct message
    instead. The barrier opens when the first round is done.
  - When the run finishes, its members' leftover mail is acknowledged: the
    rounds consumed it.
- **Wake-on-message ([design](../../../docs/design/sessions-and-messaging.md)).**
  - A message to an idle Worker session wakes it once its own run is no
    longer running. The message must ask for a reply: any intent but `answer`
    or `close`.
  - The session takes one turn on its unread messages as an `ask` run on its
    own session. Session affinity keeps it on its Worker (Model A), and the
    session is ACTIVE, with its native conversation handle, for that turn.
  - The reply goes to each peer who wrote, as an `answer`, so it wakes nobody.
    The operator reads the reply as the run's answer.
  - The mailbox is then acknowledged, and the session is idle again. Mail that
    arrived during the turn wakes it again.
  - It is idempotent per (session, last message), one wake at a time per
    session, and bounded by the session's turn budget.
  - It is durable (`workflow_wakes`). On start, unfinished wakes are settled
    and sessions with unread mail are woken.
  - **Input required:** a reply starting `INPUT_REQUIRED: <question>` goes to
    the peers as `input-required`. The session waits until any reply wakes it.
  - **Checkpoints:** every `checkpointEveryTurns` turns, the engine writes a
    `report` artifact (`session-summary@1.0`) with the latest reply.
  - **Compaction:**
    1. Past `compactAtTokens` (estimated), the session writes a handoff summary
       as one more turn. It is stored as a `handoff` artifact.
    2. The Worker source resets the native conversation (`workers.reset`), and
       the session's generation advances.
    3. The next wake opens a fresh conversation that starts from the handoff.
  - `lead: { tier }` (default `economy`) adds a lead after each round but the
    last ([lead](../../../docs/design/teams.md#lead)). It reads the members'
    current answers and replies `{"converged": …, "reason": …}`
    (`acceptance.team-lead`). The engine records that as a `gate` decision
    decided by a model.
    - Not converged: the next critique round runs.
    - Converged: later rounds are carried. Each member keeps its last answer,
      with the lead's decision as the cause, and nothing is sent.
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
- **Events:** `workflow.run.started|completed|failed|continued|deleted|expired`,
  `workflow.node.started|retry|completed|failed|blocked|escalated|superseded`,
  `workflow.graph.grown|retired`, and `workflow.gate.opened|closed`. A completed node's
  event carries the Worker, tier, and quota class that served it.
- **Read side:**
  - `get`, `wait`, and `records` read a run and its node records.
  - `usage` lists recent runs with each step's Worker, tier, and quota class,
    and the tokens its result reports, when its Worker counts them (a model
    Worker's `model-answer`) (the usage report).
  - `explain` gives each step's egress, tier, route (or admission), and
    acceptance or recovery decisions with their reasons (REQ-ART-3). A node keeps
    its turn's decision ids, so the chain outlives the turn runtime's retention.
  - Node requirements carry the node's objective and tier provenance:
    `profile` for template tiers, `caller` when the caller's tier replaced one.
- **MCP tools** (they replace the built-in placeholders):
  - `ask` waits up to `waitSeconds` (≤ 55 s);
  - `run { template, input, variant?, … }` starts any template, and waits like `ask`;
  - `approve { runId, verdict, note?, plan? }` gives the operator's verdict on a
    waiting plan (`plan` is required when several plans wait);
  - `stop`, `continue`, `delete`, and `supersede` are the operator controls above;
  - `drain` admits no new run (a new one is refused as `overloaded`) and
    reports the runs still executing; call it again to poll. `resume` admits
    runs again;
  - `research` returns at once; `deep: true` runs its `deep` variant;
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
    It is refused for a running run.
  - **Re-planning** ([design](../../../docs/design/workflow-engine.md#re-planning)):
    a planner downstream of the replacement plans again, and a replaced planner's
    result is its new plan (an invalid one is refused, and nothing changes).
    What the replaced node or a rerun node grew (plan steps, gates, remediation
    cycles), by its recorded origin `grownBy`, becomes `RETIRED`: kept as
    history in `workflow-node@1.1`, recorded in a `graph-growth` decision
    (`workflow.re-plan`, `retire`) with states and results. New growth gets
    `:g<n>:` ids. The new plan supersedes the old one behind a new gate; a
    verdict on it must name it; after a retired step that needed approval
    started, it is the operator's even under `autoApprovePlans`. A gate is never
    superseded.
  - `usage` lists runs, and `result` / `watch` follow one.
  - A request that arrives while a run's advance is still unwinding (for
    example `continue` right after the run failed) runs once that advance
    ends; it is never dropped.
- **Retention:** the operator deletes runs (`delete`). After `retainDays`, a
  finished run's input text and rendered prompts are cleared. With
  `retainRunsDays` (default 0, off), a finished run older than that is deleted
  daily, except a session's latest run, and then `ctx.artifacts.collect()` takes
  what only expired runs needed.
- **Injects:** `store`, `artifacts`, `eventLog`, `leases`, `egress`, `workers`, `workerSessions`;
  `mcp` is optional.

## Source layout

`src/index.ts` is the `ctx.workflow` service: its config, startup, and public
methods. Each mechanism lives in its own module and works on the engine state
in `engine.ts`:

| Module | Owns |
|---|---|
| `engine.ts` | engine state; admission (`start`); the run loop under the run lease; a node's path from `WAITING` to `COMPLETED` or `FAILED`; node writes |
| `spec.ts` | templates, preflight, resolution, prompt rendering, and parsing of plans, assessments, and lead decisions |
| `types.ts` | records, views, config, row shapes, `WorkflowFailure` |
| `migrations.ts` | the engine's tables |
| `recovery.ts` | retries after a failed attempt, escalation after a rejected result, admission failure kinds |
| `growth.ts` | graph growth and approval gates |
| `review.ts` | exact-subject review and remediation cycles |
| `teams.ts` | team messages, barrier, lead and carried rounds, distinct accounts, team contracts |
| `sessions.ts` | wake-on-message, checkpoints, compaction |
| `operator.ts` | `stop`, `continue`, `supersede`, `approve` |
| `retention.ts` | `delete` and the expiry of private text |
| `views.ts` | run views, `usage`, `explain` |
| `tools.ts` | the MCP tools |
