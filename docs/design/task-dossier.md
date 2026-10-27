# A board task's dossier

> Target state. Decision: [ADR-0070](../decisions/adr/0070-workers-that-share-no-session-work-through-a-tasks-dossier.md).
> Shapes: [`task-dossier-entry.v1.json`](../../schemas/task-dossier-entry.v1.json),
> [`task-dossier.v1.json`](../../schemas/task-dossier.v1.json).
>
> Built in T233 (`fd3449de`); ADR-0070 accepted 2026-10-27. Implemented in
> [`workflow`](../../packages/plugins/workflow/README.md) (`src/dossiers.ts`) and,
> for an agent Worker's own tools, [`agent-workers`](../../packages/plugins/agent-workers/README.md)
> (`src/dossier.ts`); differs from target: only Claude Code offers host tools today, so an agent
> Worker on another runtime (Codex, ACP, the Antigravity CLI) holds no dossier tool, its step is
> recorded by the engine, its answer linked, and it reads the dossier in its brief and in
> `.system/DOSSIER.md`.

Workers that cannot share a session, or be messaged, work through one artifact: they follow it,
add what they did to it, and the reviewer writes its review into it ("the elephant–goldfish model",
[PROP-0015](../proposals/0015-right-worker-right-job.md) E6: an informed author, fresh-context
critics, a human accountable). The dossier is that artifact for a board task.

## Entries

| Kind | Written by | What it says |
|---|---|---|
| `plan` | the author, at the start | the approach, the files, the risks |
| `progress` | the author, after a step; the engine for a step that wrote none | what was done, commits, what remains, small decisions and why |
| `review` | a reviewer; the engine from a review's assessment | the verdict and findings, bound to the exact subject reviewed; the review's result and assessment linked, not copied |
| `response` | the author of a fix; the engine for a fix that wrote none | per finding: fixed in which commit, or not and why |
| `evidence` | the engine (the run's checks and acceptance, the report to the board, the landing, an ended attempt's kept change, where a new attempt's tree came from); and a writing step's Worker (T267) | the System's: what it checked, and (T284) the commands a writing step's Worker ran with the exit codes and output tails its runtime reported, which the System records itself (bounded per step, never dropping the last record that shows a check; a background launch or interrupted command with no exit code) and lists when the step's evidence gate settles, check commands first, in as many entries as the entry's bound needs. The author's (optional prose now): the output of the checks it ran, verbatim; told from the System's by its author, and never a check the engine reports. A gate refusal continues the step's session once; a second fails it ("evidence refused twice") |

Every entry is a content-hashed `task-dossier-entry@1.0` artifact. Its `seq` is its place in the
task's dossier, from 1 with no gap, and `prev` names the entry before it, so the dossier at an entry
is a hash chain: an entry cannot be changed or left out unseen. The engine's table
`workflow_dossiers` lists the entries in order; a trigger refuses an update, and the engine only
inserts. The dossier is the task's: it outlives runs, and the next attempt reads the last one's.

## Writing

```mermaid
sequenceDiagram
  participant A as Author (Worker 1)
  participant E as Engine
  participant D as Dossier
  participant R as Reviewer (Worker 2)
  participant F as Fix (Worker 3)
  A->>D: dossier_append plan, progress (gated)
  E->>R: brief + slice of D (no transcript)
  R-->>E: assessment
  E->>D: review (verdict, findings; result linked)
  E->>F: brief + slice of D
  F->>D: dossier_append response (or the engine, its answer linked)
  E->>D: evidence (acceptance, report, landing)
```

- **The tool** (`dossier_append`, with `dossier_read`). A Worker's run holds it; it is no tool of
  System's own MCP surface, where a caller would name the step and be recorded as its Worker. The
  Worker's source binds it to the step the run serves when it builds the run: the workflow run, the
  step, and the execution, from the source's own record, never from the agent's input, which names
  only the entry (`kind`, `text`, `commits`, `refs`, `finding`, `inReplyTo`). The entry's author is
  that step's Worker. An agent Worker gets the two as host tools (`RunSpec.hostTools`) where its
  runtime offers them (`RuntimeEvidence.hostTools`; Claude Code, as an in-process MCP server
  `system`): the agent calls `mcp__system__dossier_append`, the call passes its tool gate first (a
  `workspace-write` of System's own record; `dossier_read` a `read`), its input is checked against
  the tool's closed schema, and an argument it does not have (a run, a step) is refused. A review
  member's run gets none (its profile allows no call); a website or model Worker has no tool, and
  the engine appends its answer.
- **The gate**. Refused, with nothing appended, unless: the run serves a board task and still holds
  it; the bound step is running now, and as the execution bound; the kind is one its role writes (a step
  that writes the change: `plan`, `progress`, `response`, `evidence`; a review: `review`; any other
  step: `progress`; the System's own `evidence` is never a Worker's: it is told by its author); the text holds 1 to 4,000 characters; commits are at most 16 hex ids;
  links are at most 16 stored artifacts; a `response`'s `inReplyTo` is an entry of this dossier.
- **The step's own entry.** When a Worker step of a task's run settles with an accepted result and
  appended nothing itself in that attempt, the engine appends its entry: a review's verdict and
  findings from the assessment its exact-subject gate stored (its result, assessment, and gate
  decision linked); an agent Worker's answer linked, never copied; a website or model Worker's
  answer as it is, cut to the bound (it has no tool of its own). A fix grown by a review writes a
  `response`, any other step `progress`. A review's assessed entry is written even when its
  reviewer appended its own: that one is bound to the subject the step reviews (from the step,
  never from the agent), and the assessed one follows it, bound to the same subject.
- **Evidence.** The task's acceptance decision (the checks the run ran, the last review, notes),
  the report of the run's outcome to the board, and the landing of an accepted result once it is
  committed, asked to merge, and where it ends (merged, returned, refused, rejected, or nothing to
  land; never the steps between) are appended as `evidence`, the decisions and records linked.
- **Attempts, and where each tree came from** (T271). An attempt that ends without its result being
  accepted keeps its change as a commit on its run's branch, and its dossier says so once it is
  settled, as an entry of that attempt: "Attempt N (run …) ended without being accepted; its change
  is kept as commit <sha> on <branch>, on top of <base>, as the attempt's result", the sha in the
  entry's `commits`; or that it is not kept, and why. The next attempt's entry says which tree it
  starts from: "Attempt N+1 (run …) starts from the tree of attempt N (run …): its change is kept as
  commit <sha> …", the sha in `commits`, and what a move of the base did: replayed on the new tip
  without conflict, or a conflict (the files named) that left the tree at the change's own base for
  the Worker to resolve. A fresh start says "starts fresh, not from the tree of attempt N" and why
  (the task opted out, or the change could not be carried). The carry's decisions are linked
  ([starting from the previous attempt's work](workflow-engine.md#starting-from-the-previous-attempts-work)).
- **What a failed check printed (T270).** A Worker cannot open a linked artifact, so a link to the
  `check-run` record alone told the next attempt that its tests failed, never which. For each
  required check that failed on the result's own subject, one more `evidence` entry follows the
  acceptance's, linking it and the `check-run` record, and carrying in its text what failed: the
  failing tests' names and assertion lines, then the run's summary, as the source that ran the
  check read them from the end of its output (`CheckResult.failures`; agent-workers'
  `failureLines`, which drops the rest, such as a tool's noise). Bounded: at most 200 lines of 240
  characters (bounded again by the engine, whatever a source sends), and the entry's own 4,000
  characters. A check that passed, did not run, or failed on another tree adds none.
- A failure to append is logged and never fails the work it records.

## Reading

- **Every step's brief** of a task's run points, once the dossier holds an entry, at a slice of it
  as it stands when the step starts: a `task-dossier@1.0` report, role `context`, rendered by the
  engine within 6,000 characters (code points). It starts with a summary: how many entries of each
  kind, which entries are left out (naming the plans, reviews, and responses among them), and where
  to read them; then the latest entries that fit, newest last, each with its place, attempt, kind,
  author, id, text (the oldest shown cut to what is left), and what it links. Progressive
  disclosure: the slice is enough to continue, and the rest is one read away.
- **The whole dossier** is placed in a run's own workspace as `.system/DOSSIER.md` (a brief file,
  within 200,000 characters) by a source that places files, beside `TASKS.md`; and `dossier_read`
  returns every entry whole, 20 at a time by default and at most 50, from any place.
- **The reviewer reads the dossier, never the author's transcript.** The dossier holds only what was
  appended; an agent's answer is linked, and a review step's brief has no session to resume and no
  pointer at the author's result or brief.

## Where the work moves

- A **continued session** (T232) keeps writing and reading the dossier as any step does.
- A **step that moves off its session** ([T230](sessions-and-messaging.md#a-step-its-sessions-worker-cannot-take)),
  a **fix routed to another Worker**, and a **new attempt** start from the dossier: their briefs hold
  its slice, so the plan, what remains, and the review's findings reach a Worker that never saw the
  conversation.

## Bounds

| Bound | Value |
|---|---|
| An entry's text | 4,000 characters |
| Links and commits per entry | 16 each |
| Entries per task | 10,000 |
| A brief's slice | 6,000 characters |
| The workspace's `DOSSIER.md` | 200,000 characters (the latest 2,000 entries read) |
| `dossier_read` page | 20 entries by default, at most 50 |
