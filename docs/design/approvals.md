# Approvals

> Target state. Boundary: [routing](../architecture/components.md#routing), core component
> *gate* ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)). Proposals:
> [PROP-0010](../proposals/0010-base-version.md),
> [PROP-0008](../proposals/0008-studio-operating-model.md#fewer-approvals-reliable-results).
> Records: [`autonomy-policy@1.0`](../reference/schemas.md#autonomy-policy),
> [`approval-request@1.1`](../reference/schemas.md#approval-request),
> [`policy-change@1.0`](../reference/schemas.md#policy-change); verdicts stay
> [`approval@1.0`](../reference/schemas.md#approval). Decisions:
> [ADR-0039](../decisions/adr/0039-base-guarantee-seam-contract-changes.md),
> [ADR-0041](../decisions/adr/0041-policy-changes-through-the-approval-queue.md).
>
> Implemented in [`approvals`](../../packages/plugins/approvals/README.md) (definition
> [`approvals-core`](../../packages/approvals-core/README.md)); the operator's queue is on `/ui`
> ([`web-ui`](../../packages/plugins/web-ui/README.md), [API](../reference/web-ui.md)); a
> Worker's tool calls pass the gate of [`agent-workers`](../../packages/plugins/agent-workers/README.md),
> which [`runtime-claude-agent-sdk`](../../packages/plugins/runtime-claude-agent-sdk/README.md)
> compiles to a PreToolUse hook. The [workflow engine](workflow-engine.md) consumes it too: a
> remediation fix's gate asks it ([remediation on the queue](workflow-engine.md#remediation-on-the-approval-queue)),
> an approved deferred call's session is continued
> ([a deferred tool call](workflow-engine.md#a-deferred-tool-call)), and a plain run that wrote
> records the checks still pending ([a plain run's acceptance](workflow-engine.md#a-plain-runs-acceptance)).
> Differs from target: with no queue loaded, remediation falls back to the operator's plan gate
> (`approval@1.0` by `approve`), and a planner's plan gate is still the operator's; a
> Worker's tool calls are judged under the studio policy only, since no trusted envelope names an
> agent run's project yet; a deferred run fails as `config_error`, since the workers seam has no
> waiting status, and only the workflow engine continues its session once approved (a board
> task's next attempt is the board's)
> ([below](#where-a-workers-gate-leaves-room)).

Every action that needs a person goes through one queue, in batches, and nothing else asks the
operator. The autonomy policy decides which actions those are; an action that is reversible and
verified runs without asking. Code decides, never a model.

## Seam

`ctx.approvals` (`Approvals` in `@tsuuanmi/system-approvals-core`), contract 1.1:

| Method | Does |
|---|---|
| `policy(projectId?)` | the studio policy, the project's, and the effective mode per action class; from 1.1, the set in force (`set`) |
| `check(action)` | classify one action; records an `autonomy` decision. Its `mode` is the mode once the required checks pass ([below](#a-verdict-is-not-yet-a-permission)) |
| `request(request)` | queue a request for an action the loaded policies still say `ask` for, as its recorded verdict says |
| `get`, `list` | read the queue |
| `batch(at)` | group open requests into batches by the policy's batch rule |
| `decide(verdicts)` | the operator's verdicts, each bound to its request's exact subject |
| `withdraw(requestId)` | close a request whose waiting work ended |
| `sweep(at)` | reject every request unanswered at `at`, then withdraw every open one the loaded policies no longer ask for |
| `proposePolicy(proposal)` | 1.1, optional: the operator's proposed record, asked as one `policy-change` request on the hash of the set it makes, applied only on approval ([below](#a-policy-change)) |
| `policyChanges(filter?)` | 1.1, optional: the policy changes, newest first |

`at` is a test seam, here and in `request`, `batch`, `decide`, and `withdraw`: the MCP tools, the
web UI, the board, and the queue's own passes fill it from the wall clock, and no core caller
passes another time. A provider trusts it: a caller that passed a time far ahead would make a
request that never expires (INV-9).

## The autonomy policy

| Mode | Effect |
|---|---|
| `auto` | the action runs and is recorded, once the rule's required checks pass |
| `notify` | the same, and the operator is shown it afterwards |
| `ask` | an approval request; the action waits for the verdict |
| `forbid` | denied |

- The effective mode is the strictest of the studio policy and the project's, which constrains
  only the classes it names. A class no rule names takes the stricter `default`, which is `ask`
  or `forbid`.
- Irreversible effects (`external-send`, `deploy`, `delete-data`, `spend`), the investor's
  decisions (`charter`, `funding`, `policy-change`), and `remediation` (a fix that writes, or a
  lost run going on, waits for a person: the workflow's remediation gate and the board ask the
  queue about it) are never `auto` or `notify` (`ALWAYS_ASK`).
  The schema refuses a policy that says so (for `remediation`, which the schema predates, a
  load-time rule does), and the provider raises each of them to at least `ask` whatever a rule
  says.
- A failed required check sends the action back to the lead as work, not to the operator. A
  check nobody reported is not a failure: the board holds such a review for the operator's own
  acceptance ([board](board.md#required-checks-bind-at-acceptance)).
- A wait for a person on a class lasts the shortest `expiresSeconds` of the rules that apply to
  it, else the stricter `expiry.defaultSeconds`, never more than the stricter `expiry.maxSeconds`
  (`waitSeconds` in `approvals-core`): a request's `expiresAt`, and a review the board holds for
  the operator.
- A `command` is judged by its exact argv. An argv equal, word for word and with nothing more,
  to a line on every applying commands list is judged as `workspace-write` (unless `command` is
  `forbid`); any other is the `command` class. An argv with a word that holds a shell
  metacharacter (`; & | $`, the backquote, `< > ( ) { } [ ] * ? ~`, quotes, backslash, newline,
  carriage return, tab, NUL) is `forbid`, whatever its class: argv is matched, never parsed by a
  shell. A list entry with an empty word or a metacharacter refuses its policy at load.
- On a Claude Code Worker the policy compiles to a PreToolUse hook: `forbid` → `deny`, `ask` →
  `defer`, `notify` and `auto` → `allow`. `canUseTool` is never the gate, because tools allowed by
  a rule or a permissive mode never reach it (B5). How a tool call becomes an action, and what a
  deferred call does, is [below](#a-workers-tool-calls).

### A verdict is not yet a permission

> **`mode` is the mode once the required checks pass.** `check` returns `auto` or `notify` for an
> action whose rule allows it, even when its required checks did not pass; `failedChecks` names
> those. A rule's `requires` are checks the **result** must pass before it is accepted, never
> preconditions of each step of the work that produces it:
>
> - A caller that **accepts or applies a result** (the board's `accept`, an acceptance gate)
>   passes the checks it ran (`action.checks`) and treats a non-empty `failedChecks` as **not yet
>   allowed**: a failed check is work for the lead, never a reason to accept the result or to ask
>   the operator. Such a caller that reads `mode` alone fails open.
> - A caller that gates the work **while it runs** (a board task becoming ready, a Worker's tool
>   call) cannot have run them: it lets the work go on under `auto` or `notify`, records the
>   checks as pending (the `autonomy` decision's `failedChecks`, and its own record), and they
>   bind when the result is accepted
>   ([board](board.md#required-checks-bind-at-acceptance), [below](#a-workers-tool-calls)).
>
> Everything else still fails closed: `forbid` denies, `ask` waits for the operator, and a
> class no rule names takes the stricter `default`.

## A request

```mermaid
stateDiagram-v2
  [*] --> open: check says ask, then request
  open --> batched: batch
  open --> approved: operator verdict
  batched --> approved: operator verdict
  open --> rejected: operator verdict, expiry, or withdrawal
  batched --> rejected: operator verdict, expiry, or withdrawal
  approved --> [*]
  rejected --> [*]
```

PROP-0010's sketch shows `expired` as a state before `rejected`. Here they are one transaction:
the request becomes `rejected` with cause `expired`, and the decision's outcome is
`denied:expired`.

| From → to | Who | Records | On failure |
|---|---|---|---|
| — → open | `request`, by a core component (board, workflow, a Worker's hook, resources) | the request, with the `autonomy` decision that said ask and `expiresAt` | refused (`not-asked`) unless the verdict cites an `autonomy` decision a policy made that says ask, of the policy the verdict names (the request takes its policy from the decision), under the project's policies as loaded now (each policy at its current version, the set's `decider.hash`), and judging the action again (its class, `command`, and project) says ask for the class the decision names; an invalid request, or a subject with no `version` (except an `artifact` subject by its `sha256:` id), is refused (`invalid`) |
| open → batched | `batch`, when the group (one per project) reaches `maxSize` or its oldest request waited `maxWaitSeconds` | `batchId`; an `approvals.batched` event | — |
| open or batched → approved | `decide`, from the operator's channel only: the queue on the web UI (`/ui`, operator token) or MCP `approvals_decide` (operator scope) | an `approval@1.0` artifact by `operator` on the request's subject, and an `approval` decision (`approved`) | a verdict for a changed subject, an expired or resolved request, or an unknown one is refused and changes nothing; one the provider cannot apply (an error) is refused as `failed`, logged; the other verdicts of the call apply |
| open or batched → rejected (verdict) | `decide` | the same, with `rejected` | as above |
| open or batched → rejected (expired) | `sweep`, at `expiresAt` | an `approval` decision `denied:expired` (decider rule `approvals.expiry`) | — |
| open or batched → rejected (withdrawn) | `withdraw`, by the requester, when its work ended | an `approval` decision `withdrawn` (decider rule `approvals.withdraw`) | a resolved request is returned unchanged |
| open or batched → rejected (policy changed) | the provider, at load and on every `sweep`, for an unexpired request whose policy is not current at its version, or whose class (and the class its decision judged it as) the loaded policies no longer ask for | an `approval` decision `withdrawn` (decider rule `approvals.policy`), its reason naming what changed | one that fails is logged and left for the next sweep |

A policy change takes effect through a `policy-change` approval while `system` runs
([below](#a-policy-change)), or by configuration at a start
([the configuration and the stored set](#the-configuration-and-the-stored-set)). Either way, open
requests are judged again under the new set. Cause `withdrawn` covers it, and
the resolution's decision tells it from the requester's own withdrawal by its decider rule
(`approvals.policy`, not `approvals.withdraw`). The requester sees its request rejected with no
verdict and puts the action to the new policy again:

- The board does so on its next sweep, as a fresh gate
  ([board](board.md#where-the-tables-leave-room)). A task waiting for approval becomes ready when
  the new policy gives its class `auto` or `notify`, waits on one new request on the same exact
  subject when it still says `ask`, and is cancelled (`forbidden`) on `forbid`. A spent budget or
  a lost run asks again on `ask` and otherwise waits for input, since it goes on only with a
  person. A charter is asked about again, or refused (a first charter abandons its project, an
  amendment is dropped) when no request can be opened. A request the board withdrew itself
  changes nothing there.
- A Worker's deferred call is denied when its session runs it again, as for any withdrawn
  request, and nothing new is queued for that call ([below](#a-deferred-call)); the workflow
  engine continues nothing for it.
- A workflow run's remediation gate closes (`plan_rejected`), and the fix does not run;
  `continue` puts the plan to the policy loaded now on a new request
  ([remediation on the queue](workflow-engine.md#remediation-on-the-approval-queue)).

### Where the tables leave room

The store-backed provider settles these cases so that the [fail-closed rules](#fail-closed-rules)
hold. The fake provider does not check them, and the suite does not test them.

- A batch holds at most the batch rule's `maxSize` requests, oldest first: a group with more
  open requests makes several batches, and only its last, smaller one waits for
  `maxWaitSeconds`. An open request already expired is not batched; the sweep rejects it.
- The batch rule of a project's requests is the first policy's that names one, the studio's
  first; with none, each request is its own batch at once. At load, a batch rule whose
  `maxWaitSeconds` is not under the shortest expiry a request it batches can get is refused: a
  lone request would expire before the operator is shown it.
- A malformed verdict, or a named request whose stored record fails its schema, refuses the
  whole `decide` call before any verdict applies.
- At load, two policies with one id, or two for one project, are refused too.
- Withdrawal on a policy change needs the request's classes: its own, and the class its
  decision judged it as. A listed command's argv is not kept, so its request is withdrawn
  unless both `command` and the class it was judged as still ask.
- The queue sweeps, then batches, once at start and every `sweepSeconds` (1 to 3600, never off);
  nothing else calls them in production.
- A withdrawn request is not a verdict. A request the requester withdrew itself changes nothing
  more; one the queue withdrew on a policy change is put to the new policy again by the board on
  its next sweep ([above](#a-request)), while a Worker's gate denies the same call again in that
  session ([a deferred call](#a-deferred-call)).

## A Worker's tool calls

Every tool call of an agent run passes the run's gate before it runs. The boundary:

```mermaid
flowchart LR
  R["agent runtime<br/>(PreToolUse hook)"] -- "ToolCall: tool, input, call id" --> G["the run's gate<br/>(agent-workers)"]
  G -- "check, request, get" --> A["ctx.approvals"]
  G -- "allow, deny + reason,<br/>defer + request id" --> R
```

- **The contract** is runtime-neutral, in
  [`agent-runtime-core`](../../packages/agent-runtime-core/README.md): `RunSpec.toolGate`, given
  the tool's name and input, answers `allow`, `deny` with a reason, or `defer` with a reason and
  the request id. A runtime that can ask it before every tool call reports `gatesToolCalls`; the
  `agents` source admits no Worker whose runtime does not, and such a runtime refuses a run that
  carries a gate. The runtime plugin never reads `ctx.approvals`: the source that owns runs builds
  each run's gate from it.
- **On Claude Code** the gate is one PreToolUse hook with no matcher: every tool, subagents'
  included. `deny` and `defer` are the hook's own decisions, which hold in every permission
  mode. `allow` returns no decision: a hook's `allow` would skip the workspace-scoped
  pre-approvals, so the runtime's own policy still decides, and a call outside the workspace
  stays refused. A gate that throws, answers with an unknown verdict, or takes longer than 30 s
  is a deny.

### How a call is classified

By code, from the tool's name and input only, never by a model's judgment; a call the table does
not cover is denied. Each tool in the table takes only the input fields its Claude Agent SDK type
declares (`MultiEdit`, `NotebookRead`, and `LS`, which the SDK no longer declares, their last
published shapes), each of its declared type: an unknown field, or a known one of another type, is
denied, its reason naming the field.

| Tool | Action |
|---|---|
| `Read`, `NotebookRead`, `LS`, `Glob`, `Grep` | `read`, for a path inside the run's workspace (absent for `Glob` and `Grep`: the workspace); a `Glob` pattern whose literal leading directory is outside it, or that climbs with `..`, is denied |
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit` | `workspace-write`, for a file inside the workspace; outside it is denied (and refused by the runtime) |
| `Bash` | `command`, its argv the command split on single spaces, so the [exact-argv rule](#the-autonomy-policy) applies as written: a listed argv is judged as `workspace-write`. A word with a shell metacharacter (the policy's own set, `SHELL_METACHARACTER`), or an empty word (a doubled, leading, or trailing space), is denied by the gate before the policy is asked; the policy forbids the former too. Its input fields are `command`, `description`, `timeout`, and `run_in_background`: `dangerouslyDisableSandbox` is denied |
| `WebFetch`, `WebSearch` | `external-send`, which always asks |
| any other tool, or an input that is not an object | denied by the gate's own rule |

A path is inside the workspace when it is both as written and on disk: its real location, every
symlink followed and `..` resolved on disk, is inside the workspace's real path. A path that does
not exist yet (a write target) is placed by its deepest existing ancestor's real path, the rest
appended, which must hold no `..`; a path that cannot be resolved (a dangling symlink, a loop, a
permission error) is not inside, and a home path (`~`) never is. A symlink created after the
check is [the runtime's confinement's to bound](#where-a-workers-gate-leaves-room). The runtime's
pre-approvals still bind each tool to the workspace on disk.

### What each verdict does

`check` judges the action under the studio policy, and records the `autonomy` decision.

| Verdict | The call | Recorded |
|---|---|---|
| `forbid` | denied; the agent is told the decision's reason | the `autonomy` decision |
| `auto` | allowed | the `autonomy` decision |
| `notify` | allowed, and an `agent-workers.tool.notified` event names the decision, the run, and the tool: the operator reads it in the event log (MCP `events` by type) and the decision itself (`system explain <decision>`, MCP `artifact`) | the `autonomy` decision |
| `auto` or `notify` with `failedChecks` | allowed: the rule's required checks are the result's, and no tool call carries them ([a verdict is not yet a permission](#a-verdict-is-not-yet-a-permission)). They stay pending, and bind when the result is accepted. The first such call of a class in a run appends `agent-workers.tool.checks-pending` naming them (a `notify` event names them too); a pending check that no rule can require is a deny | the `autonomy` decision, its `failedChecks` the pending checks |
| `ask` | one approval request on the exact call, then `defer` | the `autonomy` decision, then the request |

A gate outcome the policy did not give (no `ctx.approvals`, a call the gate does not classify, a
run that already stopped, an `ask` in a run with no session, a gate that failed) is a deny,
recorded as a `gate` decision of rule `agent-workers.tool-gate`. A denied or deferred call also
appends an `agent-workers.tool.denied` or `agent-workers.tool.deferred` event; events carry
ids, never the call's input.

### A deferred call

- **The request** binds to the exact call (INV-5): subject `{ type: content, ref:
  agent-tool-call:<agent run>:<tool>, version: <content id of the canonical tool input> }`;
  requester `worker`, with the agent run, its session, and the runtime's call id
  (`toolUseId`); summary and consequences say what runs if it is approved, and that it is denied
  if rejected or unanswered. Its classification is the run's.
- **The run stops there.** The runtime runs no further tool call (each is denied) and ends the
  run, which fails as `config_error` naming the request, whatever the runtime reported: a
  deferred run never completes, and `config_error` is never retried. On Claude Code a `defer`
  ends the headless query with the call kept in the session's transcript.
- **Resume.** The same session continues in a later run (by its native handle): for a workflow
  run that serves no board task, the engine starts it by itself once the request is approved,
  once per approval ([a deferred tool call](workflow-engine.md#a-deferred-tool-call)). The hook
  runs again on the deferred call. The gate finds the request opened for that exact call in
  that session, and checks it in full before using it: subject type `content`, ref
  `agent-tool-call:<the agent run that opened it>:<tool>`, version the input's content id, the
  action class, and requester `worker` with that agent run and this session. Any difference is a
  deny, never a new request. While it is open, the call defers again on the same request, and nothing new is
  queued; approved, the call runs, once (the approval is then used, and the same call asks
  again); rejected, expired, or withdrawn, it is denied, and nothing new is queued. A different
  input is a different call, with a request of its own.
- **A run with no session** cannot be continued, so an `ask` there is denied, not deferred, and
  nothing is queued: the operator is never asked for an approval no run could use.

### Where a Worker's gate leaves room

- **Symlinks after the check.** The gate resolves a path when the call comes. A symlink the
  agent creates or changes between that check and the tool's own open (by a `Bash` command, say),
  or one a recursive `Glob` or `Grep` walks into below the path it names, is not the gate's to
  see. The runtime's own confinement bounds it, which the gate does not replace: the host read
  confinement ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)) and the
  SDK sandbox ([ADR-0038](../decisions/adr/0038-confined-commands-for-claude-code-workers.md)).
- **Project.** Every call is judged under the studio policy. A project policy only narrows it,
  so a project's stricter rule does not reach a Worker's tool calls until a trusted envelope
  (the run's `WorkerStart`) names the run's project.
- **Waiting.** The workers seam's statuses are `queued`, `running`, `completed`, and `failed`;
  a run that waits on the operator is `failed` (`config_error`, the request in its message). A
  waiting status would change that guarantee seam's contract.
- **The later run.** Whoever owns the work starts the run that continues the session; the gate
  does not. For a workflow run that serves no board task the engine does, once the request is
  approved: it reopens the node that deferred as a new attempt on the same session, at most once
  per approval, with a `recovery` decision
  ([a deferred tool call](workflow-engine.md#a-deferred-tool-call)). A board task's run is the
  board's: its next attempt resumes the session from a brief. The engine finds the request from
  the gate's `agent-workers.tool.deferred` event and checks it through `ctx.approvals`, so
  `WorkerStart` and the workers seam stay as they are.
- **Where pending checks bind.** The bundle's studio policy gives `workspace-write` `auto` with
  `tests` and `lint` required, so a Claude Code Worker reads and writes inside its workspace,
  those checks pending. They bind at the board's acceptance of the task's result. A run outside
  the board applies nothing, so they never block it: when it wrote, its completion records them
  as pending on an `acceptance` decision (rule `workflow.run-acceptance`) for the operator to see
  ([a plain run's acceptance](workflow-engine.md#a-plain-runs-acceptance)), and they bind
  wherever its result is applied.

## A policy change

The operator changes the autonomy policy while `system` runs through the queue itself
([ADR-0041](../decisions/adr/0041-policy-changes-through-the-approval-queue.md)): the safety layer
never changes itself, and what the operator approves is exactly what comes into force.

```mermaid
stateDiagram-v2
  [*] --> asked: the operator proposes one record; the set it makes loads; the policy asks
  asked --> applied: the operator approves its request, its base still in force
  asked --> declined: rejected, expired, or withdrawn
  applied --> retired: a configuration supersedes it at a start
  declined --> [*]
  applied --> [*]
  retired --> [*]
```

| From → to | Who | Records | On failure |
|---|---|---|---|
| — → asked | `proposePolicy`, from the operator's channels only: the policy page on `/ui` (operator token) or MCP `approvals_policy_propose` (operator scope) | the `autonomy` decision for `policy-change` (under the studio's set, or the project's for a project's policy); in one transaction, the `policy-change@1.0` record (the proposed record, the record it replaces, the whole set, its hash, the base set's hash, the configured set's hash, and every effective mode it moves) and an `approval-request@1.1` on `{content, autonomy-policy-set, <hash>}`, requester `approvals` naming the change, its consequences listing the modes that move | a record that is not valid, a version not above the one in force, a changed scope or project, a new studio policy, or a set the load-time rules refuse is refused (`invalid`) and nothing is stored; `forbid` refuses it (`not-asked`); another change in force meanwhile refuses it (`invalid`) |
| asked → applied | `decide`, the operator's approval of its request on its subject, while the set it was proposed on is still in force | in the verdict's transaction: the `approval` artifact and decision, a `decision@1.6` `policy-change` (decider rule `approvals.policy-change`; candidates the old and new hash; inputs the request's `autonomy` decision, the approval, and its decision), and the change `applied`; then every open request is judged again as at load | the base no longer in force: the verdict is refused (`subject-changed`) and changes nothing; a set that no longer loads: refused (`failed`), logged |
| asked → declined | `decide` (rejected), `sweep` (expired, or withdrawn: its base no longer in force, or its set no longer loads), `withdraw` | the request's `approval` decision, named on the change with its cause | — |
| applied → retired | the provider at a start, when the configuration's `supersedes` names the stored set's hash and that set no longer applies | a `decision@1.6` `policy-change` (decider rule `approvals.configuration`), the change `retired` | — |

- **The whole set is the subject.** A proposal names one record, but the request binds to the
  hash of the whole set it makes (the studio policy, then the project policies by project id), and
  the change applies only onto the set it was proposed on. A second proposal on the same base is
  withdrawn when the first comes into force, so an approval never reverts a change it did not show.
- **After the change**, open requests are put to the new set exactly as at load: one its policy
  version or its class no longer asks for is withdrawn (decider rule `approvals.policy`), and its
  requester puts the action to the new policy, as [above](#a-request) (the board on its next sweep).
- **History:** `policyChanges` lists the changes, newest first; `policy()` names the set in force
  (`set`). The policy page on `/ui` shows both, a proposed record's diff, and each change's diff in
  its queue entry ([web UI API](../reference/web-ui.md#autonomy-policy)).

### The configuration and the stored set

An applied change is kept in the store, so a restart keeps it. At a start the provider decides
which set is in force:

| The latest applied change | In force |
|---|---|
| none, or retired | the configured set |
| derived from the configuration as it is now (its `configHash` is the configured set's hash), or its set is the configured set | the stored set |
| derived from another configuration, or its set no longer loads, and `supersedes` names its hash | the configured set; the change is retired, recorded |
| derived from another configuration, or its set no longer loads, and no `supersedes` names it | none: the plugin is refused, naming both hashes and the remedy, so every action that needs a person waits |

Neither set wins silently (INV-2): the operator approved both, so only the operator chooses,
either by restoring the configuration the change was derived from, or by naming the stored set in
`supersedes` ([runbook](../operations/runbooks.md#change-the-autonomy-policy)). Every call reads
which change is in force from the store, so a provider never judges under a set another process
replaced.

### Where a policy change leaves room

- Only the operator proposes. A lead that wants a policy change asks the operator; turning
  repeated identical approvals into a proposed policy (PROP-0008) is not built.
- `system check` cannot see the store, so a configuration that no longer matches the stored set
  is reported at the start that refuses it, in the log, not before.
- An upgrade whose bundle changes the default policy refuses the queue where the operator applied
  a change, until the operator chooses one of the two sets.
- A provider at contract 1.0 (none in the bundle) takes no proposal: its policy changes by
  configuration and a restart.

## Fail-closed rules

1. Only an operator verdict approves. Expiry and withdrawal only reject.
2. A verdict binds to the exact subject the operator was shown; the request's subject, action,
   and expiry never change after it is created
   ([INV-5](../architecture/invariants.md#inv-5-exact-subject-binding)).
3. A verdict comes only from the operator's channel, never from model text
   ([INV-6](../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes)).
4. Every request expires, and an unanswered request is denied.
5. With `ctx.approvals` unavailable, an action that needs a person waits; one that does not
   still needs its `autonomy` decision, so nothing runs: a Worker's gate denies every tool call,
   reads included.
6. The policy set changes only by the operator: an approved `policy-change` request on the exact
   set, or the configuration at a start. A stored set the configuration no longer matches is never
   used and never dropped silently.

## Conformance

[`approvals-core/conformance/approvals.ts`](../../packages/approvals-core/conformance/approvals.ts),
20 scenarios at contract 1.1 (five of them since 1.1: a policy change asked, applied, declined,
refused, and withdrawn on a stale base), run against the fake provider and the store-backed
provider. The
board's suite also runs over the store-backed provider, as the bundle composes them, and changes
its policies there: the fake's `reload` stands for the new configuration and a restart, after
which its sweeps withdraw what the policies no longer ask for, as the store-backed provider's do.
