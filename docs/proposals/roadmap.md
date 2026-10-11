# Roadmap

Non-normative. This is an ordered queue of milestones for
[PROP-0001](0001-unified-system-architecture.md). Each milestone ends with
working, tested software and updated canonical docs.

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 Kernel + engineering** | Bun workspace, CI, doc checks, `kernel` (store, blobs, events, leases, hashing) | migrations tested; revision and generation fences proven by concurrency tests |
| **M1 Provider runtime + ChatGPT Web** | BrowserPort, account vault, remote login, scheduler, receipts, `chatgpt-web` driver, CLI `turn` | crash-mid-turn tests resolve to WAIT, RECOVER, RESUBMIT, or AMBIGUOUS; manual live turn passes |
| **M2 Capabilities + routing** | Website Core, local exec capability, registry, admission, router, acceptance | fail-closed admission tests; deterministic routing tests |
| **M3 Orchestration** | workflow engine, team runner, `software-development` profile | restart mid-workflow never repeats completed nodes; exact-head gates enforced |
| **M4 Gateways** | Responses gateway, turn broker, MCP server, Web UI, drain | real-Codex smoke covering streaming, a tool round trip, cancel, and interrupt; MCP client smoke |
| **M5 Second domain** | `scientific-research` profile, typed artifacts, invalidation, `gemini-web` driver | profile runs with zero engine changes |

Later candidates, each needing its own proposal: API provider capability, ACP
Worker runtime, DSH adapter, a packaged launcher.
