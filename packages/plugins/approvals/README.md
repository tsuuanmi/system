# @tsuuanmi/system-approvals

**`ctx.approvals`**: the store-backed provider of the gate seam of
[`approvals-core`](../../approvals-core/README.md): the autonomy policy and the one batched
approval queue ([approvals](../../../docs/design/approvals.md),
[ADR-0036](../../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)). A
guarantee seam: it fails closed (INV-2). Code decides, never a model.

- **Owns:**
  - `policy(projectId?)`: the studio policy, the project's when it has one, and the effective
    mode of every action class.
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
- **Records:** `approval_requests`, one row per request with its revision and its
  `approval-request@1.0` record, indexed by state, batch, project, and expiry. Every record is
  validated before it is written and after it is read: one that fails on read is never acted on.
  Every move is revision-checked inside a store transaction (`BEGIN IMMEDIATE`), so of
  concurrent verdicts on one request, also across processes, exactly one is recorded. A
  restarted provider over the same store and configuration answers the same.
- **Time:** the queue sweeps, then batches, once at start (a restart is a sweep) and every
  `sweepSeconds` (1 to 3600: never off, so every request expires); nothing else calls them in
  production. The `at` of every method is a test seam: the MCP tools, the web UI, the board, and
  the queue's own passes fill it from the wall clock.
- **MCP** (when `ctx.mcp` is present): `approvals_list`, `approvals_get`, `approvals_policy`
  (client scope) and `approvals_decide` (operator scope: verdicts come only from the operator's
  channel, INV-6; a call that reaches it with another scope is refused too). Each input and
  structured output is validated against
  [`schemas/mcp-approvals.v1.json`](../../../schemas/mcp-approvals.v1.json) `$defs/<tool>-input`
  and `-output`; a refused input does nothing, a refusal is an MCP error naming the
  `ApprovalsError`.
- **Config:** `policies` (required): `autonomy-policy@1.x` records, exactly one studio policy
  and project policies that narrow it; `sweepSeconds` (1 to 3600, default 60). At load, a
  policy the schema refuses, two rules for one action class, a rule giving a class in
  `ALWAYS_ASK` `auto` or `notify` (a 1.0 policy's `remediation`), an `expiry.defaultSeconds` or a
  rule's `expiresSeconds` above `expiry.maxSeconds`, a commands entry with an empty word or a
  shell metacharacter, a batch rule whose `maxWaitSeconds` is not under the shortest expiry a
  request it batches can get, no or several studio policies, a project policy narrowing another
  policy than the studio's, two policies for one project, or two with one id refuses the plugin:
  no `ctx.approvals` is provided, the error is logged, and every action that needs a person
  waits. `checkConfig` names the same problems to `system check` before a start.
  The bundle row carries the default studio policy; a patch that targets the row replaces its
  whole config, so it carries the policies too.
- **Injects:** `store`, `artifacts`; `mcp` and `eventLog` are optional.
- **Consumers:** the board; the web UI's queue; and the `agents` Worker source, whose
  per-run tool gate calls `check`, `request`, and `get` for every tool call of an agent run
  ([a Worker's tool calls](../../../docs/design/approvals.md#a-workers-tool-calls)).
- **Not yet:** remediation still uses the workflow's plan gate (`approval@1.0`). A new policy
  version takes effect by configuration and a restart, not through a `policy-change` approval.
- **Tests:** [`tests/conformance.spec.ts`](tests/conformance.spec.ts) runs the seam's suite,
  [`approvals-core/conformance/approvals.ts`](../../approvals-core/conformance/approvals.ts), at
  contract 1.0 with no known failure; [`tests/board.spec.ts`](tests/board.spec.ts) runs the
  board's suite over this provider and the store-backed board, as the bundle composes them;
  [`tests/approvals.spec.ts`](tests/approvals.spec.ts) covers each load-time rule, restart, a
  policy change (refused decisions, withdrawal at load and on a sweep), a decision no policy
  made, a listed command judged again, a verdict race on one store and across processes, a
  verdict that fails on its own, the queue's own clock, the batch bound, paging, records that
  fail their schema, and the tools' outputs. Tests turn the queue's own clock off through a test
  subclass ([`tests/manual.ts`](tests/manual.ts)), never through configuration.
