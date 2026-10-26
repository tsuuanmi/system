# Maturity metrics

> Target state. Boundary: [gateways](../architecture/components.md#gateways), plugin family
> *surface* ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)). Proposal:
> [PROP-0016](../proposals/0016-operating-model.md#1-maturity-model-l0-to-l6) §1, increment I4 part 1
> (D83: the operator's go-ahead; the L3 lines are starting lines, revisited once 30 days of data exist).
> Payload: [`mcp-report@1.6`](../reference/schemas.md#mcp-tool-metrics) `$defs/metrics-output`.
>
> Implemented in [`report`](../../packages/plugins/report/README.md) (`metrics.ts`): MCP `metrics`,
> `system metrics`, and the weekly report's last section. Differs from target: three metrics are not
> measurable yet (below), and a value the records only bound says so.

PROP-0016 judges System's level by what its records show over a rolling 30 days, never by the
features built. This is the code that reads them. Each metric of §1 is computed from recorded data
only, over a window (30 days by default, `--days`), for one project or every one. Each gives its
value, the sample it is over, and the records it read. A metric the records cannot give yet says so
and why, and has no value: it is never 0. A level is a reading, never a switch: nothing reads it to
decide anything.

## What it reads

What the [report](reports.md#inputs) reads, through the same seams and scoped the same way, and:

| Source | What it gives |
|---|---|
| `workflow.run.started`, whenever recorded | each run, the task it serves, and **who started it** (`startedBy`: `dispatch`, `lead`, `operator`) |
| `workflow.task.reported`, whenever recorded | each attempt's run, and its acceptance decision |
| `workflow.task.landing`, whenever recorded | each accepted result's landing; `merged` is "landed" |
| `agent-workers.run.stalled`, `run.unknown`, in the window | the runs that stalled or ended unknown |
| `ctx.artifacts.list` by run | the decisions a person made on each run read: a `client` decider (the lead) or the `operator`. The runs read: the done tasks' runs, every run with an entry of its own in the window (an older run stopped, continued, approved, or freed in it), and every run a person decided on in the window among the 1000 latest decisions. Each run's oldest 1000 decisions, and its newest 1000 when the oldest are full; a run whose two pages share none may hold more between them, and is named (`truncatedRuns`) |
| `quota.draw`, in the window | what each agent run drew from its account's windows, and its kind of work |
| `ctx.artifacts.list`, board decisions to `ready` | when each task first became ready (the latest 1000 moves; past that, a note) |

**One record added (additive).** The engine kept who started a run in its own row only
(`TaskView.startedBy`), which no other plugin reads. The `workflow.run.started` entry of a board
task's run now carries `startedBy` too. An entry made before it has none: its task is not
attributed (below). No other storage is new.

## A lead touch

A **lead touch** on a task is one of these, recorded in System after the task was created, on a
run that served the task:

1. a run of the task **started by the lead**: its `workflow.run.started` entry says
   `startedBy: lead` (MCP `run` or `task`, the CLI, `scripts/sysrun.mjs`). A start by `dispatch`
   is not a touch; a start by the `operator` (Start on `/ui`) is the operator's;
2. a decision on one of its runs whose decider is a **client**: the lead's own token (a tie's
   deciding vote, say);
3. what the project's **lead principal** decided on its own token
   ([ADR-0076](../decisions/adr/0076-the-lead-is-a-principal-of-its-own-with-a-closed-list-of-rights.md)):
   its verdicts in the approval queue on the task's requests (`approval` decisions whose decider is the
   `client` `lead:<project>`), and its acceptance of the task's result. Each counts once. A lead's merge
   approval is a touch, and unattended completion allows it as it allows the operator's.

The operator's decisions are counted apart (operator decisions per day: the **operator principal's**
verdicts, acceptances, and decisions on runs, never a lead's), and are touches for unattended
completion. A verdict whose resolving decision cannot be read counts as the operator's, as every verdict
did before the lead principal; a record from before it (decider `operator` at version 1) is the
operator's whoever used the token, and a note on the reading says how many there are in the window.

**What it misses, and so why it is a lower bound.** The lead notes a salvage and retries by hand on its
own coordination board, outside System, and messages a session through the client scope. None of that
leaves a System record yet, and what the lead decided on the operator's token before the lead principal
is not told from the operator's. Until those records are gone from the window, the value is a **lower
bound** (`bound: lower`), and the reason says what it leaves out.

**Only before the window's end.** A run started, a decision made, or a verdict given at or after
the window's end never counts: a later retry or decision leaves an earlier window's reading as it was.

**A task not fully attributed.** A finished task with a run whose started entry names no starter
(recorded before this change), whose start the log no longer holds, or whose decisions were not all
read, stays in the sample and counts the touches recorded: a lower bound of its own touches, so the
median over every finished task is still a lower bound of the true median. For unattended
completion it counts as unattended unless a touch is known, so that share stays an upper bound.
The figures count such tasks (`unattributed`, `notAttributed`).

This definition is not a contract: it is the reading the metric gives now, and I2 extends it.

## The metrics

The window is `since` (inclusive) to `until` (exclusive). A **finished task** is a done task whose
accepting decision was made in the window, as the report counts one.

| Metric | Value | Sample | Not measurable when |
|---|---|---|---|
| Traced landings | — | — | always, for now: a change landed outside System leaves no System record; it needs the repositories' history |
| Gate coverage | — | — | always, for now: a tool call the gate did not see leaves no record to count against |
| Board coverage | runs started in the window that serve a board task, over all of them (each task has acceptance criteria by its schema) | runs started | no run started; or a project's scope (a run that serves no task belongs to none) |
| Lead touches per task | the median of touches recorded per finished task (with its p90 and mean, starts, decisions, and the tasks not fully attributed); a lower bound | finished tasks | no task finished, or none fully attributed |
| Operator decisions per day | the approval verdicts given in the window, the acceptances the operator decided, and the operator's decisions on the runs read, each once, over the window's days; a lower bound, said, when a run's decisions or the latest decisions may not all have been read | those decisions | nothing at all is recorded in the scope |
| Unattended completion | over every finished task, the share that went from ready to landed (a merged landing before the window's end) with no touch known: no lead touch, no run the operator started, and no operator decision but the merge approval (a verdict on a request of the task or its runs not of class `merge`, an operator acceptance of it or of an attempt, an operator decision on its runs). A task not landed is never unattended; a landed one whose move to ready was not read, or whose touches are not all recorded, counts unless a touch is known, so the share is an upper bound, over every tier (tiers come with I2) | finished tasks | no task finished |
| Time ready-to-landed | the median and p90, in hours, from a task's first move to `ready` to its result's `merged` landing, for the merges of the window; over every tier. When the latest 1000 moves to ready were all read (`readyReadFrom`), a task created before the first of them may have become ready earlier: its time and the median are a lower bound, which shows a miss but never meets the line | results merged | no result merged, or none has a move to ready read |
| Stalls per 100 runs | the workflow runs with an agent run that stalled or ended unknown in the window (each once), per 100 runs started in it | runs started | no run started |
| Escaped defects per 100 landed | the tasks with a defect recorded in the window, each once at the earliest time one was, per 100 results merged in it: a task another task's `defect` link names (`fixes: <taskId>@<landing sha>`, set when the fix task is filed or later by the lead, the reviewer, or the operator), a task whose landing commit a revert landed on the target names (the landing records the `This reverts commit` lines of the commits it merged), and an escape of an auto-accepted result (D93). A lower bound: a defect nobody linked, reverted, or recorded is not counted | results merged | the board records neither links nor escapes; or no result merged in the window |
| Worker availability | of the hours each Worker was observed in the window, the share it could take work. A Worker's state is the one its last event left it in (`roster.worker.unavailable` with a reason, `roster.worker.available`); hours before its first event are not observed. A usage limit (`quota-exhausted`) is no failure of the Worker (PROP-0016 §1): its hours are left out of both sides; a lost login, a quarantine, a stall, or another reason counts as unavailable | Workers | no event recorded, or no hour but at a usage limit |
| Cost per accepted result | the ledger's tokens (input and output) counted in the window over the results accepted in it, with cost, turns, and the quota the agent runs drew (clean draws, percentage points); and the same by kind of work (`byKind`, each window's quota with the draws left out by state). A usage record's kind is its run's draw's; one no draw names is listed under no kind (not known). Each component is summed over the records that carry it: one no record carries (tokens, cost, turns, a window's points with no clean draw) has no figure, never 0, and the reason says so; one some records lack counts the others, said. The value is a lower bound when records carry no token counts or runs' usage could not be counted | accepted results | none accepted; neither usage nor a draw recorded; or no usage record carries token counts (the quota drawn, cost, and turns recorded stay as figures) |
| Quota idle while work is ready | — | — | always, for now: an account's headroom is read when a run is routed, not recorded over time |

The three still not measurable (traced landings, gate coverage, quota idle) each name the record they need; adding those records is the rest of I4.

## The records of I4 part 2

- **The `defect` link** (`board-task@1.2`, [board design](board.md#the-defect-link)): `defect: { fixes, sha, at, by }`.
  Set at filing (`board_propose` `fixes`) or later (`board_defect`).
- **Reverts**: a merged landing records `reverts`, the commits its merged commits' messages say they
  revert (`This reverts commit <sha>`), on its `workflow.task.landing` entry. The metric matches each to
  the task whose landing commit or result it names. A tree the landing could not read records none.
- **Worker availability events**: the MCP server reads the roster every `availabilitySeconds` (60)
  and appends `roster.worker.unavailable` (`worker`, `reason`, `detail`) or `roster.worker.available`
  (`worker`, `was`) to the event log when a Worker's ability changes; a Worker's first read is its
  baseline. Reasons: `quota-exhausted` (left out of the share), `login-lost`, `quarantined`, `stalled`,
  `unavailable`. Hours the host was down count as the state the last event left.

## The L3 reading

Each metric stands against its L3 line (PROP-0016 §1, starting lines, D83): `meets`, `misses`,
`unproven` (a bound on the side of the line that does not settle it: a lower bound of lead touches
that is at most 1, an upper bound of unattended completion that is at least 50 %), or `not-read`
(no value). "1 working day" is read as 24 hours, and "reported weekly" is met when the cost is
measured.

`level.l3` is `holds` only when every line is met, over a window of at least 30 days, on at least
30 finished tasks. Otherwise it is `not-shown`, with every reason: the window too short, too few
tasks, the lines missed, those a bound does not show, and those not measurable. With three metrics
not measurable yet, no reading can show L3: that is the honest reading, not a defect.

## Where it is shown

- MCP `metrics` (client scope): `projectId`, `days` (1 to 366, default 30), `until`; the text is the
  rendering, the structured content the reading ([reference](../reference/schemas.md#mcp-tool-metrics)).
- `system metrics [--days n] [--project id] [--until time] [--json]`
  ([reference](../reference/cli.md)).
- The weekly report's last section, `maturity`: the same reading over the 30 days to the report's
  end, without its own `asOf` (the report's says it), so two reports of one period still differ in
  `asOf` only. One the bounds refuse leaves the report whole, with a note.

## Bounds

Reading is bounded as the report's is (INV-9): at most 100,000 entries of a type, at most 2,000
runs' decisions (`MAX_RUNS_READ`), and 1,000 moves to ready; past the first two the reading is
refused (`overloaded`), never cut. An event log trimmed by retention inside the window is said in
the notes.
