# Web UI API

> Hand-written from [`web-ui`](../../packages/plugins/web-ui/README.md) (`src/index.ts`). The
> page at `/ui` is its only client; `system ui` prints its link.

Every route is under `/ui/api` and passes the shared request guard first
([gateway-core](../../packages/gateway-core/README.md#the-request-guard)): a loopback `Host`
(else `421`), no `Origin` but the UI's own (else `403`), and the operator token as
`Authorization: Bearer` (else `401`). A `POST` takes a JSON object only
(`content-type: application/json`, else `415`), of at most 16 KiB (else `413`; 128 KiB for
`policy/propose`). Errors are `{error}`.

## Home

One navigation on every page, **Home**, **Board**, **Workers**, and **Autonomy policy**, the
current one marked (`aria-current`) and named in the window's title; a run's page counts as Home's.
Each page opens with its title and one line of what it is for.

**Home** is a dashboard: *Waiting for you* (the requests waiting for a verdict, the tasks waiting
for review, and the runs that need a look, each linking to its section), the Workers at a glance
(the roster's counts), the approval cards, the reviews as cards (what was asked, the checks not
run, the run that made the result, the exact result folded; **Accept: mark it done** and
**Reject: send it back**, each with its own note), the runs that need a look (failed, or waiting
for a plan approval, a fix's verdict, or a deciding vote) with why and a link, and the 15 most
recent runs.

## Runs

| Route | Body | Answer |
|---|---|---|
| `GET runs` | — | `{runs}`: the latest 100 runs |
| `GET runs/<runId>` | — | `{run, explain}`; `404` for an unknown run |
| `POST runs/<runId>/approve` | `{verdict: approved \| rejected, note?, plan?}`: `plan` the `sha256:` id of the plan the page shows (INV-5). A remediation fix's plan on the approval queue (the run's `blocked.approvalRequest`) is refused (`409`): decide its request in the queue | `{run}` |
| `POST runs/<runId>/vote` | `{decision, option, rationale}`: the tie decision the page shows, an option or `inconclusive` | `{run}`; the vote is the operator's |
| `POST runs/<runId>/stop` | `{reason?}` | `{run}` |
| `POST runs/<runId>/continue` | `{nodeId?}` | `{run}` |

A refused action is `400` (a malformed body) or `409` (the engine refused it).

## Reviews

Served when `ctx.board` and `ctx.artifacts` are present; without either, both routes answer `503`
([board](../design/board.md#required-checks-bind-at-acceptance)).

| Route | Body | Answer |
|---|---|---|
| `GET reviews` | — | `{reviews}`: every task in review, those held for the operator first, by expiry: `taskId`, `title`, `goal`, `actionClass`, `acceptance`, `attempts`, `project {projectId, title}`, the result's exact `subject`, `artifacts` (and `digest`, `files`), `pendingChecks`, `run`, `heldFor` (`operator`, or `reviewer` while a run's lease holds it), `since`, `expiresAt`, `lastDecision` |
| `POST reviews/<taskId>/decide` | `{verdict: accept \| reject, subject, note?}` | `{task, decision}`: the task after `ctx.board.accept`, and the `acceptance` decision recorded |

- `subject` is the exact subject of the result the page showed (INV-5): a result on another
  subject is refused (`409`), and so is a task no longer in review. Nothing is decided then.
- The verdict is an `acceptance` decision made by the operator (decider `operator`, producer
  `operator`), naming the task and the result's subject in `outcome.detail`, with every result
  artifact (and the digest) among its inputs and the note as its rationale; then
  `ctx.board.accept` applies it. This is the operator's channel for it (INV-6): no MCP tool
  accepts a review.
- A malformed body is `400`, an unknown task `404`. A refusal by the board is `409`, with its
  failure (`invalid`, `invalid-transition`, …).

## Projects

Served when `ctx.board` is present; without it, every route answers `503`
([the operator's project moves](../design/board.md#the-operators-project-moves)).

| Route | Body | Answer |
|---|---|---|
| `GET projects` | — | `{projects}`: every project, in creation order with the closed ones last: `projectId`, `title`, `state`, `revision`, `charter {version, intent}`, `amendment` (a pending amendment's charter version), `open` (its tasks per open state: `proposed`, `ready`, `claimed`, `running`, `review`, `waiting-for-input`, `waiting-for-approval`), `closure`, `lastDecision`, `createdAt`, `updatedAt`; and `tasks`, its tasks as the Board's cards (`taskId`, `title`, `state`, `actionClass`, `createdAt`, `updatedAt`, `run {runId, startedAt}`, `holder {owner, leaseExpiresAt}`, `waiting {reason, approvalRequest?, since, expiresAt}`), per state the most recently changed first, at most 50 each, `more` counting the rest per state |
| `POST projects/<projectId>/pause` | `{revision}` | `{project, decision}`: the `project@1.0` record after `ctx.board.pause`, and the `board` decision that records the move |
| `POST projects/<projectId>/resume` | `{revision}` | `{project, decision}`, after `ctx.board.resume` |
| `POST projects/<projectId>/close` | `{revision, outcome: achieved \| stopped}` | `{project, decision}`, after `ctx.board.close`; `decision` is also the closure's |

- `<projectId>` is URI-encoded (an id may hold `/`). `revision` is the project's revision the page
  showed: a project whose revision moved since (a move, a charter amended or dropped) is refused
  (`409`) and nothing moves. A malformed body is `400`, an unknown project `404`.
- The move goes to `ctx.board` as the operator's (INV-6), at the server's clock. A refusal by the
  board is `409` with its failure: `invalid-transition` for a move from another state, or a close
  while a task of the project runs or is in review.
- The **Board** page is a Kanban: a project filter (all projects by default), each shown
  project's header (title, state, charter version, what of it waits for the operator, linked to
  its card, and **Pause**, **Resume**, **Close**), how many Workers are idle and tasks ready and how
  a ready task gets a Worker, then a column per state: *Proposed*, *Ready*, *Working* (claimed and
  running), *Review*, *Waiting for you* (input and approval), with *Done* and *Cancelled* folded.
  Each card gives the task's title, its project (when several are shown), its action class, when it
  last changed, what it waits on in words (a link to the approval card or the review), who works
  on it (the Worker's roster `name` and for how long, from the roster's current work), and a link
  to its run.
- A close cancels every open task of the project (`project-closed`), releasing a claimed one's
  lease, then withdraws the approval requests those tasks and a pending amendment waited on. The
  page shows each move's consequences for that project, and sends it only on **Confirm**.

## Approval queue

Served when `ctx.approvals` is present; without it, both routes answer `503`
([approvals](../design/approvals.md)).

| Route | Body | Answer |
|---|---|---|
| `GET approvals` | — | `{batches: [{batchId?, requests}]}`: the open and batched `approval-request@1.x` records, by batch then expiry, the unbatched last (no `batchId`) |
| `POST approvals/decide` | `{verdicts, note?, batchId?}` | `{results}`: one `{requestId, state, approval?, refused?}` per verdict, in order |

- `verdicts` holds 1 to 50 `{requestId, subject, verdict: approved | rejected, note?}`. `subject`
  is the exact subject the page showed for that request (INV-5): a verdict for a request whose
  subject changed since is refused (`subject-changed`) and changes nothing.
- `note` applies to every verdict that has none of its own; a note is trimmed to 2000
  characters.
- With `batchId`, every verdict must be for a request of that batch, or nothing is decided
  (`409`). The page sends it for a batch's **Approve all N in this batch** and **Deny all N in
  this batch**, with one verdict for each request it shows.
- A malformed verdict refuses the whole call before any verdict applies (`400`). Otherwise
  the verdicts go to `ctx.approvals.decide` as the operator's (INV-6), at the server's clock:
  each applies or is refused on its own (`unknown-request`, `already-resolved`, `expired`,
  `subject-changed`, `failed`).

The page shows each request as one entry: what is asked in plain words (a charter as *Found
project …* or *Amend the charter of …*, a board task's step, a tool call, a budget raise, a fix,
a policy change), who asked (the board for a task or project, an agent run, a run's step, the
queue), the request's own text, what it is about with the exact subject behind **Exact
subject**, what approving and what denying change, and when it expires, relative and absolute
(unanswered by then, it counts as denied). The consequences a requester gave are shown as given;
for a board charter or task request without them the page says what the board does with each
verdict ([board](../design/board.md)), counting the project's proposed and open tasks from
`GET projects` when the board runs. Each button names its effect (*Approve: activate project p1*,
*Deny: hold the task*), and each entry has its own note; a batch has a note for all its requests.

After a call the page reports, above the page until **Dismiss**, what happened: each verdict
recorded, with its request and approval record and what happens next, or not recorded, with why
in plain words (each `refused` failure, or the call's own `{error}` and status) and that nothing
was decided. The same report follows a review verdict, a project move, and a run action. While a
call is in flight its buttons are disabled. The page refreshes every 5 seconds, but never while
an element of it has focus or a pointer or key is pressed: a render that lands during a press
waits for its release, so a press is never lost to a refresh.

Every pending decision on another page links to its card: a project's charter or amendment and a
task's approval on the Board, a run's fix on the run's page, and an asked policy change in the
policy page's history. The link is `/ui/?request=<requestId>`: Home, scrolled to that card, which
takes the focus; a request that no longer waits says so in the report above the page. The policy
page shows an asked change's own card, with **Approve** and **Deny**, at its top.

## Autonomy policy

Served when `ctx.approvals` is present; without it, both routes answer `503`
([a policy change](../design/approvals.md#a-policy-change)).

| Route | Body | Answer |
|---|---|---|
| `GET policy` | — | `{set?, policies, effective, proposals, changes?}`: the set in force (`hash`, `source` `configuration` or `store`, `configHash`, `changeId`, `projects`), every policy of it (the studio's first), the effective mode per action class for the studio and each project (`[{projectId?, effective}]`), whether the queue takes proposals (contract 1.1), and its latest 20 `policy-change@1.x` records, newest first (a change the queue proposed itself carries its `origin`, `@1.1`) |
| `POST policy/propose` | `{policy, note?}`: one `autonomy-policy@1.0` record | `{change, request}`: the `policy-change@1.0` record (`asked`) and the `policy-change` request that asks for it |

- The proposal goes to `ctx.approvals.proposePolicy` as the operator's (INV-6), at the server's
  clock. It applies nothing: the change comes into force only when the operator approves its
  request in the queue (`POST approvals/decide`, on the request's subject, the proposed set's
  hash), while the set it was proposed on is still in force.
- A proposal the queue refuses is `400` (`invalid`: the record, the version rule, or a load-time
  rule of the set it makes) or `409` (`not-asked`: the policy forbids `policy-change`), and
  nothing is stored. A queue at contract 1.0 answers `501`: its policy changes by configuration
  and a restart only.
- `note` is trimmed to 2000 characters and shown with the request.
- A change the queue proposed itself from repeated approvals
  ([approvals](../design/approvals.md#the-queue-proposes-a-policy-change)) has an `origin`: the
  queue entry's **Show change** says it was proposed by the queue, not the operator, with the
  command, the approvals counted, the window, and its decision, and the history marks it
  *(proposed by the queue)*. It is decided like any other request.

## Roster

Served always; each service it reads that is not mounted reads as unknown with why
([roster](../design/roster.md)).

| Route | Body | Answer |
|---|---|---|
| `GET roster` | — | the roster, an `mcp-roster@1.2` `roster-output` record ([record semantics](schemas.md#mcp-tool-roster)), as the operator reads it: account labels included. A record its schema refuses is a defect: `500` with why |

- Any other method is `405`. The **Workers** tab (`?view=workers`, next to Board) shows the counts
  (working, idle, at a limit with when the first is back, unavailable, and quarantined when any),
  then one card per Worker, grouped by status (working, idle, at a limit, unavailable,
  quarantined). Each card gives the Worker's id; what it is for (its `description`, else its
  `derived` line, marked *derived*, with *no description is configured*); its status and why in
  plain words (*Working: 1 of 2 slot(s) in use*, *At a limit: back in 2 h (11:40)*, *Unavailable:
  its account is signed out*); what it does now (each step's `summary`, with a link to its run);
  its account (the operator's label, id, kind, and state); what it serves (tier, quota class,
  locality, provider, family, role); its limits (held-off capabilities, its account's return, each
  pool and window with its used share and reset); and its load. Times read relative first, the
  clock time beside. A fact that is unknown shows as `unknown (why)`; a Worker source that was
  silent or failed in its last read is named above the cards, its Workers not listed. The tab
  refreshes every 5 seconds like the rest of the page.
