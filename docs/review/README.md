# Review guides

One `<area>.REVIEW.md` per area of this repository, each written by the area's owner. A review step's
brief is given the guides of the areas the change touches, and only those. The format, how a guide is
selected, and where it sits in the handbook are in
[the handbook](../design/handbook.md#review-guides-reviewmd).

| Guide | Area | Owner |
|---|---|---|
| [workflow-engine](workflow-engine.REVIEW.md) | the workflow engine, its templates and profiles | lead |
| [agent-workers](agent-workers.REVIEW.md) | agent Workers, runtimes, confinement, the browser | lead |
| [gate-and-approvals](gate-and-approvals.REVIEW.md) | the tool gate, the autonomy policy, approvals | operator |
| [board-and-dispatch](board-and-dispatch.REVIEW.md) | the board, dispatch, landing | lead |
| [web-ui](web-ui.REVIEW.md) | the web UI | lead |
| [docs](docs.REVIEW.md) | documentation, changesets, these guides | lead |

A guide is read from this directory in the repository the run's worktree was cut from (its checked-out
branch), never from the worktree under review: a change cannot rewrite the rules it is reviewed by.
A change to a guide is a change to a rule: its owner approves it.
