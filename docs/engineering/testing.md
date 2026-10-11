# Testing

> Planned. Quality attribute: QA-10.

## Levels

| Level | What | Notes |
|---|---|---|
| unit | pure functions such as the reducer, hashing, and reconcile decisions | no I/O |
| contract | each seam (`ProviderDriver`, store, capability) against a shared conformance suite | fakes and real implementations pass the same suite |
| driver | provider drivers against recorded DOM fixtures (`fixtures/<provider>/*.html`) | UI drift breaks a fixture test, not production |
| crash / restart | kill at every reconcile-before-repeat point; assert WAIT, RECOVER, RESUBMIT, or AMBIGUOUS and no duplicate effects | covers INV-4 |
| concurrency | competing writers and leases; assert stale-generation commits are rejected | covers the fences in [scheduling-and-leases](../design/scheduling-and-leases.md) |
| real-client smoke | the real Codex binary and a real MCP client driven against the gateway with a scripted provider | streaming, tool round trip, cancel, interrupt |
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
