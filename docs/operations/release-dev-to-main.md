---
type: operations
status: active
reviewed: 2026-11-08
related: [ADR-0002, ADR-0007, ADR-0008, ADR-0009, ADR-0010, PROP-0003, PROP-0004, PROP-0005, PROP-0006, PROP-0007]
---

# Release report: `dev` into `main`, 2026-11-08

For the operator. `main` (8b6a4c8) `..dev` (6d92315) is 117 commits, 35 merges
and 221 files (+21,211 −2,039). This report points to the documents; it does
not restate them. It replaces the report of 2026-11-07, which stopped at PR #28.

## 1. What changes for you

From the first report (PRs #5–#28):

- **One long-lived Host** (`system.service`, a user unit) owns the store; the
  old per-command mode and its five lock and snapshot defects are gone
  ([Host](../architecture/host.md), [cutover](runbook.md#cutover-to-the-host-r1)).
- **A thin CLI** talks to the Host's socket, prints one-line errors and
  detaches on Ctrl-C ([Runbook](runbook.md#host-not-running)).
- **Parallel steps** per Account (`maxConcurrentAttempts`), and an attempt
  time limit (`attemptTimeoutMinutes`, default 60).
- **Goals and `system mcp`:** an Orchestrator agent scoped to one Goal, which
  may never approve or merge ([ADR-0009](../decisions/ADR-0009-goals-and-orchestrators.md)).
- **The ChatGPT Website Worker** (`chatgpt-web`), off by default
  ([Runbook](runbook.md#the-chatgpt-web-account)), and conversation
  ingestion ([PROP-0003](../proposals/PROP-0003-conversation-ingestion.md)).
- **System merges into `dev`**; only you merge `dev` into `main`
  ([ADR-0008](../decisions/ADR-0008-dev-integration-branch.md)).

New since (PRs #29–#42):

- **Sign in without a display** (W2, #30): `system workers login <ref> --remote`
  serves a viewer you reach through an SSH tunnel.
- **The Host restarts itself on new code** (D, #32): it drains, exits 75 and
  the unit starts the new code; Works held at the gate continue.
- **System 1's ChatGPT driver** (W5, W7, W8; #34–#36) runs the `chatgpt-web`
  Runtime.
- **A replaceable Orchestrator** (OC, #39, [PROP-0006](../proposals/PROP-0006-replaceable-orchestrator-and-code-checks.md)):
  `system decision add|list`, `system goal brief`, live progress in
  `work show` and a stall notice after `stallMinutes`. Only a human runs a
  check again (`system work retry --step checks.checks`).
- **Software Engineering checks through `code-checks.yaml`**, a Sub-workflow
  ([ADR-0002 amendment](../decisions/ADR-0002-work-primitive-configured-workflows.md)).
  The Host reads the Sub-workflows a submit does not send, so an MCP caller
  names `software-engineering.yaml` alone (CQ5).
- **Worker policy and faster checks** (CQ, #42, [PROP-0007](../proposals/PROP-0007-worker-policy-checks-and-merge-queue.md)):
  a `code-write` attempt runs no background jobs and has an optional
  `attemptBudget`; the checks run on the repository's Node, give one-line
  failure reasons, and skip what a change does not touch (`paths`; a change to
  docs alone runs `docs`).
- **The merge queue** (CQ4, [ADR-0008 amendment](../decisions/ADR-0008-dev-integration-branch.md)):
  System moves `dev` by a **push with a lease**, never through GitHub's merge
  endpoint, and only to a commit whose checks passed: the change itself when it
  already holds `dev`'s tip, else its merge with the tip, checked again. Keep
  `dev` without a "require pull requests" protection rule, or that push is
  refused; `dev` has none now.

## 2. Decisions taken

- [ADR-0007](../decisions/ADR-0007-one-long-lived-host.md), [ADR-0008](../decisions/ADR-0008-dev-integration-branch.md) (amended: the merge queue), [ADR-0009](../decisions/ADR-0009-goals-and-orchestrators.md).
- [ADR-0010](../decisions/ADR-0010-core-budget-rebaselined.md): the core budget is measured from 3,403 lines (after OC), +10% per milestone, paid within the milestone.
- [ADR-0002](../decisions/ADR-0002-work-primitive-configured-workflows.md) amended: Sub-workflows, joined at admission.
- Proposals accepted: [PROP-0004](../proposals/PROP-0004-host-design.md) (the Host), [PROP-0005](../proposals/PROP-0005-chatgpt-website-worker.md) (the ChatGPT Website Worker, with the Terms-of-Use risk), [PROP-0006](../proposals/PROP-0006-replaceable-orchestrator-and-code-checks.md) (OC), [PROP-0007](../proposals/PROP-0007-worker-policy-checks-and-merge-queue.md) (CQ).
- [PROP-0003](../proposals/PROP-0003-conversation-ingestion.md): implemented; its status is still `draft`.

## 3. Evidence

Gates are checked item by item in [PLAN.md](../../PLAN.md): milestones H, O,
OC and CQ, each step with a test that failed first.

**Checks on `dev` (6d92315), 2026-11-08,** each part as `.system/checks.yaml`
runs it, under `env -i` with a fresh HOME: docs, install, build and typecheck
pass; smoke 74 of 74 pass; unit 473 of 474 pass. The one failure is
`chatgpt.test.ts`, whose Chrome launch has a 1.5 s limit; it is fixed on
`web-workers`.

**Check time.** The machine stayed at a load of about 400 all night, so `dev`
was compared with the speed pass F (1adb430), measured the same way at the
same load. Unit took 178 s on `dev` against 40 s on F. Without the three
headed-browser test files of WW (`chatgpt`, `remote-login`, `driver`) it takes
20 s; those three alone take 181 s. So the overrun is WW's browser tests, which
`web-workers` moves to a separate `test:web`. Once that is on `dev`, the
required checks are back under 3 minutes. Smoke took 85 s against 75 s on F
(PLAN, the growth at OC).

**The merge queue on github.com:** on `web-workers` System merged Works by a
leased push. `work:a62a77b5` (c92698f) and `work:12dc89aa` (17e8e31) already
held the tip and went in as they were. `work:6503fb30` was checked on bbc0cfb
while the branch had moved to 17e8e31: System merged the two, checked the merge
and pushed it as 38b1d71, whose parents are 17e8e31 and bbc0cfb ("checked on
its merge with 17e8e31a502c"). Both paths have run against GitHub.

**Defects found and fixed in this range** (besides those of the first report):
- a parallel merge of three passing changes turned `dev` red (L1, #33): two
  races in the remote sign-in. The merge queue now prevents this kind of
  break: each merge is checked against the tip it lands on;
- a stop signal sent right after the Host said `listening on` was lost, and the
  Host never stopped (CQ5; it was the flaky SIGTERM test);
- a check failing for a reason outside the change could only be run again with
  a new attempt (OC5: verify again);
- an Orchestrator could re-run a failed check until a lucky pass, and
  `code.required-checks` could read a change's own checks file (fixed in the
  review of #39).

## 4. What System did itself

Costs are **API-equivalent estimates, not billing**
([ADR-0005](../decisions/ADR-0005-subscription-tokens-for-workers.md)). PRs
#5–#28 and their numbers are in the report of 2026-11-07 (git history of this
file): 25 merges, 607 minutes over 20 Works with data, 35.17 USD over 14.

| PR | What it did | By |
|---|---|---|
| #29 | the first release report | System Work 4475c1cc |
| #30 | W2: remote sign-in over SSH | System Work ea4c284b |
| #31 | A: faster checks, test files in parallel | System Work 9f8582cc |
| #32 | D: the Host restarts itself on new code | System Work f9a49438 |
| #33 | L1: the parallel-merge races of W2 | System Work d58e7781 |
| #34, #35 | W5, W7: System 1's browser runtime and ChatGPT driver | operator's sessions |
| #36 | W8: answer blocks read with their fences | System Work 7a32d11a |
| #39 | OC (PROP-0006) | Development session |
| #42 | CQ (PROP-0007) | Development session |

The minutes and usage of Works #29–#36 were not read for this report: that
needs `system work report` on the live Host, which this session does not use.

## 5. Open pull requests into `dev`

None is merged; each waits for you.

- **#45, B:** a profile patch merges into the bundle's config instead of
  replacing it, accounts by `ref` (JSON Merge Patch for objects, Kubernetes'
  strategic merge for keyed lists; `$patch: delete`, `$patch: replace`), by a
  pnpm patch of `dsh-app-boot`. **Behaviour change:** an overlay that dropped
  a bundle account by leaving it out now keeps that account. Your live overlay
  is `[]`, and WW's overlay re-sends every account by `ref`, so neither
  changes. It also fixes a flaky Brainstorm kill test.
- **#46, E:** the Dependabot recheck. The 11 open alerts (undici, the MCP
  client, zod) are fixed on `dev` and close when `dev` reaches `main`. It also
  raises fflate to 0.8.3 (moderate; through DSH's office skills, which the
  profile does not mount).
- **#48, PLAN:** the check-time finding above, self-restart (D) ticked, and the
  core debt's proposed cuts.

PR #4 (conversation ingestion and decisions, into `main`) is still open; its
content is on `dev`.

## 6. Open items and risks

- **Core debt, your decision** ([ADR-0010](../decisions/ADR-0010-core-budget-rebaselined.md)).
  The core is 3,420 lines. Cuts without dropping a feature come to about 35
  lines. Feature drops (Goals, live progress, Sub-workflows, conversation
  intake) are listed in #48 for you to decide.
- **Docs budget.** `docs/` is about 4,990 lines, over the 4,285 limit. This
  report is dated: delete it after the merge into `main`.
- **ChatGPT Terms of Use.** An automated session is against OpenAI's Terms; you
  accepted that risk for your own account. System stops at a sign-in wall or a
  CAPTCHA.
- **Not exercised for real:**
  - the attempt budget against a real Claude Code attempt;
  - live progress reported by a real Claude Code attempt to the live Host;
  - an Orchestrator driven by a real agent over `system mcp`.

## 7. Merge checklist

1. Review this report, and decide #45, #46 and #48 (merge #46 first if you want
   the alerts closed with this release).
2. Close PR #4, or merge it first: its content is already on `dev`.
3. Merge `dev` into `main`.
4. Restart the Host on the code you run it from: it restarts itself on new code
   on disk (D), or `systemctl --user restart system`.
