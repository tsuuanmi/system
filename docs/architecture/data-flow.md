# Data flow

> Target state. Boundaries are defined in [components](components.md).

## Single turn (gateway → provider)

```text
client request
  → Gateway: authenticate transport, parse native envelope, extract trusted authority
  → Routing: build work requirement → admission → deterministic route → Worker
  → Capability (Website Core): logical request id → retained result? return it
  → Provider runtime: scheduler lease (account, session) → receipt reconcile
        → driver.prepare → verify model/effort → submit → observe → stable completion
        → receipt COMPLETED → write back auth state (guarded by revision + lease)
  → Website Core: retain result under request id
  → Routing: accept(result, contract)
  → Gateway: stream native response to client
```

## Workflow node

```text
admitted spec (hashed, with provenance)
  → engine: promote READY nodes once dependencies are complete; compute input hash
  → node-result store hit on (run, node, inputHash)?  ── yes → commit, no execution
  → no → new execution (lease, generation, heartbeat)
       → route node objective to its executor: team | worker | effect | gate
       → store result blob → commit output receipt (outputHash) under current generation
  → graph growth (for example, PR reported → append review cycle bound to head SHA)
  → convergence: list the remaining blockers, or report completion
```

## Remote tool call inside a remote turn (client-protocol gateways)

```text
remote model calls MCP tool (turn token)
  → MCP server validates token → turn broker queues call
  → gateway ends the current client response with native tool calls
       (Responses: function_call · Messages: tool_use)
  → client executes the tool locally (its own sandbox + approvals)
  → client sends tool results in a new request
  → broker completes the call → MCP returns inside the same remote turn
```

The mechanism details live in [gateways](../design/gateways.md).

## Restart

```text
host start → validate config/stores → reconcile:
  provider receipts SUBMITTED → WAIT | RECOVER | RESUBMIT (bounded) | AMBIGUOUS (fail)
  RUNNING nodes with expired or foreign lease → RECOVERING → classified retry
→ drivers resume
```
