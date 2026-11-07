# PLAN.md — System next implementation: Brainstorm first

> **Status:** draft execution handoff for the next iteration, updated 2026-11-06.
> **Implementation target:** [PR #2](https://github.com/tsuuanmi/System/pull/2)
> (`mvp0/implementation`, observed at `7099428`), **not PR #1**.
> **B0–B4 are done on PR #2 (B3 scored by a model judge, see RES-0008).**
> This checklist is not a new ADR or an alternate source of product requirements.

## 0. Read and align

- [Product Charter](docs/requirements/purpose.md), [accepted ADRs](docs/decisions/README.md)
  and [MVP scope](docs/requirements/mvp.md) define product/architecture truth.
- [PROP-0002 roadmap](docs/proposals/PROP-0002-post-mvp-roadmap.md) is the
  **canonical draft priority proposal**. [RES-0006](docs/research/RES-0006-brainstorm-workflow-feasibility.md)
  explains implementation feasibility and what to learn from System 1.
- The earlier M0–M6 implementation checklist is in the Git history and
  [PR #2's PLAN.md](https://github.com/tsuuanmi/System/blob/709942819e56c57452bf72c2db019c845fca1d74/PLAN.md).
  Do not reset MVP-0 progress or repeat its completed work. At the observed
  PR #2 commit, tests and authorized throwaway GitHub publish were reported
  complete; recheck the actual current local state before modifying code.
- **Research now:** keep the existing end-to-end Research flow operational.
  Claim-level checking and more rigorous citation verification are **future
  capabilities**, not blockers for this Brainstorm iteration.
- **Website Worker:** research that needs interactive/login-gated websites
  comes **after** the Brainstorm milestone, not before.
- **Security isolation:** not the goal of this iteration; do not expand scope
  into container/egress infrastructure merely to ship Brainstorm.

## 1. What we are shipping

**Outcome:** a user submits one Brainstorm brief and receives **three
immutable Worker output Artifacts**: two independent alternative proposals
from **Claude Code + Codex** and one synthesis from either existing Worker.
The same `WorkController` executes the externally configured Workflow.
No additional provider type, new Work authority, domain engine or required
VerifierPort. Three *executions/roles* are sufficient; not three provider
implementations. Completion means output delivery, **not** factual approval.

```text
brief Artifact ID
    ├── idea-a (Claude) → proposal-a Artifact ID ─┐
    └── idea-b (Codex)  → proposal-b Artifact ID ─┤
                                                      ↓
                                       synthesis (Claude or Codex)
                                                      ↓
                                            summary Artifact ID
```

The two idea steps have only the initial brief as input. The synthesis
step receives the two exact proposal IDs and brief. **Scheduling is
sequential** in current code even if dependencies are independent;
parallelism is explicitly not a release requirement.

## 2. Execution checklist and gates

### B0 — Confirm the MVP-0 baseline (short)

- [x] Check the current PR #2 head, clean local working tree and pinned DSH
  version. Do not overwrite local uncommitted work or rebase without consent.
  *(PR #1 merged into `mvp0/implementation` at `41d2e0a`, no rebase; tree clean; DSH `0.2.2-rc.1`.)*
- [x] Run existing offline build/unit/smoke tests and `system doctor`;
  record command, exit status, source SHA and enabled Worker accounts.
  *(`corepack pnpm check` at `41d2e0a`, Node 24.21.0: exit 1, unit 114/114, smoke 33/36 with 2 skipped and 1 failure: `tests/concurrency.test.ts`, "entries did not activate"; fixed under B4. `system doctor` exit 0; `system workers`: `claude-code/default` (2.1.311) and `codex/default` (0.166.0) available.)*
- [x] Inspect `packages/work/src/workflow.ts`, `controller.ts`,
  `registry.ts`, `packages/agents/src/index.ts`, `workspace.ts`
  before changing anything. Existing `system.workflow/v1` can express B1.
  *(Confirmed: file inputs reach a step as read-only files, a Workflow without `accept` ends "every step succeeded", ready steps run in file order, and submit already refuses a capability no enabled Worker provides.)*
- [x] Keep existing Software Engineering and Research workflows passing.
  No verifier rewrite or independent DSH plugin framework.

**Gate:** baseline documented, both existing workflow fixtures preserved.

### B1 — Brainstorm YAML, reuse Claude and Codex (next feature)

- [x] Add `workflows/brainstorm.yaml` using current strict
  `system.workflow/v1`: `idea-a`, `idea-b`, `synthesis` Worker steps.
  Each produces a named file Artifact; no `verify` or `accept` required.
- [x] Add account capability labels via DSH composition/profile config:
  `brainstorm.idea-a` for Claude, `brainstorm.idea-b` for Codex, and
  `brainstorm.synthesis` for one existing account. Retain provider-neutral
  `WorkerPort`; no new Worker or domain-specific Controller branch.
- [x] Ensure `idea-b` has no input reference to `idea-a`; synthesis
  declares `dependsOn: [idea-a, idea-b]` and inputs both proposal slots.
- [x] Write concise role instructions asking for distinct alternatives,
  assumptions, trade-offs, failure modes and unresolved questions. Synthesis
  compares arguments and proposes next experiments; no false consensus.
- [x] Add fake Worker tests: exactly three attempts, expected provider refs,
  two independent inputs, Artifact ID handoff, distinct provenance, pinned
  spec, failed capability preflight and no required verifier.
- [x] Make result Artifact IDs and step statuses inspectable using existing
  CLI. Do not build a new UI or transcript-chat layer.

**Gate:** fake Brainstorm run completes with three stored Artifact outputs,
correct independent/synthesis inputs and no Work Core modifications.

### B2 — Real run and recovery

- [x] Run a real credential-gated brief: Claude proposal, Codex proposal,
  third synthesis. Record provider/model/tier actually served, attempts,
  input/output Artifact IDs and elapsed time. *(Evidence in the table below.)*
- [x] Inject stop/crash after first idea; restart and confirm the completed
  Artifact is reused, not generated again. `work replay` matches.
  *(Stop: `tests/brainstorm.test.ts` cancels from another process while
  `idea-b` runs; `work retry` reruns only `idea-b` and `synthesis`, and
  `proposal-a` stays the same Artifact. A killed host is the generic takeover
  already covered by the controller and agents tests; not repeated with real
  models.)*
- [x] Test cancellation, unavailable Codex account and changed Workflow file:
  route refusal explicit; old Work retains admitted spec and output IDs.
- [x] Re-run existing code and research smoke tests after adding account
  capability labels.

**Gate:** real three-attempt run and recovery pass; no accidental
same-provider substitution for the two independent perspectives.

### B3 — Brainstorm daily-driver evaluation

- [x] Try at least five varied briefs (architecture, tradeoffs, feature
  design, failure analysis and open-ended ideation). *(Five open questions
  about System itself; table below.)*
- [x] Compare a single-Worker baseline to the three-role workflow. Record
  operator usefulness, novelty, diversity, actual disagreements, latency,
  usage observations (or `unknown`) and manual interventions.
- [x] Capture operator feedback as evidence Artifacts where useful. A model
  self-scoring quality is not sufficient evidence of better decisions.
- [x] Only optimize role/tier selection or add optional critique on observed
  limitations. No team ballots or debate rounds without demonstrated need.
- [x] Compare, as the PR #2 review suggested, a stance per proposal
  (pragmatist, skeptic) with one shared prompt, and a Codex synthesis with a
  Claude one, using the config in
  [workflows/experiments](workflows/experiments/README.md). Score blind:
  the operator reads outputs without knowing the arm or the provider.
  Criteria, 1 to 5 each: usefulness for a decision, diversity of the
  proposals, critical thinking (wrong assumptions, blind spots),
  actionability, and whether the extra attempts were worth their time and
  tokens. *(Scored blind by a Claude Sonnet subagent at the operator's
  request, not by the operator; see [RES-0008](docs/research/RES-0008-brainstorm-evaluation.md).)*

**Gate:** a report of real tasks and measured trade-offs, not just a demo.

### B4 — Focused reliability (may run alongside B1–B3)

- [x] Keep and extend multi-CLI same-Work concurrency regression tests
  for the DSH SQLite `busy_timeout` patch. Test lost updates, duplicate
  dispatch and replay after forced termination. *(`tests/concurrency.test.ts`
  also creates the store from scratch every round; `tests/brainstorm.test.ts`
  kills the host mid-step and starts four `work run` at once.)*
- [x] Avoid new process daemon/lease framework unless a minimal reproducer
  demonstrates a correctness defect. Record fixes independently. *(Two
  fixes, each with a red test first: `c9fc13b` store creation, `ccc5dd5` the
  Work lock. No daemon, no OS lock.)*

**Gate:** no known Work state correctness regression from the Brainstorm
feature and retained tests for the SQLite patch.

## 3. System 1 reference: adopt only the small mechanisms

See the [pinned source audit](docs/research/RES-0006-brainstorm-workflow-feasibility.md#system-1-as-a-reference-what-to-copy-conceptually)
at `tsuuanmi/system_1@f199a277`:

- **Adopt:** independent proposals, distinct provider/account perspectives,
  immutable member results, explicit synthesis, candidate objections and
  decision provenance.
- **Adapt:** use role capability labels and current Artifact-ID bindings in
  external YAML; track which provider *actually* handled each role.
- **Defer:** sealed ballots, majority vote, debate rounds, persistent team
  conversations, a monolithic team engine, cross-member peer messaging.
- **Future Research reference:** two independent literature reviews,
  structured evidence table, independent critique and conclusion are useful
  once Website Worker/research evaluation is in scope. Do not port its coded
  research template directly.

## 3b. Next milestones (decided 2026-11-06)

These follow a grilling session on architecture and roadmap. The terms are
in [GLOSSARY.md](GLOSSARY.md), the host decision in
[ADR-0007](docs/decisions/ADR-0007-one-long-lived-host.md), and the
principles in [Charter philosophy](docs/requirements/purpose.md#philosophy)
items 8, 11 and 12.

### Growth and feedback budgets (Charter 11 and 12)

Growth is expected. The budgets make it visible and justified; they do not
forbid it. Record the measures at the end of every milestone. Growth above
budget is either justified in the milestone's row or paid for by removal.

| Measure | Baseline (PR #3, 2026-11-06) | Budget per milestone | R1 (end of H4, 2026-11-07) | H, before the pass | H, after the pass | O, before → after the pass | F, speed pass (2026-11-07) |
|---|---|---|---|---|---|---|---|
| Active core: `packages/work/src` + `packages/artifacts/src`, lines | 2,317 | +20% | 2,564 (+10.7%) | 2,913 (+25.7%) | 2,953 (+27.4%) | 3,006 (+29.7%) → 3,008 (+29.8%) | not measured |
| All package source, lines (`.ts` and `.mjs` under `packages/*/src`) | 4,081 | recorded | 5,299 (+29.8%) | 6,349 (+55.6%) | 6,374 (+56.2%) | 6,722 (+64.7%) → 6,735 (+65.0%) | not measured |
| Tests: `packages/*/tests`, `tests` and `test-support`, lines | not recorded | recorded | not recorded | 6,906 | 6,832 | 7,364 → 7,351 | not measured |
| Docs under `docs/`: lines (files) | 3,571 (37) | +20%, and no fact stated twice | 4,284 (43) (+20.0%) | 4,557 (44) (+27.6%) | 4,557 (44) (+27.6%) | 4,648 (44) (+30.2%) → 4,283 (44) (+19.9%) | not measured |
| Unit check, clean worktree | ~1 min | under 2 min | 39 s (install, build, typecheck, test) | not measured | not measured | not measured → 1 min 14 s (install 7 s, build and typecheck 29 s, test 37 s) | 1 min 14 s → 1 min 14 s, now four checks (install 9 s, build 23 s, typecheck 6 s, unit 38 s); install and build run once for all checks |
| All required checks (`.system/checks.yaml`) | ~7 min | under 10 min | about 5 min (docs 2 s, unit 39 s, smoke 4 min 14 s) | not measured | not measured | not measured → about 7 min 20 s (docs 2 s, unit 1 min 14 s, smoke 6 min 9 s, run beside another job) | 7 min 20 s → 2 min 28 s (docs 0.4 s, install 9 s, build 23 s, typecheck 6 s, unit 38 s, smoke 1 min 12 s); goals met: all checks under 3 min, smoke under 2 min. Measured with `env -i PATH LANG HOME=<fresh> CI=1 sh -c`, one shared HOME, from a clean copy. Smoke 5 runs in a row: 70/70 each, 73 to 76 s, no leftover processes |
| Flaky tests known | 0 | 0: a flaky test is fixed before features | 0 | 0 | 0 | 0 → 0 | not measured |
| Host `recordBytes` | n/a | recorded | 11,308 for three Works (Software Engineering, Research and a direct Task, fake Workers) | not measured | not measured | not measured | not measured |
| Tokens per Work | n/a | Fresh input, cache read, cache write, output, recorded per milestone; usage includes every turn of an attempt and, for Claude Code, subagents (`modelUsage`) and the CLI's own `costUsd`; USD figures are API-equivalent estimates, not what the subscription is billed | | not measured | not measured | not measured | not measured |

**Growth at R1.** The core grew 10.7% since the baseline, inside the +20%
budget. Before H4b-2 it was 2,852 lines (+23.1%, over the budget): the Host
(`host.ts`, `lane.ts`, `host-lock.ts`, 247 lines), receipts in `controller.ts`
and `record.ts`, and `conversation.ts` and `summary.ts` from before H. H4b-2
took out 288 lines (`FileControl`, its lock and mutex code, the write fence and
the row's own controller and admission path) and brought it back inside. All
source grew more (+29.8%, recorded only) because the Host (`packages/host`),
the thin CLI and the unit file are new. Docs are at +20.0%, 1 line under the
budget: the Host design, the runbook and the API reference are new, and H4b-2
rewrote the ownership document to a pointer instead of keeping both. The next
milestone has to pay for its docs by removal.

**Growth at R2 (H5).** The core is 2,721 lines (+17.4%, inside the +20%
budget; the scheduler, slots and recovery of held slots are about 170 lines of
`controller.ts`, the agent worker's queue went). All package source is 5,489
(+34.5%, recorded only). Docs are 4,333 lines in 43 files (+21.4%, 48 lines over
the budget): host.md's slot section and guarantee row and the runbook's
`maxConcurrentAttempts` section are the new facts and have no other home. The
end-of-milestone simplification pass has to take the 48 lines out.

**Growth at H (the simplification pass).** The pass changed no behaviour.
It left the core 2,953 lines (+27.4%, over the +20% budget; the Host's
receipts, slots and the conversation and summary modules are the growth, and
none of it was cut by this pass: moving the slots into `slots.ts` adds a module
header and a class wrapper, about 40 lines, which the removed duplicates
(three Artifact-ID patterns, a status enum, `host.ping`, the `Counts` flags,
the retry and decision option types written twice) only partly paid back). All
package source is 6,374 (+25 over the pass: the two programs of the app and the
slots module outweigh the deleted stubs). Tests fell by 74 lines (the
start/stop, stale-socket, second-Host and idempotency duplicates). Docs held
at 4,557 lines: the pass trimmed the package READMEs, which are not counted,
and did not take out the 48 lines over budget at R2. The next
milestone has to pay the core and the docs down by removal.

**Growth at O (the simplification pass).** The pass changed no behaviour.
- **Docs: budget met.** 4,648 lines fell to 4,283 (+19.9%, inside the +20%
  budget; the 4,285-line limit). Facts stated twice went to one home and the
  copies became links: the Host protocol and notices (the Host README), CLI
  following and exit codes (the runbook), the five defects (ADR-0007), the
  test matrices of RES-0002/3/4 (the MVP contract). Research and proposals
  were cut to what is still evidence (their front matter and IDs stay), and
  the stale "draft PR #2" and "no implementation yet" statements went. No
  document was retired: none was clearly superseded.
- **Core: budget not met.** 3,006 to 3,008 lines (+29.8%, over the +20%
  budget by about 230 lines). No removal was obvious: no exported name of
  `packages/work/src` or `packages/artifacts/src` is unused, and the `NewGoal`
  type (+2) and the exported `callerSchema` pay for removing the Host's own
  `GOAL_ID` and hand-written caller check in `packages/host`, outside the core.
  The overage is the Host's receipts, slots, scheduler, conversation and Goal
  folds (see H and R2), which are behaviour, not duplication. Paying it down
  takes a decision to drop a feature, not a cleanup; it stays an open debt.
- **Other findings of the Standards review:** one `inScope`, one `shortCode`,
  `positive` out of the builder, `forwarded` reused by the MCP tool handler,
  the `work.changed` rule kept in the Host README, `chatgpt.ts` split into the
  attempt and `chatgpt-login.ts` (cookie import and sign-in). The
  `{} as Services` cast in `mcp.ts` stays: the table is built by a closure
  over `Services`, so there is no typed way to get its shapes alone.
- **Tests:** 7,364 to 7,351 lines. The orchestrator `agent: false` test over
  the socket (kept in the Host's operations test) and the budget refusal and
  raise in `tests/goal.test.ts` (kept in `packages/work/tests/goal.test.ts`)
  were duplicates.

Every milestone ends with a **simplification pass**. A System Work (Sonnet)
proposes deletions and simplifications: dead code, unused abstractions,
duplicated tests, docs that restate others. The operator reviews it like any
PR. After each milestone, the Sonnet code review's Standards axis also checks
the code against Charter items 8, 11 and 12.

### P — Finish PR #3 and small decided items

- [x] Brainstorm default: put the pragmatist/skeptic stances in
  `workflows/brainstorm.yaml`. Keep the one-shared-prompt version in
  `workflows/experiments/` for comparison.
- [x] Quality evaluations use **Sonnet as the evaluator Worker**, blind
  (operator's choice). Record that the judge shares a model family with most
  writers. *(Applied in B3; the limit is stated in [RES-0008](docs/research/RES-0008-brainstorm-evaluation.md).)*
- [x] System publishes its own changes: from the next Work, System's
  Software Engineering Workflow pushes `system/<work>` and opens a draft PR
  on the real repository. It never merges. *(PRs #5 and #6, Works `f7170bdb` and `b2f35f9f`, published in parallel.)*
- [x] A System Work resolves the Dependabot alerts on `main` (9 high,
  2 moderate), verified by the required checks. *(Work `b2f35f9f`, PR #6.)*
- [x] `dev` integration branch ([ADR-0008](docs/decisions/ADR-0008-dev-integration-branch.md)):
  - publish against `dev`;
  - a merge step in `git.publish`, allowed only for an allowlist (`dev`), only
    when the checks passed on the exact head, and recorded as an effect with
    reconciliation;
  - only the operator merges `dev` into `main`.

### H — One long-lived Host (ADR-0007 as amended, PROP-0004 accepted)

Architecture: [Host](docs/architecture/host.md). Components, verdicts and
deferral triggers: [PROP-0004](docs/proposals/PROP-0004-host-design.md).
Every step is a System Work (Sonnet) merged into `dev`, with its tests
written first.

- [x] H1. Controller seam and the deterministic concurrency fixture (barriers,
  seeded delays), with one regression per defect of 2026-11-06. Evidence:
  `packages/work/tests/seam.test.ts` (characterization, barrier cancel,
  seeds 1 to 50) passes before and after the dispatch/execute/observe split.
- [x] H2. Host lock (abstract socket), commit lane, recovery (interrupted
  attempts, uncertain slots, no auto-resume), `commandId` receipts. Evidence:
  `packages/work/tests/host-lock.test.ts` and `host.test.ts` (lock incl. a
  SIGKILLed child, lane, receipts, recovery); the slot itself is H5, so
  `host.slots.uncertain()` only lists the attempts that will keep one.
- [x] H3. API on a temporary socket (`packages/host`: transport, then the operation table). Evidence: `packages/host/tests/` (`transport`, `operations`, `api`). Includes:
  - the operation table with its `agent` flag and the exclusion test;
  - the version handshake and the caller;
  - `work.events` with a cursor;
  - `host.status` with the memory report.
- [x] H4. Cutover. Includes:
  - the thin CLI (reads through the Host; Ctrl-C detaches);
  - `system.service` (plain unit, captured PATH, lingering);
  - removing the old mode;
  - the CLI picks a Node that DSH accepts (>= 24.9) by itself, or names the
    fix (an operator ran `bin/system` under Node 22 on 2026-11-06);
  - operator-facing errors print one line, with no stack trace (a mistyped
    approval confirmation printed one on 2026-11-06). The confirmation prompt
    is on its own line and says that nothing is decided unless the typed
    text matches, so pasted commands are not taken as the answer;
  - the operations runbook with its cutover and rollback checklist (`docs/operations/`);
  - the API reference.
  **Release R1.**
  H4a: `system host`, unit, Node selection.
  H4b-1: the thin CLI (`packages/app`: `remote.ts`, `client.ts`, `io.ts`), the
  old in-process mode unused but not yet deleted. Evidence:
  `tests/cli-host.test.ts` (no Host, not answering, Ctrl-C detach,
  `--cancel-on-interrupt`, timeout retry with one `commandId`, one-line errors,
  doctor); every test of `tests/` runs through a Host started by
  `test-support/cli.ts`. Found on the way: a Host restart after an effect was
  read as absent recorded an `attempt-lost` event with no attempt (the stored
  record then failed its schema at the next start); fixed in
  `WorkController.recover`, test `an effect found absent on start is published
  only by an explicit run`.
  H4b-2: the old mode removed: the per-command path in `packages/app`,
  `FileControl` with its per-Work lock, takeover mutex and write fence, the
  controller's `hold`, `noteWrite`, `lastWrite` and `HostIdentity`, the H4a
  transition guard (`hostHeld`), the row's own controller and admission
  (`WorkService.controller`, `admitFile`, `admitTask`), `snapshotWorkTable` and
  `LocalControl`, with `control.test.ts` and the five fence tests of
  `controller.test.ts`. The Host ignores leftover `control/*.lock`, `*.takeover`
  and `*.written` files and deletes none: test `the Host ignores the control
  files of the old mode and leaves them where they are; it makes no control
  directory` (`tests/host-process.test.ts`). The runbook has the cutover
  checklist and the rollback. Each guarantee the deleted tests held has its
  test against the Host in host.md's table; the added one is `no copy of the
  store outlives its Host: a second Host is refused while one runs a Work, and
  the next one starts from what the first wrote` (`host.test.ts`).
- [x] H5. Parallel steps and Works with per-Account slots. Barrier tests for
  shared-Account contention and for restarts. **Release R2.** Evidence:
  `packages/work/tests/slots.test.ts` (the tests are named in the `Slots hold
  (R2)` row of host.md's guarantees table), `tests/brainstorm.test.ts`, and the
  agent side in `packages/agents/tests/agent.test.ts`. Found on the way: the
  in-memory Work table's `update` was not atomic, which two attempts of one Work
  reporting together exposed; as in DSH it now is (`test-support/memory.ts`).
  The agent worker's own per-account queue is gone (the Host's slots replace
  it); each attempt's CLI writes a pid file first, which is what lets a later
  Host confirm a lost attempt's process gone.
- [x] Self-restart on new code (D): the Host notices new code on disk, stops dispatching, lets running attempts finish and exits 75; the unit and `system host --supervise` restart it, the thin client retries the swap, and Works held at the gate continue (host.md "Upgrading on new code (D)"). Evidence: `packages/host/tests/upgrade.test.ts`
  ("on new code a supervised Host starts nothing new, finishes its attempt, exits 75, and the next Host
  serves the new version and runs what was queued", "a client built from the new code upgrades an idle
  Host at once"), `packages/work/tests/upgrade.test.ts` (drain, held, resume),
  `packages/app/tests/service.test.ts` ("the supervisor runs the Host again after exit 75") and
  `packages/app/tests/remote.test.ts` (a follow reconnects across the swap).
- [x] Gate R1 (checked 2026-11-07, each item against a test that exists):
  - [x] every existing smoke behaviour passes through the Host: every file of
    `tests/` drives `bin/system` through `systemCli` (`test-support/cli.ts`),
    which starts a Host; `with no Host, a command prints one line and exits 1`
    (`tests/cli-host.test.ts`) shows that no command runs Work without one.
    `corepack pnpm smoke` passes (63 passed; 2 skipped, the credential-gated
    `real-agents.test.ts`, which also go through the Host when enabled);
  - [x] a Host killed mid-step recovers on restart, conservatively, and replay
    matches: `a Host killed mid-attempt: the new Host marks the attempt lost,
    does not run the Work, and an explicit run continues it` (`host.test.ts`);
    through the process, `the pinned spec survives a Workflow file edit and a
    killed host; done steps never re-run` (`tests/work.test.ts`: the Work stays
    `running` after the restart until `work run`) and `after the Host is killed
    mid-step, four runs asked for at once dispatch the lost step once, losing no
    event` (`tests/brainstorm.test.ts`, which ends with `work replay` exit 0);
  - [x] an agent caller cannot approve: `an agent connection is refused every
    method flagged agent: false, and only those` and `approval.decide needs a
    human even when its row is opened to agents`
    (`packages/host/tests/operations.test.ts`); `marking the pull request ready
    waits for a human at a terminal; an agent or a pipe cannot approve`
    (`tests/publish.test.ts`);
  - [x] the guarantees table in host.md has a passing test per row, but the
    last: `Slots hold (R2)` belongs to H5 and release R2, not R1. The rows the
    deleted tests held are now `One Host per home` and `No change from a stale
    copy`;
  - [x] growth measures are recorded: the budget table above. The core grew
    10.7% since the baseline (within +20%), and docs 20.0% (1 line under).
- [x] Attempt time limit (found 2026-11-07): an attempt that hung on a test
  ran for 2 hours with nothing to stop it (Work `38ff51c3`). Done:
  `attemptTimeoutMinutes` in the `agents` row config (per Account, default 60;
  not in the Workflow, ADR-0006); past it the attempt is stopped like a cancel,
  partial output kept, and fails with the limit as its reason.
- [x] Gate R2 (checked 2026-11-07, each item against a test that exists):
  - [x] Brainstorm's two proposals overlap in time: `Brainstorm: idea-a
    (Claude) and idea-b (Codex) are in execute at once` (both held at fixture
    barriers at once) and, through `bin/system` on the real profile with the fake
    CLI, `the two proposals overlap in time: both are dispatched before either is
    observed, and the synthesis waits for both` (`tests/brainstorm.test.ts`);
  - [x] two Works on one Account never run two attempts at once: `two Works on
    one Account never run two attempts at once with a limit of 1`, and with a
    limit of 2 `two Works on one Account run two attempts at once with a limit of
    2` (`slots.test.ts`); `seed 1` to `seed 50` (three concurrent Brainstorms,
    never above the limit);
  - [x] restarts: `a Host killed with two attempts in flight: both are lost,
    their slots are held until settled, and nothing is dispatched by itself`,
    `a lost attempt whose Worker cannot confirm it gone keeps its slot` and `a
    lost attempt confirmed gone at the next start frees its slot at once; one
    confirmed later is settled when its Work waits for the slot`;
  - [x] replay: `seed 1` to `seed 50` replay exactly with no event lost or
    repeated (`assertConsistent`), and `a cancel while two attempts run records
    both, then one terminal event`.
- [x] End of milestone: the two-axis Sonnet review (Charter 8, 11 and 12 on
  the Standards axis), the simplification pass, and the growth record (the
  growth table above, column "H, after the pass").
  *(Spec review 2026-11-07, three defects fixed: `git.publish` now matches a
  pull request by head and base and fails on one aimed elsewhere; the version
  handshake is a hash of the built code, not the package version; ADR-0008
  "required checks" clarified as System's own verifier.)*

### O — Orchestrator and Goal ([ADR-0009](docs/decisions/ADR-0009-goals-and-orchestrators.md))

Steps: O1 `goal@1`, admission with a Goal and the budget fold; O2 `system mcp`
and orchestrator scope; O3 completion notices.

- [x] **Goal** (O1): the operator's aim, scope and budget (attempts and observed
  tokens; once spent, new Works for that Goal are refused and running Works
  finish; only the operator raises it). Every Work an Orchestrator creates
  names its Goal. A Goal carries the Charter principles as context for its
  Works.
- [x] **`system mcp`** (moved from H, ADR-0007 amendment): the agent client
  of the Host's socket, offering only operations flagged `agent`.
- [x] **Orchestrator**: an agent connected through MCP, a caller scoped to
  one Goal. It may submit, run, cancel and retry, and read Artifacts. It may
  never approve, mark a PR ready, accept an inconclusive verdict or merge.
- [x] **Completion notices** (operator, 2026-11-06): instead of polling, the
  Host tells a connected Orchestrator when one of its Works changes state,
  for example finishes, is held, or needs approval. Use MCP's own
  server-to-client notifications (resource subscriptions), not a new
  protocol. A notice is only a wake-up: the event log stays the source of
  truth, and a client that missed notices reads on from its last
  `work.events` cursor, so nothing is lost while it was away.
- [x] Spec review fixes (F2): a Goal's Work needs an input Task for the Goal's
  context; Goal tokens count cache writes; admitted, unfinished Works count as
  attempts; only the newest Goal can be superseded; chatgpt-web records the
  model label and `SELECTORS.version`; `system mcp` announces a changed
  resource list after it reconnects; the code version covers
  `cordis.patch.yml`.
- [x] End of milestone: review, simplification pass, growth record (the
  growth table, column "O, before → after the pass").
- [ ] Later, not in O: an Orchestrator that System spawns on a schedule.

### W — ChatGPT Website Worker (PROP-0005, after H release R1)

- [ ] Design: [PROP-0005](docs/proposals/PROP-0005-chatgpt-website-worker.md)
  (accepted 2026-11-07). The operator accepted the Terms-of-Use risk for their own account
  (2026-11-06).
- [x] Re-run the three research Works (tokens, existing drivers, risks) after
  the verifier fix V1. *(2026-11-07, verifier v2, ratio 0.5: tokens `851ec77c`
  5/8 quotes confirmed, drivers `12143a0f` 5/7, risks `8aaea4d6` 8/9 (one
  page 403); all accepted, the unconfirmed listed in each verdict; 82-108 s
  and about $0.22-0.29 (estimate) each.)*
- [x] Build after R1: the `chatgpt-web` Runtime on Playwright, a dedicated
  signed-in profile, one prompt per attempt, completion detection, answer
  and cited links as outputs, each exchange recorded as a `conversation@1`,
  and deterministic tests on a local fake page. *(2026-11-07, W1: PROP-0005
  accepted; `system workers login`, cookie import; not enabled in the bundle;
  the real-site run, `SYSTEM_REAL_WEB=1`, is still to do.)*

- [x] W2. Remote sign-in over SSH, as System 1 does (operator, 2026-11-07).
  *(2026-11-07: pure Node, no VNC and no new package.)*
  - `system workers login <ref> --remote` opens the account's profile headed
    on its own Xvfb and serves a viewer on 127.0.0.1 behind a random 32-byte
    token: a CDP screencast over Server-Sent Events, input sent back by POST,
    **Save** and **Cancel**, a 15-minute TTL. The CLI prints the
    `ssh -L <port>:127.0.0.1:<port> <user>@<host>` line and the URL.
  - No CDP port is exposed (Playwright's pipe). A human clears a challenge in
    the viewer; System never does.
  - **System never runs the browser headless** (operator, 2026-11-07): attempts
    and login use a real headed Chrome on the operator's `DISPLAY` or a private
    Xvfb it stops with the attempt; the `headless` option is gone; without
    Xvfb the account is `unavailable`.
  - Reference: System 1, `docs/design/browser-runtime.md` ("remote" flow).
  - Cookie import (`--cookies`) stays as the quick path.
  - Verified here by the unit and Host tests; the browser tests are skipped
    where a headed Chrome does not start on an Xvfb (the Chrome 95 on this
    machine crashes on start when headed), so a headed run is still to do on a
    machine where it starts.
  - Parallel-merge interaction fixed (L1) *(2026-11-07)*. W2, A (faster
    checks, tests in parallel) and D each passed alone; their merge turned
    `dev` red. Cause, two races in W2's code, both made likely by the parallel
    runs: (1) `agentWorker` closed the browser from the abort and again at the
    end, and the second `close()` returned before Chrome had exited, so the
    attempt ended with Chrome and its profile still in use (the test then read
    a dead or half-gone process, and the file's cleanup hit a profile still
    being written); (2) `startXvfb` took the first X socket it saw, which
    could be another Xvfb's when two started from the same display number, so
    two attempts shared a display and one Xvfb exited under its browser.
    Fixed in the code (`chatgpt.ts` shares one close; `display.ts` takes a
    display only when its lock names its own Xvfb); a test starts four Xvfbs
    from the same number. Not the tests' fault, and not Chrome's zygote.
- [x] W5. Port System 1's browser runtime and make `dev` green again
  (operator, 2026-11-07). *(Real-site result pending: the operator runs it.)*
  - Evidence from the real site: a signed-in account reported as challenged (a
    false positive), and Turnstile looping on a second account. Cause by
    comparison: Playwright's default launch advertised automation and used
    `--no-sandbox`, `--password-store=basic`, `--use-mock-keychain` on
    Chromium 136. System 1 launches a genuine Chrome and works.
  - `playwright-core` is replaced by `patchright-core` 1.63.0 (System 1's pin),
    launched with System 1's `CHROME_ARGS` and `ignoreDefaultArgs`; Chrome is
    chosen as System 1 does (`chrome.ts`, `chrome.lock.json`: configured path,
    `CHROME_PATH`, a recent system Chrome, else Chrome for Testing 155.0.8059.39,
    installed on first use; it runs on this Ubuntu 20.04, glibc 2.31). Page
    state, Chat mode and the Work refusal are System 1's logic in a selector
    table and scripts, `SELECTORS.version` 2. PROP-0005 records that System 1
    used VNC (real X input) and that CDP-dispatched input is the difference
    left if a challenge still loops.
  - `dev` was red: Chrome aborts with `Socket path too long` when `TMPDIR` is
    deeper than about 55 bytes, and the verifier's throwaway HOME is. The
    headed tests were **skipped** there (the probe saw Chrome die), so the
    required checks passed on L1 without running them: a coverage gap. Fixed
    in the code (Chrome gets a short `TMPDIR`) and in the checks: a headed
    Chrome that cannot start now fails these tests (`SYSTEM_SKIP_HEADED=1`
    opts out); the tests use the Chrome the Runtime chooses, installed once
    into a cache shared by the test processes.
  - `bin/system` supervised only when `host` was `args[0]`; it now finds `host`
    after DSH's options (`--patch X host --supervise`).
  - The one change to `pnpm-lock.yaml` is the dependency swap itself
    (`playwright-core` out; `patchright-core` and `@puppeteer/browsers` in),
    which `--frozen-lockfile` needs.
- [x] W7. Port System 1's ChatGPT web driver, its UI map and its UI engine
  (operator, 2026-11-07, said twice). *(Real-site result pending: the
  operator's agent runs `SYSTEM_REAL_WEB=1 node --test tests/real-web.test.ts`
  after the merge.)*
  - Why: W5 and W6 re-implemented parts of System 1's driver as a small
    selector table and met problems System 1 had already fixed (a stale send
    selector, `?temporary-chat=true` navigation aborted, a false challenge).
    System 1 works against chatgpt.com, so its logic is copied, with its
    comments, and not written again.
  - New package `packages/web-driver` ([README](packages/web-driver/README.md)):
    System 1's `ui-ops` (engine, map, locate, outline, network, answers, site,
    heal), its `provider-chatgpt-web` driver, UI map and fake site, and only the
    parts of `provider-core` and `libs` they import. Each file names its source
    path and System 1's commit (`f199a277`); the README lists every difference
    and why (no Cordis glue; reports go to the attempt's log, heal off; the
    map schema is checked with `ajv` without format checks; parameter
    properties as fields; a fixture without `otpauth`). Dependencies: `yaml`
    2.9.1 (System 1's pin) and `ajv` 8.20.0 (already in the lockfile through DSH).
  - `packages/agents/src/chatgpt.ts` uses the driver: `ask` opens a temporary
    chat in Chat mode (the operator's default), checks the sign-in, sends and
    waits; the answer's Markdown comes from the page's Copy. Deleted: the
    `SELECTORS` table, the page-state and send/wait scripts, `classify`,
    `settle` and `pageState`, the stage `send` and its timeout, and the tests
    the ported ones cover. Kept: never headless, the private Xvfb, the
    persistent session-bound profile, the `conversation@1` record, the output
    blocks, cancel and the attempt time limit. The remote login's Save check is
    the driver's `checkAuth`.
  - Test evidence here: the ported engine tests (9), the driver tests against
    the ported fake site (3), the Runtime's attempt tests against it (24), the
    remote-login tests (11) and the booted `chatgpt-web` smoke test (4) pass on
    a headed Chrome on Xvfb.
  - **Growth recorded** (lines of `.ts` and `.mjs`; the baseline is `dev` at
    `a63457f`): the active core (`packages/work/src` + `packages/artifacts/src`)
    is 3,076 before and after, **unchanged**; all package source 7,705 → 10,469
    (+2,764: `packages/web-driver/src` 3,006, `packages/agents/src` 1,935 →
    1,693); tests (`packages/*/tests`, `tests`, `test-support`) 8,603 → 9,421
    (+818: System 1's fake site is 672 of them). The growth is the ported
    code, which is the decision; it is outside the core's budget, and the
    next milestone should check that none of System 1's unused procedures
    (Deep research, deletion, credential sign-in, heal) is kept without a use.
  - `pnpm-lock.yaml` is not part of this change (instructions): the new
    workspace package needs its importer entry (`yaml`, `ajv`, `patchright-core`
    under `packages/web-driver`, `@system/web-driver` under `packages/agents`),
    which `--frozen-lockfile` wants; regenerate it with
    `corepack pnpm install --no-frozen-lockfile` when merging.
- [x] W8. Read a ChatGPT answer's output blocks with their fences (follow-up
  to W7; operator's real-site run, 2026-11-07).
  - Evidence: the whole turn worked through `packages/web-driver`, and ChatGPT
    wrote a `report` and a `sources` block, but the attempt failed with "wrote
    no output block": the answer recorded was the rendered text (header and
    content, no fences). No "copy refused" note was logged because System 1's
    `markdownOf` returns the rendered text silently when Copy's code blocks do
    not pair with the page's `pre code`.
  - Fix, from System 1's own `answer.code` map entry: when the answer text has
    no fence, `withFencedBlocks` fences each `pre code` block again with its
    header as the info string (README, "Fences without Copy").
  - Red test first: driver tests where the fake page's Copy gives text without
    fences, and where it gives nothing, must still fill `report` and `sources`.
- [ ] W3. Two ChatGPT accounts for Brainstorm (operator, 2026-11-07). With
  temporary chats, two signed-in accounts (`chatgpt-web/default`,
  `chatgpt-web/second`) can each give an independent proposal. A Brainstorm
  variant in `workflows/experiments/` routes `idea-a` and `idea-b` to the two
  ChatGPT accounts through role capabilities. Compare it with the Claude/Codex
  default on real briefs, judged by the Sonnet evaluator (B3's method).

### OC — A replaceable Orchestrator, and the checks as a Sub-workflow ([PROP-0006](docs/proposals/PROP-0006-replaceable-orchestrator-and-code-checks.md))

Decided by the operator on 2026-11-07, built from `dev` as one pull request
by the Development session, apart from the Website Worker programme on
`web-workers` (whose PLAN records milestone WW). Each step with a test that
failed first; the acceptance list is in PROP-0006.

- [x] OC1. `decision@1`, `system decision add|list` (`decision.add` agent,
  Goal-scoped).
- [x] OC2. Live attempt progress in the Host (`work show`), and the stall
  notice after `stallMinutes`.
- [x] OC3. `system goal brief` / `goal.brief`, generated from records.
- [x] OC4. Sub-workflows in the Workflow compiler (ADR-0002 amendment).
- [x] OC5. `workflows/code-checks.yaml`, used by `software-engineering.yaml`,
  and `work retry --step` on a verify step ("verify again").
- [x] Growth recorded (core lines, docs, check time) and a simplification
  pass, as for every milestone.

**Growth at OC** (measured from `orchestrator-continuity` at `a4862d7`, the
same line counts before and after; all checks with `env -i PATH LANG
HOME=<fresh> CI=1`, the machine at a load average of about 270):

| Measure | Before OC | OC, before → after the pass |
|---|---|---|
| Active core (`packages/work/src`, `packages/artifacts/src`), lines | 3,076 | 3,403 → 3,403 (+327, +10.6%; +46.9% over the PR #3 baseline) |
| All package source, lines | 10,505 | 11,069 → 11,062 |
| Tests, lines | 9,162 | 9,540 → 9,540 |
| Docs under `docs/`, lines (files) | 4,786 (46) | 4,821 (46) → 4,821 (46) (+35) |
| Required checks | not measured | docs 0.4 s, install 12 s, build 33 s, typecheck 10 s, unit 3 min 14 s (463 pass, 1 fail, see below), smoke 1 min 32 s (73 pass): 5 min 44 s |

- **Core: over budget, justified.** The +327 lines are behaviour asked for
  by PROP-0006, none of it duplication: Sub-workflows in the compiler (about
  110 lines of `workflow.ts`), live progress and the stall timer (`live.ts`,
  88), decisions in the Goal store with their kind and `Artifacts.ofKind`
  (about 80), and the `work` row's config, the verify-step retry and the
  controller's dotted step IDs (about 50). The brief lives in `packages/host`,
  outside the core. The operator then measured the budget from here
  ([ADR-0010](docs/decisions/ADR-0010-core-budget-rebaselined.md)): 3,403
  lines, +10% per milestone, paid back within the milestone.
- **Docs: +35 lines**, the new facts only (the `uses` step, verify again,
  `live` and stalls, replacing the Orchestrator); the package READMEs carry
  the rest. Docs were over the 4,285-line limit before OC (the WW programme's
  documents); OC does not pay that down.
- **Check time: over the 3-minute goal on this machine.** The unit check took
  3 min 14 s against 38 s at F, with the machine at a load average of about
  270 (other users' sessions). The same commands measured 2 min 28 s at F.
  It is measured again on a quiet machine once OC is on `dev`, and the row
  above corrected; a unit check still over 1 minute is then a defect of the
  next milestone (operator, 2026-11-07). The merge does not wait for it.
  **Measured again (2026-11-08).** The load never fell below about 400 that
  night, so F (`1adb430`) and `dev` (`6d92315`) were measured the same way
  at the same load, with CPU time beside wall time (`/usr/bin/time`, `env -i`,
  fresh HOME). Unit: F 40 s (34 CPU-s), `dev` 178 s (122 CPU-s); `dev`
  without the three headed-browser test files of WW (`chatgpt`,
  `remote-login`, `driver`) 20 s (31 CPU-s), those three alone 181 s
  (99 CPU-s). Smoke: F 75 s, `dev` 85 s (354 and 386 CPU-s); install, build
  and typecheck 56 s and 55 s. So the overrun is WW's browser tests, not
  OC or CQ, and it ends when `web-workers` moves them to `test:web` (the
  rule above); no defect is carried into the next milestone.
- **One flaky test, outside OC:** `packages/agents/tests/chatgpt.test.ts`
  "a page that is neither signed in nor signed out" failed once in the full
  run (Chrome did not start within its 1.5 s launch timeout under load) and
  passed 24/24 alone. It belongs to the web Runtime (WW) and is a defect to
  fix there (Charter 12).
- **Default tests have no Website Worker and no browser** (operator,
  2026-11-07): the unit and smoke checks run without headed Chrome or Xvfb;
  those tests run apart (`test:web`, introduced on `web-workers`).
- **Review fixes before the merge** (operator, 2026-11-07): the human's
  approval type is `Approval`, apart from `decision@1`; only a human verifies
  a step again (an agent would otherwise keep the luckiest run, so it records
  a decision and tells the operator); `code.required-checks` pins its checks
  only from a task's base commit, never from the change itself.
- **Simplification pass:** the orchestrator scopes of the Goal rows became
  two helpers (`ownGoal`, `inChain`); `goal.brief` uses `inScope`. No
  feature was dropped.

### CQ — Worker policy, faster and clearer checks, and a merge queue ([PROP-0007](docs/proposals/PROP-0007-worker-policy-checks-and-merge-queue.md))

Decided by the operator on 2026-11-07, built from `dev` after OC (PR #39) by
the Development session; moved out of milestone WW, which keeps only what is
Website-Worker-specific. Acceptance in PROP-0007.

- [x] CQ1. Worker policy (no background tasks or monitors for `code-write`
  Accounts) and the per-attempt budget.
- [x] CQ2. Checks run on the repository's Node; one-line failure reasons.
- [x] CQ3. Checks selected by `paths`; the verdict lists run and skipped.
- [x] CQ4. The merge queue for `mergeInto` branches (push with a lease, not
  GitHub's merge endpoint: operator, 2026-11-07; ADR-0008 amendment).
- [x] CQ5. The Host resolves Sub-workflows for `work.submit`; the flaky
  host-process test.
- [x] Growth recorded and a simplification pass.

**Growth at CQ** (from `dev` at `4af8bf0`; budget per
[ADR-0010](docs/decisions/ADR-0010-core-budget-rebaselined.md): +10%):

| Measure | Before CQ | After CQ |
|---|---|---|
| Active core, lines | 3,405 | 3,420 (+15, +0.4%: the effect intent's `required` checks) |
| All package source, lines | 11,068 | 11,366 (+298: the merge queue, the checks' Node and reasons, the attempt budget) |
| Tests, lines | 9,549 | 9,712 |
| Docs under `docs/`, lines (files) | 4,872 (47) | 4,985 (48), PROP-0007 included |
| Required checks | | docs 0.4 s, install 12 s, build 21 s, typecheck 7 s, unit 2 min 52 s (473 pass; 1 fail, the chatgpt-web launch test fixed on `web-workers`), smoke 1 min 11 s (74 pass): 4 min 45 s at a load average of about 210; a docs-only change now runs docs alone |

- **Simplification pass:** GitHub's merge endpoint went, and with it the
  merged-pull lookups and the pull request fields only they read; the fake
  GitHub servers lost their merge endpoint and `--kill-host-on-merge`.
- **A lost stop signal, found by CQ5:** the Host replaced the launcher's
  signal handlers by removing them first; a SIGTERM sent in between (right
  after `listening on`) was dropped and the Host never stopped. That was the
  flaky SIGTERM test. Fixed (4 of 9 failures before, 16 of 16 passes after,
  in parallel).
- **Not tested end to end:** the merge queue against github.com (a branch
  protection that requires pull requests refuses its push), and the attempt
  budget against a real Claude Code attempt.

### Core debt ([ADR-0010](docs/decisions/ADR-0010-core-budget-rebaselined.md))

After OC and WW are on `dev`, so it does not compete with them for code:

- [x] A Sonnet agent read `packages/work/src` and `packages/artifacts/src`
  at `dev` 6d92315 (3,420 lines) and proposed cuts; the Development session
  checked them (2026-11-08). Without dropping a feature: about 35 lines
  (`Host.interrupted`, used only by tests; the `Host` pass-throughs to the
  controller; the `executor` and `usage` shapes written twice), about 75 with
  header comments that restate ADRs. Every class method has a caller, and the
  defaults kept for records written before M4 to M6 must stay (a stored record
  would fail to open). Feature drops, approximate core lines each:
  Goals, decisions and the Orchestrator caller (288); live progress and
  stall notices (125; the attempt budget reads it); Sub-workflows (90; only
  `software-engineering.yaml` uses one); the conversation intake (43; the
  `conversation@1` kind stays, the ChatGPT Worker stores one per exchange).
  Not cut: external effects, receipts, drain and hold (AGENTS.md invariants),
  and settling lost attempts (`gone`, which the agent Worker implements).
- [ ] The operator decides each: drop the feature, or keep it.
- [ ] Each cut is its own pull request, with tests showing the rest behaves
  the same.
- [ ] The core's line count is recorded after each.

## 4. After Brainstorm — future, not current gates

- [x] Website Worker for interactive/browser-assisted Research **only when**
  a real source workflow requires it; keep the same WorkerPort/Artifact IDs.
  *Layer 1 (conversation-to-Artifact ingestion) is being built on PR #3 per
  [PROP-0003](docs/proposals/PROP-0003-conversation-ingestion.md): `system
  conversation add|show`, `task new --context`. Dogfood: the operator's
  ChatGPT review of PR #2 stored as a conversation (`selection: excerpts`)
  and given as context to Brainstorm Work `work:cc9a38a7…` (roles, standard
  tier, 3 attempts, 176 s); the synthesis treated it as operator-supplied
  data and named its uncheckable claims.*
  *Observed need (2026-11-06): the System 1 audit and this roadmap update
  (PR #1 `2dcfe48`) were produced by the operator in ChatGPT on the web and
  carried into the repository by hand, with no Artifact recording what was
  asked and what came back. The B2 Brainstorm Work `work:cad623e9…` is a
  first design comparison for this Worker (summary `sha256:c4eb1e20…`).*
  *Decided: layer 1 shipped (PROP-0003); the interactive Worker is milestone W
  ([PROP-0005](docs/proposals/PROP-0005-chatgpt-website-worker.md)).*
- [x] Split the Website Worker into three layers (PR #2 review), each its
  own step: (1) **conversation-to-Artifact ingestion**: the prompt, the
  response and metadata from a web session become Artifacts with honest
  provenance, with no browser automation (can be tried early); (2) **source
  fetching and snapshots** with content identity (future Research); (3) the
  **interactive Website Worker** with a signed-in session and recovery
  (after B3/B4). System 1 is a reference for session lifecycle only; no
  persistent team sessions in Work Core. *(Layer 1: PROP-0003, shipped.
  Layer 3: milestone W. Layer 2 waits for its trigger, below.)*
- [ ] Research quality capabilities (source snapshots, citation consistency,
  claim-to-evidence checking) as separately selected verifiers. The **current
  Research flow continues to work**, without mandatory stronger verification.
  *Trigger: a Research Work whose accepted report the operator finds wrong
  because a source changed or a claim was not supported. Until then, V1's
  ratio policy (unconfirmed quotes are listed, not hidden) is the bar the
  operator chose (2026-11-06).*
- [ ] Optional Skill, LSP, web-fetch or third Worker adapter only if a
  measured use case requires it and the pinned DSH plugin can satisfy
  the System contract without duplicating the model loop. *(The third
  Runtime, `chatgpt-web`, is milestone W. Others: trigger is a Work that fails
  for want of one.)*
- [x] Parallel independent steps, additional provider accounts and adaptive
  routing only if B3 results justify their overhead. *(Parallel steps are
  H5 (ADR-0007). More Accounts: the profile already takes several (ADR-0005);
  adaptive routing waits for a measured need, such as quota exhaustion.)*

## 5. Progress and handoff

| Stage | Status | Commit / PR | Test/evidence |
|---|---|---|---|
| B0 MVP-0 baseline | done | `41d2e0a` (merge of PR #1) | See the B0 checklist: one concurrency failure at baseline, fixed in B4. |
| B1 Brainstorm YAML | done | `b74f97e` | No Work Core change. `corepack pnpm check`: unit 115/115, smoke 40/42 (2 credential-gated skipped); with `SYSTEM_REAL_AGENTS=1` both pass (a real Claude change; a cancelled Claude attempt taken over by Codex, 132 s). Fake run: three attempts (Claude, Codex, Claude), `idea-a` and `idea-b` inputs are the brief only, `synthesis` inputs the two exact proposal IDs, provenance per Artifact, no verifier, `work replay` matches; refused at submit without Codex; a pinned spec survives an edited file. |
| B2 Real three Worker attempts | done (economy tier) | Work `work:cad623e9-4a65-45ab-bb2d-eb473044811d` | Brief: design a Website Worker. `idea-a` Claude Code 2.1.311 `claude-haiku-5-5` (31 s, 42,940 in / 4,881 out) → proposal `sha256:e0e6c883…`; `idea-b` Codex 0.166.0 `gpt-6-luna` requested (the served model is not reported by Codex; 43 s, 30,148 / 1,783) → `sha256:d2c72a35…`; `synthesis` Claude `claude-haiku-5-5` (53 s, 99,560 / 9,616) → `sha256:c4eb1e20…`, inputs exactly those two IDs. 3 attempts, 0 operator touches, 127 s, `work replay` matches. The synthesis named six real disagreements (session expiry, automatic publish versus operator confirmation, screenshots, partial transcripts, CDP exposure, account check) with the evidence that would settle each. |
| B3 Daily driver evaluation | done (model judge) | `6dc0244` (arms) | 15 Works, all succeeded, 5 hosts in parallel, 35 attempts, 0 operator touches. Tier standard everywhere: Claude `claude-sonnet-5-5`, Codex `gpt-6.1-sol` requested. Arms per brief: S = one Claude attempt (`brainstorm-single`), B = `brainstorm.yaml`, R = `brainstorm-roles.yaml` (Codex synthesis on *failure* and *openended*). Mean per Work: S 37 s, 40k input / 3.4k output tokens; B 157 s, 164k / 10.0k; R 162 s, 152k / 8.9k (about 4× S). Proposal similarity (word cosine of A and B, lower = more different): B 0.52 / 0.59 / 0.57 / 0.48 / 0.36, R 0.53 / 0.50 / 0.44 / 0.43 / 0.39 (mean 0.50 vs 0.46): the stances add a little diversity in 3 of 5 briefs. Blind scores (Sonnet subagent, operator's choice; key kept apart), mean of U/D/C/A: S 3.60, B 4.65, R 4.45. S was never best; R was best on the three briefs with a Claude synthesis, and B beat R where Codex synthesised. Caveats: a model judge from the same family as most writers, five briefs and one run each. Report and recommendation: [RES-0008](docs/research/RES-0008-brainstorm-evaluation.md). |
| B4 Concurrency regression | done | `c9fc13b`, `ccc5dd5`, stale-snapshot fence | Baseline failure reproduced: commands that all find the store missing raced in DSH storage-sqlite (WAL switch "database is locked" despite `busy_timeout`; `UNIQUE constraint failed: units.name`). Patch extended; new test red 9/12 rounds, green 3/3; 300 parallel commands on fresh stores, 0 failures. Review finding (PR #2, P1): `FileControl` created the lock before writing its pid, so a host could read it empty, take it as stale and also acquire the Work. Red test with an empty lock; fixed by linking a complete file (a recent pid-less lock counts as held). Same-Work test: a host SIGKILLed during `idea-b`, then four `work run` at once: exactly one runs, `idea-b` is dispatched once more, every event `seq` kept in order, replay matches; 3/3 runs. A free-lock race between processes did not reproduce the window (microseconds) and stays as a regression test. `corepack pnpm check`: unit 118/118, smoke 41/43 (2 credential-gated skipped). Then (PR #1 review RES-0007, hypotheses confirmed): DSH `storage-domain` serves each host an in-memory snapshot taken at start, so a host that took the lock after another wrote acted on an older record; `retry` also checked before locking and released between reopening and running. Red controller tests (one snapshot per host) for `run` and `retry`; fixed by an event-count fence in `FileControl` and by holding the lock through `retry`/`approve`. `corepack pnpm check`: unit 122/122, smoke 41/43. |

Update this table *after executing tests*. Each implementation milestone
should be a small reviewable commit on the chosen implementation branch.
If YAML role routing cannot ensure Claude + Codex, provide a failing
reproducer before proposing a schema change. **Do not silently add another
runtime, change a decided ADR, or mutate the documentation-only PR into a
code PR.**

**Done =** one System Work containing two independently authored proposal
Artifacts and one synthesized Artifact, replayable after restart, with
provider provenance and no need for an additional Worker type. The
research/verifier/browser expansions remain future work.
