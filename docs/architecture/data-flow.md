# Data flow

> Target state. Boundaries are defined in [components](components.md); mechanisms in
> [design](../design/README.md).

Every step below that chooses between alternatives (tier, route, admission, egress, reconcile,
accept, escalate, recover, grow, gate) writes a decision artifact before its effect
([INV-13](invariants.md#inv-13-every-decision-is-an-artifact)). `system explain <runId>` reads
the chain back.

## Turn

Every entry point (CLI, MCP tool, gateway) starts a workflow run; even a single `ask` is a run
on the engine. The website Worker source is shown; agent Workers take the same route through
the `agents` source, which checks the prompt at egress (Worker class `agent`: the agent runs
here, but its model is remote), runs `ctx.agentRuntimes` under an `agent-run:<id>` lease, and
marks a run as started before the agent acts.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client (CLI, MCP, gateway)
  participant W as ctx.workflow
  participant R as ctx.workers
  participant T as ctx.turns (website source)
  participant E as ctx.egress
  participant S as account scheduler
  participant D as driver on ctx.browser
  participant K as ctx.turnReceipts, ctx.artifacts
  C->>W: start(template, input, tier, classification)
  Note over W: run and nodes stored (WAITING), run lease taken
  W->>W: promote: render prompt, bind input hash (READY)
  W->>R: route(requirement, restrict)
  R->>K: work requirement, tier and route decisions
  R-->>W: admitted Worker and its source
  W->>T: start(key, worker, prompt, decisions)
  T-->>W: execution, durable and queued (node RUNNING)
  Note over T: turn lease taken, heartbeat
  T->>E: check(prompt, classification, website)
  E->>K: egress decision
  T->>S: runTurn(account, session)
  S->>D: openTurn(account state), ask(prompt, mode)
  D->>D: fill composer, read back mode
  D->>K: beforeSend: receipt SUBMITTED (fenced)
  D->>D: send, two-clock completion
  D-->>T: answer, conversation binding
  T->>T: write back refreshed state (revision + lease)
  T->>K: receipt COMPLETED, answer artifact (one fenced transaction)
  W->>T: wait(execution)
  T-->>W: completed, result artifact
  W->>R: accept(result, contract)
  R->>K: acceptance decision
  W->>W: node COMPLETED, run completed
  C->>W: wait / result
  W-->>C: answer
```

A failure before the receipt is retryable by the engine; after it, nothing is resent
automatically except by the turn runtime's own bounded reconciliation
([provider turns](../design/provider-turns.md), [routing](../design/routing.md)).

## Restart

A start is reconciliation, not replay
([INV-4](invariants.md#inv-4-restart-is-reconciliation-not-replay)). Each owner looks at its own
durable rows under its own lease.

```mermaid
flowchart TD
  start["host start: plugins apply, migrations run"] --> turns & agents & wf
  subgraph turns["ctx.turns: each queued or running turn"]
    tl["take turn lease"] --> sub{"running with a<br/>SUBMITTED receipt?"}
    sub -- no: never sent --> run1["run normally<br/>(egress, scheduler, receipt)"]
    sub -- yes --> snap["snapshot the bound conversation<br/>(temporary or unbound: unobservable)"]
    snap --> dec{"reconcile decision"}
    dec -- WAIT --> poll["look again in 5 s<br/>until the deadline"] --> snap
    dec -- RECOVER --> commit["commit the answer<br/>from the page"]
    dec -- RESUBMIT --> run1
    dec -- AMBIGUOUS --> fail1["fail: reconciliation_failed<br/>never resent"]
  end
  subgraph agents["ctx.agentWorkers: each queued or running run"]
    al["take run lease"] --> started{"started<br/>before the stop?"}
    started -- no --> run2["run"]
    started -- yes --> fail2["fail: reconciliation_failed<br/>the agent may have acted"]
  end
  subgraph wf["ctx.workflow"]
    runs["each running run: take run lease"] --> attach["RUNNING nodes re-attach to<br/>their execution (source.get / wait)"]
    runs --> adv["advance the rest"]
    wakes["settle unfinished wakes,<br/>wake sessions with unread mail"]
  end
```

`RESUBMIT` is bounded (`maxResubmits`) and only when nothing new follows the receipt's boundary
and the page does not show the prompt. A lease held by another live process is re-checked when
it would expire ([scheduling and leases](../design/scheduling-and-leases.md)).

## Gateway round trip

Claude Code (`/anthropic`) and Codex (`/openai`) use a website model as their model. The web
model never runs a tool: it proposes calls in text, and the client runs them under its own
sandbox and approvals
([ADR-0022](../decisions/adr/0022-text-protocol-tool-calls-for-website-models.md),
[gateways](../design/gateways.md)).

```mermaid
sequenceDiagram
  autonumber
  participant CL as Client (Claude Code, Codex)
  participant G as gateway (/anthropic, /openai)
  participant TH as gateway-turns threads
  participant W as ctx.workflow (ask run)
  participant M as web model
  CL->>G: request: system, tools, history (model token)
  G->>G: guard, then native envelope to turns and tool specs
  G->>TH: exchange(thread key, tools, turns, tier)
  alt new thread
    TH->>TH: opening prompt: tools described in text, whole history
  else bound thread
    TH->>TH: suffix only: tool results and new user turns
  end
  TH->>W: start(ask, prompt, tier, session or persist)
  W->>M: turn on the bound provider conversation
  M-->>W: answer with call tags in a fenced block
  W-->>TH: run completed (answer)
  TH->>TH: parse call tags, offered tools only
  opt no call and the model claims no access
    TH->>W: one nudge turn in the same conversation
  end
  TH->>TH: bind thread to the session
  TH-->>G: text and tool calls
  G-->>CL: native tool calls (tool_use / function_call), SSE
  CL->>CL: run the tools (own sandbox, approvals)
  CL->>G: next request with tool results
```

A call tag looks like `<call tool="Read">{"file_path": "/abs/path"}</call>`. Each exchange is an
ordinary `ask` run, so it is routed, egress-checked, receipted, and explainable.

## Workflow node lifecycle

Node states are those of `workflow-node@1.0`. A run is `running` until every node is
`COMPLETED` (run `completed`) or one node is `FAILED` (run `failed`). The design's `RECOVERING`
is not a stored state: a recovery is a `recovery` decision that moves a node back to `READY`, and
after a restart a `RUNNING` node re-attaches to its execution.

```mermaid
stateDiagram-v2
  [*] --> WAITING: run start, or step appended by graph growth
  WAITING --> READY: dependencies COMPLETED, prompt rendered, input hash bound
  WAITING --> BLOCKED: gate after a planner, waits for approval of the exact plan
  WAITING --> COMPLETED: team converged, answer carried
  BLOCKED --> COMPLETED: approved by operator or policy (approval artifact, gate decision)
  BLOCKED --> FAILED: rejected (plan_rejected)
  READY --> RUNNING: routed (tier, route decisions), started on the source
  READY --> READY: admission failed, retryable and never sent (recovery decision, backoff)
  READY --> FAILED: admission failed, not retryable or attempts exhausted
  RUNNING --> COMPLETED: accepted, and the exact-subject gate passed
  RUNNING --> READY: rejected and escalated a tier, or failed before sending (retry)
  RUNNING --> FAILED: rejected, failed after sending, stale subject, or stopped
  FAILED --> READY: operator continue (input bound)
  FAILED --> WAITING: operator continue (input not bound yet)
  COMPLETED --> WAITING: upstream result superseded (lineage invalidation)
  COMPLETED --> [*]
```

- **Graph growth:** an accepted plan appends its steps and a gate; a review that requests changes
  appends a fix step and a new review, up to `maxReviewCycles` (a `graph-growth` decision).
- **Stop:** every unfinished node fails as `stopped`, and running executions are cancelled
  through their sources; nothing is resent.
- **Continue:** reopens one failed node, or every node a stop failed, as a new attempt.
- **Supersede:** replaces a completed node's result; every node downstream returns to `WAITING`
  with a `recovery` decision, so nothing stale is reused.

Details: [workflow engine](../design/workflow-engine.md), [teams](../design/teams.md).
