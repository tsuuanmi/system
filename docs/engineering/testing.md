# Testing

Quality attribute: QA-10.

## Levels

| Level | What | Notes |
|---|---|---|
| unit | pure functions such as the reducer, hashing, and reconcile decisions | no I/O |
| contract | every seam (store, browser, providers, workers, agent runtimes, …) against its conformance suite | every provider, including fakes, passes the same suite ([plugin rules](../architecture/plugin-model.md#plugin-rules)) |
| composition | the shipped profile loads through `dsh`, validates all plugin configs, and disposes back to quiescence | catches broken `inject` graphs and leaked effects |
| driver | provider drivers against fake sites built from the live accessibility tree (each driver's `fixtures/`), in a real headed Chrome | UI drift breaks a fixture test, not production |
| crash / restart | kill at every reconcile-before-repeat point; assert WAIT, RECOVER, RESUBMIT, or AMBIGUOUS and no duplicate effects | covers INV-4 |
| concurrency | competing writers and leases; assert stale-generation commits are rejected | covers the fences in [scheduling-and-leases](../design/scheduling-and-leases.md) |
| client protocol | the gateways and the MCP server against recorded client requests and a scripted provider | streaming, tool round trip, cancel; the real Codex and Claude Code binaries are on the release checklist |
| agent runtime | each runtime provider against a scripted agent, through the shared provider conformance suite | probe, run, handle, refusal, abort; live agents are on the release checklist |
| manual release checklist | live accounts: sign-in, live turn, tool round trip, full workflow cycle | a failed or skipped item blocks a release |

## Conformance suites

Every seam with an abstract definition ships a suite in its definition
package's `conformance/` directory. Each provider's tests call the suite with a
`boot` function, and the test fakes run the same suites. See the
[seam table](../architecture/plugin-model.md#seam-definitions-and-conformance).

## Conventions adopted from DSH

- **Real plugins over mocks.** Plugin tests compose the real plugins they inject
  with `ctx.plugin(...)` and mock only external boundaries (provider websites,
  agents, models).
- **Built-artifact smoke test**
  ([`packages/cli/tests/profile.e2e.ts`](../../packages/cli/tests/profile.e2e.ts)).
  The `system` wrapper boots the shipped profile from built `lib/` through the
  real `dsh` launcher. The test asserts the exact allow-listed row set, calls
  MCP with a token, and checks cleanup on SIGTERM.
- **Upgrade suite**
  ([`packages/cli/tests/upgrade/`](../../packages/cli/tests/upgrade/upgrade.e2e.ts),
  part of `pnpm test:e2e`; REQ-HOST-2,
  [INV-14](../architecture/invariants.md#inv-14-every-record-has-a-versioned-schema)).
  - Each fixture is a store seeded by that release's code and written as SQL
    text with a manifest of its runs: every kind of run the engine keeps (ask, a
    persistent session, a plan, an approval gate, a re-plan with retired nodes,
    a team panel, a rejected result).
  - The suite boots the shipped profile on each fixture through `dsh`, which
    migrates it. Every old run must still `explain` and answer `result` as the
    manifest says, no migration may go backwards, and every node, session, and
    artifact record must validate against its schema.
  - A release adds its fixture with `pnpm gen:upgrade-fixture <version>` from
    its own code; a fixture is never edited afterwards. Until the first release,
    one is seeded from the current code.
- **Crash injection**
  ([`packages/system-bundle/tests/crash/`](../../packages/system-bundle/tests/crash/restart.crash.ts),
  `pnpm test:crash`).
  - The engine runs as a separate process on the built packages, against the
    fake site. It is killed with SIGKILL, with its whole process group (Xvfb and
    Chrome too).
  - The kill comes at each reconcile point of a website turn: sent but not
    answered, and answered but not committed, in a persistent and in a
    temporary chat.
  - It is then restarted on the same state. The provider must see the prompt
    exactly once, and the run must recover, or fail closed as AMBIGUOUS.
- **Architecture rules**
  ([`scripts/architecture.spec.ts`](../../scripts/architecture.spec.ts)).
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

## CI gates

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on every push to
`main` and every pull request, on Node 22 and 24, with a real Xvfb, TigerVNC, and
Chrome installed. Each gate is a root [`package.json`](../../package.json) script:

1. `pnpm check`:
   - `check:docs` ([`scripts/check-docs.ts`](../../scripts/check-docs.ts)):
     every `docs/**` directory has exactly one `README.md`, no `topic.md` sits
     beside `topic/`, and every relative Markdown link and anchor resolves;
   - `check:schemas` ([`scripts/check-schemas.ts`](../../scripts/check-schemas.ts)):
     every file in `schemas/` compiles under Ajv draft 2020-12 with
     `strict: true`, and every file in `schemas/examples/` validates;
   - `check:reference` and `check:traceability`: the generated
     [configuration catalog](../reference/configuration.md) and
     [traceability](../validation/traceability.md) are current;
   - `lint` (oxlint) and `typecheck` (`tsc --noEmit`).
2. `pnpm test`, with `SYSTEM_REQUIRE_BROWSER=1`: unit, contract, driver,
   concurrency, and architecture tests.
3. `pnpm test:e2e`: build, then boot the shipped profile through `dsh`, and
   upgrade every seeded store fixture.
4. `pnpm test:crash`: crash injection at each reconcile point of a turn.

CI cannot prove account-bound flows. The
[release checklist](../validation/release-checklist.md) covers them.
