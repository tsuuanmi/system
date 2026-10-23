# ADR-0040: Base B6 gives every Worker execution a brief, composed by the engine and rendered by the Worker source

- **Status:** Proposed
- **Date:** 2026-10-23
- **Related:** [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0037](0037-schema-and-protocol-first.md), [ADR-0039](0039-base-guarantee-seam-contract-changes.md),
  [PROP-0010](../../proposals/0010-base-version.md),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-12](../../architecture/invariants.md#inv-12-data-egress-is-explicit),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

PROP-0010 replaces prompt text with a `brief@1.0` for every Worker run: goal, acceptance
criteria, artifact pointers (never copied content), budget, sandbox. Multi-day work becomes a
chain of board tasks, each resuming the agent's native session from a brief. Two guarantee seams
carry a Worker execution: `workers` (the gate: what a Worker is given, and egress) and `workflow`
(the work state machine and runner). Until now the engine rendered the prompt itself, dependency
results copied in, and handed the text to the source. ADR-0036 makes a change to either seam's
contract need an ADR. The question is where a brief becomes a prompt: in the engine, so every
source still receives text, or in the source, which knows its own prompt format and runs the
egress check on what it sends.

## Options

1. **The engine renders.** It records the brief and still passes the rendered text. Sources do not
   change, but pointers are resolved before egress sees them, and a source cannot render a brief
   in its own format.
2. **The source renders.** `WorkerStart` names the brief; each source reads it at start, resolves
   the pointers through `ctx.artifacts`, renders its prompt, and checks egress on that. A shared
   default text rendering keeps the three text sources identical.
3. **The Worker reads the pointers itself** through an `artifact` tool, in windows. Only agent
   Workers could, and only with a tool `system` does not give them yet; website and model Workers
   never could.

## Decision

Option 2. The contracts change as follows.

**`workers` (core: gate).**
- `WorkerStart` gains an optional `brief` (the `objective` artifact's id), and `prompt` becomes
  optional: a start names exactly one. A source renders a brief at start, checks egress on what it
  rendered at the requirement's classification (the work's, as for any prompt), and refuses a
  brief it cannot render (`invalid_input`, nothing sent). Callers that pass `prompt` see no change.
- `WorkerSource` gains an optional `sandbox(worker, runId?)`: the confinement a run on that Worker
  is held to, from the source's configuration, for the brief. A source that declares none runs
  nothing on this machine.
- The default text rendering (`renderBrief`, in `libs`) is pure: the instructions in order, each
  pointer replaced by its artifact's text and never expanded again; for a board task or a brief
  without instructions, the task, goal, criteria, and open questions first; unplaced pointers
  after.

**`workflow` (core: work state machine, runner).** The conformance contract moves to 1.3:
- Every Worker execution is started with a `brief@1.1` recorded before it, in the transaction
  that starts it, and named by its node record (`workflow-node@1.2` `execution.brief`). Its
  instructions are composed at promotion: the template's text and the caller's input as text,
  every dependency's result as a pointer. A plain run's Worker reads the prompt the template
  words, unchanged. Scenario `brief-recorded`.
- A run for a board task briefs every execution from the task: project, task, attempt, goal,
  criteria, budget less the ledger's count, and pointers to its dependencies' results, the
  previous attempt's result, and the decision behind this attempt. Scenario `task-brief`.
- A task's next attempt, or the first attempt of a task that depends on exactly one other,
  resumes the session of the run before it when the template keeps a conversation, the session's
  Worker keeps a native session it can resume now, and the session has served fewer than
  `maxSessionRuns` runs (INV-9); otherwise it starts fresh. The choice is an `admission` decision
  (`workflow.task-session`). Scenario `task-resume`.

`brief@1.1` adds `instructions` and `workflow-node@1.2` adds `execution.brief`: optional fields,
minor versions.

The `digests` capability seam (the digest family) is new; under ADR-0036 it needs no ADR, and it
follows ADR-0037 with its own schema, definition, protocol, and suite.

## Consequences

- What a Worker is given is a reviewable record, linked to every artifact it read (INV-13), and
  egress sees exactly what is sent (INV-12).
- The prompt text a plain run's Worker reads is unchanged; a board task's Worker reads the task's
  goal and criteria first, and its earlier work.
- A source that renders in another format (an agent reading pointers in windows) can do so behind
  the same brief.
- Open, and not decided here: a team's ballot and debate prompts and a remediation step's prompt
  quote sealed records as engine-composed text rather than pointers (see the amendment); the
  board's `run.brief` is not set, since a run has one brief per execution.
- Revisit if a Worker needs pointers it reads itself, or if briefs must survive a run's deletion.

## Amendment (2026-10-23): digests on a task's result, and usage spent on a task

B6's remaining items change one guarantee seam additively and leave the others' contracts as they
are.

**`board` (core: work state machine): contract 1.1** adds one optional method,
`attachDigest(taskId, digest)`. It sets the task result's `digest` once, to a stored
`digest@1.0` report whose sources are exactly the result's artifacts. It is refused while the
reviewer holds the review, because that acceptance binds to the whole result, digest included. No
state moves and no decision is made. A provider at 1.0 has no such method, and its results keep
no digest. Scenario `board.digest-attached` (since 1.1). This settles what the board's contract
must say about a missing digest: a result with none is complete, and a digest never accepts
anything.

**`workflow` (core): no contract change.** The engine asks the `digests` capability seam, when
loaded, for a digest of each board task result that reached the board. It asks after the report,
so the acceptance never waits. One request per run, at most `digestsPerHour` (a new optional
configuration field, default 6) in any hour, recorded as an `admission` decision
(`workflow.task-digest`). A written digest is set through `attachDigest`; anything else leaves it
unset, recorded with why. A board task's brief counts against the task's budget the ledger's
records of the runs that served it and of the executions they started, each once, through
`ctx.resources.usage` (no change to `resources`).

**`digests` (capability, contract 1.1, no ADR needed under ADR-0036)** escalates once: an
economy answer whose every claim failed the quote check is written again on the standard tier,
never higher.

Still open: a team's ballot and debate prompts and a remediation step's prompt stay
engine-composed text. Moving them to pointers would change what the Worker reads. A ballot
quotes fields parsed out of each peer's answer (recommendation, rationale, risks; choice,
confidence, strongest points), and a review ballot quotes findings merged across members, which
no single artifact holds. A remediation prompt lists only the blocking findings of the
assessment, one formatted line each. A pointer would render the whole answer or the whole
assessment instead.
