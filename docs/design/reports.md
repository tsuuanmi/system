# Reports

> Target state. Boundary: [gateways](../architecture/components.md#gateways), plugin family
> *surface* ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)). Proposals:
> [PROP-0010](../proposals/0010-base-version.md) (B8: the baseline report, a weekly investor report),
> [PROP-0008](../proposals/0008-studio-operating-model.md#validation-plan) (the baseline).
> Payload: [`mcp-report@1.0`](../reference/schemas.md#mcp-tool-report).
>
> Implemented in [`report`](../../packages/plugins/report/README.md); differs from target: quota
> lost at reset is not reported (the ledger's seam gives each window's latest reading only), and
> a project's report has no attention budget per milestone.

The baseline report says what the recorded data says about a period, for one project or every
one: progress on the board, the attempts and the reviews of their results, what asked for the
operator and how long the operator took, what the work consumed, and what each accepted result
cost. It is computed by code from records only. No model writes it, it writes nothing, and it
decides nothing, so it records no decision. The weekly investor report is the same report over the
7 days before now, rendered for the operator: one screen, read in layers
([PROP-0008](../proposals/0008-studio-operating-model.md#governance-a-startup-template)).

## Inputs

A period from `since` (inclusive) to `until` (exclusive): `until` defaults to the time of the call,
and `since` to `days` (default 7) before it; at most 366 days. And a scope: one project
(`projectId`), or every project on the board (the studio).

| Source | Read through | What it gives |
|---|---|---|
| board | `ctx.board`: `projects`, `project`, `tasks` | projects and their tasks as they are now (`asOf`) |
| approval queue | `ctx.approvals.list`, every state | each request: its class, requester, creation, batch, and resolution |
| resource ledger | `ctx.resources.usage` over the period | the counted usage records observed in it (deduplicated by the ledger); and, for each run whose usage it could not count, whether it has counted a record of that run in its pool since |
| event log | `ctx.eventLog.query` | `workflow.task.reported` (one per attempt that reached its task), `workflow.task.digest`, `workflow.graph.grown`, `workflow.gate.opened` and `closed`, `approvals.batched`, `usage.unknown` (a run whose usage the ledger could not count, [resources](resources.md#usage-the-ledger-cannot-count)); for a project, each of its runs' `workflow.node.started` |
| decisions | `ctx.artifacts.get` | the acceptance decision of each done task and of each reported attempt |
| digests | `ctx.digests.get`, when loaded | each attached digest's claims kept and dropped, escalation, and the runs that wrote it |

## Scope

The studio report counts every record. A project's report counts a record when it names the
project, or one of its tasks, or a run that served one of them: the runs its attempts reported
from, each task's current run, the executions those runs started (an agent Worker's run, which the
ledger names), and the runs that digested the tasks' results (the agent results the digest's
settling and escalation decisions took as inputs). The same attribution the engine makes for a
task's budget ([usage spent on a task](workflow-engine.md#a-board-tasks-brief)), with the digests
added: their cost is part of what the work cost. A run whose usage the ledger could not count
belongs to it the same way: its entry names the project, one of its tasks, or a run that served one,
as the run itself or as the workflow run it belongs to. An approval request belongs to the project when its
requester names the project, one of its tasks, or one of those runs; a batch, when it holds one of
those requests.

## What it counts

| Figure | Counted |
|---|---|
| tasks now | the scope's tasks per state, as of `asOf` |
| tasks created, cancelled | `createdAt`, `cancellation.at` in the period |
| tasks done, accepted results | done tasks whose accepting `acceptance` decision was made in the period; `doneByOperator` when the operator's own decision accepted it (a review held for the operator) |
| attempts | `workflow.task.reported` in the period, by where each left its task: accepted (done by the run's own acceptance decision), rejected by it (another attempt), held for the operator, reconciled (reported with `reconcileRun` and neither done nor held: a failed or stopped run, or one whose holder was lost), other (refused, moved on, never started) |
| reviews | per reported attempt, the `review` check its acceptance decision reports: passed, failed (changes still requested), or none bound to the result |
| remediation | cycles grown (`workflow.graph.grown` with a cycle), fixes the queue opened and closed |
| approvals | requests made in the period; resolved in it by cause: approved, rejected by verdict, expired, withdrawn; open now; per action class |
| waits | from a request's creation to the operator's verdict, over the verdicts given in the period: median, 90th percentile (nearest rank), longest |
| interruptions | what asked for the operator: the requests made, and the reviews held for the operator, per UTC day |
| batches | what the operator was shown: the batches the queue made (`approvals.batched`), and each request the operator answered outside a batch, per UTC day |
| attention budget | for a project's report, its charter's `maxInterruptionsPerDay` and `maxBatchesPerDay`; each day over either is marked |
| usage | the records observed in the period, per pool and in all: input tokens (cached input included), cache reads and writes, output tokens, turns, the runtime's own cost estimate; and the records by outcome |
| usage a cap counts as 0 | per pool and in all, only where there is any (`mcp-report` 1.1): the records without token counts, without a cost, without turns, and the runs recorded in the period whose usage the ledger could not count and has not counted since (`unknownRuns`); and those runs in all (`usage.unknown`): each once per pool by its first entry's kind (not reported, interrupted, refused, failed), and how many the ledger has counted a record of since (reconciled) |
| digests | digests of task results that ended in the period: attached or bypassed; for those attached, the claims kept and dropped, and the escalations |
| baseline | accepted results, interruptions, attempts; and, with an accepted result, per accepted result: tokens (input and output), cost, turns, interruptions, attempts |

A missing number stays missing: a usage record with no token counts adds none, and the report says
how many there were (`notes`), as it does for records without a cost or turns and for the runs whose
usage the ledger could not count, so tokens and cost per accepted result are then lower bounds. A
`usage.unknown` entry that is not a valid `usage-unknown@1.0` record is not counted, and said. An
event log trimmed by retention within the period is said too, as is a digest provider that is not
loaded.

## The baseline

PROP-0008 asks whether `system` deserves to exist: the same kind of task done by a well-configured
Claude Code session alone and through `system`, compared on accepted results per operator
intervention, tokens per accepted result, and quota lost at reset. The report gives `system`'s side
of the first two from its records. The other side is measured by the operator outside `system`
([pilot](../operations/pilot.md#read-the-baseline)); the third is not reported yet.

## Failure

| Case | Outcome |
|---|---|
| the board, the queue, or the ledger not loaded | refused (`unavailable`): a report without one of them would be silently wrong (INV-2) |
| an unknown project | refused (`unknown-project`) |
| an empty period, one past 366 days, or `since` with `days` | refused (`invalid`) |
| more than 100 000 entries of one event type, more records than the ledger returns at once, or records of more than 64 pools | refused (`overloaded`), never truncated (INV-9) |
| a decision a count rests on is not stored | that task or attempt is counted as having none (no review, not done in the period) |

## Determinism

What is read is sorted before it is counted or summed (records by observation time and request id,
requests by id, events by sequence), costs are rounded to the micro-dollar, and the rendering
writes numbers without a locale. The same records and period give the same report; two calls differ
only in `asOf`, when the board and the queue were read.
