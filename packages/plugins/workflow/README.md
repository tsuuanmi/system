# @tsuuanmi/system-workflow

**`ctx.workflow`**: the single workflow engine
([design](../../../docs/design/workflow-engine.md),
[ADR-0012](../../../docs/decisions/adr/0012-dag-execution-model.md)). This is the
MVP subset. Every MCP `ask` and `research` call is a run on it; there is no
second execution path (INV-1).

- **Templates are data.** The built-in ones are `ask`, `brainstorm`, and `review`;
  profiles add theirs, such as `research`
  and `agent-review`; config `templates` adds or replaces any. Each one's nodes,
  and the templates PROP-0004 removed, are listed in the
  [workflow templates](../../../docs/reference/workflow-templates.md) reference.
  - `ask` is one node, `ask:1`. It takes the caller's tier and session.
  - `brainstorm` is one team node of two members, one per provider family;
    `review` is a source step, then such a team node (see Teams).
  - **Variants.** A node may declare `variants`; the caller picks one at start
    (`variant`), and its fields replace the node's own before the spec is hashed.
    An unknown variant is refused as `invalid_input`
    ([design](../../../docs/design/workflow-engine.md#variants)).
  - **Different provider families.** A node with `differentFrom: [nodeId…]`
    waits until those nodes have Workers, then routes excluding their provider
    families; a named node that failed stops it, and a Worker whose family
    cannot be read fails it as `config_error`
    ([design](../../../docs/design/workflow-engine.md#different-provider-families)).
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
    - exactly one final node, whose result is the run's;
    - `differentFrom` names only other, non-team nodes;
    - a team node has no `differentFrom`, `grows`, or `resultSchema`;
    - a source step (`snapshot: true`) has no `team`, `grows`, `variants`,
      `differentFrom`, or `resultSchema`.
  - A configured template that fails its check is refused alone, with why: it
    is not served, `refusedTemplates()` lists it (health shows it as
    `templates`), and starting it says why. The engine and every other template
    keep working (INV-2). `checkConfig(config)` runs the same checks without a
    host, for `system check` before an update's restart.
  - At `start`, every node's acceptance contract must be registered with
    `ctx.workers`; otherwise the run is refused before anything is sent.
- **Start (admission).**
  - The caller's options are applied, and the resolved spec is hashed. The run
    binds to that `specHash`. A caller's `repository` is part of it; a template
    with no source step refuses one as `invalid_input`.
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
    and its view shows `blocked { kind: 'gate', nodeId, plan, until }`.
  - The wait is bounded (INV-9): after `gateTimeoutHours` (default 24, at most
    720) with no verdict, the gate closes by rule (a `gate` decision by
    `workflow.gate-timeout`), and the run fails as `gate_timeout`, saying when
    and how to go on. `continue` reopens the gate, which waits again with a new
    deadline. Nothing of the plan ran.
  - `approve(runId, { verdict, note?, plan? })` (MCP `approve`,
    `system approve`) records an `approval@1.0` bound to that exact plan, then a
    `gate` decision. Approved, the steps run; rejected, the run fails as
    `plan_rejected`.
  - The verdict is bound to the plan the operator read: `plan` names it, and the
    gate is read under the run's lease. Without `plan` the run must wait on
    exactly one plan; with several waiting, the call is refused and lists them,
    so a plan that arrived later is never approved unseen.
  - `autoApprovePlans` (default off) approves a high-confidence plan by policy.
- **Teams (REQ-TEAM-1, 2, 4..7, [design](../../../docs/design/teams.md)).**
  - A template node with `team: { kind: brainstorm | review, members (2-5,
    default 2), debateRounds (0-2, default 1) }` is unrolled at admission:
    - `id:m<k>:propose` per member, with no peer text (the independent-first
      rule, made structural). Member k has `differentFrom` members 1..k-1
      (ADR-0027). It must pass `acceptance.team-proposal` (brainstorm) or
      `acceptance.team-findings` (review);
    - `id:m<k>:ballot:1`: a sealed ballot over every option, its prompt composed
      by the engine, peers quoted as fenced data
      (`acceptance.team-ballot-<n>` or `acceptance.team-ballot-review`);
    - `id:tally:1` and the decision under the team node's own id: deterministic
      `team` steps that run no Worker.
  - **A review's source** ([design](../../../docs/design/teams.md#sources)): the
    `source` node is run by the engine, with no Worker (record executor
    `effect`). It reads the caller's public repository at one pinned commit
    through `libs`' `snapshotRepository`, or else takes the caller's text as
    the one file `material`. It stores a `source-snapshot@1.0` `evidence`
    artifact and an `acceptance` decision `workflow.source-snapshot` (the URL,
    commit, files with their blob ids, and the unread files). The members'
    proposal prompt is the request, then the files line-numbered between
    content-derived fences, then the unread list. Config `repositories`: the
    allowed `hosts` (default `github.com`), `maxFiles` (40), `maxBytes`
    (300 KB), `maxFileBytes` (48 KB), and `maxSourceChars` (24,000 characters
    as members read it; `fitSource` lists files past it as not shown, and
    caller text past it is refused). A refused URL fails the step as
    `invalid_input`; an unreachable one is retried with backoff.
  - Options are fixed at propose time: brainstorm `O<k>` is member k's
    recommendation, verbatim; review options are `pass` and `changes`, over one
    list `F1..Fn` of every member's findings, in member order, merged only when
    they quote the same `path:line`, with every reporter and the highest
    severity. Each finding is classed against the source: `confirmed` (its
    quote matches a shown line within ±2 lines), `needs-verification` (with
    why), or `suggestion`
    ([quote checks](../../../docs/design/teams.md#quote-checks)).
  - A tally records a `vote` decision (decision@1.1; @1.2 with a review's
    checked findings) with the round's ballots, against a strict majority of
    every member. A confirmed blocking finding decides a review `changes`
    first: the round ends `blocking-finding`, by the rule
    `workflow.blocking-finding`, with no majority, debate, or tie. On a split,
    with an objection open and debate rounds left, it appends
    `id:m<k>:debate:<r>` and `id:tally:<r+1>` (a `graph-growth` decision
    `workflow.team-debate`). A debate turn answers the crux and casts the next
    sealed ballot.
  - The decision completes as `blocking-finding` or `team-majority`, or blocks
    as a `tie`: the view shows `blocked { kind: 'tie', nodeId, decision, options, until }`, and a
    waiter on `result` or `wait` returns at once. `vote(runId, { decision,
    option | inconclusive, rationale, by })` decides it, bound to that exact
    tie decision; `by` is `client` or `operator`, from the token's scope. After
    `tieTimeoutHours` (default 24, at most 720) the tie completes `inconclusive`
    by the rule `workflow.tie-timeout`; a later `vote` ends it so and is refused.
    Engine timers are capped at 2^31−1 ms, so a long wait looks again then.
  - `stop` then `continue` on a tie promotes the tally and the decision again:
    the tie blocks again, with a new deadline. `supersede` refuses a tally or a
    decision; superseding a member's step re-runs the tally, whose new debate
    gets `:g<n>` ids.
  - The final `vote` decision holds the members by session id, the options,
    every round, the dissent, revisions, any tiebreak, and a review's findings,
    repository, unread count, and deciding findings (`blocking`).
    The result is a `team-result@1.0` report (`@1.1` for `blocking-finding`)
    whose text starts with `outcome: …; method: …; winner: …; decision: …`; for
    `blocking-finding`, each deciding finding with every member's stance
    follows.
  - An invalid ballot is rejected, then escalated or retried; if it still fails,
    the run fails (`continue` redoes it). The threshold never drops.
  - Each member is one persistent session that the engine issues, so session
    affinity keeps one identity and one Worker for the team's lifetime
    (Model A). The run forms one session group per team, and each member joins
    at its first admission. Members never message each other. A member's later
    steps stay in its conversation through session affinity, which admits any
    tier of the same account, so an escalated step runs in the same
    conversation without joining again.
  - Members route one at a time, each avoiding every account another member
    holds (REQ-TEAM-4). A member that finds no other provider family fails as
    `config_error`, naming how many families the team needs and how many are
    ready.
  - When the run finishes, its members' leftover mail is acknowledged.
  - A run of the removed procedure (critique rounds, a lead, a synthesis) stays
    readable with `explain` and `result`; `continue` and `supersede` refuse it
    (`invalid_input`).
- **Board tasks ([design](../../../docs/design/workflow-engine.md#board-tasks)).** A run started
  with `task` (MCP `run` `task: { taskId, holder?, generation? }`) serves one attempt of that
  board task, as the run's owner on `ctx.board`:
  - it adopts the claim its caller hands it (renewed, so the board fences a stale one) or claims
    the ready task as `workflow:<runId>`; a task not ready, a stale claim, or a refusal refuses
    the start before anything is written or sent. Each is an `admission` decision
    (`workflow.task-admission`). A task's template, and its project's classification as a
    floor, bind the run;
  - the run is written `starting` (`workflow_tasks`, at most one live run per task), the board
    records it (`start`), and only then is it opened and scheduled; a restart in between is
    decided by the board's record;
  - the engine renews the lease at a third of what the board granted, while the run lives; when
    the board refuses the generation, the run starts nothing new (`workflow.task-holder`
    `wind-down`), reconciles what is in flight, and fails the rest as `holder_lost`;
  - a completed run's result is bound to the subject the task writes (else `stale_subject`),
    with an `acceptance` decision (`workflow.task-acceptance`) naming the task, the subject, and
    the checks the run ran (`schema`, `review`), then submitted and accepted; a refused
    acceptance leaves the task in review. A failed or stopped run, and a run whose holder was
    lost, is reported with `reconcileRun` (a `reconciliation` decision). The view's `task`
    shows the claim, the phase, and how the outcome reached the board;
  - such a run is not continued, superseded, deleted, or expired before its outcome is reported.
  - The board is optional: with none loaded, a task's run is refused (`config_error`) and every
    other run is unchanged.
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
  - **Failover (ADR-0034).** An unsent `quota_exhausted`, `challenge`,
    `reauth_required`, or `overloaded` instead routes the node again with the
    failed Worker left out (`excluded` on the node row, the router's `excluded`
    check), within `maxAttempts`, at once (an overload after its back-off). With
    no other Worker it routes as before. A node whose session holds an account,
    or a team member, never moves. `continue` clears the exclusions.
  - Each choice is a `recovery` decision (`retry`, `failover`, or `fail`). It
    becomes the node's `lastDecision`, and the `retry` (with `failoverFrom`) or
    `failed` event names it.
- **Ownership and restart (REQ-WF-4).**
  - A run advances under a `run:<id>` lease, and every node write is fenced.
  - A lost lease (a host that slept past it, or a takeover) re-arms the run,
    so it is taken back as soon as the lease is free.
  - On start, unfinished runs resume. The turn runtime reconciles their turns.
  - A scheduler exception fails the run as `internal` (`CODE_FIX`) and never
    loops.
- **Events:** `workflow.run.started|completed|failed|continued|deleted|expired`,
  `workflow.node.started|retry|completed|failed|blocked|escalated|superseded`,
  `workflow.graph.grown|retired`, `workflow.gate.opened|closed`,
  `workflow.team.tallied|decided`, and `workflow.task.lost|reported`. A completed node's
  event carries the Worker, tier, and quota class that served it.
- **Read side:**
  - `get`, `wait`, and `records` read a run and its node records.
  - `usage` lists recent runs with each step's Worker, tier, and quota class,
    and the tokens its result reports, when its Worker counts them (a model
    Worker's `model-answer`) (the usage report).
  - `explain` gives each step's egress, tier, route (or admission), and
    acceptance or recovery decisions with their reasons (REQ-ART-3), and each
    vote decision's ballots (round, member, choice, confidence, rationale). It
    lists every attempt's decisions in the order they were made, so a rejected
    answer, and the escalation or retry it led to, stay visible after a later
    attempt. A node keeps its turn's decision ids, so the chain outlives the turn
    runtime's retention. `system explain --json` prints it as it is.
  - Node requirements carry the node's objective and tier provenance:
    `profile` for template tiers, `caller` when the caller's tier replaced one.
- **MCP tools** (they replace the built-in placeholders):
  - `ask` waits up to `waitSeconds` (≤ 55 s);
  - `run { template, input, variant?, task?, … }` starts any template, and waits like `ask`;
    with `task`, for one attempt of that board task (above);
  - `approve { runId, verdict, note?, plan? }` gives the operator's verdict on a
    waiting plan (`plan` is required when several plans wait);
  - `stop`, `continue`, `delete`, and `supersede` are the operator controls above;
  - `drain` admits no new run (a new one is refused as `overloaded`) and
    reports the runs still executing; call it again to poll. `resume` admits
    runs again;
  - `research` returns at once; `deep: true` runs its `deep` variant;
  - `brainstorm { question }` and `review { material, repository?: { url, ref? },
    focus? }` start those templates and return at once;
  - `vote { runId, decision, option, rationale }` (client scope; an operator
    token may call it too) breaks a team's tie;
  - `result` takes a `runId` and long-polls it, returning early when the run
    waits on a gate or a tie;
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
    - Every check that could refuse it runs first. Then the executions of the
      nodes it runs again or retires are cancelled through their sources, as
      `stop` does, and have ended (at most 30 s, else it is refused as
      `overloaded` and nothing changes) before anything is reset. A run that
      failed beside a running node, then restarted, never gets a new attempt
      beside the orphaned one (INV-4).
    - An execution that had already finished keeps its result as history: the
      node's `recovery` decision names it and says so, and it is never taken
      or resent. One that had ended otherwise (a reconciliation that failed
      closed, say) is named with how it ended, and nothing of it is taken.
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
- **Conformance.** The seam's suite is [`conformance/workflow.ts`](conformance/workflow.ts),
  run through the [conformance runner](../../libs/conformance/runner.ts) at contract 1.2 by
  `tests/conformance.spec.ts`, against this engine and the real plugins it injects (the
  store-backed board and approval queue among them), with only Worker execution scripted:
  - valid `workflow-node@1.x` records; a node completes only with its input receipt, its
    Worker's result, and the acceptance decision that accepted it;
  - input bound by hash, and the execution keyed by it; a repeated `clientRequestId`;
  - since 1.1, every execution names its run (`WorkerStart.runId`);
  - since 1.2, a run for a board task: claimed, recorded before it runs, its result submitted and
    accepted on its exact subject; a lead's claim adopted, a stale claim or a task not ready
    refused before anything is written; a failed run reported with `reconcileRun`, never
    continued;
  - admission that fails closed and stays within `maxActiveRuns`; a node no Worker is
    admitted for fails with nothing sent;
  - bounded retries of unsent failures, a sent one never resent, and bounded escalation;
  - a restart that reconciles started executions and starts nothing again;
  - `stop`, `continue`, and `supersede`;
  - graph growth only from a valid plan; a gate opened only by an approval of its exact plan,
    and closed by rule after `gateTimeoutHours`;
  - `drain` and `resume`;
  - the decision a refused planner names (its `graph-growth` refusal), and the `gate` decision a
    blocked gate records and names (what it waits for, until when).
- **Injects:** `store`, `artifacts`, `eventLog`, `leases`, `egress`, `workers`, `workerSessions`;
  `mcp` and `board` (the abstract `Board` of `board-core`, never the board plugin) are optional.
- **Tests** beyond the suite: [`tests/board.spec.ts`](tests/board.spec.ts) runs the engine over
  the store-backed board and approval queue end to end: a task claimed and done, a lead's claim
  adopted, stale claims refused, the lease renewed past its length, a failed and a stopped run
  reported, a restart with the holder lost (reconciled, nothing new started) and one whose work
  finished meanwhile (accepted through `reconcileRun`), a review left to the operator for want
  of a required check, a result off the written subject, and the refusals with no board.

## Source layout

`src/index.ts` is the `ctx.workflow` service: its config, startup, and public
methods. Each mechanism lives in its own module and works on the engine state
in `engine.ts`:

| Module | Owns |
|---|---|
| `engine.ts` | engine state; admission (`start`); the run loop under the run lease; a node's path from `WAITING` to `COMPLETED` or `FAILED`; node writes |
| `spec.ts` | templates, team unrolling, preflight, resolution, prompt rendering, and parsing of plans and assessments |
| `types.ts` | records, views, config, row shapes, `WorkflowFailure` |
| `migrations.ts` | the engine's tables |
| `recovery.ts` | retries after a failed attempt, escalation after a rejected result, admission failure kinds |
| `growth.ts` | graph growth and approval gates |
| `review.ts` | exact-subject review and remediation cycles |
| `sources.ts` | a review's source step: the repository snapshot or the caller's text, rendered for members |
| `teams.ts` | team contracts and parsing, quote checks and merging of findings, options, ballot and debate prompts, tally and the blocking-finding rule, decision, tie and `vote`, distinct accounts |
| `sessions.ts` | wake-on-message, checkpoints, compaction |
| `operator.ts` | `stop`, `continue`, `supersede`, `approve` |
| `retention.ts` | `delete` and the expiry of private text and runs; a deleted run releases the Worker sessions no other run uses |
| `tasks.ts` | runs that serve a board task: taking the task, run first then work, lease renewal, the holder lost, the result's subject and acceptance, the report through the board's moves |
| `views.ts` | run views, `usage`, `explain` |
| `tools.ts` | the MCP tools |
