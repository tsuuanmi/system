# System building System

`system` is built with `system`. Its development is a software-development workflow of the kind
the [`algorithm-development` template](../reference/workflow-templates.md#algorithm-development) runs: a lead splits work into
briefs, Workers change code in worktrees of their own, a team reviews the exact change, findings
are fixed, checks validate, and the operator approves. When that loop runs through `system` and
holds, it is evidence that `system` works; where it breaks, it is a defect to fix first.

This page records that evidence. The [pilot](../operations/pilot.md) and its
[baseline report](../design/reports.md) are the measured version; this page keeps the record of
the runs before the pilot.

## Before the pilot: team reviews of its own code

In the Base release (PROP-0010), `system`'s own `review` template (one member per provider family,
quotes checked against the files read, sealed ballots) reviewed security-relevant code of `system`
at a pinned commit of this public repository. A run's findings were checked against the code by
the lead before any change; only the ones that held were fixed, each with a test that fails on
the code before the fix.

| Run | Subject (commit) | Members | Outcome | Findings held | Fixed in |
|---|---|---|---|---|---|
| `run_65c39f158163c5c6` | the Worker tool gate, `agent-workers/src/gate.ts` (`59962e5`) | ChatGPT (Gemini stalled) | changes | 4 of 5: a symlink escaped the workspace; unknown input fields were not classified; the gate left shell syntax to the policy (made defence in depth); a stored request was not checked in full. The fifth (a used approval asks again) is the design | `ef015fb` |
| `run_d28538263173ef45` | remediation on the approval queue, `workflow/src/queue.ts` (`4dd2d3c`) | ChatGPT, Gemini | changes (a confirmed blocking finding) | 4 of 4: the gate could open after the reviewed tree moved; a late approval was not refused (defence in depth); a crash could lose a terminal verdict and ask twice; an unreadable queue was not settled by the gate itself | `a32e430` |

The two subjects and the nine findings the lead checked (eight defects and the design) are the
cases and the labels of the [worker-agnosticism experiment](experiments/worker-agnosticism.md)'s
suite.

Two earlier runs did not start, and each showed a defect in `system` itself: `review` refused an
abbreviated commit id (`run_65a61f8b37f2c17e`), and a focus larger than the source bound
(`repositories.maxSourceChars`, 24 000) was refused rather than narrowed (`run_cdd56619136656b8`).
Gemini members stalled (`provider_stalled`) in one of the two reviews that ran.

## Not yet through `system`

The rest of that loop ran outside `system`: the lead was a Claude Code session, the Workers were
its subagents and a second Claude Code installation, and the operator approved in chat. Each part
has a counterpart now built (the board and briefs, Claude Code Workers with a worktree per run and
confined commands, remediation and approvals on the queue, the report), so the next evidence is
the pilot: the same work run through the board, measured by `system report` against Claude Code
alone ([read the baseline](../operations/pilot.md#read-the-baseline)).
