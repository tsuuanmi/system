---
id: PROP-0016
type: proposal
status: accepted
created: 2026-10-26
summary: System runs as a startup inside a group. It has room to grow itself inside clear policies, rules, and workflows, and the operator keeps objectives, budgets, trust boundaries, irreversible actions, and exceptional risk. A maturity model from L0 to L6 judges each level by criteria observed over a rolling 30 days, not by a list of features. System is between L2 and L3 today, and the target is L4 by 2028 to 2029, with L5 only where the evidence allows it. Getting to L3 needs five things. A handbook in five layers, each with an owner, a version, and a check that enforces it, and each Worker gets only its role's and its task's slice. A process tiered by risk, light for docs and heavy (two model families and an adversarial review) for the gate, dispatch, and security. Onboarding and probation for a new Worker or model. A weekly scorecard from an evidence ledger. A research function that proposes direction, with the operator approving direction and budget only. After L5, System is packaged so one operator can run several projects within an attention budget. Five increments, each measurable, I1 to I5.
owners: [operator]
evidence: [operator vision 2026-10-26 (four points), the lead's analysis 2026-10-26, T224 brainstorm (two model families, both chose one option), T215, T216, T217, T218, T219, T220 (2026-10-25/26)]
related: [PROP-0008, PROP-0011, PROP-0013, PROP-0014, PROP-0015, ADR-0027, ADR-0028, ADR-0036, ADR-0041, ADR-0049, ADR-0050, ADR-0057, ADR-0060, ADR-0063, ADR-0064, ADR-0066, ADR-0067, ADR-0068, ADR-0069]
implementation: [ADR-0071]
---

# Proposal: Operating model — a startup inside a group

## Problem

System works, but mostly while someone watches it. Dispatch already starts ready work by itself
where a project allows it ([ADR-0064](../decisions/adr/0064-system-starts-ready-work-under-the-dispatch-action-class.md),
D2, since 2026-10-25), and a listed branch's result is accepted on its review and checks
([ADR-0067](../decisions/adr/0067-system-accepts-a-listed-branchs-result-on-its-review-and-checks.md)).
What is still done by hand: the lead starts the tasks it runs itself with `scripts/sysrun.mjs`
(this task, T225, is one), reads the reports, retries or fixes failed attempts, and accepts the
results outside the listed branches; the operator answers the approvals that `ask` sends. Each new kind of failure is fixed once and written down somewhere, but nothing
tells a new Worker which of those rules apply to it. The operator's attention is the limit on how
much System can do. It cannot run a second project.

On 2026-10-26 the operator set out a vision in four points:

| # | The operator's point | What it asks of System |
|---|---|---|
| 1 | **L3: the lead also checks only what matters**, as in a real company | policies, rules, onboarding, and one source of rules that a new Worker follows, without giving any Worker too much to read |
| 2 | **L4 to L5: the organisation develops and steers itself** from objective, independent research | a research function whose findings, not the lead's habits, set direction |
| 3 | **After L5, package System** so it runs many projects, because the operator's attention is the limit | project templates, portfolio scheduling, an attention budget |
| 4 | **A startup inside a large group**: room to grow within clear policies, rules, and workflows, so Workers and teams work well | freedom within a frame: what System decides alone, and what escalates |

The parts already exist one at a time: the gate and the autonomy policy, the board, dispatch,
auto-acceptance, attempt shielding, the repository's lessons, and the weekly report. What is
missing is the operating model that ties them together. Nothing says what "better" means as a
measured level, which rules a Worker must see, how much process a change needs, how a new model
earns trust, or what the operator alone decides.

## Goals

1. **A maturity model whose levels are observed, not claimed.** Each level holds when its criteria
   hold over a rolling 30 days, measured from recorded data.
2. **Reach L3 next.** Routine work goes from ready to landed with no lead touch. The lead and the
   operator see only exceptions, each with a decision brief.
3. **One handbook, layered and enforced.** Every rule has an owner, a version, and a check. Each
   Worker reads only its slice.
4. **Process in proportion to risk.** A docs change takes the light path. A change to the gate,
   dispatch, or security takes the heavy path.
5. **Trust is earned.** A new Worker or model starts in shadow and moves up by its measured
   results.
6. **Direction from evidence.** From L4, independent research and a council vote propose the
   direction. The operator approves the direction and its budget.
7. **One operator, several projects.** From L6, a new project starts from a template, and the
   operator's attention is budgeted across projects.

## Non-goals

These come from T224, where both model families chose to avoid them:

| Not doing | Why |
|---|---|
| more agents for their own sake (agent proliferation) | every agent costs quota, review, and attention; add one only when a measured gap needs it |
| policies that rewrite themselves | the frame is the operator's; System proposes a change and the operator approves it ([ADR-0041](../decisions/adr/0041-policy-changes-through-the-approval-queue.md), [ADR-0050](../decisions/adr/0050-the-queue-proposes-a-policy-change-from-repeated-approvals.md)) |
| SaaS multi-tenancy | one operator, one host; packaging means more projects, not more customers |
| a rewrite on Kubernetes | no measured need; the host on DSH core holds the guarantees |
| custom or fine-tuned models | System uses the providers' models and measures them |
| native mobile apps | `/ui`, notifications, and the lead are enough |

Also out of scope: changing an invariant, and any increment's design in detail. Each increment
comes with its own design and, where it touches a guarantee, its own ADR.

## Evidence and research

| Source | What it says | What this proposal takes |
|---|---|---|
| Operator vision, 2026-10-26 | the four points above | the frame of the whole proposal |
| T224 brainstorm (two model families, both chose the same option) | target L4 by 2028 to 2029, with selective L5; judge each level by rolling-30-day observable criteria, not feature lists; humans keep objectives, budgets, trust boundaries, irreversible actions, and exceptional risk; next quarter: an integration queue per repository with exact-tree checks, a Worker health canary with rollback, approvals tiered by risk with decision briefs, attempts shielded from infrastructure failures, global IDs, and an operational evidence ledger; the six things to avoid | the target, the kind of criteria, the reserved decisions, I2 to I4, the non-goals |
| The lead's analysis, 2026-10-26 | System is between L2 and L3; the lead's touches per task are the main cost; rules are spread over lessons, ADRs, and briefs | I1, I2, the lead-touch metric |
| [PROP-0008](0008-studio-operating-model.md) (draft) | projects as startups from one template, an investor report, an autonomy matrix | packaging (L6) and reporting up; this proposal measures what PROP-0008 described |
| [PROP-0014](0014-dispatch-by-quota.md), [PROP-0015](0015-right-worker-right-job.md) (accepted) | System starts ready work by itself; quota and measured strengths choose the Worker | dispatch and E4's measured strengths feed L3 and probation |
| [PROP-0011](0011-feedback-loop.md) (proposed) | experiments and evaluations as records; promotion through the queue | the research function's evaluations (L4) |

### Where System is today: L2, moving to L3

What happened on 2026-10-25 and 2026-10-26:

| Evidence | What it shows | Level |
|---|---|---|
| T215 landed end to end: a dispatched attempt that resumes a session stays on that session's Worker ([ADR-0064](../decisions/adr/0064-system-starts-ready-work-under-the-dispatch-action-class.md)) | System found, fixed, and landed its own dispatch regression | L3 behaviour |
| T217 landed end to end: a listed branch's result is accepted on its review and its checks ([ADR-0067](../decisions/adr/0067-system-accepts-a-listed-branchs-result-on-its-review-and-checks.md), D80) | the lead no longer accepts every routine result | L3 behaviour |
| T219 landed end to end: a live update fails, and rolls back, when a Worker that took work before it does not take work after it | Worker availability is checked, not assumed | L3 behaviour |
| T218: an attempt is not spent on an infrastructure failure ([ADR-0069](../decisions/adr/0069-an-attempt-is-not-spent-on-an-infrastructure-failure.md)) | attempt shielding exists | L3 building block |
| T216: an accepted result is rebased and checked again before it lands ([ADR-0068](../decisions/adr/0068-an-accepted-result-is-rebased-onto-its-target-and-checked-again-before-it-lands.md), proposed) | the start of an integration queue | L3 building block |
| T220: each writing Worker's brief carries the repository's lessons ([lessons](../engineering/lessons.md)) | the first layer of a handbook, bounded (30 lines) | L3 building block |
| Dispatch starts ready work with no request under `auto` and `notify` (ADR-0064 D2), and records who started each run (`dispatch`, `lead`, or `operator`, `TaskView.startedBy`) | starting is automated where a project allows it | L3 behaviour, demonstrated |
| The lead still starts its own tasks with `scripts/sysrun.mjs` (T225 is one), reads the reports, retries or fixes failed attempts, and accepts results outside the listed branches; the operator answers each `ask` approval | the remaining lead and operator touches, per task, are not yet few | **still L2** |
| No record counts the lead's touches, escaped defects, or idle quota, and no 30-day share of runs started by `dispatch` or landed with no touch is computed | L3 cannot be shown yet, only argued | **still L2** |

So the automation L3 needs is demonstrated on single tasks (T215, T217, T219, and dispatched
starts), but the 30 days of evidence that would establish L3 do not exist yet. I4 makes that
measurable.

## Proposed design

### 1. Maturity model, L0 to L6

A level holds when **every** criterion of that level and the levels below it has held over a
rolling 30 days, on at least 30 finished tasks (fewer reads "too few", as in PROP-0015 E4). A level
is lost the same way. The scorecard (I4) computes it each week. A level is a reading, never a
switch: no behaviour turns on because a level is reached.

| Level | Name | In one line | Who checks the work |
|---|---|---|---|
| **L0** | Tools | the operator drives each agent by hand | the operator, everything |
| **L1** | Assisted | System runs a template when asked; one run at a time | the operator, every run |
| **L2** | Supervised | board, gate, approval queue, worktrees; the lead starts and checks each attempt | the lead, every attempt; the operator, every approval |
| **L3** | Managed | routine work goes from ready to landed with no lead touch; rules come from the handbook; process follows risk | the lead and the operator, exceptions only, each with a decision brief |
| **L4** | Self-improving | System measures itself and proposes its own improvements from independent research; the operator approves direction and budget | the operator, direction and budget; the council, proposals |
| **L5** | Self-steering (selective) | in the kinds of work where the evidence holds, System sets its own backlog inside the frame | the operator, the frame and the exceptions |
| **L6** | Packaged | System runs several projects from templates; one operator, an attention budget across them | the operator, the portfolio |

**The metrics** (each from recorded data; I4 builds those not recorded yet):

| Metric | Definition | Source | Recorded today? |
|---|---|---|---|
| **Traced landings** | share of changes landed in the project's repositories that trace to a recorded System run with its report | landing decisions, run reports, the repository's history | in part (I4) |
| **Gate coverage** | share of an agent's tool calls in a run that carry a recorded gate decision | the gate's `autonomy` decisions per run | yes, not summed |
| **Board coverage** | share of runs bound to a board task with acceptance criteria | runs' board-task ids, the board | yes, not summed |
| **Lead touches per task** | median number of lead actions on a task after it is created: a start, an answer, an accept, a retry, a fix by hand | the lead's MCP calls and board moves, bound to the task | no (I2) |
| **Operator decisions per day** | approvals, verdicts, answers, and merges the operator gives, per day, per project | approval and board decisions | yes, not summed |
| **Unattended completion** | share of finished tasks that went from ready to landed with no lead or operator touch except a required merge | board, `board.auto-accept`, landing decisions | in part (I4) |
| **Time ready-to-landed** | median and 90th percentile, from `ready` to merged | board and landing decisions | in part (I4) |
| **Stalls** | stalled or held runs per 100 runs | `agent-workers.run.stalled`, liveness verdicts | yes, not summed |
| **Escaped defects** | landed changes later reverted, or fixed by a task that names them, per 100 landed | a new `defect` link on a task (I4) | no (I4) |
| **Worker availability** | share of hours each configured Worker could take work, usage limits excluded | roster, live-update check (T219) | in part (I3, I4) |
| **Cost per accepted result** | quota and metered usage per accepted task, by kind | resource ledger, report | yes, per run |
| **Quota idle while work is ready** | share of window-hours with headroom above the reserve while a ready task waited unstarted | quota readings, board | no (I4) |

**Criteria per level** (rolling 30 days; the numbers are proposed, see [open question 2](#open-questions)):

| Metric | L0 | L1 | L2 | L3 | L4 | L5 (where it applies) |
|---|---|---|---|---|---|---|
| Traced landings | measured, any value | ≥ 80 % | ≥ 95 % | ≥ 98 % | ≥ 99 % | ≥ 99 % |
| Gate coverage | measured, any value | 100 % | 100 % | 100 % | 100 % | 100 % |
| Board coverage | — | measured | ≥ 90 % | ≥ 95 % | ≥ 98 % | ≥ 98 % |
| Lead touches per task (median) | — | — | measured | ≤ 1 | ≤ 0.5 | ≤ 0.2 |
| Operator decisions per day, per project | — | measured | measured | ≤ 10 | ≤ 5 | ≤ 3 |
| Unattended completion, light and normal tiers | — | — | measured | ≥ 50 % | ≥ 75 % | ≥ 90 % |
| Time ready-to-landed, light tier (median) | — | — | measured | ≤ 1 working day | ≤ 4 h | ≤ 2 h |
| Stalls per 100 runs | — | measured | measured | ≤ 5 | ≤ 2 | ≤ 1 |
| Escaped defects per 100 landed | — | — | measured | ≤ 5 | ≤ 3 | ≤ 2 |
| Worker availability | — | — | measured | ≥ 95 % | ≥ 98 % | ≥ 99 % |
| Cost per accepted result | — | measured | measured | reported weekly | not rising over 90 days at equal or fewer escaped defects | falling over 90 days |
| Quota idle while work is ready | — | — | measured | ≤ 20 % | ≤ 10 % | ≤ 5 % |
| Research and direction | — | — | — | — | at least one improvement per month from the research function, landed and measured | the backlog in those kinds set by System, the operator overruling ≤ 1 in 10 |
| Projects | one | one | one | one | one | one |

"Measured" means the scorecard reads the metric over the 30 days, whatever its value; "—" means the
level does not need it. **L0** is the reading when the records exist (traced landings and gate
coverage can be counted) but L1's criteria fail; with no records there is no reading at all. **L1**
holds when most landed work traces to a recorded run and the gate decides every tool call. **L2**
adds the board: nearly every run is a board task, and every L3 metric is read.

**L6** adds: a second project onboarded from a template, holding L3 within 30 days of its start,
while the first project keeps its level and the operator's decisions across both stay inside the
attention budget.

### 2. The handbook, in layers

One source of rules, in five layers. A higher layer wins over a lower one. No layer is new
text for its own sake: most of it exists and is moved or linked, not rewritten.

| Layer | Holds | Owner | Version | Where | Enforced by | Changed by |
|---|---|---|---|---|---|---|
| **1. Constitution** | the invariants and accepted ADRs | operator | ADR number and status; the invariants file's commit | [invariants](../architecture/invariants.md), [ADRs](../decisions/adr/README.md) | conformance suites, `scripts/architecture.spec.ts`, the crash suite, the review | an ADR the operator accepts |
| **2. Organisation policies** | the autonomy policy, action classes, risk tiers (§4), trust tiers (§3), what escalates (§7) | operator; the lead proposes | the policy's version and hash | the studio policy, `docs/operations/` | the gate on every tool call; the approval queue; `pnpm check` for the tier map | a `policy-change` approval ([ADR-0041](../decisions/adr/0041-policy-changes-through-the-approval-queue.md)) |
| **3. Project charter** | the project's objective, budget, repositories, required checks, auto-accept branches | operator with the lead | the board's charter record | the board | the board (budgets, gates), the required checks ([ADR-0063](../decisions/adr/0063-a-runs-required-checks-run-on-its-exact-result.md)) | the operator's project move |
| **4. Role playbooks** | how a writer, reviewer, validator, researcher, and lead each work; what "done" means for the role | lead | the template's version | the templates and their prompts | template conformance tests; the brief's schema | a reviewed change (light or normal tier) |
| **5. Repository lessons** | mistakes made here before, one line each, with the check that now enforces it | lead and review | the commit at the Worker's HEAD | [lessons](../engineering/lessons.md) per repository | `agent-workers/tests/lessons.spec.ts` (at most 30 lines, 400 characters each) | a commit; a lesson whose check makes it impossible to repeat is folded or dropped |

**Rules for every layer:**

- A rule without a check says so ("Check: the review; no automated check yet"), as the lessons
  already do. The scorecard counts such rules; their number should go down.
- A rule has one home. Another layer links to it and never copies it.
- A lower layer may make a rule stricter, never looser.

**Progressive disclosure.** Each Worker gets a **slice**, not the handbook:

| In the brief, always | Fetched through read tools, when needed |
|---|---|
| the task (goal, acceptance, budget) | the full invariants, ADRs, and designs |
| the role's playbook (layer 4), for this role only | other roles' playbooks |
| the policy lines that bear on this role and tier: what the gate allows, what escalates | the full policy |
| the project's charter lines: objective, required checks | the project's history |
| the repository's lessons (layer 5, as T220 does now) | the workspace reads server; git history once T223 (on the board) gives read-only git views |

- The slice has a **fixed bound**, proposed at 6,000 tokens for the handbook part of the brief, the
  task not counted ([open question 3](#open-questions)). Over the bound, the brief is refused when it is
  built, with the layer that overflowed, and the owner of that layer shortens it. It is never cut
  silently (INV-9).
- The brief records the version of each layer it used, so a result can be traced to the rules it
  was given (INV-13).
- I1 measures the slice's size and the reads each run fetched, to see whether Workers miss rules or
  read too much.

### 3. Onboarding and probation of a new Worker or model

A new Worker (a new account, runtime, or model version) earns trust in tiers. The tiers sit on
what exists: quarantine of an unverified account, kinds ([ADR-0057](../decisions/adr/0057-route-work-by-kind.md)),
read-only review members ([ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md)),
and measured strengths (PROP-0015 E4).

| Tier | May do | Moves up when (rolling 30 days, proposed) | Moves down when |
|---|---|---|---|
| **T0 Shadow** | runs beside a trusted Worker on the same task; its result is recorded and never used | probe passes; ≥ 5 shadow results, review scores not worse than the trusted Worker's | probe fails; any gate violation |
| **T1 Probation** | light-tier tasks only (docs, tests); every result reviewed by another model family | ≥ 10 accepted light-tier results, 0 escaped defects, availability ≥ 95 % | 1 escaped defect, or 2 rejected results in a row |
| **T2 Standard** | light and normal tiers; may review light-tier work | ≥ 30 accepted results, escaped defects ≤ the project's L3 line | escaped defects above the L3 line, or a failed health canary |
| **T3 Trusted** | may be one of the two families on the heavy path; may review normal-tier work | the operator's approval (T3 is a trust boundary) | the operator, or a heavy-path defect |

- A model version change on a provider is a new Worker for this table: it starts at T1, not T0,
  when its predecessor was T2 or above ([open question 5](#open-questions)).
- Every move is a recorded decision with its numbers. A move down is automatic, a move to T3 never
  is.
- **Onboarding** for a Worker is its slice (§2). It needs no separate document.

### 4. Process tiered by risk

The tier of a change is decided by **what it touches**, by a path map in the policy (layer 2),
not by a model's opinion. The highest tier among the touched paths wins. An unmapped path is
normal tier. A path that can't be read is heavy (INV-2).

| Tier | Touches (proposed) | Writer | Review | Checks | Acceptance | Merge |
|---|---|---|---|---|---|---|
| **Light** | `docs/` except invariants and ADRs; `README.md` files; changesets; tests only | any T1+ Worker | one exact-subject review | required checks on the exact tree | auto-accept on a listed branch ([ADR-0067](../decisions/adr/0067-system-accepts-a-listed-branchs-result-on-its-review-and-checks.md)) | the operator's merge, batched |
| **Normal** | any other source | T2+ | one exact-subject review by another model family ([ADR-0027](../decisions/adr/0027-provider-diversity-in-routing.md)) | required checks; rebased and checked again before landing ([ADR-0068](../decisions/adr/0068-an-accepted-result-is-rebased-onto-its-target-and-checked-again-before-it-lands.md)) | auto-accept on a listed branch | the operator's merge |
| **Heavy** | the gate and approvals, dispatch and routing, confinement and credentials, the ledger's guarantees, schemas' major versions, store migrations, invariants, ADRs | T3 | two model families, plus an **adversarial review** that tries to break the change | required checks plus the conformance and crash suites | never automatic: a **decision brief** to the operator | the operator's merge, alone |

**A decision brief** is one page: what changes, why, the options and the one recommended, the
evidence (review findings, checks, the diff's size), what is reversible, and how to roll back. The
operator answers yes, no, or a question. Every escalation in §7 uses it.

**The lead-touch metric** (I2) shows whether the tiers work: light and normal tasks should need no
lead touch, and heavy ones should need the operator's decision only.

### 5. The research function (steering L4 to L5)

| Step | Who | Output |
|---|---|---|
| 1. Question | the scorecard's weakest metric, or the operator | a research task on the board |
| 2. Independent research | research Workers on at least two providers, many sources | findings with quotes, quote-checked |
| 3. Brainstorm | a team of two model families, each proposing alone first | options with evidence, scored |
| 4. Council vote | the brainstorm team and the lead, majority by family | one chosen option, dissent recorded |
| 5. Proposal | the lead writes it, from the vote | a proposal with increments and measures |
| 6. Approval | **the operator: direction and budget only** | accepted, changed, or rejected |
| 7. Build and measure | System, under the tiers of §4 | the increment and its metric before and after (PROP-0011 where an experiment fits) |

- Research has its own budget line, proposed at most 10 % of the week's quota
  ([open question 6](#open-questions)).
- The research function proposes; it never changes a policy, a budget, or a trust tier. Those go
  through the queue as today.
- T224 itself is an example of steps 2 to 4; this proposal is step 5.

### 6. Packaging (L6)

| Piece | What it is | Builds on |
|---|---|---|
| **`system project new --kind <kind>`** | creates a project from a template by kind (software repository, research programme, operations): charter, policy layer, playbooks, required checks, an empty lessons file | the board's projects; PROP-0008's template |
| **Portfolio scheduling** | dispatch across projects by each project's share and priority, inside the bounds that exist | dispatch's bounds per project (ADR-0064), the quota order (ADR-0066) |
| **Attention budget** | a cap on operator decisions per day across projects, with a share per project; past a project's share, its non-urgent asks wait for the next day's digest | the approval queue, *Needs you* (PROP-0015 E5) |
| **Reporting up** | each project reports weekly like a subsidiary: level, scorecard, spend against budget, decisions needed, risks | the weekly report (`report` plugin) |
| **Global IDs** | every task, run, decision, and evidence record has an ID unique across projects, so a portfolio can be read as one | the ledger of record |

### 7. Governance: freedom within a frame

| System decides alone (records it) | System decides and tells (in the weekly report) | Escalates, always with a decision brief |
|---|---|---|
| which Worker takes a ready task, within quota and tiers | a Worker moved down a trust tier | a project's **objective** or a new project |
| retries shielded from infrastructure failures (ADR-0069) | a lesson added or dropped | a **budget** or its increase |
| light and normal acceptances on listed branches | research tasks started within the research budget | a **trust boundary**: a new sandbox, egress, credential, or a Worker to T3 |
| a rebase before landing | a rollback after a failed canary | an **irreversible action**: a merge, a delete, a push, a release |
| splitting a task into child tasks (PROP-0015 E6) | the weekly level reading | **exceptional risk**: a heavy-tier change, a policy change, an invariant, anything the policy does not cover |

What escalates is the five things humans keep (T224). Everything else runs inside the frame and is
recorded, so the operator can read it later instead of being interrupted now.

## Increments

Each one ships alone, has a metric before and after, and starts on the operator's go-ahead.

| Increment | Delivers | Measured by | Builds on |
|---|---|---|---|
| **I1** Handbook layers and the per-Worker slice | the five layers named, each with owner, version, and check; the slice built per role and tier within the bound; the brief records each layer's version; refusal over the bound | slice size per run; rules without a check (count); reads fetched per run | T220 (lessons), T223 (git reads, on the board) |
| **I2** Risk tiers and the lead-touch metric | the path map in the policy; light, normal, and heavy paths in `algorithm-development`; the adversarial review step; the decision brief; lead touches recorded per task | lead touches per task; operator decisions per day; heavy-tier changes with two families (should be 100 %) | ADR-0067, ADR-0027 |
| **I3** Integration queue, attempt shielding, canary | one integration queue per repository, landing in order, each result checked on its exact rebased tree; attempt shielding (built in T218); a Worker health canary after each update with automatic rollback (T219, extended to a test task) | time ready-to-landed; landings that broke the target (should be 0); attempts spent on infrastructure; Worker availability | T216, T218, T219 and their follow-ups |
| **I4** Evidence ledger and weekly scorecard | global IDs; an operational evidence record for each metric of §1; the `defect` link; the weekly scorecard with the level reading in the report | every metric of §1 computed for 30 days; the level read from records alone | the report, the resource ledger |
| **I5** A project template, proven by a second project | `system project new --kind`; the attention budget; reporting up | the second project holds L3 within 30 days; the first keeps its level; operator decisions inside the budget | I1 to I4 |

**Order** (proposed, [open question 7](#open-questions)): I4's first part (the metrics) and I2 first,
since L3 cannot be shown without them; I1 and I3 next (I3 is partly built); I5 last.

**ADRs on acceptance:** the risk tier map and the heavy path (I2); trust tiers, and who may move a
Worker (I2 or a later step); the integration queue (I3, amending ADR-0060 and ADR-0068); global IDs
(I4); a project template's contents (I5).

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| A feature checklist per level ("L3 = auto-accept built") | T224: a feature built is not a feature that works; the levels are read from 30 days of outcomes |
| Aim for full L5 by 2028 | T224: autonomy beyond the evidence costs trust; L5 only in kinds of work where L4's metrics hold |
| One large handbook given to every Worker | costs tokens, dilutes the rules that matter; the operator asked for no Worker to be overloaded |
| A model classifies a change's risk | not reproducible and easy to sway; a path map is deterministic and reviewable |
| More agents (a manager agent per role) | agent proliferation, a non-goal |
| Package first (L6), then mature | a template that copies an L2 setup copies the lead's load to every project |

## Validation plan

- **I1:** a brief per role and tier holds only that slice, within the bound; a slice over the bound
  is refused with the layer named; the brief records each layer's version.
- **I2:** the path map's table tests (each tier, the highest wins, an unmapped path is normal, an
  unreadable one heavy); a heavy-tier task never auto-accepts; lead touches counted on a fixture.
- **I3:** two accepted results for one repository land in order, the second rebased and checked on
  the exact tree; a failed canary rolls back; crash tests for the queue.
- **I4:** each metric on a fixture with known answers; the level reading changes only after 30
  days and 30 tasks.
- **I5:** a second project created from a template on the live host, read through its own weekly
  report.
- **Live:** after I2 and I4, 30 days of the scorecard on the `system` project, and a level reading
  the operator checks against what happened.

## Rollout and rollback

- Every increment is off or read-only until turned on: the scorecard only reads; the tier map
  starts in shadow (each task labelled, its process unchanged) for 30 tasks; the slice bound starts
  as a warning before it refuses.
- Turning an increment off returns to today's behaviour; records stay.

## Observability and operations

- The weekly report gains the scorecard and the level reading (I4), and later a portfolio view
  (I5).
- `system explain` on a task shows its tier, the handbook layers' versions its brief used, and its
  lead touches.
- Runbooks: read the scorecard; move a Worker between trust tiers; change the tier map; create a
  project from a template.

## Security and privacy

- No Worker gains a capability, sandbox, or egress from this proposal. The heavy path adds review;
  it removes none.
- Trust tier T3 and every trust boundary stay the operator's decision.
- Research Workers reach outside sources as they do today, under their declared egress; nothing
  from a project's repository is sent unless its charter allows it.

## Compatibility and migration

The scorecard and the tier labels are new records, additive. The brief gains the layers' versions
as an optional field (a minor version). Global IDs need a migration of record identifiers, designed
with I4's ADR. Nothing else changes until an increment is turned on.

## Open questions

Each has a recommendation; the operator decides.

1. **The target.** L4 by 2028 to 2029, with L5 only in kinds of work where L4's metrics hold for
   90 days?
   **Recommended:** yes, as T224's two families both chose.
2. **The thresholds in §1.** Are the L3 lines right (lead touches ≤ 1, operator decisions ≤ 10 a
   day, unattended ≥ 50 %, escaped defects ≤ 5 per 100)?
   **Recommended:** take them as starting lines, and revisit them once I4 has 30 days of data,
   before any level is declared.
3. **The slice bound.** How large may the handbook part of a brief be?
   **Recommended:** 6,000 tokens, a warning for 30 tasks, then a refusal.
4. **The heavy path's list.** Is §4's list right (the gate and approvals, dispatch and routing,
   confinement and credentials, ledger guarantees, schema majors, migrations, invariants, ADRs)?
   **Recommended:** yes, and an unreadable path counts as heavy.
5. **Probation for a new model version.** Does a new version of a trusted model start at T1 or at
   T0?
   **Recommended:** T1 when its predecessor was T2 or above, T0 otherwise.
6. **The research budget.** How much of the week's quota may the research function spend without
   asking?
   **Recommended:** at most 10 % of each week's quota, never from the operator's 20 % reserve
   (D63).
7. **Order of increments.** **Recommended:** I4's metrics and I2 first, then I1 and I3, then I5.
8. **The second project for I5, and the attention budget.** Which project, and how many decisions a
   day across projects?
   **Recommended:** a project of a different kind from `system` (a research programme), so the
   template is tested on more than one kind; 15 decisions a day in total, 10 for `system`.

## Decision

Accepted by the operator on 2026-10-26, each open question answered as this proposal recommends
(D83):

1. The target is L4 by 2028 to 2029, with L5 only in kinds of work where L4's metrics hold for 90
   days.
2. The L3 lines of §1 are starting lines, revisited once I4 has 30 days of data and before any
   level is declared.
3. The handbook part of a brief is bounded at 6,000 tokens: a warning for 30 tasks, then a refusal.
4. The heavy path's list is §4's, and an unreadable path counts as heavy.
5. A new version of a trusted model starts at T1 when its predecessor was T2 or above, T0
   otherwise.
6. The research function may spend at most 10 % of each week's quota without asking, never from
   the operator's 20 % reserve (D63).
7. The order is I4's metrics and I2 first, then I1 and I3, then I5. The operator gave the go-ahead
   for I4's metrics and I2.
8. The second project is of a different kind from `system`; the attention budget is 15 decisions a
   day in total, 10 for `system`. The operator wants several projects on System soon: I5 is the
   goal the earlier increments serve.

## Implementation

- **I2, part 1** (T237): the path map in the policy (`autonomy-policy@1.1` `riskTiers`; the system
  repository's in `policies/system.json`, kept whole by `check:tiers`), the tier as a decision on the
  run, a heavy change's second review by another provider family and its hold for the operator, and
  a light change's skipped validation:
  [ADR-0071](../decisions/adr/0071-a-changes-risk-tier-comes-from-the-policys-path-map.md),
  [process tiered by risk](../design/workflow-engine.md#process-tiered-by-risk). As T237 asks, an
  unmatched path is heavy (fail closed, like an unreadable one), not normal as §4 first wrote; the
  check keeps every tracked path matched, so only a new one is ever unmatched. The adversarial review
  prompt, the decision brief, and the lead-touch metric are I2's later parts.
