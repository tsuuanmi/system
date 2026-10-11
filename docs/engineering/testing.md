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

## Conventions adopted from DSH

- **Real composition over hand wiring.** Every product-visible plugin has a test
  that boots a test-only `cordis.yml` through the DSH Loader, mocking only
  external or non-deterministic boundaries (provider websites, models, clock).
  Hand-built `ctx.plugin(...)` suites alone are not enough.
- **Built-artifact smoke tests** (**implemented**:
  [`packages/cli/tests/profile.e2e.ts`](../../packages/cli/tests/profile.e2e.ts)).
  The `system` wrapper boots the shipped profile from built `lib/` through the
  real `dsh` launcher. The test asserts the exact allow-listed row set, calls
  MCP with a token, and checks cleanup on SIGTERM.
- **HMR safety.** Every registry gets a test that disposes the contributing
  plugin and asserts cleanup (plugin rule 3).
- **Mock only the expensive boundary.** Keep the real registry, store, and
  engine downstream of a scripted provider.

## CI gates (planned)

1. oxlint and ESLint, typecheck, and the layer dependency check.
2. Unit, contract, driver, crash, and concurrency tests.
3. Real-client smoke (scripted provider).
4. Schema checks (**implemented**: `scripts/check-schemas.ts`): every file in
   `schemas/` compiles under Ajv draft 2020-12 with `strict: true`, and every
   file in `schemas/examples/` validates. Checking that generated TypeScript types
   are current comes later.
5. Documentation checks (**implemented**: `scripts/check-docs.ts`): every `docs/**` directory has exactly one `README.md`;
   no `topic.md` alongside `topic/README.md`; every relative Markdown link
   resolves; every package directory has a `README.md`.

CI cannot prove account-bound flows. The manual checklist covers them, and its
results are recorded in the release PR.
