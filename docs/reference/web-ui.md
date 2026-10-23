# Web UI API

> Hand-written from [`web-ui`](../../packages/plugins/web-ui/README.md) (`src/index.ts`). The
> page at `/ui` is its only client; `system ui` prints its link.

Every route is under `/ui/api` and passes the shared request guard first
([gateway-core](../../packages/gateway-core/README.md#the-request-guard)): a loopback `Host`
(else `421`), no `Origin` but the UI's own (else `403`), and the operator token as
`Authorization: Bearer` (else `401`). A `POST` takes a JSON object only
(`content-type: application/json`, else `415`), of at most 16 KiB (else `413`; 128 KiB for
`policy/propose`). Errors are `{error}`.

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

Served when `ctx.board` is present; without it, both routes answer `503`
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
- A refusal by the board is `409`, with its failure (`invalid`, `invalid-transition`, …).

## Projects

Served when `ctx.board` is present; without it, every route answers `503`
([the operator's project moves](../design/board.md#the-operators-project-moves)).

| Route | Body | Answer |
|---|---|---|
| `GET projects` | — | `{projects}`: every project, in creation order with the closed ones last: `projectId`, `title`, `state`, `revision`, `charter {version, intent}`, `amendment` (a pending amendment's charter version), `open` (its tasks per open state: `proposed`, `ready`, `claimed`, `running`, `review`, `waiting-for-input`, `waiting-for-approval`), `closure`, `lastDecision`, `createdAt`, `updatedAt` |
| `POST projects/<projectId>/pause` | `{revision}` | `{project, decision}`: the `project@1.0` record after `ctx.board.pause`, and the `board` decision that records the move |
| `POST projects/<projectId>/resume` | `{revision}` | `{project, decision}`, after `ctx.board.resume` |
| `POST projects/<projectId>/close` | `{revision, outcome: achieved \| stopped}` | `{project, decision}`, after `ctx.board.close`; `decision` is also the closure's |

- `<projectId>` is URI-encoded (an id may hold `/`). `revision` is the project's revision the page
  showed: a project whose revision moved since (a move, a charter amended or dropped) is refused
  (`409`) and nothing moves. A malformed body is `400`, an unknown project `404`.
- The move goes to `ctx.board` as the operator's (INV-6), at the server's clock. A refusal by the
  board is `409` with its failure: `invalid-transition` for a move from another state, or a close
  while a task of the project runs or is in review.
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
  (`409`). The page sends it for **Approve batch** and **Deny batch**, with one verdict for each
  request it shows.
- A malformed verdict refuses the whole call before any verdict applies (`400`). Otherwise
  the verdicts go to `ctx.approvals.decide` as the operator's (INV-6), at the server's clock:
  each applies or is refused on its own (`unknown-request`, `already-resolved`, `expired`,
  `subject-changed`, `failed`).

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
