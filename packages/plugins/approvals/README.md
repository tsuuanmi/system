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
    `autonomy` decision (decider: the policy that gave it, with its version). The effective mode
    is the strictest of the studio's rule and the project's; a project policy constrains only the
    classes it names; a class the studio policy does not name takes the stricter `default`. An
    `auto` or `notify` rule names the checks of every applying policy that did not pass
    (`failedChecks`): that work goes back to the lead, never to the operator. A `command` whose
    argv every applying commands list allows, word for word (a listed line alone or followed by
    more arguments), is judged as `workspace-write` unless the `command` class is forbidden; any
    other command is the `command` class. A malformed action is refused (`invalid`).
  - `request(request, at?)`: queues an `approval-request@1.0` on the exact subject, in one
    transaction that also checks the verdict it cites: a recorded `autonomy` decision whose
    outcome is `ask`, of the policy and version the verdict names (else `not-asked`). The
    request's `policy` is the decision's. It expires at its creation plus its rule's
    `expiresSeconds`, else the stricter `expiry.defaultSeconds`, never more than the stricter
    `expiry.maxSeconds`. A request the schema refuses is refused (`invalid`), storing nothing.
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
    and changes nothing; the others apply. An applied verdict writes an `approval@1.0` by
    `operator` on the request's own subject and an `approval` decision, with the request's move.
    A malformed verdict, or a named request whose stored record fails its schema, refuses the
    whole call before any verdict applies.
  - `withdraw(requestId, at?)`: rejects an unresolved request with cause `withdrawn`; a resolved
    one is returned unchanged; an unknown one is refused (`unknown-request`).
  - `sweep(at)`: rejects every unresolved request whose expiry has come, cause `expired`, with
    an `approval` decision `denied:expired` (decider rule `approvals.expiry`), each in its own
    transaction that re-reads the request first. Idempotent; one that fails is logged and left
    for the next sweep.
- **Records:** `approval_requests`, one row per request with its revision and its
  `approval-request@1.0` record, indexed by state, batch, project, and expiry. Every record is
  validated before it is written and after it is read: one that fails on read is never acted on.
  Every move is revision-checked inside a store transaction (`BEGIN IMMEDIATE`), so of
  concurrent verdicts on one request, also across processes, exactly one is recorded. A
  restarted provider over the same store and configuration answers the same.
- **Time:** the queue sweeps, then batches, once at start (a restart is a sweep) and every
  `sweepSeconds`; nothing else calls them in production. `0` leaves both to the caller.
- **MCP** (when `ctx.mcp` is present): `approvals_list`, `approvals_get`, `approvals_policy`
  (client scope) and `approvals_decide` (operator scope: verdicts come only from the operator's
  channel, INV-6; a call that reaches it with another scope is refused too). Each input and
  structured output is validated against
  [`schemas/mcp-approvals.v1.json`](../../../schemas/mcp-approvals.v1.json) `$defs/<tool>-input`
  and `-output`; a refused input does nothing, a refusal is an MCP error naming the
  `ApprovalsError`.
- **Config:** `policies` (required): `autonomy-policy@1.0` records, exactly one studio policy
  and project policies that narrow it; `sweepSeconds` (default 60). At load, a policy the
  schema refuses, two rules for one action class, an `expiry.defaultSeconds` or a rule's
  `expiresSeconds` above `expiry.maxSeconds`, no or several studio policies, a project policy
  narrowing another policy than the studio's, two policies for one project, or two with one id
  refuses the plugin: no `ctx.approvals` is provided, the error is logged, and every action that
  needs a person waits. `checkConfig` names the same problems to `system check` before a start.
  The bundle row carries the default studio policy; a patch that targets the row replaces its
  whole config, so it carries the policies too.
- **Injects:** `store`, `artifacts`; `mcp` and `eventLog` are optional.
- **Not yet:** no Worker-side hook enforces a verdict (the PreToolUse hook, B5), and
  remediation still uses the workflow's plan gate (`approval@1.0`). A new policy version takes
  effect by configuration and a restart, not through a `policy-change` approval.
- **Tests:** [`tests/conformance.spec.ts`](tests/conformance.spec.ts) runs the seam's suite,
  [`approvals-core/conformance/approvals.ts`](../../approvals-core/conformance/approvals.ts), at
  contract 1.0 with no known failure; [`tests/board.spec.ts`](tests/board.spec.ts) runs the
  board's suite over this provider and the store-backed board, as the bundle composes them;
  [`tests/approvals.spec.ts`](tests/approvals.spec.ts) covers each load-time rule, restart, a
  verdict race on one store and across processes, the queue's own clock, the batch bound,
  paging, records that fail their schema, and the tools' outputs.
