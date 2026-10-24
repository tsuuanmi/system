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
  - **Kinds of work.** A node may name its `kind` (a label such as `code`; a
    variant may change it), which its requirement carries (`work-requirement@1.2`),
    so a Worker the operator gives kinds takes it only when it lists that kind
    ([work kinds](../../../docs/design/routing.md#work-kinds),
    [ADR-0056](../../../docs/decisions/adr/0056-route-work-by-kind.md)). A remediation
    fix has the kind of the step whose change it fixes, its re-review the review's;
    a planner's step has none.
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
    - The re-review is worded as the review the cycles started from: that
      review's prompt, composed again at promotion (`{{input}}` the caller's
      text, each `{{node:<id>}}` the result that review read, but the fix's in
      place of the step that wrote the change, its note naming the fix). A plan
      step's review stays model text. A re-review an earlier version grew marked
      literal is composed so too, and its spec says so from then on.
    - Cycles stop at the engine config `maxReviewCycles` reviews (default 3,
      the first included). Each choice, the bound included, is a
      `graph-growth` decision (`workflow.remediation`).
    - **The fix waits on the approval queue** (`ctx.approvals`, optional;
      [design](../../../docs/design/workflow-engine.md#remediation-on-the-approval-queue)):
      its gate asks the policy about `remediation` (always `ask`), opens one
      request on the exact subject (the plan's content id at the reviewed
      subject `git:<HEAD>:<hash>`; requester `workflow`, the run, the gate),
      stores its id on the gate, and waits until it expires, reading it every
      `approvalPollSeconds` (default 15). An operator approval bound to that
      plan and subject, given before the request expired, opens the gate (its
      result is the `approval@1.0`) once the working tree is captured again
      and is still the reviewed subject (else `stale_subject`, an
      exact-subject decision); a rejection or withdrawal closes it as
      `plan_rejected`, an expiry, or a queue unreadable past the deadline, as
      `gate_timeout`; `forbid` closes it without asking. Each is a `gate`
      decision (`workflow.remediation-approval`). A restart reads the request
      again, and adopts the gate's own request whose id a crash lost, in any
      state, applying its outcome, never asking twice.
      `approve` refuses such a gate (the queue decides it); `continue` asks
      again on a new request; `stop` withdraws it. With no queue loaded, the
      gate is the operator's plan gate below.
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
    - a prompt may use only `{{input}}`, its own dependencies
      (`{{node:<id>}}`), and `{{grown}}` after a planner; any other `{{` (an
      unknown name, another spelling, no closing `}}`, or `{{team}}`, which only
      the engine's team ballots use) is refused;
    - exactly one final node, whose result is the run's;
    - `differentFrom` names only other, non-team nodes;
    - a team node has no `differentFrom`, `grows`, `resultSchema`, or `kind`;
    - a source step (`snapshot: true`) has no `team`, `grows`, `variants`,
      `differentFrom`, `resultSchema`, or `kind`;
    - a `kind`, a node's or a variant's, matches `^[a-z][a-z0-9-]{0,31}$`.
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
- **Nodes** are durable `workflow-node@1.x` records, validated on every write
  (`@1.2` once an execution names its brief).
  - `WAITING` → `READY`: when every dependency is `COMPLETED`, the template's
    prompt is composed into the brief's instructions: its text and the caller's
    input as text, each dependency's result as a pointer by content id. The input
    receipt binds `inputHash` (the node, the prompt those instructions render to,
    and the dependency results) and its bundle.
  - **Every placeholder filled (INV-2).** Composition fills every placeholder of
    the template's text or composes nothing: one the engine cannot fill fails the
    node as `config_error` with nothing sent, on a `gate` decision
    (`workflow.instructions`) naming it. Before each Worker execution starts, the
    engine checks again that the node's instructions are what its wording
    composes to; a node an earlier version promoted otherwise (a re-review's
    template stored as it is) fails the same way, without its input receipt, so
    `continue` composes it again. Text the engine never expands (the caller's
    input, a result, a plan step's model text, a fix's quoted findings, a diff)
    is data, sent as written.
  - A `worker` node declares capabilities, and its requirement (objective,
    capabilities, plus `persistent-conversation` in a session, classification,
    tier, and contract) is recorded at admission. A review team member's step
    (proposal, ballot, debate) also names its kind of work, `scope: review-member`
    (`work-requirement@1.1`), so a Worker whose offers are scoped to it is
    admitted there and nowhere else
    ([scoped offers](../../../docs/design/routing.md#scoped-offers),
    [ADR-0049](../../../docs/decisions/adr/0049-read-only-agent-workers-as-review-members.md)).
    A node that names its `kind` carries it (`work-requirement@1.2`). A board
    task's session is resumed only on an unscoped `persistent-conversation`, and
    only on a Worker that takes the kind of every step that would continue it.
  - The engine routes it through `ctx.workers` (a session keeps its affinity),
    then records its **brief** (`brief@1.1`, an `objective` artifact: the
    instructions, its goal and criteria, the pointers, the budget, the Worker's
    `sandbox` as its source declares it) and starts it on the admitted Worker's
    source with that brief, which the source renders into its prompt
    ([briefs](../../../docs/design/workflow-engine.md#briefs)). Admission measures
    the rendered prompt. The request key is the run, node, attempt, and input hash,
    so a restart re-attaches to the same execution and never sends twice.
  - `RUNNING` carries the execution, its route decision, and its brief. A stop
    while routing starts nothing.
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
    choice is an `escalation` decision either way (`workflow.escalation`
    version 2), and `workflow.node.escalated` names it. A node its session
    holds to its Workers (a team member, Model A) escalates only when one of
    them serves the next tier or above, since routing would refuse every other
    Worker. Those Workers are listed only for a rejected result; a listing that
    fails leaves them unknown, and the node does not escalate (never failed
    for the listing). With no tier left, the bound reached, no Worker of its
    session at the next tier, or its Workers unknown, the node fails with
    `acceptance_rejected` (`NONE`): the
    contract's reasons, then why it was not escalated. A rejected answer its
    Worker cut at its output bound (`model-answer` `finish: max-tokens`) says so
    among them.
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
    and its view shows `blocked { kind: 'gate', nodeId, plan, until }`, with
    `approvalRequest` when a remediation fix's plan is on the approval queue
    (above).
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
    content-derived fences, then the unread list. For the caller's text, that
    text is the request and the file `material` both, so it is shown once:
    `{{input}}` composes to one line naming the file (`MATERIAL_REQUEST`), so the
    text counts once against a member's input. Config `repositories`: the
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
    tier of the same account (a model Worker's session: a higher tier of its
    family), so an escalated step runs in the same conversation without joining
    again; with none at the next tier, it is not escalated (above). Its Worker's source keeps that
    conversation natively, or by replaying it (a model Worker; an agent Worker
    under the review-member profile whose runtime cannot resume, for a review
    member's steps only, an exact replay recorded with its answer): the ballot
    and debate prompts rely on it holding the request, the source, and the
    member's own earlier answers. A member that cannot continue its
    conversation fails its step; it is never given a fresh one.
  - Members route one at a time, each avoiding every account another member
    holds (REQ-TEAM-4): every sibling of a Worker another member holds, and
    every Worker whose descriptor names the same account, so two roles of one
    agent home are one account. A member whose held account cannot be told
    apart (no source describes the held Worker or names its siblings, or its
    siblings name different accounts) fails as `config_error` with that cause,
    before anything is sent, even with `allowSameFamily`
    ([distinct accounts](../../../docs/design/teams.md#distinct-accounts)). A
    member that finds no other provider family fails as `config_error`. When
    fewer families are ready than the team has members (counting Workers ready
    or busy that prove the step), its message starts with how many it needs and
    how many are ready; otherwise the admission's own reasons are why, and a
    member over every other family's input bound fails as `invalid_input`,
    naming the bound to change.
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
    the checks the run ran (`schema`, `review`), then submitted and accepted; one only the
    operator may accept leaves the review held for the operator. A failed or stopped run, and a run whose holder was
    lost, is reported with `reconcileRun` (a `reconciliation` decision). The view's `task`
    shows the claim, the phase, and how the outcome reached the board;
  - a task that declares a budget runs only where the resource ledger can hold it to its lines:
    with no ledger loaded, or a pool of its budget the ledger does not configure or finds
    unavailable, the start is refused before the task is taken (`config_error`, `overloaded`; an
    `admission` refusal). Once the board recorded the run, before each Worker execution of it (a
    step) is routed, the run reserves its task's lines on the ledger (`ctx.resources.reserve`: the
    lines as caps for the task, the least of each line as the step's draw; ADR-0047, step 1),
    records the step's hold on its row before the step starts, and releases it as soon as the step's
    execution settles (the run's next turn releases any hold left, and a finished run's budget ends
    `released`, reserved or not). A cap the task's earlier steps or attempts already reached refuses it: no new
    step starts, the steps in flight finish and their results are taken, and the run asks for
    funding, from the ledger's count of the
    task's usage (`ctx.resources.usage`): for each spent line, what the task overdrew plus one
    attempt's share of the line, fixed on the run's row (`task.budget.funding`) before it blocks
    the task on the board with it (`budget-spent` with `funding`, which asks the policy about
    `funding`; the operator's approval adds exactly those lines to the task's budget). The run
    fails as `budget_spent`, its outcome `blocked`; the next attempt's brief points at the results
    of the steps it completed. On the task's last
    attempt nothing is asked, since no approval could serve it: a `gate` decision
    (`workflow.task-funding`) and the run's failure (`budget_spent`) commit together, the view's
    `task.budget.lastAttempt` names the decision, and the run's report leaves the task waiting for
    input (`retries-spent`). Any other refusal fails the run (`quota_exhausted`), an attempt the
    board counts. Where it stands is the view's
    `task.budget` and the `workflow.task.budget` event
    ([a task's budget](../../../docs/design/workflow-engine.md#a-tasks-budget),
    [funding a spent task](../../../docs/design/workflow-engine.md#funding-a-spent-task));
  - every brief of the run gives the board's `TASKS.md` projection of its project
    (`renderTasks` of `board-core`, at most `tasksFile.maxTasks` tasks, default 200, and
    `tasksFile.maxChars` characters, default 65,536, cut with a note) as a `board-projection@1.0`
    artifact named in its `files` (`brief@1.2`, path `.system/TASKS.md`), which a Worker source
    with a worktree of the run's own writes there before the run, git-ignored and never read back
    ([TASKS.md in a run's workspace](../../../docs/design/workflow-engine.md#tasksmd-in-a-runs-workspace));
  - a step may answer with questions instead of a result, as every brief of the run offers
    (`brief@1.2` `ask`): an answer that is wholly one `{"questions": [...]}` object, 1 to 8 of at
    most 500 characters, fails the step as `question` with a `gate` decision
    (`workflow.task-question`), nothing new starts, and before the run ends the holder blocks the
    task on them (the board's question wait); its outcome is `blocked`. Answered, the next
    attempt's brief points at the answers
    ([a question from a run](../../../docs/design/workflow-engine.md#a-question-from-a-run));
  - every brief the run writes states the task, the attempt, its goal and acceptance criteria,
    its budget less the usage spent on it (the ledger's records that name the task, its runs, or
    the executions they started, each once), and points at the accepted results of the
    tasks it depends on and, on a later attempt, the previous attempt's result and the decision
    behind this one ([a board task's brief](../../../docs/design/workflow-engine.md#a-board-tasks-brief));
  - a task's next attempt, or the first of a task that depends on exactly one other, resumes the
    session of the run before it when the template keeps a conversation, the session's Worker
    keeps a native session it can resume now, and the session has served fewer than
    `maxSessionRuns` runs (default 5); else it starts fresh. Either is an `admission` decision
    (`workflow.task-session`), made before the task is taken;
  - such a run is not continued, superseded, deleted, or expired before its outcome is reported;
  - once its result reached the board (accepted, rejected, held for the operator, or reconciled
    completed), the engine asks `ctx.digests` for a digest of the result's artifacts, after the
    report so it never blocks it: one per run, at most `digestsPerHour` (default 6; 0 asks for
    none) in any hour, decided by an `admission` decision (`workflow.task-digest`, `request` or
    `bypass`) that takes the bound in the same transaction. A written digest is set on the task's
    `result.digest` through the board's `attachDigest`; a bypass (no digest provider, the bound,
    a refused request, a digest not written, a board that does not take it, or 6 hours without a
    settlement) leaves it unset, recorded with why in the view's `task.digest` and the
    `workflow.task.digest` event. Its state is on the run's `workflow_tasks` row, so a restart
    asks once and goes on waiting
    ([a digest of a task's result](../../../docs/design/workflow-engine.md#a-digest-of-a-tasks-result)).
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
- **A deferred tool call's continuation
  ([design](../../../docs/design/workflow-engine.md#a-deferred-tool-call)).** A node that
  fails for good on an execution its Worker's tool gate deferred (sent, `config_error`, on a
  session, in a run that serves no board task) keeps the request it waits on, read from the
  gate's `agent-workers.tool.deferred` event (`workflow_deferrals`). Every
  `approvalPollSeconds`, and at start, the engine reads those requests through
  `ctx.approvals`: one the operator approved, for exactly that execution and session, continues
  the session once, under the run's lease and in one transaction: a `recovery` decision
  (`workflow.approved-call`), the node reopened as a new attempt whose instructions end with the
  approval, and `workflow.run.continued` (`by: rule`). A rejected request, or a run that moved on
  (continued, stopped, deleted, or failed elsewhere), continues nothing.
- **A plain run's acceptance
  ([design](../../../docs/design/workflow-engine.md#a-plain-runs-acceptance)).** A run that
  serves no board task and wrote (a `develop` step completed) records, before it completes, an
  `acceptance` decision (`workflow.run-acceptance`, under its final step) with the checks it ran
  (`schema`, `review`) and the policy's required checks for `workspace-write` it did not pass,
  pending (`ctx.approvals.check`; `unknown` with none loaded). They never block it: a plain run
  applies nothing.
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
  - **Assigned accounts (ADR-0052,
    [design](../../../docs/design/workflow-engine.md#waiting-for-an-accounts-limit)).**
    The account an attempt was routed to is kept on the node row (`account`).
    A node refused only because the assigned accounts that could take it are at
    their limit (the router's `limitUntil`) waits for the earliest reset:
    `READY`, `not_before` the reset, nothing sent, no attempt spent, its first
    wait kept (`limit_wait_since`) and bounded by `maxLimitWaitHours` (default
    24; past it, or with no known reset, it fails `quota_exhausted` as before).
    After an unsent failure on an assigned account, no other account of its group
    takes the node (`assignment` on the row, `RouteOptions.assignment` on every
    later route); an unsent overload there is retried, never failed over.
    `continue` clears both. The view shows a waiting node's `waitingUntil`.
  - Each choice is a `recovery` decision (`retry`, `failover`, `wait`, or
    `fail`). It becomes the node's `lastDecision`, and the `retry` (with
    `failoverFrom`), `waiting`, or `failed` event names it.
- **Ownership and restart (REQ-WF-4).**
  - A run advances under a `run:<id>` lease, and every node write is fenced.
  - A lost lease (a host that slept past it, or a takeover) re-arms the run,
    so it is taken back as soon as the lease is free.
  - On start, unfinished runs resume. The turn runtime reconciles their turns.
  - A scheduler exception fails the run as `internal` (`CODE_FIX`) and never
    loops.
- **Events:** `workflow.run.started|completed|failed|continued|deleted|expired`,
  `workflow.node.started|retry|completed|failed|blocked|escalated|superseded`,
  `workflow.graph.grown|retired`, `workflow.gate.requested|opened|closed`,
  `workflow.team.tallied|decided`, and `workflow.task.lost|reported`. A completed node's
  event carries the Worker, tier, and quota class that served it.
- **Read side:**
  - `get`, `wait`, and `records` read a run and its node records.
  - `usage` lists recent runs with each step's Worker, tier, and quota class,
    and the tokens its result reports, when its Worker counts them (a model
    Worker's `model-answer`) (the usage report). A step whose execution's
    usage the resource ledger could not count when it ended carries
    `usageUnknown`, the kind its Worker source recorded first in the run's
    `usage.unknown` entries
    ([resources](../../../docs/design/resources.md#usage-the-ledger-cannot-count)).
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
    waiting plan (`plan` is required when several plans wait), never on a remediation
    fix's plan on the approval queue, which is decided there;
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
  finished run's input text, rendered prompts, and composed instructions are
  cleared; its briefs stay with the run. With
  `retainRunsDays` (default 0, off), a finished run older than that is deleted
  daily, except a session's latest run, and then `ctx.artifacts.collect()` takes
  what only expired runs needed.
- **Conformance.** The seam's suite is [`conformance/workflow.ts`](conformance/workflow.ts),
  run through the [conformance runner](../../libs/conformance/runner.ts) at contract 1.5 by
  `tests/conformance.spec.ts`, against this engine and the real plugins it injects (the
  store-backed board, approval queue, and resource ledger among them), with only Worker execution
  scripted:
  - valid `workflow-node@1.x` records; a node completes only with its input receipt, its
    Worker's result, and the acceptance decision that accepted it;
  - input bound by hash, and the execution keyed by it; a repeated `clientRequestId`;
  - since 1.1, every execution names its run (`WorkerStart.runId`);
  - since 1.2, a run for a board task: claimed, recorded before it runs, its result submitted and
    accepted on its exact subject; a lead's claim adopted, a stale claim or a task not ready
    refused before anything is written; a failed run reported with `reconcileRun`, never
    continued;
  - since 1.3, every execution started with a brief recorded before it and named by its record,
    pointing at its dependencies' results and never carrying them, which renders to the
    template's prompt; a board task's brief from the task; a task's next attempt resuming the
    session before it when its Worker can, fresh otherwise;
  - since 1.4 ([ADR-0053](../../../docs/decisions/adr/0053-workflow-contract-states-task-budget-question-and-tasks-file.md)),
    a task's budget: refused before the task is taken when the ledger cannot hold it, reserved
    before each step, a spent line starting no further step and blocking the task with a funding
    request from the ledger's count, the funded attempt pointed at the completed steps, and no
    funding asked on the last attempt (`retries-spent`); a step's questions blocking its task, the
    answers briefing the next attempt, and none offered outside a board task; the board's
    `TASKS.md` in every brief, written git-ignored into the run's own worktree by a scripted source
    with one, the result bound to the worktree's subject without it, nothing committed, nothing
    read back;
  - since 1.5 (ADR-0052), under assigned accounts: a node refused only for an account's limit
    waits for its reset, a `wait` decision, kept across a restart, spending no attempt, then runs
    on it; a reset past `maxLimitWaitHours` fails it; an unsent challenge moves only to another
    group, never to another account of its own, and fails with none; an unsent overload retries
    on its account; under pooled, the failover to another account of the group stands;
  - since 1.5 (REQ-TEAM-4), a team member never takes a sibling of a Worker another member holds,
    even of another family, and takes a Worker of another account; a member whose held Worker's
    siblings name different accounts is refused, `config_error`, with nothing sent;
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
  `mcp` and `board` (the abstract `Board` of `board-core`, never the board plugin) are optional;
  it reads `resources` when present (a task's budget: its reservation, its briefs, and the
  funding a spent one asks for; a task with a budget is refused without it), asks `digests` (the
  abstract `Digests` of `digest-core`) when present, for a task's results, and reads `approvals`
  (the abstract `Approvals` of `approvals-core`) when present: remediation gates, deferred calls'
  continuations, a plain run's acceptance.
- **Tests** beyond the suite: [`tests/board.spec.ts`](tests/board.spec.ts) runs the engine over
  the store-backed board and approval queue end to end: a task claimed and done, a lead's claim
  adopted, stale claims refused, the lease renewed past its length, a failed and a stopped run
  reported, a restart with the holder lost (reconciled, nothing new started) and one whose work
  finished meanwhile (accepted through `reconcileRun`), a review left to the operator for want
  of a required check (held by the board, past the run's lease), a result off the written
  subject, a task's budget reserved and released, a spent one blocking the task, a spent one
  funded over the store-backed ledger (the ask from the ledger's count, approved in the queue, the
  lines raised, the next attempt reserving and running; a denial and an ask past the board's bound
  raising nothing; a crash between the approval and the board's move applying it once), the refusals
  of a budget no ledger can hold, a step's questions blocking its task and the answers briefing
  the next attempt, the board's TASKS.md in every brief (bounded), and the refusals with no board. [`tests/remediation.spec.ts`](tests/remediation.spec.ts)
  runs remediation over the store-backed queue and a git working tree: one request on the exact
  subject and the fix only once it is approved (`approve` refused), a rejection and `continue`, an
  expiry, `forbid`, `stop` withdrawing, a restart that applies a verdict given meanwhile and adopts
  a request whose id was lost, the plan gate with no queue, and a plain run's acceptance with its
  pending checks; and a re-review's instructions: composed as its review's, its pointer re-bound
  to the fix, one an earlier version grew marked literal composed when promoted, and one stored
  uncomposed refused before it starts, then composed on `continue`.
  [`tests/instructions.spec.ts`](tests/instructions.spec.ts) covers the placeholder guard: a
  template with a placeholder the engine does not fill refused at load and on the profiles seam,
  a stored one refused at promotion and before a Worker starts, each on a decision with nothing
  sent, and a `{{…}}` in the caller's input or a result sent as written.
  The continuation of a deferred call runs end to end with a gating agent runtime
  in [`agent-workers`' gate tests](../agent-workers/tests/gate.spec.ts).
  [`tests/digests.spec.ts`](tests/digests.spec.ts) covers
  the digests of task results: asked after the report and set on the task, the next task's brief
  pointing at it, the hourly bound, no provider, a digest not written, a review held for the
  operator, a restart while a request is pending, the wait's bound, and a board that no longer
  takes it. [`tests/member-routing.spec.ts`](tests/member-routing.spec.ts) covers a review
  member kept off a website by its input bound (the live review of 2026-10-23): a text review's
  material shown once, so the member fits the site; a member over a site's bound routed at its own
  tier; a rejected answer its session cannot escalate failed with the rejection and why, never a
  family shortage that is not there, and one it can escalated within its session.

## Source layout

`src/index.ts` is the `ctx.workflow` service: its config, startup, and public
methods. Each mechanism lives in its own module and works on the engine state
in `engine.ts`:

| Module | Owns |
|---|---|
| `engine.ts` | engine state; admission (`start`); the run loop under the run lease; a node's path from `WAITING` to `COMPLETED` or `FAILED`; node writes |
| `spec.ts` | templates, team unrolling, preflight, resolution, composing a prompt into a brief's instructions (every placeholder filled, or none), and parsing of plans and assessments |
| `briefs.ts` | the brief of each execution: drafted from the node's instructions and its board task, its rendered length, recorded with the Worker's sandbox; the guard that no execution starts on instructions that leave a placeholder unfilled, and its decision |
| `types.ts` | records, views, config, row shapes, `WorkflowFailure` |
| `migrations.ts` | the engine's tables |
| `recovery.ts` | retries after a failed attempt, escalation after a rejected result (onto a Worker its session can take), admission failure kinds and their hints |
| `growth.ts` | graph growth and approval gates |
| `review.ts` | exact-subject review and remediation cycles; what a node's instructions are composed from, a re-review's from its review |
| `queue.ts` | a remediation fix's gate on the approval queue: the request on its exact subject, its verdict, adoption after a crash |
| `continuations.ts` | a deferred tool call's continuation: the request noted when its node fails, read from the queue, the session continued once when approved |
| `acceptance.ts` | a plain run's acceptance: the policy's required checks it did not pass, recorded as pending |
| `sources.ts` | a review's source step: the repository snapshot or the caller's text, rendered for members; the caller's text shown once where a prompt shows its snapshot |
| `teams.ts` | team contracts and parsing, quote checks and merging of findings, options, ballot and debate prompts, tally and the blocking-finding rule, decision, tie and `vote`, distinct accounts |
| `sessions.ts` | wake-on-message, checkpoints, compaction |
| `operator.ts` | `stop`, `continue`, `supersede`, `approve` |
| `retention.ts` | `delete` and the expiry of private text and runs; a deleted run releases the Worker sessions no other run uses |
| `tasks.ts` | runs that serve a board task: what their briefs carry, resuming the session before them, taking the task, run first then work, lease renewal, the holder lost, the result's subject and acceptance, the report through the board's moves |
| `digests.ts` | the digest of a task run's result: asked for after the report, bounded per hour, set on the task through the board's `attachDigest`, failing open |
| `views.ts` | run views, `usage`, `explain` |
| `tools.ts` | the MCP tools |
