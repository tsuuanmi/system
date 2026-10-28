---
id: PROP-0019
type: proposal
status: draft
owners: [operator]
created: 2026-10-27
summary: The lead is a session talking to System (operator, D109, 2026-10-27), so all logic, the lead's too, belongs in System, so the session can change, and another project's lead works the same. Today about 1,400 lines of scripts and state files in the lead's coordination directory do eleven jobs that System should do (a watcher loop, command judges, routine remediation approvals, auto-accept and auto-merge sweeps, pushing dev and syncing checkouts, a task registry, a decision log, the live profile patch history, salvage and hand landings, the morning report and health table, the handover). For each, this proposal says what System already has (the command rules, the lead inbox, the lead principal, auto-accept, the report) and what is missing, and gives the design in System, its switch (off or warn first, D108, T322) and its test on the test profile (T323). It designs `system lead brief --project <id>`, the one page a new lead session needs to take over, with a handover note the outgoing session leaves. The end state is a coordination directory that holds LEAD.md and nothing a script reads. Thirteen ranked tasks, each small and each with its switch, start after the core loop (T293b, T318b, T321) runs clean. Nothing in this proposal changes code.
evidence: [operator request 2026-10-27 (D109), D107 (the lead's inbox), D108 (everything a plugin, turn it off, test profile first), D88 (a lead per project), T319b, T320, T318b, T322, T323, T324, ADR-0076, docs/operations/lead-playbook.md]
related: [PROP-0008, PROP-0016, PROP-0017, PROP-0018, ADR-0060, ADR-0063, ADR-0064, ADR-0067, ADR-0068, ADR-0069, ADR-0071, ADR-0072, ADR-0076, INV-2, INV-5, INV-6, INV-9, INV-10, INV-13, INV-14, INV-15]
implementation: []
---

# Proposal: The lead is a session; its logic lives in System

## Problem

The operator's words on 2026-10-27 (D109): "the lead is only a session talking to System, so all
logic, the lead's too, belongs in System, so the lead session can change, and another project's
lead works the same."

That is not how it is. A project's lead session keeps working because of what sits beside it, in
its coordination directory (`~/workspaces/system-coordination`): about 1,400 lines of scripts and
state files that decide, push, sweep, and remember. A new session cannot take over without them,
and cannot read them as policy: they are not gated, not recorded as decisions, not tested, and not
visible on `/ui`. A second project's lead (D88; `system project new`, [packaging](../design/packaging.md))
would have to copy them. The handover from one session to the next exists only in the outgoing
session's memory.

Part of the logic has already moved into System, each time after the lead's script had shown the
need: the lead as a principal with a closed list of rights
([ADR-0076](../decisions/adr/0076-the-lead-is-a-principal-of-its-own-with-a-closed-list-of-rights.md)),
the routine command judges as policy [command rules](../design/approvals.md#command-rules) (T319b),
the polling script as [the lead's inbox](../design/notifications.md#the-leads-inbox) (T320, D107),
a listed branch's acceptance as `board.auto-accept` ([ADR-0067](../decisions/adr/0067-system-accepts-a-listed-branchs-result-on-its-review-and-checks.md)).
This proposal finishes the move, and says what is left, in what order, and how each part is turned
off.

This proposal is not normative until accepted, and changes no code. The scripts' contents are read
from the task that asked for this proposal (T324) and from the lead playbook, not from the scripts
themselves, which are outside this repository; the first task of each duty below begins by reading
its script and listing every behaviour it has, so none is lost.

## Goals

1. Every duty of the lead that a rule can state is a System mechanism: a seam, a plugin row, a policy
   rule, and a record, so it is decided in one place, recorded (INV-13), and the same for every
   project.
2. Every such mechanism ships as an optional row or behind a switch, starting off or warn (D108,
   T322), and is proven on the test profile (T323) before it runs on live.
3. A new lead session, or another project's lead, takes over from `LEAD.md` plus MCP and the CLI
   alone, using one command, `system lead brief`.
4. The lead's own judgement stays the lead's: what to file, what to escalate, what to tell the
   operator. System gets the rules, never the judgement.

## Non-goals

- No change to what the lead may decide. The closed list of rights
  ([the lead principal](../design/approvals.md#the-lead-principal)) and the escalations of
  [PROP-0016 §7](0016-operating-model.md) stand; a duty moves into System only inside them. The
  operator keeps a merge or push to `main`, policy and charter changes, deploys, external sends,
  security alerts, and a heavy-tier acceptance (INV-6).
- No Worker, model, or vendor named in a mechanism (INV-11).
- No second place for a rule. The [lead's playbook](../operations/lead-playbook.md) stays the home of
  each LD rule; a rule that System enforces says so in its Check column, and the lead keeps no copy.
- No code, schema, or configuration change here. Each task below is filed separately by the lead.

## 1. The inventory

What each item is today, what System already has, and what is missing. "Has" names what is built as
of 2026-10-27; a task still running (T318b, T321, T322, T323) is named as such.

| # | Item (in the coordination directory) | System already has | Missing |
|---|---|---|---|
| 1 | **Watcher loop**: auto approvals, stuck detection, held items reported once | The lead's inbox ([`lead-notice@1.0`](../design/notifications.md#the-leads-inbox)): notices for a held result or merge, a question, spent retries, a landing that gave up, a request outside the lead's rights or stale, idle quota, a live update, a landing; deduplicated per project, subject, and kind, so a held item is told once; closed by its subject; `system lead wait`; sinks (`command`, `file`). Liveness verdicts and `agent-workers.run.stalled` events. Dispatch and its pause | A notice for a **stuck** run or task (stalled with no verdict, running past its bound, a lease that keeps lapsing, a task in `waiting` past its time); the auto-approval part of the loop is items 2 and 3, so no loop is left to port |
| 2 | **Command judges**: read-only, own tests, `git mv`/`rm`, scratch removal | `autonomy-policy@1.4` `commandRules` (T319b): parsed argv, path scopes, `scratch-rm`, the run's own tests; decided at the gate and recorded with the rule's id; only the studio grants ([command rules](../design/approvals.md#command-rules)) | Nothing in the rules themselves. What is left is **proof the lead's judges are redundant**: a replay of the judges' recorded verdicts against the rules, then the judges' removal. The rules reach a project only through its policy: a new project gets them from the template |
| 3 | **Routine remediation approvals**: a review-asked fix, a host-stopped retry | The lead may decide these two kinds of `remediation` alone, by the request's own fields (`leadMayDecide`, T302); the decision is recorded as `lead:<project>` | A policy rule that **decides them at the request**, so no script (or session) has to: the two kinds are stated in the policy with their conditions, the approval is recorded as the policy's, and the lead sees a notice, not a request |
| 4 | **Auto-accept and auto-merge sweeps on dev** | `board.auto-accept` (ADR-0067): the run owner's acceptance applies when the last review approved the exact tree and the checks passed. The lead may accept a result whose checks passed, and approve a `merge` into a listed `devBranches` branch (`leadMayDecide`). Required checks run before acceptance (ADR-0063, T293) | Two sweeps in System: **accept** a held result that meets LD1's conditions after the fact (checks that were pending have since passed, a review re-opened by `board_reopen_review`), and **approve the `merge`** of an accepted result into a listed dev branch. `ALWAYS_ASK` holds `merge` today, so the second needs a policy rule that names listed dev branches only |
| 5 | **Pushing dev to the remote and syncing checkouts** | `landing-local` merges into the repository's checked-out branch and **never pushes**; a landing into a moved or dirty checkout refuses ([land](../operations/runbooks.md#land-an-accepted-result)). PROP-0017 designs a GitHub provider that pushes a result's own branch and opens a PR (accepted, not built). The landing queue (T318b) orders landings per target | A **publish** step after a landing on a listed dev branch: push the branch to the project's remote through the egress check (INV-12), and leave the landing checkout in step, so the next landing rebases onto what the remote holds (LD16, LD17). A lead's own push to the target must enter the queue (T318b, deliverable 4) |
| 6 | **Task registry**: `T`-number aliases, goal files | The board: tasks with ids (`task-…`), goal, criteria, state, dependencies, `board_brief`. Coordination tasks that do not run in System live on the coordination board | A short, stable **alias** (`T324`) the board gives a task and every tool and CLI accepts; the goal stays on the task, so the files are copies. A home for the lead's tasks that run no run (today `board.json` in the coordination directory) |
| 7 | **Decision log**: `D`-numbers, about 107 | System's decisions (INV-13) are System's own acts, not the operator's words. ADRs hold durable decisions. The lead playbook says every operator decision gets the next free `Dn` and is cited by that id (LD28), with no check | An **operator decision** record: number, date, the operator's words, what it caused (ADR, task, commit), who recorded it; a lead's open question to the operator beside it; read by id from MCP and the CLI; the 107 imported once |
| 8 | **Live profile patch history**: `cordis.patch.1..12` | `scripts/live-update.sh` (pause, wait, build, dry run, apply, rollback, verify the Workers); the `host.live-update` event and MCP `live_update_record`; the plugin host's lifecycle decisions; T322 will write a runtime toggle into the patch; T323 adds a stage on a test profile | A **versioned history of the live profile patch**: each write (a toggle, a live update, an operator edit) kept as an artifact with its parent, its reason, and its decision; show, diff, and restore; so `.1` to `.12` are System's records and a profile can be rebuilt from them |
| 9 | **Salvage and hand landings** | The playbook's LD13 to LD15 (when, how, root cause); `board_cancel`; `system stop`; the run's worktree and its retention; a landing needs an approval of the exact subject (ADR-0060); the landing queue (T318b) | A **salvage** operation: the decision (with its LD13 reason), the diff saved as an artifact, the run stopped, the task closed as salvaged, a worktree for the lead's edits on the run's branch, then the result **through the same checks and the landing queue** as any other, recorded as a lead landing, with its root-cause task filed (LD15) |
| 10 | **Morning report and health table** | `system report` (the weekly report), `system metrics`, `workflow.task.digest` and the inbox's `task.digest`, `system health` (MCP `status`), the `/ui` Home and Lead panel, `system dispatch`, `system worktrees` | The lead's **daily digest** as one record (what landed, what the lead decided under LD2, what waits on the operator with its expiry, what failed and its task, what is left for tomorrow) within the attention budget (LD8), and a **health table per project** that joins what is read in several places (dispatch, Workers, quota, sinks, live update, remote in step) |
| 11 | **Handover to a new session** (only in the session's memory) | `board_brief` (a page for an agent new to a project), the playbook and `LEAD.md` checklist, `lead wait`, `lead inbox` | A **brief for a lead** (section 3), and a **handover note** the outgoing session leaves: a record, not a memory |
| + | **Starting tasks** (`scripts/sysrun.mjs`, in this repository) | Dispatch starts ready work under `auto` (ADR-0064); the lead starts the rest with a script | `system task start <task>`: the same start as a CLI and MCP verb of the lead, so the lead needs no script (rank 13) |

Two findings the inventory shows. First, items 1 to 3 are mostly **built**: what is missing is proof
and removal, not code. Second, items 4, 5, and 9 are about **landing**: they must come after the
landing queue (T318b), or a sweep, a push, and a salvage race the queue (the failure T298 and T299
met).

## 2. The design in System

Each part below says: the seam or row, the policy rule, the record, how it is switched off, and how
it is tested on the test profile.

### 2.0 Four rules for all of them

**The switch.** Following D108 and T322, every mechanism lands as an optional row or as a key
`enforce: off | warn | on` on its owner's row, read live (no restart).

| Mode | What it does | What the lead does |
|---|---|---|
| `off` | The mechanism does nothing and its records stop; System works as today | the lead's script still does the duty |
| `warn` | It computes what it **would** do and records it as a `lead-duty` decision (`would-approve`, `would-push`, and the like), acts on nothing | the script still does the duty; the two are compared |
| `on` | It acts, as a decision recorded under its rule's id, within the lead's rights | the script is removed |

A new mechanism starts `off`, or `warn` where the mechanism only reads. It moves to `on` only after N
days clean on live, N in the policy (T322; proposed 5 working days for a deciding mechanism, 3 for
a notice). Turning any of them off never breaks System (T317, T322).

**The retirement.** A script is removed only when its replacement has run in `warn` beside it for N
days with **no disagreement**: every case the script acted on, the mechanism would have, and every
case the mechanism would act on, the script did. Each disagreement is a task. The comparison is a
query over the `lead-duty` decisions and the lead's own notes, not a manual read.

**The test.** Each mechanism's tests run on the test profile (T323) with the conformance fakes. A
mechanism's switch is turned to `warn`, then `on`, on the test profile first, with the canary
(a board task through `algorithm-development` on fakes, an ask, a research run, the removability
smoke); only then on live. The canary gains one case per mechanism, named below. A mechanism whose
canary case fails never reaches live: the stage step refuses to touch `system` (T323).

**The records.** One new record, `lead-duty@1.0`, is a decision of System's own (INV-13): the
duty, the project, the subject, the mode, what it did or would do, the rule's id. It is added to
the decision kinds; an existing kind (`approval`, `acceptance`, `landing`) is used instead where the
act already has one, with the rule id in its detail.

### 2.1 The watcher loop → the inbox, with stuck notices (rank 3)

- **Seam and row.** The `lead-inbox` row (a surface, no seam, optional) already reads recorded events
  only. It gains three notice kinds: `run.stuck` (an agent run stalled and not freed within
  `stuckMinutes`, from `agent-workers.run.stalled` and the liveness verdicts), `task.stuck` (a task
  `running` past its bound, or `waiting` past the time its wait states, with no event since), and
  `host.restarted` (the board's recorded restart and what it reconciled).
- **Policy.** None: a notice decides nothing (INV-6). The inbox's rule stays: ids, kinds, counts, times,
  and the command to act only.
- **Record.** `lead-notice@1.0`, an added kind (a minor version of the enum).
- **Off / warn.** The row's new `kinds` list names the kinds on; the three start off. `warn` is the
  kind present but with `push: false` (shown in `lead inbox` and `/ui`, never pushed to a sink).
- **Test.** Fixtures on the test profile: a fake Worker that stalls produces one `run.stuck`, once,
  and none after the run is freed; the second stall of the same run is one more notice only after
  `dedupMinutes`.
- **Retires.** The watcher loop's stuck check and its "report once" state file.

### 2.2 Command judges → command rules (rank 3: audit, then removal)

- **Built.** `commandRules` decide the read-only programs, the run's own tests and checks, tree
  edits, and scratch removal at the gate. The lead's judges are redundant when every command they
  approved is one a rule decides.
- **What is added.** A read-only query, `system lead audit-commands --project <id> [--days n]` (MCP
  `lead_audit`), lists the deferred commands of the period that **reached the lead** and what the
  lead decided, grouped by the program and subcommand, so each group is either a rule to add (a
  policy change the operator approves) or a command that must stay a judgement. It replaces reading
  the judge script by eye.
- **Policy, record.** None new: a rule is added through a [policy change](../design/approvals.md#a-policy-change);
  every verdict is already recorded.
- **Off / warn.** The audit is read-only; there is nothing to switch. A judge is removed under the
  retirement rule of 2.0: after N days in which no deferred command reached the lead that a rule
  could have decided.
- **Test.** A fixture with a replay of ten recorded commands: those a rule decides do not reach the
  lead; the rest group correctly.

### 2.3 Routine remediation approvals → policy rules (rank 6)

- **Seam and row.** The `approvals` row, in `request`: the policy's new `remediationRules`
  (`autonomy-policy@1.5`): a rule per kind, each with the **same conditions** `leadMayDecide` checks
  today (the workflow's review-fix with the plan artifact grown by its review's decision; the board's
  retry of a run its host stopped, subject at version `reconciliation-failed:host-stopped`), and its
  project's runs only. A request that meets a rule is decided at once.
- **Policy rule.** `remediationRules`, granted only by the studio policy, narrowed (never widened) by
  a project's, like `commandRules`. Taking effect needs the operator's approval of a policy change;
  the lead never approves it.
- **Record.** The `approval` decision as for any verdict, the decider `{ type: policy, id: <rule id> }`;
  the lead's inbox gets a `remediation.decided` notice (a minor kind) so the lead knows, and a
  decision it can still overrule by `board_cancel`. A lost run without the host-stopped mark, and every other
  remediation, stays the operator's.
- **Off / warn.** `remediationRules.mode: off | warn | on` in the policy. `warn` records
  `would-approve` and leaves the request open for the lead, as today.
- **Test.** On the test profile: a fake review that blocks, a fix, a host stop. With `warn`, the
  request stays open and one `lead-duty` decision says `would-approve`; with `on`, it is approved with
  the rule's id; a run lost without the mark is not decided; a request of another project is not.
- **Retires.** The remediation approval branch of the watcher.

### 2.4 Auto-accept and auto-merge sweeps → the board and the approvals rows (ranks 7 and 8)

- **Accept sweep (board).** `board.auto-accept` already accepts at the run owner's decision. The sweep
  re-reads every task held `operator-review` for a **listed** project on each board sweep and applies
  the same conditions (last review approved the exact tree, no blocking finding, every required check
  passed on it, none `notRun`, a listed landing branch, not heavy), deciding as `board.auto-accept`
  on the held record. It never accepts a heavy-tier result, one with a check pending, or one on an
  unlisted branch. Switch: the board row's `autoAccept.sweep: off | warn | on`; `warn` records
  `would-accept` in the same `board` decision kind.
- **Merge sweep (approvals).** A `merge` request into a listed `devBranches` branch for an accepted
  result whose acceptance recorded the landing on that branch and whose subject is the exact head: a
  policy `mergeRules` entry with `branches: listed-dev` and no other, decided with the rule's id.
  `ALWAYS_ASK` keeps `merge` for every other branch, and `main` and `master` can never be listed.
  This is the one change in this proposal that touches the gate: it **amends ADR-0060 and ADR-0076**
  and takes the heavy path (two families, the operator accepts alone). Switch: `mergeRules.mode`.
- **Order.** After the landing queue (T318b), so the queue's order is the merge order and a sweep
  never moves a target under a landing.
- **Test.** On the test profile, three results accepted together land in order; a heavy-tier result is
  held; a result with a pending check is held until it passes; a request for `main` is asked, never
  decided; `warn` records `would-merge` and leaves the request open.
- **Retires.** The two sweeps.

### 2.5 Pushing dev and syncing checkouts → a publish step after a landing (rank 9)

- **Seam and row.** A new optional row `landing-publish`, a decorator of the landing seam's provider
  ([the landing seam](../design/workflow-engine.md#the-landing-seam)): after a landing `merged` on a
  listed dev branch, it pushes that branch to the project's remote and, through the same provider,
  leaves the landing checkout on the pushed commit. The provider's own rule stays: `landing-local`
  never pushes. A project with no `publish` entry is untouched.
- **Policy rule.** A new action class `publish` (a push of a listed dev branch to a named remote),
  asked by default and decided by the lead's rights where the branch is listed; a push to `main` or
  any other branch stays the operator's. The push goes through the egress check on the exact refs
  (INV-12); the credential is the vault's (INV-8), never the lead's file.
- **Record.** The `landing` decision gains a `publish` outcome (`pushed`, `skipped`, `refused`), the
  commit pushed, the remote's name (never its URL); an inbox notice on a refusal.
- **Off / warn.** `landing-publish` starts off. `warn` computes the refs it would push and records
  `would-push`, pushes nothing.
- **Never on a red commit** (LD17): the landing's checks are the push's precondition; a push is never
  made for a landing that skipped them.
- **Test.** On the test profile with a local bare repository as the remote: a landing pushes once; a
  second landing pushes after it, in order; a remote that moved refuses and notifies, and changes nothing;
  a `main` landing never pushes.
- **Retires.** The push script and the checkout sync (LD16).

### 2.6 The task registry → the board (rank 5)

- **Seam and row.** The `board` row. A task's `ref` (`T324`) is a per-project sequence the board
  allocates when it creates the task, kept with the record (`board-task@1.3`, an optional field: a
  minor version, no migration of existing tasks; the board assigns the lead's existing T-numbers once
  by `system board import-refs`). Every tool and the CLI accept `T324` where they accept the id, within
  the project the caller reaches; an ambiguous or unknown ref is refused with the reason.
- **Goals.** The task's goal and criteria are already its record; the coordination goal files are
  copies and go.
- **Tasks that run nothing.** A lead's own task (a note to follow up, a thing to ask the operator)
  is a board task with `action: none` and the lead as owner, moved by `board_update`, no run. Whether
  the board admits that today is the first thing the task checks; if it does not, it is a small change
  of its own (open question 4).
- **Policy.** None new.
- **Off / warn.** The field is optional and the allocation is a switch on the row (`refs: off | on`);
  with it off a task has only its id, as today.
- **Test.** Tasks created concurrently get distinct refs; a ref of another project is refused for a
  lead token; a restart keeps the sequence.

### 2.7 The decision log → an operator-decision record (rank 4)

- **Seam and row.** A new optional row `decisions` (a surface, store-backed, no seam). It holds
  `operator-decision@1.0`: `id` (`D109`), `projectId` (or none: studio-wide), `date`, `words` (the
  operator's text, bounded), `state` (`asked` | `decided`), `causes` (ADR, task ref, commit, doc),
  `recordedBy` (`lead:<project>` or `operator`). An `asked` record has no number: it is the lead's
  question to the operator, which is one of the lead brief's **pending decisions**; it gets the next
  free `D` when the operator's answer is recorded.
- **Tools.** `decision_record`, `decision_list`, `decision_show D109`, and `system decision
  record|list|show` (a lead token may record and read its project's; the operator's token records for
  any). The next number is allocated by the store in one transaction (INV-15), so two sessions can
  never take the same one: LD28's "next free id" becomes a store property, not a habit.
- **A record is not a decision of the operator unless the operator made it.** `recordedBy` says who
  wrote it down; a decision records the operator's words and their source (a message, `/ui`, a
  review). It is evidence, and the operator can correct a record; a lead never deletes one (a
  correction is a new record that names the old).
- **Import.** `system decision import <file>` (operator scope, once) reads the 107 existing
  decisions with their dates and words and refuses a gap or a duplicated number.
- **Off / warn.** The row is optional and its tools read and write only when on. Off: the lead
  keeps its file, as today.
- **Test.** Two concurrent records get distinct numbers; an import with a gap is refused; a lead token
  records only for its project; a correction names its predecessor.

### 2.8 The profile patch history → the plugin host (rank 5)

- **Seam and row.** The `plugin-host` row, which T322 makes write a runtime toggle into the profile
  patch. Every write of the patch (`system plugin on|off`, a live update, an operator edit found at
  start) is kept as a `profile-patch@1.0` artifact: the patch's text, its parent, its hash, the reason,
  and the decision that made it. `system profile history`, `system profile diff <a> <b>`, and
  `system profile restore <n>` (operator scope; a restore is itself a write, a new version).
- **Policy.** A patch change stays what it is today: the operator's, or a live update the operator's
  `dev` permission covers (LD3). Nothing here lets the lead write the profile.
- **Record.** `profile-patch@1.0` plus the existing lifecycle and `host.live-update` decisions, each
  linked to its version.
- **Import.** `cordis.patch.1..12` are imported once as versions with their dates; a gap is noted, not
  invented.
- **Off / warn.** Versioning off: the patch is written as today. `warn`: versions are kept and a
  mismatch between the patch on disk and the last version is a health finding, not a refusal.
- **Test.** On the test profile: off, on, a live update each make one version; a restore reproduces
  the patch byte for byte; an edit made outside System is found and recorded as `external`.

### 2.9 Salvage and hand landings → one salvage operation through the queue (rank 11)

- **Seam and row.** A tool of the `workflow` row (it owns the runs and the landing seam), `salvage`,
  and `system salvage <task> --reason <sandbox-gap|review-bound|hang> --cause "…"`:
  1. records a `salvage` decision with its LD13 reason, the run, and the task;
  2. saves the run's diff as an artifact (the `$TMPDIR` copy of LD14 becomes a record);
  3. stops the run (`system stop`) and takes the task off the board as `salvaged`, never `cancelled`;
  4. opens a **salvage worktree** on the run's branch for the lead's edits (never the live checkout);
  5. proposes the **root-cause task** (LD15) with the cause as its goal: the operation is refused
     without one.
  `system salvage land <task>` then takes the worktree's head, runs the **required checks on that exact
  tree** (ADR-0063, T299), and enters it in the landing queue (T318b) as a result with
  `landedBy: lead:<project>`, its tier from the path map (ADR-0071), so a heavy-tier salvage is held
  for the operator like any heavy result. No salvage lands on a failed or skipped check (LD17).
- **Policy.** The lead's right to merge into its listed dev branches (existing); nothing new.
- **Record.** The `salvage` decision, the diff artifact, the `landing` decision with its source.
- **Off / warn.** The tools are refused with a reason while off, and the lead lands by hand, as
  today. `warn` runs the whole path but stops before the landing and says what it would land.
- **Test.** On fakes: a salvaged run lands once, in the queue's order, after its checks; a salvage
  without a cause is refused; a failing check stops it; a heavy path is held for the operator.
- **Retires.** The hand-landing steps of LD14 and the salvage notes of the coordination board.

### 2.10 The morning report and health table → a daily digest and a health section (rank 10)

- **Seam and row.** `report` (a surface plugin that reads the core, writes nothing) gains
  `lead_digest` (client scope, a lead token's project only): for a day, what landed (task, run,
  commit), what the lead decided under LD2 (read from the lead's own recorded verdicts and moves,
  the same source as the lead-touch metric), what waits on the operator with its brief link and its
  expiry, what failed and the task filed for it, and the decisions left for tomorrow, within the
  operator's attention budget (D83 #8). The record is `lead-digest@1.0`, stored, so the operator can
  read yesterday's.
- **Health.** `lead_health` (the same tool group): one table per project with the rows that today are
  read in five places, each `ok`, `degraded`, or `unknown` with its reason: dispatch (paused or
  running, bounds), Workers (available, in cooldown, quota headroom), notification and lead sinks,
  the live update (idle, paused, failed), the landing queue (depth, oldest), the remote (in step or
  behind, when `landing-publish` is on), worktrees held, the handbook bound's mode. A row that cannot be
  read says `unknown`, never `ok` (INV-2).
- **Policy.** None: it reads.
- **Off / warn.** Read-only; `report` row off turns it off. The digest's **push** (to a sink at an hour)
  is a separate switch that starts off.
- **Test.** A fixture day with known landings, one lead decision, one held review, one failure: the digest
  names each once and no more; a Worker the fixture marks unavailable is a degraded row.
- **Retires.** The morning report script and the health table.

### 2.11 The handover → the lead brief and a handover note (ranks 1 and 2)

See section 3.

### 2.12 What stays the lead's, and not in System

| What | Why |
|---|---|
| deciding what to file and in what order (LD21, LD22) | judgement: System offers the facts (`lead brief`, `system metrics`), never the choice |
| the decision brief for the operator (LD4) | it needs the lead's reading of the evidence; System builds the facts of it (I2) |
| what to tell the operator and when, beyond the digest | judgement |
| answering a Worker's question (T291) | the answer is knowledge the lead has |
| the choice to salvage or retry | LD13 says when; System does the mechanics |

## 3. `system lead brief --project <id>`

One command, one page, read-only, that a session reads at its start and again whenever it is lost.
It is MCP `lead_brief` (client scope; a lead token reaches its own project only, the operator names
one) and `system lead brief --project <id> [--json] [--since <time>]`. It adds nothing a session could
not read elsewhere, and replaces six calls with one: its value is that nothing is forgotten.

**It reads, never writes**, except one event, `lead.brief-read` (who, when, which project), which
`system metrics` counts as a session change and the inbox's lead-touch metric ignores.

| # | Section | Holds | Read from |
|---|---|---|---|
| 1 | **You** | the project, the principal the token names (`lead:<id>`), the charter's objective and constraints in a line each, dates, **the playbook's version** and the rules that changed since the last brief this principal read | `board_projects`, the lead principal, the playbook's blob id (handbook layer 4), the last `lead.brief-read` |
| 2 | **Inbox** | unread notices, oldest first, each with its kind, subject, age, and the command to act | `lead_inbox` |
| 3 | **Waiting on the operator** | open approval requests outside the lead's rights, each with its expiry and brief; reviews held `operator-review` and `review-expired`; heavy-tier results | approvals, `board_tasks` |
| 4 | **Held on you** | requests the lead may decide and has not (a deferred command no rule covers, a `remediation`, a `merge`), and results the lead may accept, each by expiry | approvals, board |
| 5 | **Pending decisions** | the lead's open questions to the operator (`asked` operator-decision records), a policy or charter change awaiting approval, and decisions recorded since the last digest | `decisions`, approvals |
| 6 | **Running work** | runs and their steps, tasks `ready`, `running`, `waiting` (with what for), blocked by dependency, the landing queue (its depth and head), worktrees held | board, workflow, the landing queue, `system worktrees` |
| 7 | **Health** | the health table of 2.10 | `lead_health` |
| 8 | **The last day** | what landed, what the lead decided, what failed (the digest's body for the period since the last brief) | `lead_digest` |
| 9 | **Switches** | each lead mechanism of this proposal, its mode, and its days clean | the owning rows' `enforce` keys |
| 10 | **Handover note** | the outgoing session's note: what it was doing, what it promised, what to watch, what it deferred and why | `lead-handover@1.0` |
| 11 | **What I could not read** | each section that failed, with the reason | the brief itself |
| 12 | **First moves** | the daily loop's three commands, `system lead wait`, `system lead ack`, `system handbook --role lead` | fixed text |

- **Bounded** (INV-9): each list holds at most 20 entries and says how many it omitted; the text
  rendering fits one screen when the project is quiet and about 200 lines when it is not.
- **Fail closed** (INV-2): a section that cannot be read says so in section 11 and shows no value,
  never an empty list, because an empty list reads as "nothing to do".
- **The playbook is a pointer, not a copy**: section 1 gives the version and the changed rules; the
  text is read through `system handbook --role lead` (I1 part 3) or `LEAD.md`'s link, so a rule has
  one home.
- **The handover note** (`lead-handover@1.0`): `system lead handover --project <id> (<text…> | -)`
  and MCP `lead_handover`, bounded (4,000 characters), per project, one current note with its
  history kept. The lead writes it when it ends a session or before a long wait; `lead brief` shows the
  latest, and the next session marks it read (`ack`). A note is advice, not an instruction: it never
  grants a right (INV-6), and `lead brief` says who wrote it and when.
- **Switch.** `lead_brief` is a tool of the `lead-inbox` row and appears with it. Its sections
  are read through optional rows (`decisions`, the landing queue, `landing-publish`): a row that is
  off is a section that says so, which is how it works on a project without them.
- **Test.** On the test profile: an empty project, a busy project from a fixture (one of each
  section), a section whose source is down (it reads "could not read", not empty), two projects (a lead
  token never reads the other's), and the 20-entry bound.

## 4. The end state

The coordination directory holds `LEAD.md` and nothing a script reads. A new session, or another
project's lead, works from `LEAD.md` plus MCP and the CLI.

| Today (coordination directory) | End state | Where it lives |
|---|---|---|
| watcher loop, its state file | gone | the inbox (2.1), command rules (2.2), policy rules (2.3, 2.4) |
| command judges | gone | `commandRules` |
| remediation, accept, and merge sweeps | gone | `remediationRules`, `autoAccept.sweep`, `mergeRules` |
| push and sync scripts | gone | `landing-publish` |
| task registry, goal files | gone | board refs |
| decision log | gone | `operator-decision` records |
| `cordis.patch.1..12` | gone from the directory | `profile-patch` versions |
| salvage notes | gone | the `salvage` decisions and diffs |
| morning report script, health table | gone | `lead_digest`, `lead_health` |
| the handover in memory | a record | `lead-handover` |
| `board.json` for tasks that run nothing | gone | board tasks with no run (open question 4) |
| `LEAD.md` | **stays**, shorter | the checklist of [LEAD.md](../operations/examples/LEAD.md), the project's own facts (its name, its listed branches, who the operator is), and four commands: `system lead brief`, `system lead wait`, `system lead ack`, `system lead handover` |

- **What `LEAD.md` may hold**: text a session reads. It never holds a token, a number a script parses, or a
  rule: a rule is in the playbook or the policy. `system lead doctor --project <id>` (built with the
  retirement, rank 12) reads the coordination directory and fails when it holds anything but `LEAD.md`,
  so the end state is checked, not hoped for.
- **A lead token is not in the directory.** It stays beside the operator's token (`lead-<project>.token`), as
  today (LD25).
- **The test of the end state**: start a fresh lead session in a project with only `LEAD.md`, the token,
  and the CLI; it reads the brief, handles the inbox, and ends a session with a handover note; a second fresh
  session reads that note and continues. This is the proof on the test profile and, once, on a second project
  (PROP-0016 I5): it is the acceptance of the last task.
- **Another project's lead** needs no copy: `system project new` writes `LEAD.md` from the template, the
  policy rules come with the project's policy, the duties' modes are the project row's keys, and every tool
  names its project by id.

## 5. Ranked implementation tasks

The order starts after the core loop runs clean: T293b (the checks run before any acceptance),
T318b (the landing queue), and T321 (the handbook bound fits). It also needs T322 (the switches) and
T323 (the test profile) for every task that changes how the system decides. Each task is one concern,
about 1,500 changed lines at most, one switch, one test on the test profile, and its docs and a
changeset. Ranked by value over risk, read-only first, deciding last. **Rank 12 is the one exception**:
it changes no behaviour of System beyond `lead doctor`, so its switch is the lead's own step (a script
is removed only after N clean days of its replacement), and its docs are `LEAD.md` and the template;
a changeset only for `lead doctor`.

| Rank | Task | Row or seam | Switch (starts) | Test that must fail without it | Needs |
|---|---|---|---|---|---|
| 1 | **`system lead brief`** (section 3, sections 1 to 8, 11, 12) and `lead.brief-read` | `lead-inbox` | the row; read-only | the briefs of an empty and a busy fixture; an unreadable section is named | core loop |
| 2 | **The handover note** (`lead-handover@1.0`, `lead handover`, section 10 of the brief) | `lead-inbox` | the row; read-only | a note is shown once and kept; a note grants no right | 1 |
| 3 | **Stuck notices** (2.1) and the audit of commands (2.2) | `lead-inbox`, `lead_audit` | `kinds` (off); the audit is read-only | one `run.stuck` per stall; the audit groups a replay | 1 |
| 4 | **The operator-decision record** and the import of the 107 (2.7) | new row `decisions` | the row (off) | two writers never share a number; a gap in an import is refused | 1 |
| 5 | **Board refs** (2.6) and **profile patch versions** (2.8) | `board`; `plugin-host` | `refs` (off); versioning (`warn`) | distinct refs under concurrency; a restore is byte-exact | T322 |
| 6 | **Remediation rules** (2.3) | `approvals`, policy `autonomy-policy@1.5` | `remediationRules.mode` (`warn`) | `would-approve` while open; `on` approves the two kinds only | 3, an operator-approved policy change |
| 7 | **The accept sweep** (2.4) | `board` | `autoAccept.sweep` (`warn`) | a held result with passed checks accepts; a pending or heavy one does not | 6 |
| 8 | **The merge rule on listed dev branches** (2.4), ADR amending 0060 and 0076 | `approvals` | `mergeRules.mode` (`warn`) | `main` is asked, a listed dev branch decided, in the queue's order | 7, T318b; **heavy path** |
| 9 | **`landing-publish`** (2.5) | new row | the row (off, then `warn`) | a landing pushes once, in order; a moved remote refuses | 8 |
| 10 | **The daily digest and the health table** (2.10) | `report` | read-only; the push (off) | the fixture day; an unavailable Worker degrades its row | 1 |
| 11 | **Salvage** (2.9) | `workflow` | off, then `warn` | a salvage lands once after its checks; none without a cause | 9 |
| 12 | **`system lead doctor`**, then **retire the coordination scripts**, one duty at a time, and `LEAD.md` rewritten from the template | the CLI; the template, the example | the lead's own step, after N clean days of each replacement (the exception above) | `lead doctor` names a stray file in a fixture directory | 3 to 11 |
| 13 | **`system task start`** (replacing `sysrun.mjs`) | `workflow`, the CLI | the verb; refused while off | a start by the lead is recorded as `lead:<project>` | 12 |

Notes on the order:

- **1 to 4 are read-only or add records**: they can ship before T322's switches are everywhere, and
  they give the lead the brief now, which is the part no other task can give.
- **6 to 9 decide or act**: each starts `warn`, is compared with the script it replaces for N days, and
  moves to `on` only on the test profile's canary and N clean days on live. A policy change (6, 8) goes
  through the approval queue; the lead never approves it.
- **8 is the only task on the heavy path** (it changes the gate's rules for `merge`). It follows the
  landing queue so a merge never races a landing.
- **Each task begins by reading its script** and listing every behaviour it has (one line each, in the
  task's evidence), so a behaviour the script has and this proposal missed is found before the script goes.
- **Metrics**: the lead-touch metric ([maturity metrics](../design/maturity-metrics.md)) is the
  measure. A mechanism that moves a duty into System should lower the lead's touches per task, and the
  scripts removed at 12 are the count of lines gone (about 1,400).

## Alternatives considered

| Alternative | Why not chosen |
|---|---|
| Keep the scripts and document them | the operator's point (D109): a session changes, so what it needs must not be beside it; a script is not gated, recorded, or tested on a test profile |
| One `lead-duties` plugin holding every mechanism | a row that does eight unlike things is not removable in part (D108); each duty lives at the seam it belongs to, with its own switch |
| The lead's sessions share a state file in System | a file is a mirror of System's records (INV-7); the records exist, and what does not exist is a record, not a file |
| System writes the digest and decides what to file | judgement is the lead's; a rule cannot state it, and this is where a rule goes wrong (2.12) |
| Let the lead approve the policy changes that move its duties | LD3 and INV-6: a policy or charter change is the operator's |
| A lead daemon, a second process that runs the lead's loop | a second authority (INV-1); a session that waits on the inbox does the same, and a daemon is one more thing to restart |
| Do all of it in one task | each duty is a different seam and risk; a task over about 1,500 lines is not reviewable |

## Validation plan

- Each task's tests run first with the switch `off` (nothing changes, System healthy), then `warn`,
  then `on`, on the test profile with fakes (T323), with one canary case per mechanism.
- The retirement comparison (2.0): for N days in `warn`, the mechanism's would-do decisions equal the
  script's acts. A disagreement is a task before the script goes.
- Conformance suites for the records where a new one is added (`operator-decision`, `lead-handover`,
  `lead-digest`, `lead-duty`, `profile-patch`), with schemas (INV-14), minor versions of the existing
  `lead-notice@1.0`, `board-task`, and the `autonomy-policy`.
- The end-state check: `lead doctor`, and the two-session handover test of section 4.
- `pnpm check`, `pnpm lint`, `pnpm typecheck`, and the related tests on every task, as for any change
  (W15).

## Rollout and rollback

- Every mechanism is optional and starts `off` or `warn` (2.0). Turning one off returns the duty to the
  lead's script, which is why the script stays until N days clean, and the records the mechanism made stay.
- The scripts are removed last, one duty at a time (rank 12), and not before the replacement has been
  `on` for N days. A removed script is in git history of the coordination directory, so a duty can come
  back to a script in minutes if a mechanism proves wrong.
- A mechanism is switched to `on` on the test profile first, with the canary, then on live
  ([update the live install](../operations/runbooks.md#update-the-live-install-automatically)).

## Observability and operations

- `system lead brief` (section 3) is the new operational view. The `/ui` Lead panel shows the same
  sections for the project.
- Each mechanism's mode and days clean are in the brief's section 9 and in `system plugin list` (T322).
- `lead-duty` decisions are read by `system explain` on a task and by the metrics' lead-touch count: a
  duty System does is not a lead touch; the comparison with the scripts' acts is a query.
- Runbooks to add: take over as a lead; turn a lead mechanism to `warn` and `on`; retire a script;
  write a handover note.

## Security and privacy

- No right is added to the lead. Each mechanism acts inside `leadMayDecide`, and `main`, policy and
  charter changes, deploys, external sends, security alerts, and tokens stay the operator's (INV-6).
  A mechanism decides as a **policy rule** recorded with its id, never as the lead's token.
- A push (2.5) is an egress (INV-12): declared, checked on the exact refs, with the vault's credential
  (INV-8). The lead's file token is never used for it.
- The brief, the digest, and a notice hold ids, kinds, counts, times, and commands, not secrets, tokens,
  host paths, or private text. The handover note is the lead's text: it is classified like the
  lead's other output (`operator-shared`), and it is checked by the credential scan on write.
- A handover note and a decision record are data, never an instruction to System (INV-6): neither grants
  a right nor changes a policy.
- The decision log holds the operator's words: its records are not deleted and are corrected by a
  new record, so a lead cannot rewrite what the operator said.

## Compatibility and migration

- Additive: new records and tools; a minor version for `lead-notice`, `board-task`, `autonomy-policy`
  (`remediationRules`, `mergeRules`), and the `landing` decision's `publish` outcome. No existing record
  is changed in place (INV-14, [schemas](../reference/schemas.md#versioning)).
- Imports, once each: the 107 decisions, the T-number refs, the patch versions `.1` to `.12`.
- A project without these rows works as today: the brief says which sections it could not read.

## Open questions

Each has a recommendation; the operator decides.

1. **N, the days clean before a mechanism moves to `on`.**
   **Recommended:** 3 working days for a notice or a read, 5 for a mechanism that decides or acts,
   set in the policy (T322).
2. **The merge rule (2.4) amends ADR-0060 and ADR-0076.** May the policy let System approve a `merge`
   into a listed dev branch, with `main` and `master` never listed?
   **Recommended:** yes, on the heavy path, after the landing queue runs clean, because today's lead
   approval is the same decision with a session in the way.
3. **A push of a listed dev branch (2.5) as the lead's right.**
   **Recommended:** yes for a listed dev branch on the project's named remote only; any other push is
   the operator's.
4. **Tasks that run nothing (2.6).** Do they live on the System board with no run, or do they end?
   **Recommended:** on the board, `action: none`, so a lead's follow-up is visible to the next session;
   the coordination board is then not needed.
5. **Where the operator's decisions live for studio-wide (no project) decisions.**
   **Recommended:** the same `decisions` row, `projectId` absent, readable by every lead, written by the
   operator or by a lead on the operator's word, as `recordedBy` says.
6. **The handover note's bound.**
   **Recommended:** 4,000 characters, the latest shown, ten kept.

## Decision

Draft. Record the operator's review outcome and the resulting ADRs (the merge rule, the publish
action class) here.

## Implementation

Each task of section 5 is filed by the lead after the core loop (T293b, T318b, T321) runs
clean; it records its commit here and in the [roadmap](roadmap.md) when it lands.

- **Rank 10 (T329), the daily digest and the health table.** Built in the `report` row, read-only:
  MCP `lead_digest` and `lead_health` (`mcp-report@1.7`), `system lead digest|health`, and the
  `lead-digest@1.0` record, stored once a day is over
  ([`report`'s README](../../packages/plugins/report/README.md), [runbook](../operations/runbooks.md#read-the-day)).
  Not built: the digest's push to a sink at an hour (it will be its own switch, off), the remote
  row (`landing-publish` is rank 9), and "decisions left for tomorrow" beyond what waits on the
  operator. A landing by hand is a first-parent commit on a branch the project landed on that no
  merged landing names.
- **Rank 1, `system lead brief` and MCP `lead_brief` (T327, this task's commit).** A tool of the
  `lead-inbox` row (`packages/plugins/lead-inbox/src/brief.ts`, `brief-sources.ts`), so it appears with
  the row. Sections 1 to 8, 11, and 12 are built; 9 (switches) and 10 (handover note) read *not yet
  available*. Sources that do not exist yet are named in section 11 and show no value: the playbook's
  version (waits for I1 part 3), the `decisions` row (rank 4: section 5's questions and decisions),
  `lead_health` (section 7), and `lead_digest` (rank 10: the whole of section 8, which is never filled
  from another source). A source that cannot be read whole within its bound (the board read page by
  page up to ten pages, at most 1,000 open requests, 500 open landings, 100 run worktrees) is
  unreadable too, never a list filtered from a truncated read. Section 3 and 4's split of the
  approval queue is `approvals.leadMay`, the one test `decideAsLead` applies; section 6 reads the
  runs and their steps through `workflow.get` and the landing queues through
  `workflow.openLandings()`, showing a shared queue's head only when it is the project's own and its
  target branch, never the repository's path. The record is `lead-brief@1.0`
  (`schemas/lead-brief.v1.json`), validated before it is returned. The one event is
  `lead.brief-read` (`principal`, `project`); a project the board does not know is refused, not
  briefed empty. Tests: `lead-inbox/tests/brief.spec.ts`, `cli/tests/lead-brief.spec.ts`,
  `system-bundle/tests/lead-brief-seams.spec.ts`.
