# Testing

> Planned. Quality attribute: QA-10.

## Levels

| Level | What | Notes |
|---|---|---|
| unit | pure functions such as the reducer, hashing, and reconcile decisions | no I/O |
| contract | every seam (store, browser, providers, agent runtimes, client protocols, …) against its conformance suite | every provider, including fakes, passes the same suite ([plugin rules](../architecture/plugin-model.md#plugin-rules)) |
| composition | every shipped profile loads, validates all plugin configs, and disposes back to quiescence | catches broken `inject` graphs and leaked effects |
| driver | provider drivers against recorded DOM fixtures (`fixtures/<provider>/*.html`) | UI drift breaks a fixture test, not production |
| crash / restart | kill at every reconcile-before-repeat point; assert WAIT, RECOVER, RESUBMIT, or AMBIGUOUS and no duplicate effects | covers INV-4 |
| concurrency | competing writers and leases; assert stale-generation commits are rejected | covers the fences in [scheduling-and-leases](../design/scheduling-and-leases.md) |
| real-client smoke | the real Codex and Claude Code binaries and a real MCP client driven against the gateways with a scripted provider | streaming, tool round trip, cancel, interrupt |
| agent-runtime smoke | the Claude Agent SDK and Codex SDK runtimes on a throwaway repository | probe, run, resume, cancel, sandbox enforcement |
| manual release checklist | live accounts: sign-in, live turn, tool round trip, full workflow cycle | a failed or skipped item blocks a release |

## CI gates (planned)

1. Biome, typecheck, and the layer dependency check.
2. Unit, contract, driver, crash, and concurrency tests.
3. Real-client smoke (scripted provider).
4. Documentation checks: every `docs/**` directory has exactly one `README.md`;
   no `topic.md` alongside `topic/README.md`; every relative Markdown link
   resolves; every package directory has a `README.md`.

CI cannot prove account-bound flows. The manual checklist covers them, and its
results are recorded in the release PR.
