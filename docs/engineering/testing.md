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

Suites written since [ADR-0037](../decisions/adr/0037-schema-and-protocol-first.md) use the
[conformance runner](../../packages/libs/conformance/runner.ts), after
`@modelcontextprotocol/conformance`:

- a suite (`defineSuite`) names its seam and contract version, and lists scenarios with stable
  ids (`<seam>.<what>`, never reused), each applying from one contract version on;
- a provider's test (`runSuite`) pins the contract version it implements and runs every scenario
  that applies to it; another major, or a newer minor than the suite knows, is refused;
- known failures are a baseline, each with its reason. A baselined scenario must still fail:
  once it passes, the run fails until the entry is removed. A baseline never hides a new
  failure.

A provider's own spec tests what its seam's suite does not hold: what is particular to that
provider (a default, the words of a refusal, a helper it exports). A test that only repeats a
scenario of the suite, on the same provider, does not stay.

## Conventions adopted from DSH

- **Real plugins over mocks.** Plugin tests compose the real plugins they inject
  with `ctx.plugin(...)` and mock only external boundaries (provider websites,
  agents, models).
- **One temporary parent per run** ([`scripts/test-tmp.ts`](../../scripts/test-tmp.ts), the
  global setup of every lane). TMPDIR points at `system-test-<pid>-…` before the workers start,
  so test directories, browser profiles, and child processes all land under it, and teardown
  removes it. A killed run cannot tear down; the next run removes the parents of runs that are
  gone, and nothing else. A test keeps using `tmpdir()`. A process that names a path under a
  parent on its command line (an Xvfb's `-auth`, a Chrome profile) belongs to that run: it is
  stopped when the parent is removed, so a host the crash suite kills, or a suite killed before
  its close, leaves no display behind.
- **Built-artifact smoke test**
  ([`packages/cli/tests/profile.e2e.ts`](../../packages/cli/tests/profile.e2e.ts),
  [`api-first.e2e.ts`](../../packages/cli/tests/api-first.e2e.ts)).
  The `system` wrapper boots the shipped profile from built `lib/` through the
  real `dsh` launcher, once per preset. Each test asserts the exact row set, calls
  MCP with a token, and checks cleanup on SIGTERM; the `api-first` one also
  answers through a model Worker against a fake API server. The default one also
  checks the profile against the code before a start, the plugin host's findings at
  start ([ADR-0048](../decisions/adr/0048-the-plugin-host-checks-the-composition-at-start.md)),
  and a digest provider swapped by the operator's patch alone.
- **MCP surface budget**
  ([`packages/cli/tests/surface.e2e.ts`](../../packages/cli/tests/surface.e2e.ts), part of
  `pnpm test:e2e`; QA-12). It boots the shipped profile the same way and fails when `tools/list`
  per scope, a tool's entry, or a canonical reply is over its ceiling
  ([token budget](../../packages/plugins/mcp-server/README.md#token-budget)).
- **Upgrade suite**
  ([`packages/cli/tests/upgrade/`](../../packages/cli/tests/upgrade/upgrade.e2e.ts),
  part of `pnpm test:e2e`; REQ-HOST-2,
  [INV-14](../architecture/invariants.md#inv-14-every-record-has-a-versioned-schema)).
  - Each fixture is a store seeded by that release's code and written as SQL
    text with a manifest of its runs: every kind of run the engine keeps (ask, a
    persistent session, a plan, an approval gate, a re-plan with retired nodes,
    a team, a rejected result). The generator seeds a team `brainstorm`; the
    committed fixture `seed-2026-10-14` holds a run of the removed `panel`,
    which must still `explain` and answer `result`.
  - The suite boots the shipped profile on each fixture through `dsh`, which
    migrates it. Every old run must still `explain` and answer `result` as the
    manifest says, no migration may go backwards, and every node, session, and
    artifact record must validate against its schema.
  - A release adds its fixture from its own code when it is versioned
    ([releasing](releasing.md#cutting-a-release)); a fixture is never edited
    afterwards. Until the first release, one is seeded from the current code.
- **Crash injection**
  ([`packages/system-bundle/tests/crash/`](../../packages/system-bundle/tests/crash/),
  `pnpm test:crash`).
  - The engine runs as a separate process on the built packages. It is killed
    with SIGKILL, with its whole process group (Xvfb and Chrome too), then
    restarted on the same state.
  - A website turn, against the fake site, is killed at each reconcile point:
    sent before its conversation was bound, sent and bound but not answered, and
    answered but not committed; a temporary chat once sent; a deletion clicked on
    the site but not recorded; a session-bound account's turn; and a failed run
    whose turn was still running, superseded after the restart (that turn is
    cancelled). The provider must see the prompt exactly once, and the run must
    recover, or fail closed as AMBIGUOUS.
  - The harnesses cap the leases at 10 s (`leases.maxTtlMs`,
    [`leases.mjs`](../../packages/system-bundle/tests/crash/leases.mjs)), so a
    restart waits out the dead process's leases in a sixth of the time, as it
    would their 60 s; a live holder keeps its lease, renewed at a third of the
    TTL granted. The budget cases keep the default cap: a run's lease on its
    board task must outlive the run's own lease, as on a real restart.
  - Every other row of the
    [effect register](../architecture/data-flow.md#effect-register) that names a
    crash test gets what its row says a restart does: an agent run, a model call,
    a board task's spent budget on its last attempt, and a node waiting for an
    assigned account's limit.
  - A two-step run killed around its per-step budget reservation
    ([ADR-0047](../decisions/adr/0047-a-run-stops-at-a-boundary-once-its-task-budget-is-spent.md))
    runs its first step once and never its second. A daemon killed between an
    enrollment slot's allocation and its verification leaves the slot `enrolled`,
    never `ready`, until the operator verifies it
    ([ADR-0051](../decisions/adr/0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md)).
    A daemon killed between a carried worktree's `git worktree add --no-checkout` and the reading
    of the earlier tree into it (a `git` on the harness's PATH whose `read-tree` never returns)
    leaves that worktree marked, no agent run in it; past the retention it is put back to its base
    and removed with nothing committed on its branch, and the run's agent later works on the base's
    files ([ADR-0061](../decisions/adr/0061-a-tasks-next-attempt-starts-from-the-work-its-previous-attempt-left.md)).
    An engine killed between a team member's `resend` decision and its new attempt (the
    decision, the session's reset, and the ready node one transaction) resends that step exactly
    once after a restart, in the new conversation, and the team completes
    ([ADR-0062](../decisions/adr/0062-a-team-members-first-step-is-resent-once-after-a-sites-own-error.md)).
- **Architecture rules**
  ([`scripts/architecture.spec.ts`](../../scripts/architecture.spec.ts)).
  Capability-routed code names no tools (INV-11). Native protocol objects stay
  inside their own adapters (INV-7). There is one provider per service (INV-1),
  one bundle row per plugin (REQ-HOST-4), and a conformance suite per seam (QA-9),
  a guarantee seam's at a pinned contract (ADR-0036). A work requirement has no
  provider field (REQ-ACC-2).
- **HMR safety.** Every registry gets a test that disposes the contributing
  plugin and asserts cleanup (plugin rule 3).
- **Mock only the expensive boundary.** Keep the real registry, store, and
  engine downstream of a scripted provider.
- **Golden fixtures.** The statistics library is checked against SciPy's results
  on fixed datasets, generated once by hand
  ([`scripts/statistics/`](../../scripts/statistics/sign-flip-goldens.py)) and
  committed with the versions they ran with. No test runs Python
  ([golden tests](../design/statistics.md#golden-tests)).
- **Clean up with the test.** What a test or its helper starts (a store, a fake
  site, a browser) is released by `onTestFinished`, newest first, so a helper that
  boots something registers its own cleanup and a test file keeps no list of its
  own.
- **Wait for the event, not the clock.** A test waits with `vi.waitFor` for what
  it must see (a row's state, the next read of a poll or sweep), or runs a long
  timer on fake time. A fixed sleep stays only where a test shows that nothing
  happens during a window, and nothing it could wait for marks that window.
- **A test's bound fits its work.** The 5 s default is for in-process tests. A test whose work
  is real processes (a script end to end, the CLI started from source, a scripted agent or its
  hook, bubblewrap) sets a bound for them, for the whole file when every test there does: under
  load a process start costs several times what it does alone. So does a test whose point is time
  passing on real timers (a stall bound firing, a slow stream). A test whose CPU outgrows the
  default holds too much: it is split by its independent cases (one per golden dataset). A larger
  bound never stands in for waiting on an event the test could wait for.
- **An unhandled rejection is a failure.** vitest fails a run on one even when every test passed,
  and under the `dsh` launcher the same rejection exits the daemon. Find whose promise it is and
  fix it there: a dependency's, until a release of it does, with a [patch](dependencies.md#patches).
- **Pin the time a test reads.** A test that formats or compares a clock time, a
  day, or a reset passes whenever and wherever it runs. Its data names fixed
  instants, not offsets from the host's now. A page that shows them opens in a
  context with a `timezoneId` and a locale, its clock fixed at the data's instant
  (`page.clock.setFixedTime`). Code that reads the host's now itself (a runtime
  reading a usage limit) runs with only `Date` faked at the fixture's instant
  (`vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })`), so timers
  and child processes run as before.

## Real display and browser tests

`display-virtual` and `browser-patchright` are tested against a real Xvfb and a real
headed Chrome, not a mocked engine: invisibility, foreground behavior, and the
absence of automation leaks are properties of the real browser.

- A file of tests that each compose the real stack shares one Xvfb:
  `fileDisplay()` in
  [`browser-patchright/tests/support.ts`](../../packages/plugins/browser-patchright/tests/support.ts)
  starts it in `beforeAll` and stops it in `afterAll`, and each test mounts it where it would
  mount `display-virtual`, as a profile's browsers share one display. Each test still launches
  its own Chrome. The fake passes the display conformance suite, and `display-virtual` itself is
  tested on its own real Xvfb.
- A website driver's tests against its fake site are split by theme, one file each (pages, modes
  or answers, the composer, stalls, conversations, deletion, Deep research), so they run side by
  side: the suite's wall time is set by its slowest file. Each file launches one Chrome on its own
  Xvfb through `fakeSite()` in the driver's `tests/site.ts`, and each test opens its own fake site
  and browser context there, stopped when the test finishes. A test that expects the driver to give
  up (a conversation that never renders, a send nothing confirms) sets that bound small rather than
  waiting out the production default.
- The turn runtime's and the workflow engine's browser specs are split by theme the same way
  (turns: asks, sessions, sign-in, routing, limits, the session-bound login profile, the ChatGPT
  one, kept tabs, a site's notice or check; workflow: static DAGs, acceptance, plans, plan
  approval, the operator's stop and supersede, deletion, team votes, ties and their deciding vote,
  runs that wait on a vote, review findings, where a member runs and what it may be sent,
  provider families), each file on
  its own Xvfb through its
  package's `tests/stack.ts`. Those stacks do not pace page opens (the drivers' `pageGapMs` and the
  runtime's `providerPageGapMs` are 0); the browser pool's own tests show the spacing.
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

## Test groups

`pnpm test` runs the whole suite, at most 32 test files at once, one per CPU but one on a smaller
host ([`vitest.config.ts`](../../vitest.config.ts)): vitest's own default of one per CPU ran every
file at once on a 256-CPU host, where in-process tests passed their bounds. Every workspace
package's tests, and the repository scripts', belong to one functional group: `kernel`,
`workflow`, `workers`, `websites`, `surfaces`, and `libs`. [`scripts/test-groups.ts`](../../scripts/test-groups.ts) holds them, and
`pnpm test:group` with no name lists each with its packages; its own test fails when a package or
a test file is in no group, or in two.

- `pnpm test:group <name>...` runs those groups.
- `pnpm test:affected` runs the groups the change since `origin/main` affects, committed or not
  (`--base <ref>` for another base, `--dry-run` to print them only). A group is affected when its
  tests depend on a changed package: on its code or on its test files (a fake site, a conformance
  suite, a test helper), through imports and `package.json`, transitively; or when they locate a
  changed package's data file. The `libs` group runs for every change, since the scripts' tests
  check the whole repository, and documentation reaches it alone. A schema reaches every package;
  a root configuration file, CI, or a path the script cannot place runs every group (fail
  closed). A spike runs none: spikes are not part of the suite.

The rule:

- **A change** runs its groups (`pnpm test:affected`) and `pnpm check`.
- **A big update** runs the full gate: `pnpm check`, `pnpm test`, `pnpm test:e2e`, and
  `pnpm test:crash`. A contract, seam, or schema change, a batch integration, and a release are
  big updates.

## CI gates

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on every pull request, every
push to `main` or `dev` (every merge; `dev` is where the lead integrates batches and the live install
follows), nightly on `main`, and on each release tag (the
[release workflow](releasing.md) calls it), on Node 24.18.1 (the floor), the latest 24, and the
latest 26, with a real Xvfb, TigerVNC, bubblewrap, and Chrome installed. A pull request runs
`pnpm check` and its affected [test groups](#test-groups); everything else runs the full gate.
The job keeps one name on every trigger, so a required check names it whatever ran. Each gate is
a root [`package.json`](../../package.json) script:

1. `pnpm check`:
   - `check:docs` ([`scripts/check-docs.ts`](../../scripts/check-docs.ts)):
     every `docs/**` directory has exactly one `README.md`, no `topic.md` sits
     beside `topic/`, and every relative Markdown link and anchor resolves;
   - `check:secrets` ([`scripts/check-secrets.ts`](../../scripts/check-secrets.ts)):
     no tracked text file holds a credential, by the scan `egress` applies to
     outgoing payloads (secretlint's recommended rules plus the shapes they miss,
     in `packages/plugins/egress/src/scan.ts`). Tests make credential-shaped values
     at run time instead of committing them; there is no opt-out;
   - `check:schemas` ([`scripts/check-schemas.ts`](../../scripts/check-schemas.ts)):
     every file in `schemas/` compiles under Ajv draft 2020-12 with
     `strict: true`, and every file in `schemas/examples/` validates;
   - `check:reference`, `check:packages`, and `check:traceability`: the generated
     [configuration catalog](../reference/configuration.md),
     [package graph](../architecture/packages.md), and
     [traceability](../validation/traceability.md) are current;
   - `check:manifests` ([`scripts/gen-manifests.ts`](../../scripts/gen-manifests.ts)): every plugin
     and seam definition ships a `plugin-manifest.json` the plugin host would take, and it agrees
     with the code: the seams provided, consumed, and defined, their conformance contract
     versions, the class in the seam catalog, `package.json`, the configuration keys of its
     `Config`, and a Worker source's egress; a declared egress and `cacheStable` only where they
     can apply; and the bundle's plugin-host allowance names exactly its DSH rows
     ([plugin host](../design/plugin-host.md#manifests));
   - `lint` (oxlint) and `typecheck` (`tsc --noEmit`).
2. `pnpm test`, with `SYSTEM_REQUIRE_BROWSER=1` and `SYSTEM_REQUIRE_BWRAP=1`:
   every `*.spec.ts` in a package's `tests/` and in `scripts/`
   ([`vitest.config.ts`](../../vitest.config.ts)): unit, contract, driver,
   concurrency, and architecture tests, and the tests of the repository's scripts.
   The agent read confinement tests run against the real bubblewrap; locally they
   are skipped when `bwrap` is missing, and in CI a missing one fails the run. On a
   pull request, `pnpm test:affected --base origin/<its base branch>` instead, with
   the same environment.
3. `pnpm test:e2e`: build, then every `*.e2e.ts`, one file at a time
   ([`vitest.e2e.config.ts`](../../vitest.e2e.config.ts)): boot the shipped
   profile and the `api-first` preset through `dsh`, and upgrade every seeded
   store fixture. Not on a pull request.
4. `pnpm test:crash`: build, then every `*.crash.ts`, one file at a time
   ([`vitest.crash.config.ts`](../../vitest.crash.config.ts)): the cases of
   [crash injection](#conventions-adopted-from-dsh). Not on a pull request.

[`.github/workflows/audit.yml`](../../.github/workflows/audit.yml) runs
`pnpm audit:deps` (no high or critical advisory in a production dependency) once,
outside the Node matrix, on the same triggers and daily. It fails closed: a
registry error fails it like an advisory does, so it is never run with
`--ignore-registry-errors`. The release checklist adds a full audit.
[`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml) runs CodeQL's
`security-extended` queries on the same triggers and weekly.
[`.github/dependabot.yml`](../../.github/dependabot.yml) proposes npm and Action
updates weekly, each version once it is a week old, except `@deepseek-ai/*`, whose
one exact pin moves by hand after the conformance and composition suites pass
(CON-8). Every third-party Action is pinned by commit SHA, with its version in a
comment; a test in [`scripts/checks.spec.ts`](../../scripts/checks.spec.ts) checks the pin.

CI cannot prove account-bound flows. The
[release checklist](../validation/release-checklist.md) covers them.
