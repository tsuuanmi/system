# Reference architectures: Claude, ChatGPT/OpenAI, Devin

Non-normative. Researched 2026-10-11 from primary sources where they were
reachable. Items marked **[unverified]** could not be checked against a primary
source.

## Anthropic / Claude

- **Workflows vs agents** ([Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)).
  *Workflows* are LLMs and tools "orchestrated through predefined code paths".
  *Agents* "dynamically direct their own processes". Start with the simplest
  solution. The patterns are prompt chaining, routing, parallelization
  (sectioning or voting), orchestrator-workers (for when "you can't predict the
  subtasks needed"), and evaluator-optimizer. Agents need ground truth at each
  step and can pause for human feedback at checkpoints.
- **Multi-agent research** ([How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)):
  - A lead agent delegates to subagents. This beat a single agent by 90.2% on
    their research evaluation, but used about **15× the tokens** of chat.
  - Token usage explains about 80% of the variance in performance.
  - **Effort scaling** is written into prompts: one agent with 3–10 tool calls for
    simple facts, 2–4 subagents for comparisons, and more than 10 for complex
    research.
  - The **delegation contract** is "an objective, an output format, guidance on
    the tools and sources to use, and clear task boundaries".
  - Subagents "store their work in external systems, then pass lightweight
    references back", which avoids a game of telephone.
  - Errors compound, so the system needs resume from checkpoints and retries.
  - Evaluation starts with about 20 real queries, judged with a rubric. Agents
    that change state are evaluated by **end state**. Human evaluation is still
    needed.
  - It is a poor fit when all agents must share the same context, and for most
    coding, which parallelizes less than research.
- **Claude Code** ([how it works](https://code.claude.com/docs/en/how-claude-code-works)):
  - An agent loop of gather context, act, then verify.
  - **Subagents**, each with its own context, tools, permissions, and *model*.
    Cost can be controlled by routing tasks to cheaper models. A subagent returns
    only a summary.
  - **Hooks** are deterministic lifecycle gates. They are best-effort: a timed-out
    hook does not block, so hard policy belongs in permissions.
  - **Plan mode** proposes a plan without editing.
  - Compaction clears old tool output first.
  - Sessions are stored as JSONL and can be resumed or forked.
- **Context engineering** ([effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)):
  - Aim for "the smallest set of high-signal tokens".
  - Retrieve just in time through lightweight identifiers.
  - Keep structured notes outside the context window.
  - Subagents return about 1–2k-token distilled summaries.
- **Tools** ([writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)):
  - Tools are "a contract between deterministic systems and non-deterministic
    agents".
  - Prefer a few namespaced tools with readable identifiers, a concise or
    detailed `response_format`, actionable errors, and bounded responses.

## OpenAI / ChatGPT

- **A practical guide to building agents** ([PDF](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf)):
  - Maximize a single agent first.
  - Split only for complex logic or overlapping tools.
  - **Model selection:** establish a baseline with the most capable model, then
    swap in smaller models where evaluations still pass.
  - Multi-agent setups use either a **manager** (agents as tools, one controller)
    or **decentralized handoffs**.
  - The guide prefers code-first orchestration over declarative graphs, which it
    says become cumbersome as workflows grow more dynamic.
  - **Layered guardrails:** tools are rated low, medium, or high risk by
    read/write access, reversibility, permissions, and financial impact. Escalate
    to a human on failure thresholds and on high-risk actions.
- **Agents SDK** ([docs](https://openai.github.io/openai-agents-python/)):
  - Handoffs, guardrails that run in parallel and fail fast, sessions, and
    human-in-the-loop.
  - **Tracing:** a trace is one end-to-end operation and contains spans for each
    agent run, generation, tool call, guardrail, and handoff. A `group_id` links
    traces.
- **Deep Research** ([guide](https://developers.openai.com/api/docs/guides/deep-research)):
  - In ChatGPT, an intermediate step clarifies intent and rewrites the prompt.
    The API omits this step.
  - Outputs include every search and tool call, plus inline citations.
  - **Security:** "even read-only MCPs can embed prompt-injection payloads", so
    keep web research and private-data access in **separate phases**.
- **Background mode** ([guide](https://developers.openai.com/api/docs/guides/background)):
  - Long tasks are polled, and streams resume from a sequence cursor.
  - Cancellation is idempotent.
  - Results are deleted unless they are stored.
- **Structured Outputs** ([guide](https://developers.openai.com/api/docs/guides/structured-outputs)):
  - `strict: true` guarantees conformance to a JSON Schema, with
    `additionalProperties: false`, every field required, and nullable unions for
    optional fields.
  - A refusal may not follow the schema. Exact limits **[unverified]**.
- **Codex app-server** ([docs](https://learn.chatgpt.com/docs/app-server)):
  - JSON-RPC with Thread → Turn → Item, where an item is a message, a command, a
    file change, or a tool call.
  - Approvals and steering.
  - The SDK is recommended for automation.
- **Codex cloud tasks:** isolated containers with verifiable evidence through log
  citations (system-card addendum). The launch post was not reachable
  **[unverified]**.

## Cognition / Devin

- **[Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)** (2025):
  - "Share context, and share full agent traces."
  - "Actions carry implicit decisions, and conflicting decisions carry bad
    results."
  - The recommendation is a single-threaded linear agent, with a compression
    model for long histories.
- **[Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working)** (2026), the revision:
  - Review loops where the reviewer **shares no prior context** and sees only the
    diff catch about 2 bugs per PR.
  - Managers that split work, read-only subagents, and a "smart friend" stronger
    model given a fork of the context all work.
  - Parallel-writer swarms still fail.
  - **"Writes stay single-threaded and the additional agents contribute
    intelligence rather than actions."**
- **[Devin manages Devins](https://cognition.com/blog/devin-can-now-manage-devins)**:
  - A coordinator assigns, monitors, resolves conflicts, and compiles results.
  - Each child gets an isolated VM, its own playbook, and a budget.
  - The coordinator reads child trajectories and is woken on events instead of
    polling.
- **Planning and confidence** ([Devin 2.0](https://cognition.com/blog/devin-2), [2.1](https://cognition.com/blog/devin-2-1)):
  - Interactive planning shows files, findings, and a plan that the user edits
    before execution.
  - Green, yellow, and red confidence. Below green, Devin asks questions and
    waits for plan approval.
  - Confidence is "highly correlated with task success".
- **Playbooks:** a procedure, specifications (postconditions), advice, forbidden
  actions, and what is required from the user.
- **[Devin Review](https://cognition.com/blog/devin-review):** findings labeled
  red (probable bug), yellow (warning), or gray (FYI).
- **[Sonnet 4.5 lessons](https://cognition.com/blog/devin-sonnet-4-5-lessons-and-challenges):**
  removing harness-owned memory degraded performance, so memory and handoffs are
  better owned by the harness.
- **[SWE-bench report](https://cognition.com/blog/swe-bench-technical-report):**
  evaluation hygiene. The git remote is removed and the tests are reset before
  hidden tests run.

## Synthesis for `system`

| Pattern | Seen in | Verdict | Where in `system` |
|---|---|---|---|
| Durable DAG for predictable steps; agentic loop inside a node | Anthropic workflows vs agents, OpenAI code-first | **adopt** | [ADR-0012](../decisions/adr/0012-dag-execution-model.md) |
| Orchestrator-workers through runtime growth | Anthropic, Devin manager, OpenAI manager | **adapt** | `plan` artifacts → validated graph growth ([workflow engine](../design/workflow-engine.md#graph-growth)) |
| **Single writer per subject**; parallel fan-out only for read-only work | Cognition (2025, 2026), Claude Code, internet's dedicated writer | **adopt** | [INV-15](../architecture/invariants.md#inv-15-one-writer-per-subject) |
| Workers store results and return references | Anthropic, Codex log citations | **adopt** | [artifacts](../design/artifacts.md) |
| Explicit decision records | Cognition principle 2 (implicit decisions), Devin compression of key decisions | **adopt; our extension** | [INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact); downstream Workers receive upstream decision artifacts with their handoff |
| Full trace sharing | Cognition principle 1 | **adapt** | handoff = synthesis plus decision artifacts plus trace refs; reviewers deliberately get *no* shared context |
| Strict JSON Schema at node boundaries | OpenAI Structured Outputs, Anthropic delegation "output format" | **adopt** | [ADR-0014](../decisions/adr/0014-json-schema-contracts.md); the engine validates even when a Worker cannot constrain its output |
| Delegation contract (objective, output format, tools, boundaries, effort) | Anthropic, Devin playbooks | **adopt** | `work-requirement` `boundaries` and `effort` fields ([schema](../../schemas/work-requirement.v1.json)) |
| Effort scaling for research fan-out | Anthropic | **adopt** | routing tiers plus `effort`; fan-out costs about 15× tokens, so it is gated by tier |
| Frontier baseline, then downgrade where evaluations pass | OpenAI guide, Claude subagent `model` | **adopt** | P4 tiers; PROP-0002 evaluation |
| Engine-owned memory and handoff summaries | Anthropic compaction and notes, Cognition | **adopt** | `handoff` and `report` artifacts, not model-owned notes |
| Plan → approve → execute gate before writes | Devin planning and confidence, Claude plan mode, ChatGPT DR clarify | **adopt** | REQ-WF-11 ([workflow engine](../design/workflow-engine.md#plan-approval-gate)) |
| Risk-rated tools, layered guardrails, hard permissions over best-effort hooks | OpenAI guide, Claude hooks and permissions | **adopt** | `sideEffectClass` on capabilities; policies enforced in routing, not in hooks |
| Independent reviewer without shared context | Devin Review, Anthropic evaluator-optimizer | **adopt** | REQ-TEAM-5 ([teams](../design/teams.md)) |
| Separate phases: web research vs private data | OpenAI DR security guidance | **adopt** | [routing data locality](../design/routing.md#data-locality-policy) |
| Long-running jobs: poll, cursor, persist immediately | OpenAI background mode, Devin wake-ups | **adopt** | provider turn receipts and two-clock completion |
| Tracing as spans grouped per run | Agents SDK | **adopt** | event log spans keyed by run, node, and turn; `explain` walks the lineage |
| Evaluation: small golden set, rubric, end state, hygiene | Anthropic, Cognition | **adopt** | [testing](../engineering/testing.md) and the v1.0 validation area |
| Decentralized peer handoffs, swarms | OpenAI decentralized pattern, Swarm | **reject** | they break single-writer, lineage, and replay |

**Bottom line.** A DAG provides durability and lineage. Each node runs a single
agentic thread inside it. Fan out only for read-only work. Record decisions and
handoffs as typed artifacts. Put a plan-approval gate before any subgraph that
writes.
