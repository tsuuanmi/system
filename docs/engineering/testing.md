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

## Conformance suites

Every seam with an abstract definition ships a suite in its definition
package's `conformance/` directory. Each provider's tests call the suite with a
`boot` function, and the test fakes run the same suites. See the
[seam table](../architecture/plugin-model.md#seam-definitions-and-conformance).

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
- **Crash injection** (**implemented**:
  [`packages/system-bundle/tests/crash/`](../../packages/system-bundle/tests/crash/restart.crash.ts),
  `pnpm test:crash`).
  - The engine runs as a separate process on the built packages, against the
    fake site. It is killed with SIGKILL, with its whole process group (Xvfb and
    Chrome too).
  - The kill comes at each reconcile point of a website turn: sent but not
    answered, and answered but not committed, in a persistent and in a
    temporary chat.
  - It is then restarted on the same state. The provider must see the prompt
    exactly once, and the run must recover, or fail closed as AMBIGUOUS.
- **Architecture rules** (**implemented**:
  [`scripts/architecture.spec.ts`](../../scripts/architecture.spec.ts)).
  Capability-routed code names no tools (INV-11). There is one provider per
  service (INV-1), one bundle row per plugin (REQ-HOST-4), and a conformance
  suite per seam (QA-9).
- **HMR safety.** Every registry gets a test that disposes the contributing
  plugin and asserts cleanup (plugin rule 3).
- **Mock only the expensive boundary.** Keep the real registry, store, and
  engine downstream of a scripted provider.

## Real display and browser tests

`display-virtual` and `browser-patchright` are tested against a real Xvfb and a real
headed Chrome, not a mocked engine: invisibility, foreground behavior, and the
absence of automation leaks are properties of the real browser.

- They need Xvfb and a modern Chrome. The tests choose Chrome with the
  product's own `discoverChrome` and launch it with the product's arguments.
  The order is `CHROME_PATH`, then a system Chrome no older than the engine,
  then the managed build installed by `system browser install`. As a last
  resort they use the same pinned build in `~/.cache/system-chrome` (`npx
  @puppeteer/browsers install chrome@<chrome.lock.json buildId> --path
  ~/.cache/system-chrome`). No root is needed.
- The remote-login tests also need `x0vncserver` (on PATH, in `X0VNCSERVER`, or
  TigerVNC's static build under `~/.cache/system-tigervnc`). CI installs
  `tigervnc-scraping-server`.
- Locally they are skipped when either is missing. CI sets
  `SYSTEM_REQUIRE_BROWSER=1`, so a missing browser **fails** the run instead of
  skipping silently.

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
