---
status: active
summary: What existing projects, Claude Code primitives, and open standards already do for each core component of the Base version, and whether to adopt, adapt, or avoid each.
---

# Ecosystem for the Base version: adopt, adapt, avoid

Non-normative. Researched on 2026-10-22 for [PROP-0010](../proposals/0010-base-version.md).
Statements about products and policies are as published on that date and change often; each
links to its source. Projects marked *not checked* were named but not verified in this round.

## Conclusion

Nothing found covers `system` as a whole, and nothing can replace a core component: each is a
guarantee seam that fails closed, so `system` owns it
([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)). But almost every
Base milestone has a primitive to build on:

- **Adopt** Anthropic's own sources and primitives: the Agent SDK's result message for usage,
  the status line's `rate_limits` for plan windows, `@anthropic-ai/sandbox-runtime` for confined
  commands, and PreToolUse hooks with `defer` for approvals.
- **Adapt** protocols and schemas from open standards: A2A task states, OpenTelemetry GenAI
  usage attributes, MCP `server.json` and its conformance runner, the Claude Code plugin
  manifest, DBOS's step checkpoints.
- **Avoid** code under restrictive licenses and projects whose maintainer has stopped.

Four mechanisms have no existing implementation, so `system` would be first:

1. one resource ledger across several subscriptions and APIs, with shadow prices;
2. one batched approval queue, with expiry that fails closed, across Workers;
3. charters and funding rounds as the governance of agent work;
4. a measured shadow → canary lifecycle for LLM plugins (decision, digest, verification).

## By core component

### Ledger of record

| Source | Learn | Decision |
|---|---|---|
| [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai) | usage vocabulary: `gen_ai.provider.name`, request vs response model, `gen_ai.usage.input_tokens` (includes cached tokens), `cache_read` and `cache_creation` input tokens, reasoning output tokens; detailed counts are subsets of the total | adapt: name the fields of `usage-record` after it, so an OTLP export costs nothing later. The conventions are still in Development |
| [A2A](https://a2a-protocol.org/latest/specification/) task and artifact | a terminal task is immutable; a refinement is a new task in the same context | adapt: fits the append-only ledger; a refinement is a new artifact with lineage |
| W3C PROV, OpenLineage | entity, activity, agent model of provenance | *not checked* |

Two lessons from [ccusage](https://github.com/ryoppippi/ccusage) apply to the ledger now: dedupe
usage by request or message id, or totals inflate; and store the price version with each record,
or history is repriced whenever prices change.

### Work state machine and board (B4)

- **[Backlog.md](https://github.com/MrLesk/Backlog.md)** (MIT, TypeScript): the closest match to
  board tasks with a `TASKS.md`. A task is a Markdown file with acceptance criteria, a
  definition of done, milestones, and dependencies; an MCP server and a workflow resource guide
  the agent; "one task, one context window, one PR", with review at spec, plan, and
  implementation. **Adapt** the task format, the three checkpoints, and the workflow resource.
  **Do not adopt it as the store**: it keeps Markdown as the source of truth, while `system` keeps
  SQLite and projects `TASKS.md`.
- **[claude-task-master](https://github.com/eyaltoledano/claude-task-master)**: PRD to task
  graph with dependencies. Its license is MIT with the Commons Clause. **Avoid** its code and
  prompts; the idea of a dependency-aware graph from a spec is common knowledge.
- **A2A task states** (`submitted`, `working`, `input-required`, `auth-required`, `completed`,
  `failed`, `canceled`, `rejected`) separate active, interrupted, and terminal states, and give a
  task no deadline. **Adapt**: split the board's `blocked` into waiting for input and waiting for
  approval, and add the expiry A2A leaves out.
- **vibe-kanban** (Apache-2.0): a board, a worktree per task, and diff review. Its company closed
  on 2026-04-10 and its agents run with permission checks skipped by default. **Avoid** as a
  dependency; **adapt** the review flow, and plan worktree cleanup from the start.

### Runner

- **[DBOS Transact](https://github.com/dbos-inc/dbos-transact)** (MIT): an in-process library
  that checkpoints each workflow step in the database and resumes from the last completed step;
  queues with concurrency and deduplication; notifications with timeouts; patching of running
  workflows (March 2026). Closer to "restart is reconciliation, not replay" than Temporal.
  **Adapt** the step table, patch points for templates that run for days, and send and receive
  with a timeout. Not adopted: it needs Postgres, and its decorators conflict with the plugin
  host.
- **[Temporal](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python)**: approval by a
  signal and a condition with a timeout. It needs its own server and replays deterministically.
  **Adapt** the pattern, **avoid** the dependency.
- **LangGraph** `interrupt` and resume: the node runs again from its start, so everything
  before the interrupt must be idempotent. The same rule as the crash suite at every reconcile
  point.
- None of them defines what happens when an approval expires. Fail closed on expiry is
  `system`'s own guarantee.
- Restate, Inngest, Hatchet, Trigger.dev: *not checked*; check the server license first.

### Gate and approval queue (B5)

- **Agent SDK permissions**
  ([permissions](https://platform.claude.com/docs/en/agent-sdk/permissions),
  [hooks](https://code.claude.com/docs/en/agent-sdk/hooks)): evaluated as hooks, deny rules, ask
  rules, permission mode, allow rules, then `canUseTool`. **Adopt** as the Worker-side
  enforcement. The autonomy matrix compiles to a PreToolUse hook: forbid → `deny`, ask →
  `defer`, notify → `allow` and an event, auto → `allow`. A hook's deny holds in every mode.
- **`canUseTool` is not a gate**: tools approved by an allow rule or a permissive mode never
  reach it. The fail-closed check belongs in the PreToolUse hook.
- **`defer`** ends the turn with the tool call kept in the transcript, and the hook runs again on
  resume. Limits: one tool call per turn, print mode only, and open bug reports on resume. Design:
  the approval queue is the source of truth; on expiry it records a `denied:expired` decision and
  resumes with deny; a turn with several tool calls is denied with a reason so the agent proposes
  again. Known bugs become conformance tests.
- **HumanLayer**: its approval SDK is deprecated by its own README. **Avoid**.
- **Egress**: the sandbox runtime's network proxy enforces an allow-list at the OS level;
  classification and the secret scan stay in the gate.

### Resource ledger and metering (B2)

Objective sources, all **adopted**:

1. the Agent SDK's result message for every `query()`, failures included: `total_cost_usd`,
   `usage`, and per-model `modelUsage` with cache read and cache creation tokens
   ([cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)). The cost is an
   estimate computed client-side, and `usage` covers the main loop only: subagents appear in
   `modelUsage`. A crashed process writes no result message;
2. the status line's `rate_limits.five_hour` and `seven_day`, each with `used_percentage` and
   `resets_at`, for Pro and Max plans, after the first response
   ([status line](https://code.claude.com/docs/en/statusline)). The field once went missing in a
   release ([#45133](https://github.com/anthropics/claude-code/issues/45133)), so readers must
   accept its absence;
3. the session transcripts under `~/.claude/projects/` for reconciliation. They are deleted
   after 30 days unless `cleanupPeriodDays` is raised.

Tools:

- **[ccusage](https://github.com/ryoppippi/ccusage)** (MIT): reads those transcripts, knows the
  five-hour blocks, and covers many agent CLIs. **Adopt** its `--json` output as the oracle in the
  metering conformance suite; **adapt** its block logic and deduplication.
- **Claude-Code-Usage-Monitor** (MIT): burn-rate forecasts to the end of a block. **Adapt** for
  reservations and for the scarcity term of shadow prices.
- **[LiteLLM proxy](https://docs.litellm.ai/docs/proxy/virtual_keys)**: budgets and rate limits
  per key, team, or tag; several windows per key and budgets per model are Enterprise features.
  **Optional** for API Workers only, as one more usage source; the ledger stays the source of
  truth.

**Plan policy is the largest risk, not technology.** Anthropic announced on 2026-05-13 that from
2026-06-15 Agent SDK and `claude -p` use would draw on a separate credit; its help article
[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
then said the change was paused ("For now, nothing has changed"), and on 2026-10-07 added that
Max and Team plans include a monthly API credit covering the Agent SDK, `claude -p`, the API, and
Managed Agents. Third-party harnesses were cut off from plan limits in April 2026
([The Next Web](https://thenextweb.com/news/anthropic-openclaw-claude-subscription-ban-cost)).
So the ledger models **pools and windows as configuration** (an account has an interactive
window, a programmatic credit, an API key), never a hardcoded Claude Max assumption, and a
Claude Code Worker run through the SDK may draw on a different pool than interactive use.

### Plugin host, manifests, lifecycle (B7)

- **Claude Code [`plugin.json` and `marketplace.json`](https://code.claude.com/docs/en/plugins-reference)**:
  `userConfig` with a sensitive flag that sends secrets to secure storage, `dependencies` with
  semver ranges, `defaultEnabled: false`, `renames` to migrate names, and `claude plugin validate`.
  **Adapt** the structure, immutable names with renames, and a validator.
- **MCP [`server.json`](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md)**:
  a schema versioned by date, and the registry's `_meta` (status, published, latest) kept apart
  from what the publisher declares. **Adapt**: the plugin declares; the host owns the lifecycle
  state (candidate, shadow, canary, default, retired).
- OpenFeature, Argo Rollouts, Flagger for traffic splitting and rollback: *not checked*. No
  project found runs agent plugins in shadow mode with automatic scoring.

## By plugin family

- **Worker.** The Agent SDK is a required dependency. Its TypeScript package is under Anthropic's
  Commercial Terms: depend on it, never vendor or fork it. Sessions offer `resume` and
  `forkSession`; a session keeps the conversation, not the files, and resumes on the same machine
  only, so the git worktree holds the file state.
- **Decision.** `used_percentage` and `resets_at` are the scarcity signal; no open project routes
  by plan window.
- **Verification.** [`@modelcontextprotocol/conformance`](https://sunpeak.ai/blogs/mcp-app-conformance-testing/)
  (a pinned runner with suites per spec version) is the model for every seam's conformance runner.
- **Digest.** Each claim cites an artifact hash and a verbatim quote for the quote check; a
  reviewer reads a forked session so the original stays clean.
- **Context.** Serena, RTK, context-mode, Tool Search stay fail-open context plugins, measured by
  cache reads over input tokens from the ledger.
- **Knowledge.** Index the content-addressed artifact store rather than adding a memory server.
- **Surface.** The Claude Code status line is the cheapest place to show windows, budgets, and
  pending approvals to the operator.

## Plan by milestone

| Milestone | Adopt | Adapt |
|---|---|---|
| B1 Specification | — | schemas with a dated `$schema` (MCP `server.json`); transition tables with active, interrupted, and terminal states (A2A); a pinned conformance runner per seam (MCP conformance); a manifest validator (`claude plugin validate`) |
| B2 Resource ledger | SDK result message; status line `rate_limits`; transcripts for reconciliation; `ccusage --json` as test oracle | `usage-record` named after OTel GenAI, plus account, pool, price version, and request id for dedup; pools and windows as configuration; reservations by burn rate |
| B3 Claude Code Worker | Agent SDK `resume`, `forkSession`; `@anthropic-ai/sandbox-runtime` around the Worker (writes and network denied unless allowed) | a worktree per writing task with a cleanup job; `default` or `dontAsk` mode, never `bypassPermissions`; usage from `modelUsage` for the whole tree |
| B4 Board | — | SQLite as source of truth; `TASKS.md` in Backlog.md's format; an MCP workflow resource; `blocked` split into input and approval, with expiry |
| B5 Approval queue | PreToolUse hooks with `deny` and `defer` | one batched queue with `expires_at`; expiry records `denied:expired`; several tool calls → deny with a reason; known `defer` bugs as conformance tests |
| B6 Brief and digest | SDK fork sessions for reviewers | briefs of artifact pointers, open questions, remaining budget; `digest@1.0` claims with citations and quotes |
| B7 Plugin manifest | — | seams provided and consumed with semver; sensitive config into the vault; immutable names with renames; lifecycle state in a host-owned `_meta`; shadow runs write artifacts nobody consumes, scored by verification |
| B8 Pilot | `ccusage` as an independent baseline | measure tokens and cost by pool, window use, approvals per day and wait time, cache read ratio, operator interventions |

## Risks

- **Policy.** Anthropic's plan terms for the Agent SDK changed three times in five months.
  Driving ChatGPT and Gemini websites carries more terms-of-service risk than APIs, which supports
  keeping website Workers after Base.
- **Licenses.** The Agent SDK is proprietary (depend, do not redistribute); claude-task-master
  carries the Commons Clause; some neighbouring products are ELv2 or AGPL. Do not mix their code
  in.
- **Maturity.** `sandbox-runtime` and `defer` are beta with open bugs, and `rate_limits` went
  missing once. Every reader tolerates absent fields, and metering keeps a second source.
- **Coverage.** Not checked in this round: claude-flow, ccswarm, oh-my-opencode, SuperClaude,
  BMAD, MetaGPT, ChatDev, CrewAI, Langfuse, Helicone, Portkey.
