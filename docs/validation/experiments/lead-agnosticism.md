# Lead agnosticism

> Experiment 1. State: **ready**, once the live install is updated; nothing has run. A pass/fail
> check with no objective contract, so outside PROP-0011's comparisons. Record:
> [lead-agnosticism-1.record.json](records/lead-agnosticism-1.record.json).

**Question.** Can a lead of another provider family pick up a project that another lead started,
reading the board through `system`'s MCP tools alone, and carry it on without losing or repeating
a step? [PROP-0008](../../proposals/0008-studio-operating-model.md#claude-as-the-default-lead)
makes Claude the default lead "not a lock-in (Codex can lead through MCP)", and `board_brief` is
"one page for an agent new to a project" ([MCP tools](../../reference/mcp-tools.md#board_brief)).
This tests both.

## Pass criteria

All four must hold. Each is judged against the records named in [judging](#judging).

| Id | Criterion |
|---|---|
| C1 | **State read correctly.** B's first summary, written before its first call that is not a read, states what the [handoff snapshot](#the-protocol) shows: the charter's intent, T1 `done`, T2 `running` with its run id (or the state T2 has moved to since), and that milestone m3 has no task. B never claims, runs, proposes, or cancels work the board shows as done, running, or in review, even where the board would refuse it. |
| C2 | **No step duplicated or lost.** At the close each milestone has exactly one `done` task and no other; every attempt was served by exactly one run, and T2's attempt by the run A started; `system report` counts as many reported attempts as runs started, and no attempt as *other*. |
| C3 | **One continuous decision chain.** `system explain` of each run shows every step's egress, route, and acceptance, with no step failed or missing unexplained; the run's view (`result`) gives its `task`: the claim it took (`own`, or `adopted` from the lead's `board_claim`) and the outcome it reported to the board with that decision; T2's run is one chain from A's start to the operator's acceptance, across the handoff; each done task's `lastDecision` is the operator's acceptance of exactly that task's result. |
| C4 | **MCP only.** B's transcript shows only `system` MCP tool calls and no context other than the [opening prompt](#bs-opening-prompt) and the operator's [scripted messages](#the-operators-messages). |

## Setup

**Roles.** The operator approves the charter, accepts each result on `/ui`, merges it, and sends
the scripted messages; nothing else. Session A is the first lead: Claude Code with `system`'s MCP
server (`system mcp-config claude`). Session B is the second lead: preferably the Codex CLI with
the same server (`system mcp-config codex`, served on stdio by `system mcp-stdio`), a provider
family other than A's and than the Workers'; another Claude Code installation with no shared
history is the weaker variant. Record which. The Workers are the pilot's Claude Code Workers.

**The project.** A real gap: `packages/cli/src/bin.ts` dispatches `system events`, `system
conversations`, and `system conversation inspect`, which the runbooks and playbooks use, but the
[CLI reference](../../reference/cli.md) names none of them. Three tasks, one per milestone, each
validated by `node scripts/check-docs.ts` (plain Node, no dependency, no network):

| Milestone | Task | Lead |
|---|---|---|
| m1 | document `system events` | A proposes and runs it |
| m2 | document `system conversations` and `system conversation inspect` | A proposes and starts it; the handoff comes while its run is running |
| m3 | make the docs check fail on a dispatched command the reference does not name | B proposes and runs it, from the charter alone |

**Preconditions.**

1. The live install runs a commit that holds this page; `system health` is healthy. Record its
   version and commit.
2. A clone on a throwaway branch, never pushed: `git clone https://github.com/tsuuanmi/system.git
   ~/experiments/lead-agnosticism-1/system`, then `git -C ~/experiments/lead-agnosticism-1/system
   switch -c exp/lead-agnosticism-1`. Check the gap is still there: `grep -c 'system events'
   docs/reference/cli.md` in the clone prints `0`; otherwise pick another undocumented command
   and record the change. Empty directories `~/experiments/lead-agnosticism-1/lead-b` (B's working
   directory) and `…/evidence`.
3. The pilot's configuration ([name the repository and the Workers](../../operations/pilot.md#name-the-repository-and-the-workers))
   with the clone as the Workers' `workspace`, and `node scripts/check-docs.ts` among the policy's
   `commands` ([change the autonomy policy](../../operations/runbooks.md#change-the-autonomy-policy)).
   If `node` lives under your home (nvm), add its directory to the `agent-runtimes` row's
   `readOnly` ([agent Workers](../../operations/runbooks.md#agent-workers)). `system health`
   shows the developer proving `develop` and `validate`, the reviewer and the digester `review`.
4. Nothing else runs: pause every other active project on `/ui`. Routing picks a Worker by
   capability, not by project, so another project's task would land on these Workers.
5. The algorithm-development row of the [release checklist](../release-checklist.md) is not yet
   verified live: T1 is its first run. If T1 cannot complete for a reason of the Workers or the
   host, stop. The experiment has not started; record it as not run, with the reason.

**B's permissions.** B works in the empty `lead-b` directory and may use nothing but the `system`
MCP tools. For Codex: its read-only sandbox and an approval policy that asks before any command
(`codex --cd ~/experiments/lead-agnosticism-1/lead-b --sandbox read-only --ask-for-approval
untrusted`); the operator approves each `system` tool call and denies anything else. For Claude
Code: deny every tool but the `system` MCP tools in its permission settings. Record the
configuration used.

## The protocol

Every call is made with the client token. `<…>` marks a value from an earlier step. Save each
call's output to `evidence/` as it comes.

| Step | Who | Call or action |
|---|---|---|
| 1 | A | `board_charter` with the [charter below](#the-charter) |
| 2 | operator | approve the `charter` request on `/ui`; the project is `active` on the board's next sweep |
| 3 | A | `board_brief {"projectId":"<projectId>"}` until `state` is `active` |
| 4 | A | `board_propose` [T1](#the-tasks) |
| 5 | A | `run {"template":"algorithm-development","input":"<T1 input>","task":{"taskId":"<T1>"},"clientRequestId":"lead-agnosticism-1/t1/1","waitSeconds":0}` |
| 6 | A | `result {"runId":"<T1 run>","waitSeconds":55}` until it is no longer running; then `board_task {"taskId":"<T1>"}` shows it in `review`, held for you |
| 7 | operator | [accept the review](../../operations/runbooks.md#accept-or-reject-a-review): run `node scripts/check-docs.ts` in the run's worktree, then Accept on `/ui`; commit in the worktree and `git -C <clone> merge system/run/<T1 run>` ([a run's worktree](../../operations/runbooks.md#a-runs-worktree)); send A message M1 |
| 8 | A | `board_propose` [T2](#the-tasks), `writes` naming the HEAD from M1 |
| 9 | A | `run` T2 as in step 5 (`clientRequestId` `lead-agnosticism-1/t2/1`); `board_task {"taskId":"<T2>"}` until `state` is `running` |
| 10 | A | **handoff snapshot:** `board_brief {"projectId":"<projectId>"}` and `board_tasks {"projectId":"<projectId>"}`, saved verbatim as `evidence/handoff-brief.json` and `evidence/handoff-tasks.json` |
| 11 | operator | end session A while T2's run is running; record the time |
| 12 | operator | start session B with the [opening prompt](#bs-opening-prompt) and nothing else |
| 13 | B | its own calls. The operator answers only with the scripted messages: when T2 is held for review, accept and merge it as in step 7 and send M2; when B's m3 task is held for review, the same and M3 |
| 14 | operator | when B reports the project's work done or waiting on you: close the project (`/ui` **Board**, or `board_close {"projectId":"<projectId>","outcome":"achieved"}`, operator scope); export B's transcript to `evidence/` |

A rejected review is part of the run, not a deviation: tell the lead currently in charge with the
scripted rejection message, and let it start the next attempt.

### The charter

```json
{
  "title": "CLI reference: the commands it misses",
  "template": "algorithm-development",
  "classification": "operator-shared",
  "charter": {
    "version": 1,
    "intent": "Every command the system CLI dispatches is named in docs/reference/cli.md. Document system events, system conversations, and system conversation inspect from their code in packages/cli/src, then make the docs check (node scripts/check-docs.ts) fail when a command packages/cli/src/bin.ts dispatches is missing from the reference.",
    "criteria": [
      { "id": "documented", "statement": "docs/reference/cli.md names system events, system conversations, and system conversation inspect, each with the arguments its code accepts", "measure": { "kind": "accepted-results", "target": 2, "comparison": "at-least" } },
      { "id": "kept", "statement": "node scripts/check-docs.ts passes on the branch and fails when a command bin.ts dispatches is missing from docs/reference/cli.md", "measure": { "kind": "tests" } }
    ],
    "constraints": { "deadline": "<seven days from now, ISO 8601>", "notes": ["Throwaway branch exp/lead-agnosticism-1: nothing is pushed or merged upstream", "One task per milestone; each task's validation command is node scripts/check-docs.ts"] },
    "stopRules": [{ "id": "stuck", "condition": "A task has used all its attempts without an accepted result", "action": "stop" }],
    "budget": { "pools": [{ "pool": "<the Workers' pool>", "unit": "runs", "amount": 30 }], "attention": { "maxBatchesPerDay": 6, "maxInterruptionsPerDay": 12 } }
  },
  "milestones": [
    { "id": "m1", "title": "system events documented", "criteria": ["documented"], "state": "planned" },
    { "id": "m2", "title": "system conversations and system conversation inspect documented", "criteria": ["documented"], "state": "planned" },
    { "id": "m3", "title": "the docs check names a dispatched command the reference misses", "criteria": ["kept"], "state": "planned" }
  ],
  "clientRequestId": "lead-agnosticism-1/charter"
}
```

### The tasks

Both of A's tasks are `board_propose` calls with `"projectId":"<projectId>"`,
`"actionClass":"workspace-write"`, `"template":"algorithm-development"`, and `"writes":{"type":"git-head","ref":"<the clone's HEAD>"}`:

| Task | `milestone`, `title`, `clientRequestId` | `goal` | `acceptance` | `run` input |
|---|---|---|---|---|
| T1 | `m1`, `Document system events`, `lead-agnosticism-1/t1` | Add `system events` to docs/reference/cli.md, in the Operations table, with every flag `parseEvents` (packages/cli/src/index.ts) and the `events` case of packages/cli/src/bin.ts accept, and what `--json` prints, written as the other rows are | `[{"id":"docs","statement":"node scripts/check-docs.ts passes","check":"tests"},{"id":"flags","statement":"The row names --run, --node, --session, --turn, --type, --since, --after, --limit, and --json, as the code accepts them","check":"review"}]` | `Document system events in docs/reference/cli.md from its code; change nothing else.` |
| T2 | `m2`, `Document system conversations and system conversation inspect`, `lead-agnosticism-1/t2` | Add `system conversations [--state <state>]` and `system conversation inspect <account> <binding>` to docs/reference/cli.md, from their cases in packages/cli/src/bin.ts and the MCP tools they call | `[{"id":"docs","statement":"node scripts/check-docs.ts passes","check":"tests"},{"id":"rows","statement":"Each row gives the command's arguments and what it prints, as the code does","check":"review"}]` | `Document system conversations and system conversation inspect in docs/reference/cli.md from their code; change nothing else.` |

### B's opening prompt

Give B exactly this, with the project id filled in, and nothing else:

> You lead a software project that `system` runs. You reach it only through the `system` MCP
> tools; do not read files, run commands, or search the web. The project is `<projectId>`.
> Another lead started it and is gone; you have no other context. First read the project's state
> and write a short summary: the charter's intent, each task and its state, any run in flight,
> and what you will do next and why. Then carry the project on until each milestone's work is
> done or waits on the operator. Never start, claim, or propose work the board shows as done,
> running, or in review. When something waits on the operator, say what, and wait for the
> operator's message.

### The operator's messages

Sent verbatim, to whichever lead is in charge, and recorded with their time:

- **M1, M2, M3:** `T<n> is accepted and merged into exp/lead-agnosticism-1; the repository's HEAD is now <sha>.`
- **Rejection:** `T<n>'s result is rejected: <the reason given on /ui>.`

## Judging

| Criterion | Read |
|---|---|
| C1 | B's first summary (its transcript) against `evidence/handoff-*.json`; every `board_*` and `run` call in B's transcript against the board's state at that time |
| C2 | `board_tasks {"projectId":"<projectId>"}` at the close; `board_task` of each task (`attempts`, `run`, `result`); `system report --project <projectId> --since <the charter's approval> --json` (attempts by outcome, accepted results) |
| C3 | `system explain <runId>` and `result {"runId":"<runId>"}` (its `task`) of each run; `system artifact <decision>` of each run's reported outcome and of each done task's `lastDecision` |
| C4 | B's transcript: every tool call it made, and every message it received |

## What to record

Fill [lead-agnosticism-1.record.json](records/lead-agnosticism-1.record.json) and commit it:

- the date, the install's version and commit, the clone's base commit;
- each session: client, version, model, provider family, and B's permission configuration;
- the project, each task's id, who proposed it, its runs, its acceptance decision, and the merge;
- the handoff time and snapshot; each operator message with its time; B's first summary,
  verbatim; B's calls (how many, how many the board refused, how many outside MCP);
- each criterion: pass or fail, with the evidence that decides it; the wall-clock time and the
  interruptions (`system report`); every deviation from this protocol; the outcome, `pass` only
  when all four criteria hold;
- `evidence`: each file kept in `~/experiments/lead-agnosticism-1/evidence` (transcripts, call
  outputs, explains, the report), with its sha256. The files stay outside the repository.

Since T1 to T3 run the `algorithm-development` template end to end on Claude Code Workers, the run
is also evidence for that row of the [release checklist](../release-checklist.md); record it there
too.
