# @tsuuanmi/system-approvals

**`ctx.approvals`**: the store-backed provider of the gate seam of
[`approvals-core`](../../approvals-core/README.md): the autonomy policy and the one batched
approval queue ([approvals](../../../docs/design/approvals.md),
[ADR-0036](../../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)). A
guarantee seam: it fails closed (INV-2). Code decides, never a model.

- **Owns:**
  - `policy(projectId?)`: the studio policy, the project's when it has one, the effective mode of
    every action class, and the set in force (`set`: its hash, `source` `configuration` or
    `store`, the configured set's hash, the applied change in force, and the projects with a
    policy).
  - `check(action)`: the mode the policies give one action, recorded as a `decision@1.4`
    `autonomy` decision (decider: the policy that gave it, with its version and `hash`, the
    sha256 of the canonical JSON of the project's effective policy set as loaded). The effective
    mode is the strictest of the studio's rule and the project's; a project policy constrains
    only the classes it names; a class the studio policy does not name takes the stricter
    `default`; a class in `ALWAYS_ASK` is raised to at least `ask` whatever a rule says. An
    `auto` or `notify` rule names the checks of every applying policy that did not pass
    (`failedChecks`): that work goes back to the lead, never to the operator. A `command` whose
    argv equals a line of every applying commands list, word for word and with nothing more, is
    judged as `workspace-write` unless the `command` class is forbidden; any other command is the
    `command` class. An argv with a word holding a shell metacharacter (`SHELL_METACHARACTER`) is
    `forbid`, with the reason in the decision. A malformed action is refused (`invalid`).

    > **`mode` is the mode once the required checks pass.** Required checks are the result's. A
    > caller that accepts or applies a result passes the checks it ran (`action.checks`) and
    > treats a non-empty `failedChecks` as not yet allowed, even when `mode` is `auto` or
    > `notify`; reading `mode` alone there fails open. A caller that gates work while it runs (a
    > task becoming ready, a Worker's tool call) records them as pending, and they bind at
    > acceptance ([approvals](../../../docs/design/approvals.md#a-verdict-is-not-yet-a-permission)).
  - `request(request, at?)`: queues an `approval-request@1.0` on the exact subject, in one
    transaction that also checks the verdict it cites (else `not-asked`): a recorded `autonomy`
    decision whose outcome is `ask`, made by a policy (its producer and decider), of the policy
    and version the verdict names, under the project's policies as loaded now (each current at
    its version, the same `decider.hash` and policies); and judging the action again (its class,
    `request.command`, and `requester.projectId`) must say `ask` for the class the decision
    names. So a studio `ask` never reaches the operator for a project whose policy forbids the
    class, and an `ask` for one class never queues another. The request's `policy` is the
    decision's. Its subject names a `version`, unless it is an `artifact` subject by its
    `sha256:` id (else `invalid`). It expires at its creation plus the shortest `expiresSeconds`
    of the rules that apply (studio and project), else the stricter `expiry.defaultSeconds`,
    never more than the stricter `expiry.maxSeconds`. A request the schema refuses is refused
    (`invalid`), storing nothing.
  - `get`, `list(filter?)`: the queue, by default its open and batched requests, batched ones
    first by batch, then by expiry. `page(filter?, { limit?, after? })` is one page of the same
    for `approvals_list`: 20 by default, never more than 100, with an opaque cursor.
  - `batch(at?)`: groups open requests per project, oldest first, at most the policy's
    `batch.maxSize` per batch (the first policy that names a batch rule, the studio's first;
    with none, each request alone at once). A full batch is made at once; the last, smaller one
    once its oldest request has waited `batch.maxWaitSeconds`. A request already expired is left
    for the sweep. Each batch is one transaction with an `approvals.batched` event (when
    `ctx.eventLog` is present) naming the batch, its project, and its requests.
  - Events, in the transaction of the change they name, when `ctx.eventLog` is present (a failed
    append is logged, and the change stands): `approvals.requested` for each request queued (its
    id, class, `expiresAt`, requester component, and project, never its summary, consequences, or
    command) and `approvals.resolved` for each resolution (state, cause, option, with the
    `approval` decision), which [notifications](../../../docs/design/notifications.md) read.
  - `decide(verdicts, at?)`: the operator's verdicts, each its own transaction. A verdict for an
    unknown, resolved, or expired request, or for another subject than the request's, is refused
    and changes nothing; one whose transaction throws (a busy store, a stale write, an approval
    its schema refuses) is refused as `failed` and logged; the others apply, and every verdict
    gets its result. An applied verdict writes an `approval@1.0` by
    `operator` on the request's own subject and an `approval` decision, with the request's move.
    A malformed verdict, or a named request whose stored record fails its schema, refuses the
    whole call before any verdict applies.
  - `withdraw(requestId, at?)`: rejects an unresolved request with cause `withdrawn`; a resolved
    one is returned unchanged; an unknown one is refused (`unknown-request`).
  - `sweep(at)`: rejects every unresolved request whose expiry has come, cause `expired`, with
    an `approval` decision `denied:expired` (decider rule `approvals.expiry`); then withdraws
    every unexpired one the loaded policies no longer ask for (its policy not current at its
    version, or its class, or the class its decision judged it as, no longer `ask`), cause
    `withdrawn`, decider rule `approvals.policy`, the reason naming what changed. Each is its own
    transaction that re-reads the request first. Idempotent; one that fails is logged and left
    for the next sweep. The provider withdraws the same at load, before it serves anything.
  - `proposePolicy({policy, note?}, at?)` (contract 1.1): a policy change, from the operator's
    channels only (the web UI, MCP `approvals_policy_propose`; INV-6). The record replaces the
    policy with its id at a higher version, same scope and project, or adds a policy for a project
    that has none; the whole set it makes must pass every load-time rule, or nothing is stored
    (`invalid`). `policy-change` is judged like any action (the project's set for a project's
    policy) and recorded; on `forbid` it is refused (`not-asked`). On `ask`, one transaction
    stores a `policy-change@1.0` (the record, the record it replaces, the whole set, its hash, the
    base set's hash, the configured set's hash, and every effective mode it moves) and queues an
    `approval-request@1.1` on
    `{content, autonomy-policy-set, <hash>}`, requester `approvals` with the `policyChangeId`.
    `request` refuses that requester from any caller (`invalid`).
  - Applying it: an operator's approval of that request, while its base set is still in force (else
    the verdict is refused `subject-changed`, and the sweep withdraws it), applies the set in the
    verdict's transaction, with a `decision@1.6` `policy-change` (decider rule
    `approvals.policy-change`, its two candidates the old and the new hash). Then every open request
    is judged again as at load (the board puts its own to the new policy on its next sweep). A
    rejection, expiry, or withdrawal declines the change and changes nothing; a change whose base
    is no longer in force, or whose set no longer loads, is withdrawn on the next sweep.
  - `policyChanges({states?, limit?})`: the changes, newest first (20 by default, at most 100).
  - `proposeRepeated(at?)` (not a seam method; off unless `repeatedApprovals.enabled`): the queue's
    own proposal, never applied, from repeated identical approvals
    ([approvals](../../../docs/design/approvals.md#the-queue-proposes-a-policy-change),
    [ADR-0050](../../../docs/decisions/adr/0050-the-queue-proposes-a-policy-change-from-repeated-approvals.md)).
    A request's shape is a studio `command`'s exact argv (no project, not `local-private`, judged as
    `command`, a valid commands line), stored with the request. When no policy change is asked and
    the policy asks for `policy-change`, a shape approved at least `approvals` times among the
    requests made in the last `windowSeconds`, none of them rejected by a verdict or expired, is
    proposed as the studio policy at its next version with that one line added to `commands`, and
    nothing else: only when the argv then runs as `workspace-write` under `auto` or `notify` and no
    class's mode moves. One transaction stores the `policy-change@1.1` (its `origin`), its request,
    and a `decision@1.6` `policy-change` (decider rule `approvals.repeated-approvals`), after reading
    the shape's requests again: if they no longer read as they were counted, nothing is stored and
    the next pass reads them afresh. A shape whose
    queue proposal was asked, applied, retired, rejected, or expired is never proposed again; a
    withdrawn one may be. A pass that fails is logged; it never stops the queue.
  - **The set in force** is the latest applied change's, kept in the store, while it is not
    retired, its `configHash` is the configured set's hash (or its set is the configured set
    itself), and its set still loads; the configured set when no change is in force. A stored set
    the configuration no longer matches is never used and never silently dropped: the plugin is
    refused, naming both hashes, unless the configuration's `supersedes` names that stored set's
    hash; then the change is retired with a `policy-change` decision (decider rule
    `approvals.configuration`) and the configured set is in force. Every call reads which change
    is in force from the store, so a provider never judges under a set another process replaced.
- **Records:** `approval_requests`, one row per request with its revision and its
  `approval-request@1.x` record, indexed by state, batch, project, and expiry; `policy_changes`
  (migration 2), one row per change with its revision, its `policy-change@1.x` record, and the
  order in which applied changes came into force; `request_shapes` (migration 3), the shape of each
  request the queue could propose a change for, and `policy_changes.origin_shape`, the shape a
  queue proposal is for. Every record is
  validated before it is written and after it is read: one that fails on read is never acted on.
  Every move is revision-checked inside a store transaction (`BEGIN IMMEDIATE`), so of
  concurrent verdicts on one request, also across processes, exactly one is recorded. A
  restarted provider over the same store and configuration answers the same.
- **Time:** the queue sweeps, then makes its own proposal (when enabled), then batches, once at
  start (a restart is a sweep) and every `sweepSeconds` (1 to 3600: never off, so every request
  expires); nothing else calls them in production. The `at` of every method is a test seam: the
  MCP tools, the web UI, the board, and the queue's own passes fill it from the wall clock.
- **MCP** (when `ctx.mcp` is present): `approvals_list`, `approvals_get`, `approvals_policy`
  (client scope), and `approvals_decide` and `approvals_policy_propose` (operator scope: verdicts
  and policy changes come only from the operator's channel, INV-6; a call that reaches one with
  another scope is refused too). Each input and
  structured output is validated against
  [`schemas/mcp-approvals.v1.json`](../../../schemas/mcp-approvals.v1.json) `$defs/<tool>-input`
  and `-output`; a refused input does nothing, a refusal is an MCP error naming the
  `ApprovalsError`.
- **Config:** `policies` (required): `autonomy-policy@1.x` records, exactly one studio policy
  and project policies that narrow it; `sweepSeconds` (1 to 3600, default 60); `supersedes`
  (optional): the `sha256:` hash of the stored set this configuration replaces, read only at a
  start where that set no longer matches the configuration; `repeatedApprovals` (optional, off
  unless `enabled`): `approvals` (3 to 100, default 5) and `windowSeconds` (3600 to 7776000,
  default 604800), when the queue proposes a change from repeated approvals. At load, a policy the schema
  refuses, two rules for one action class, a rule giving a class in `ALWAYS_ASK` `auto` or
  `notify` (a 1.0 policy's `remediation`), an `expiry.defaultSeconds` or a rule's
  `expiresSeconds` above `expiry.maxSeconds`, a commands entry with an empty word or a shell
  metacharacter, a batch rule whose `maxWaitSeconds` is not under the shortest expiry a request
  it batches can get, no or several studio policies, a project policy narrowing another policy
  than the studio's, two policies for one project, two with one id, or more than 101 policies
  (the studio's and 100 projects') refuses the plugin, as does a stored policy set the
  configuration no longer matches unless `supersedes` names it: no `ctx.approvals` is provided,
  the error is logged, and every action that needs a person waits. `checkConfig` names the same
  problems of the configured set to `system check` before a start; only the start sees the
  store. The bundle row carries the default studio policy; a patch that targets the row replaces
  its whole config, so it carries the policies too.
- **Injects:** `store`, `artifacts`; `mcp` and `eventLog` are optional.
- **Consumers:** the board; the web UI's queue; the `agents` Worker source, whose
  per-run tool gate calls `check`, `request`, and `get` for every tool call of an agent run
  ([a Worker's tool calls](../../../docs/design/approvals.md#a-workers-tool-calls)); and the
  workflow engine, whose remediation gates ask the queue (`remediation`), which continues a
  deferred call's session once its request is approved, and which records the checks a plain
  run that wrote leaves pending (`check`, `request`, `list`, `get`, `withdraw`;
  [workflow engine](../../../docs/design/workflow-engine.md#remediation-on-the-approval-queue));
  and the baseline report, which reads the queue (`list`) and writes nothing.
- **Tests:** [`tests/conformance.spec.ts`](tests/conformance.spec.ts) runs the seam's suite,
  [`approvals-core/conformance/approvals.ts`](../../approvals-core/conformance/approvals.ts), at
  contract 1.1 with no known failure; [`tests/board.spec.ts`](tests/board.spec.ts) runs the
  board's suite over this provider and the store-backed board, as the bundle composes them;
  [`tests/approvals.spec.ts`](tests/approvals.spec.ts) covers each load-time rule, restart, a
  policy change (refused decisions, withdrawal at load and on a sweep), a decision no policy
  made, a listed command judged again, a verdict race on one store and across processes, a
  verdict that fails on its own, the queue's own clock, the batch bound, paging, records that
  fail their schema, the tools' outputs, and a policy change through the queue: kept across a
  restart, refused against a changed configuration until it supersedes the stored set (retired,
  recorded), agreeing with a configuration that is the stored set, a stored change that fails its
  schema never used, a policy that forbids `policy-change`, and `approvals_policy_propose` at
  operator scope only; and the queue's own proposal from repeated approvals: off unless enabled,
  the threshold and window, exactly one line, recorded, at most one asked (also across a restart
  and between two providers), never again once rejected or expired, again once withdrawn, never
  for a project's, local-private, other-class, or always-asking request, and its bounds. Tests turn the queue's own clock off through a test
  subclass ([`tests/manual.ts`](tests/manual.ts)), never through configuration.
