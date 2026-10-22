# @tsuuanmi/system-board-core

Work state machine **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[board](../../docs/design/board.md)). A guarantee seam: its contract changes only by an ADR
([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.board` | abstract `Board` with `charter(input, at?)`, `project`, `projects`, `pause`, `resume`, `close`, `propose(input, at?)`, `task`, `tasks`, `claim`, `renew`, `start`, `submit`, `accept`, `reconcileRun`, `block`, `answer`, `cancel`, `sweep(at)`; `Project`, `Charter`, `Milestone`, `BoardTask`, `CharterInput`, `TaskInput`, `Claim`, `RunOutcome`, `BoardError`; `TERMINAL`, `BOARD_CONTRACT` (1.0) | the fake `FakeBoard`; the store-backed [`board`](../plugins/board/README.md) |

- The types mirror `project@1.0` and `board-task@1.0`; the schemas in `schemas/` are canonical.
- Depends on Cordis and the vocabulary of `@tsuuanmi/system-approvals-core`: the board asks
  for approvals through `ctx.approvals` and never decides one itself.
- The conformance suite is [`conformance/board.ts`](conformance/board.ts), run through the
  [conformance runner](../libs/conformance/runner.ts) at contract 1.0 over any `ctx.approvals`
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
    with the class's required checks passed unless the operator made it; bounded attempts;
    review bounded by the reviewer's lease;
  - blocking and answering; cancelling, with the approval withdrawn and dependents cancelled;
    validation of proposals; pausing and closing.

  It also exports `FakeBoard`, which passes it.
