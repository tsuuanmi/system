# ADR-0070: Workers that share no session work through a task's dossier

- **Status:** Proposed
- **Date:** 2026-10-26
- **Related:** T233, T230, T232, [PROP-0015](../../proposals/0015-right-worker-right-job.md) E6,
  [ADR-0015](0015-worker-sessions-and-peer-messaging.md),
  [ADR-0061](0061-a-tasks-next-attempt-starts-from-the-work-its-previous-attempt-left.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-12](../../architecture/invariants.md#inv-12-data-egress-is-explicit)

## Context

The operator (2026-10-26): "Workers that cannot be messaged communicate through artifacts: follow
the artifact, update what was done into it, the reviewer writes the review into it, update the
source code."

Today a board task's work crosses Workers in several ways, and none of them is one record:

- **A session** carries a Worker's own conversation (T232 continues one), but only on its Worker.
- **A step that moves off its session** (T230) is handed the earlier turns' results as `prior`
  pointers, which are whole answers, not what the work needs next.
- **A new attempt** points at the previous attempt's result, its digest, and the decision behind the
  attempt; the plan, what remained, and why a choice was made are lost unless the answer said them.
- **A review** reads the task, its criteria, and the exact change (PROP-0008's goldfish): good, but
  the fix that follows is told only the blocking findings, and nobody records which finding a fix
  answered.

PROP-0015 E6 (handoffs) names the model: an informed author, fresh-context critics, a human
accountable; a child gets the spec and evidence, never the author's transcript.

## Options

1. **Messages between sessions** (ADR-0015). A website Worker, a model Worker, or a step on another
   Worker has no session to be messaged in, and a message is not a record the next attempt reads.
2. **Copy each step's answer into the next brief.** Unbounded, and the reviewer would read the
   author's conversation.
3. **One append-only record per task, carried across its attempts, written by the Workers through a
   narrow gate and by the engine for its own evidence; every brief points at a bounded slice of it.**
   Chosen.

## Decision

- **The dossier is the task's**, not a run's: its entries outlive runs and attempts. Each entry is a
  content-hashed artifact, `task-dossier-entry@1.0`, of one kind: `plan` (the author at the start:
  approach, files, risks), `progress` (after a step: what was done, commits, what remains, small
  decisions and why), `review` (a reviewer's findings, bound to the subject it reviewed, its result
  and assessment linked, not copied), `response` (the author per finding: fixed in which commit, or
  not and why), `evidence` (the System's: checks and acceptance, the report to the board, the
  landing; and, since T267, a writing step's own: the output of the checks it ran, told by its author).
- **Append-only and versioned.** Entries are numbered per task from 1, with no gap (`seq`), and each
  names the entry before it (`prev`): the dossier at an entry is a hash chain. The engine lists them
  in `workflow_dossiers` (migration 23), whose rows reference the artifacts (so retention keeps
  them); a trigger refuses any update. An entry is never rewritten: a correction is another entry.
- **Who writes.**
  - The engine writes the System's `evidence` (acceptance, report, landing); a Worker never writes
    that, but a writing step's Worker writes its own `evidence`, the output of the checks it ran
    (T267: its author is the Worker, so a reader never mistakes it for a check the engine ran).
  - For a step that appended nothing itself, the engine writes the step's entry when it settles: a
    review's verdict and findings from the assessment its exact-subject gate stored; a website or
    model Worker's answer as it is (it has no tool of its own); an agent Worker's answer linked, never
    copied. A fix grown by a review is a `response`; any other step is `progress`. A review's
    assessed entry is written even after its reviewer appended its own, which is bound to the
    subject the step reviews.
  - A Worker appends its own entries through `dossier_append`, a tool its run holds, never one of
    System's own MCP surface. Its Worker source binds the tool to the step the run serves when it
    builds the run: the workflow run, the step, and the execution, from the source's own record of
    the run, never from the agent's input, which names only the entry. The entry's author is that
    step's Worker. The engine takes it only while that execution is the one its step runs, only the
    kinds its role writes (a writing step `plan`, `progress`, `response`; a review `review`; any
    other step `progress`), text of 1 to 4,000 characters, at most 16 commits as hex ids and 16
    links to stored artifacts, a response's `inReplyTo` an entry of the same dossier. Anything else
    is refused and nothing is appended (INV-2). A tool that took the step as an argument would let
    any holder of a client token write as a running step's Worker, and so is not offered.
  - **An agent Worker's run** gets `dossier_read` and `dossier_append` as **host tools** (the
    agent-runtime seam's `RunSpec.hostTools`): tools its source binds to the run, answered in
    System's own process, which a runtime that reports `RuntimeEvidence.hostTools` offers its agent
    as the MCP server `system` (`mcp__system__dossier_append`), each call passing the run's tool gate
    first like any other (`dossier_read` a `read`, `dossier_append` a `workspace-write` of System's
    own record) and its input checked against the tool's closed schema. Claude Code offers them, as
    an in-process server of its SDK. A runtime that does not (Codex, ACP, the Antigravity CLI today)
    gets none, and its step is recorded by the engine, its answer linked. A review member's run gets
    none: its profile allows no tool call.
- **Who reads.** Every step's brief of a task's run points at a slice of the dossier as it stands
  when the step starts (`task-dossier@1.0`, role `context`): a summary (entries by kind, which are
  left out, among them the plans, reviews, and responses, and where to read them) and the latest
  entries that fit within 6,000 characters, newest last. A source that places a brief's files also
  writes the whole dossier as `.system/DOSSIER.md` (within 200,000 characters), and `dossier_read`
  pages through every entry whole. The slice and the file are rendered by the engine from the
  entries, never by a model, and are at least as strict as what they hold (INV-12).
- **A reviewer reads the dossier, never the author's transcript.** The dossier holds only what was
  appended to it; an agent's answer is linked, and a review's brief carries no session to resume and
  no pointer at the author's result.
- **Where it continues.** When a session continues (T232), its steps still write the dossier. When
  a step moves to another Worker (T230's handoff, a fix routed elsewhere, a new attempt), the
  dossier is what carries the work: the step's brief holds its slice.

## Consequences

- A fix on another Worker, a new attempt, and a reviewer all start from the same record: the
  author's plan and progress, the review's findings, the System's evidence.
- Every brief of a task's run after its first entry is up to about 6,000 characters longer; a
  Worker's input bound counts it (ADR-0032), so a website Worker with a small bound may be refused a
  step it took before.
- `dossier_read` is an MCP tool of System's own surface too (`client` scope: the lead and the
  operator read a task's dossier); `dossier_append` is not, so neither can write as a Worker.
- On Claude Code, an agent author writes its plan, progress, and responses itself, and a reviewer
  its review. On a runtime without host tools, an agent's step is recorded by the engine, its answer
  linked, and it reads the dossier in its brief and in `.system/DOSSIER.md`; giving such a runtime
  the tools (Codex through a sibling of the workspace reads server that relays its calls to System)
  is a later change.
- The dossier's rows name its entries, and its entries link what they record, so retention keeps a
  task's dossier, and the results and decisions it links, after the runs that wrote it are deleted:
  at most 10,000 entries of at most 16 links each per task (INV-9).
- `ctx.workflow` gains `dossier`, `readDossier`, and `appendToDossier` (the latter two bound to a
  step's execution) without a new contract of its conformance suite; a second provider of the seam
  would need one. The agent-runtime seam gains `HostTool`, `RunSpec.hostTools`, and
  `RuntimeEvidence.hostTools`, additive.

## Rejected alternatives

The options above; also: a mutable document per task (two Workers' edits would race, and no reader
could tell what changed since it read it); a dossier per run (a new attempt would start from
nothing); and a model's summary of the dossier in every brief (a summary is a claim, the entries
are the record).
