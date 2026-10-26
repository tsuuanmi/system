# ADR-0076: The lead is a principal of its own, with a closed list of rights System enforces

- **Status:** Proposed
- **Date:** 2026-10-26
- **Related:** T273, [PROP-0016](../../proposals/0016-operating-model.md) (§7 who decides, I2 lead touches
  recorded), D83, D88,
  [ADR-0023](0023-scoped-control-credentials.md) (scopes, the operator token),
  [ADR-0024](0024-agent-workers-confined-for-reads.md) (secret paths),
  [ADR-0060](0060-an-accepted-result-lands-on-the-operators-merge-approval.md) (the landing's merge
  request), [ADR-0064](0064-system-starts-ready-work-under-the-dispatch-action-class.md) (dispatch),
  [ADR-0067](0067-system-accepts-a-listed-branchs-result-on-its-review-and-checks.md) (listed branches),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

The lead's scripts approved dispatch starts, deferred commands, merges, and acceptances with the
operator's token. `system metrics --days 2 --project system` read 404 "operator decisions" in two days
against an L3 line of at most 10 a day, and "lead touches: at least 0, unattributed 76". So L3 could
never be read, and the line between what the lead may decide and what only the operator may decide
(PROP-0016 §7: decides alone, decides and tells, escalates) was kept by nobody but the lead.

What constrains the answer:

- **System enforces, the lead's scripts never do** (INV-2, INV-6): a rule the lead checks of itself is
  the rule that failed.
- **A decision names its decider** (INV-13): the metrics and `/ui` read records, not accounts.
- **The operator's token and its file stay as they are**, and old records are not migrated.
- **The records' schemas.** A `client` decider on `decision@1.x` must carry a team vote, and an
  `approval` decision must be exactly `decision@1.4`, so neither can name a lead as it is; and
  `approval@1.0`'s `by` is closed to `operator` and `policy`.

## Options

1. **Keep one token, and have the lead say who it is in each call.** The operator's token stays the
   lead's; a name in a request is the lead's word. Rejected: nothing is enforced.
2. **A lead scope for every project, in `scopeTokens`.** Three fixed scope files cannot carry a
   project each, and a restart would issue them. Rejected.
3. **A token per project, issued and revoked by the operator, read on each request; a closed list of
   rights checked where each decision is recorded.** Chosen.

## Decision

- **The principal.** `lead-<project>.token` sits beside `operator.token`, owner-only, 32 random bytes,
  the same permissions. `system lead-token issue <project>` creates it (issuing again replaces it, which
  is how it is rotated), `revoke <project>` removes it, `list` names the projects. The token is never
  printed. The host reads the files on each request, so a revoked token is refused with 401 at once and
  neither command needs a restart. `registerSecretPath` covers each file once the host has seen it, so
  an agent Worker never reads it (ADR-0024). The operator's token file is never written.
- **What a lead token is.** To the MCP endpoint and the web UI it is a `client` token that names its
  project (`ToolContext.lead`). It reaches the client tools (the board moves, the answers to Workers,
  `run`, `vote`), and, of the operator's tools, only those flagged `lead` in their spec: today
  `approvals_decide`. In `/ui` it reaches the approval queue and the reviews of its own project, and
  every other route is refused with the reason (403). A tool or route that does not name the lead is the
  operator's: the list is closed by default.
- **Its rights, enforced by the code that records the decision** (`leadMayDecide`, one function):
  1. approve or deny a **command** or a **dispatch** start of its project (the request's
     `requester.projectId` is the lead's project);
  2. accept or reject a **result** of its project whose run's own acceptance recorded a landing on one of
     the project's listed **dev branches** (`devBranches` of the `approvals` row, by project; the branch is
     `outcome.detail.landing.branch`, which System wrote, never the lead's word);
  3. approve a **merge** into a listed dev branch (the base branch of the request's landing);
  4. the board moves and answers to Workers its token already reaches as a client.

  Everything else is refused for the lead token with the reason, and stays the operator's: policy and
  charter changes, a merge or push to a protected branch (`main` and `master` cannot be listed as dev
  branches), a deploy beyond the dev live update, a security alert dismissal, an external send, issuing
  tokens. A branch that cannot be read is not a listed branch. A call with one verdict off the list is
  refused whole: nothing of it is decided.
- **A lead's acceptance is not the operator's.** It is a `client` decider, so the board applies it as it
  applies any non-operator acceptance: a result whose required checks did not pass, a heavy-tier result,
  and the auto-accept rule's conditions still hold it for the operator.
- **Recorded.** Every decision a lead makes has the decider `{type: client, id: lead:<project>}`
  (the `approval` decision of a verdict, the `acceptance` decision, a tie vote's decision). A lead's
  approval or acceptance is `decision@1.10`, a minor that lets a `client` decider decide more than a vote
  (an `approval` decision may be `@1.4` or `@1.10`; a vote's client decider still carries its vote). The
  artifact producer is `system`, ref `lead:<project>`. The operator's decisions keep type `operator`, at decider
  version **2**; a record at version 1 is from before the lead principal, when the lead's scripts used the
  operator's token, and is marked so (`/ui`, the metrics' notes), never migrated or reassigned.
- **Metrics.** Lead touches per task count what the records name: a lead's verdicts in the queue on the
  task's requests, its acceptance of the result, its starts, its decisions on the task's runs. Operator
  decisions per day count the operator principal's decisions only. A lead's merge approval is a touch,
  and unattended completion still allows it as it allows the operator's.
- **`/ui` shows who decided** each accepted result and its merge approval: the operator, a lead
  (`lead:<project>`), or System, with "before the lead principal" on an old record.

## Consequences

- L3's operator-decisions line becomes readable as the lead moves to its own token; the "unattributed"
  figure falls as the old records leave the window.
- **Known limits.** The lead's process runs as the same OS user as the operator's shell, so the token
  boundary is enforced for what the lead sends to System, not against a process that reads
  `operator.token` itself (LD25: the lead never reads a secret; ADR-0024 hides the file from agent
  Workers only). The approval artifact of a lead's verdict says so in its producer and note, but its
  `by` stays `operator`, as `approval@1.0` allows no other value; a later minor version adds `lead`.
  Decisions the lead makes in its own coordination board leave no System record. The dev branches are
  configuration of the `approvals` row: a project not listed has none, so its lead decides no merge or
  acceptance until the operator lists one.
- No store migration. `decision@1.10` is a minor (additive for every reader of an earlier version);
  `approvals-core` gains the optional `decideAsLead` and `devBranches` on the seam, and the `forbidden`
  failure.

## Rejected alternatives

The options above; also: letting the lead approve any request of its project (a policy change of a
project is its project's request too), and a lead right to `main` with a second check (a protected branch
is the operator's, whoever asks).
