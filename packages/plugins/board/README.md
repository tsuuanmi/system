# @tsuuanmi/system-board

**`ctx.board`**: the store-backed provider of the work state machine seam
([board](../../../docs/design/board.md); definition
[`board-core`](../../board-core/README.md)). It holds work that outlives a run: projects with
charters, and their tasks.

- **Records.** Projects are `project@1.0` and tasks `board-task@1.0` records, one row each in
  `board_projects` and `board_tasks`, indexed by project and state. Every record is validated
  before it is written and after it is read: one that fails on read is never acted on. Every
  write is revision-checked.
- **Moves.** Each move is one store transaction with the decision it names (INV-13): a `board`
  decision (`decision@1.4`) for a move the board makes on its own, in which every candidate says
  why it was or was not chosen; otherwise the `autonomy`, `approval`, or `acceptance` decision
  that caused it. A move that awaits the approval queue first commits only if the record is still
  the revision it read (else `conflict`), and withdraws the request it opened when it cannot.
- **Approvals.** Only through `ctx.approvals` (`check`, `request`, `get`, `list`, `withdraw`); the
  board never decides one. With the queue unavailable, every move that needs it fails and
  nothing moves; the sweep still applies the moves that do not (a lapsed claim).
  - A request is on the exact subject: `project:<id>:charter:<version>` with the charter's hash,
    or `board-task:<id>:attempt:<n>` with the wait's reason. A verdict counts only for that
    subject and that task, and every return to ready for a new attempt asks the policy again,
    so one approval never covers a later attempt.
  - Before it opens a request, the board adopts its own request on the same subject, open or
    already approved, one a crash left between asking and committing, so a retried move asks the
    operator once and an approval given meanwhile applies. It lists the project's open, batched,
    and approved requests to find it, which grows with the project's history (M5, open).
  - An accepting decision that is not the operator's, with the class's required checks not
    passed (or the class forbidden), holds the review for the operator: the lease released,
    `waiting` `operator-review` with the checks still pending, for the policy's wait for the class
    (`waitSeconds` over `ctx.approvals.policy`), then `review-expired` on the sweep. Only the
    operator's acceptance (on `/ui`, [`web-ui`](../web-ui/README.md)) accepts it then; a
    rejection, or a decision with the checks passed, applies.
  - A move that ends a wait (`reconcileRun`, `cancel`, `close`) reads the request first, commits,
    and withdraws it after; a withdrawal that fails is logged, and the request expires on its
    own. The sweep leaves a task waiting on a withdrawn request as it is (only the board
    withdraws).
- **Leases.** A task's holder is a `ctx.leases` lease on `board-task:<taskId>`; its generation is
  the holder's generation. The lease token stays in the store, never in the record. Every write a
  holder makes (`start`, `submit`, `block`, `renew`) presents the generation and passes the
  lease's own fence inside the committing transaction, so a stale generation is refused across a
  restart too (INV-4, INV-15). A move that drops the holder releases the lease. A lease is lost
  when it lapsed or no longer holds the resource.
- **One writer per subject.** An open task's `writes` subject (type and ref) is unique, by a
  partial unique index as well as the check in `propose` (INV-15).
- **Time.** `sweep(at)` is the only time-driven path, and it is idempotent: it settles charter
  requests, then walks the open tasks in insertion order, so a dependency moves before the tasks
  that depend on it. One item that fails is logged and left for the next sweep. A pending
  request's expiry is applied by the board itself when the queue has not resolved it or no
  longer knows it: the charter request's expiry is stored with the project
  (`charter_expires_at`), a task's in its `waiting.expiresAt`, so nothing waits forever when the
  queue lost a row or never sweeps. A first charter refused or expired abandons its project and
  cancels its open tasks in the same transaction. The board sweeps
  once at start (a restart is a sweep) and every `sweepSeconds`; `0` leaves sweeping to the
  caller.
- **Where the protocol's tables leave room**, this provider settles it as
  [board](../../../docs/design/board.md#where-the-tables-leave-room) says.
- **Reads beyond the seam:** `projectPage` and `taskPage` (20 items by default, never more than
  `pageBound`, with an opaque cursor), `counts`, `latest`, and `tasksMarkdown`. `projects` and
  `tasks`, the seam's own reads, return every match.
- **`TASKS.md`:** `tasksMarkdown(projectId)` renders one project's board as Markdown in
  Backlog.md's spirit, for native agents without MCP: per task its id, title, state, action
  class, attempts, dependencies, holder, run, why it waits (with its questions), result, and
  acceptance criteria as checkboxes (checked once done). Tasks are grouped in progress, waiting,
  ready, proposed, done, cancelled; at most `projectionMaxTasks`, open ones first, the rest
  counted. The output depends on the stored records only, quotes each goal so it cannot read as
  the board's structure, and is never read back; the caller writes it where an agent reads it.
- **MCP** (when `ctx.mcp` is present, client scope): `board_projects`, `board_charter`,
  `board_brief`, `board_tasks`, `board_task`, `board_propose`, `board_claim`, `board_update`,
  `board_cancel`. Each input and structured output is validated against
  [`schemas/mcp-board.v1.json`](../../../schemas/mcp-board.v1.json) `$defs/<tool>-input` and
  `-output`; a refused input does nothing, a refusal is an MCP error naming the `BoardError`.
  - `board_charter` and `board_propose` are retry-safe under `clientRequestId`, recorded in the
    same transaction as the write (the table is never pruned: M5, open); a `board_charter` retry
    reports the charter version that call asked about, and founding under a key derives the
    project's id from it, so a retry after a crash adopts the request it left;
  - `board_claim` defaults to `leaseTtlSeconds`; `leases.maxTtlMs` (default 10 minutes) caps
    every lease, and the output gives the real expiry;
  - no tool starts, submits, accepts, blocks, or reconciles a task: the workflow run that serves
    an attempt does, as its owner (MCP `run` with `task`;
    [workflow](../workflow/README.md)), so one attempt has one writer (INV-15). A lead takes a
    task with `board_claim` and hands the claim to `run` (holder and generation); a claim no run
    starts lapses back to `ready`;
  - `board_update` renews the caller's lease for as long as it was claimed (a run that serves
    the task renews it itself), or answers every
    question of a waiting task by index, not both; its `note` is not stored (no record holds
    progress notes yet). Only a `question` wait takes answers: a `rejected`, `retries-spent`, or
    `review-expired` wait takes no input and only expires to cancelled, and answering the last
    attempt's questions leaves the task waiting for input (`retries-spent`), never ready with no
    attempt left
    ([what ends an input wait](../../../docs/design/board.md#what-ends-an-input-wait));
  - `board_cancel` cancels as `operator` for an operator token and as `lead` for a client one;
  - `board_projects` and `board_brief` give no `budget`: use comes from the resource ledger,
    which has no provider yet;
  - `board_brief`'s `readFirst` lists the closed project's lessons and the accepted results of
    its latest done tasks (their digest, else their first artifact); `conventions` are the
    charter's constraint notes.
- **Injects:** `store`, `artifacts`, `leases`, `approvals`; `mcp` is optional.
- **Config:** `inputExpirySeconds` (default 7 days), `leaseTtlSeconds` (600), `maxAttempts` (3),
  `pageBound` (100), `projectionMaxTasks` (200), `sweepSeconds` (60).
- **Bundle:** the `board` row is on, over the `approvals` row
  ([`system-approvals`](../approvals/README.md)); with that row off or refused, the board waits
  on its `approvals` inject and is not mounted.
- **Tests:** [`tests/conformance.spec.ts`](tests/conformance.spec.ts) runs the seam's suite
  ([`board-core/conformance/board.ts`](../../board-core/conformance/board.ts)) at contract 1.0
  over `FakeApprovals`, with no expected failures; the approval queue's own tests run it over the
  store-backed queue too.
  [`tests/board.spec.ts`](tests/board.spec.ts) covers what the suite does not: restart (in place
  and as a new process over the same file), fencing across a restart, concurrent claims and
  racing sweeps, the queue unavailable, adoption of an orphaned request (open, or approved while
  a founding call crashed), both crash windows around a withdrawal and a close that fails after
  reading, a wait whose request the queue no longer knows, a spent or lost run under a policy
  that does not ask, the gate before every attempt, the checks an acceptance reports, results
  on the written subject, paging bounds, invalid records refused, the tools' outputs against
  their schema definitions, and the projection.
