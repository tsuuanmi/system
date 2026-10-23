# @tsuuanmi/system-board-core

Work state machine **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[board](../../docs/design/board.md)). A guarantee seam: its contract changes only by an ADR
([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.board` | abstract `Board` with `charter(input, at?)`, `project`, `projects`, `pause`, `resume`, `close`, `propose(input, at?)`, `task`, `tasks`, `claim`, `renew`, `start`, `submit`, `accept`, `reconcileRun`, `block` (its optional `funding`, 1.2), `answer`, `cancel`, `sweep(at)`, and the optional `attachDigest(taskId, digest, at?)` (1.1); `Project`, `Charter`, `Milestone`, `BoardTask`, `Funding`, `CharterInput`, `TaskInput`, `Claim`, `RunOutcome`, `BoardError`; `TERMINAL`, `fundingVersion`, `BOARD_CONTRACT` (1.2) | the fake `FakeBoard`; the store-backed [`board`](../plugins/board/README.md) |

- The types mirror `project@1.0` and `board-task@1.1`; the schemas in `schemas/` are canonical.
- `block` takes, from 1.2, an optional `funding` on a `budget-spent` wait: the lines the holder
  asks to raise the task's budget by. `fundingVersion(contentId)` is the version of the subject
  that binds a funding request to those lines (`budget-spent:<sha256 of their canonical JSON>`);
  each provider hashes the lines with `contentId` of `@tsuuanmi/system-libs`
  ([funding a spent budget](../../docs/design/board.md#funding-a-spent-budget)).
- `renderTasks(project, tasks, maxTasks)` is the board's `TASKS.md` projection, a pure function
  of those records, outside the seam's contract: the provider renders it on request, and the
  workflow engine into a task run's worktree, so both render the same text.
- Depends on Cordis and the vocabulary of `@tsuuanmi/system-approvals-core`: the board asks
  for approvals through `ctx.approvals` and never decides one itself.
- The conformance suite is [`conformance/board.ts`](conformance/board.ts), run through the
  [conformance runner](../libs/conformance/runner.ts) at contract 1.2 over any `ctx.approvals`
  provider:
  - a charter approved by the operator before anything starts; rejection or expiry abandons the
    project and cancels its open tasks; amendments held until approved;
  - a task ready only once its dependencies are done and the policy allows it, and asked about
    again before every new attempt; asked about,
    rejected into a wait that expires, or forbidden; a wait the queue never resolves expired by
    the board itself;
  - one holder at a time, every write fenced by its generation; a run recorded before it starts,
    never started again when its holder is lost, its outcome taken from the run's owner, also
    when its request was withdrawn before the owner's move committed;
  - review to done only by an accepting `acceptance` decision bound to the task's exact result,
    with the class's required checks passed unless the operator made it; bounded attempts,
    ending in a wait no input revives, never ready once spent; review bounded by the
    reviewer's lease; a result on the subject the task writes;
  - blocking and answering; cancelling, with the approval withdrawn and dependents cancelled;
    validation of proposals and of founding milestones; pausing and closing;
  - a wait whose request the queue withdrew on a policy change put to the policy again: ready,
    the forbid outcome, or one new request on the same subject; a charter asked about again or
    abandoned. Its `boot` therefore also changes the queue's policies (`changePolicies`);
  - since 1.1, a digest attached to a task's exact result once, never while its reviewer holds
    the review; a review held for the operator takes one, and the operator's acceptance must then
    name it; a done task's result takes one after its acceptance;
  - since 1.2, a spent budget's funding ask bound to the request's subject, invalid asks refused,
    kept when the request is asked again after a policy change; approved, exactly those lines
    added to the budget, the raise recorded with the approval before the next attempt's gate;
    rejected, nothing raised; an ask past any bound a provider may set opening no request.

  It also exports `FakeBoard`, which passes it (its bound per task: `fundingMaxPercent`, default
  100). Contract 1.0 is unreleased and amended in place
  ([ADR-0039](../../docs/decisions/adr/0039-base-guarantee-seam-contract-changes.md)); 1.1 adds
  the optional `attachDigest`, a minor
  ([ADR-0040](../../docs/decisions/adr/0040-briefs-on-the-workers-and-workflow-seams.md)); 1.2
  the optional `funding` of a `budget-spent` block, a minor
  ([ADR-0044](../../docs/decisions/adr/0044-funding-raises-a-spent-task-budget.md)).
