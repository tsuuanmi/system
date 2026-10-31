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
  one, kept tabs, a site's notice or check, a turn across a restart, a restarted turn that must
  wait and its cancel, the runtime's bounds and stop, the conversation ledger, a conversation kept
  or failing to delete; workflow: static DAGs, acceptance, plans, plan approval, the operator's
  stop and supersede, deletion, failures, restarts, retention, explain and MCP, re-plans, team
  votes, ties and their deciding vote, runs that wait on a vote, review findings, where a member
  runs and what it may be sent, provider families, a member woken by a message, one that needs a
  peer's input, one handed off to a new conversation), each file on its own Xvfb through its
  package's `tests/stack.ts`. Those stacks do not pace page opens (the drivers' `pageGapMs` and the
  runtime's `providerPageGapMs` are 0); the browser pool's own tests show the spacing. They also
  set the drivers' answer-stable window (`stableMs`) to 300 ms, as the drivers' own specs do,
  instead of production's 1.5 s. Production waits that long for a live site that pauses mid-answer.
  The fake sites stream a word every 60 ms and then mark the answer done, so the longer window only
  added idle time to every turn of every spec. The drivers' specs still cover completion on stable
  text.
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

### A loaded host (T348)

A run's own tests take a bounded share of the host, and the browser and real-Xvfb specs tolerate a
loaded one.

- **Workers.** `vitest.config.ts` sets `maxWorkers` by `testWorkers()`
  ([`scripts/test-workers.ts`](../../scripts/test-workers.ts)): the host's cores less one, at most 32,
  or the budget the environment gives, the smaller of `SYSTEM_TEST_MAX_WORKERS` and
  `SYSTEM_CHECK_MAX_WORKERS` when both are set. An acceptance check gets the second (`checks.maxWorkers`,
  T292). A writing step's own `pnpm test:affected` or `test:related` gets the first: agent-workers
  puts it in the run's confinement (`RunSpec.testWorkers`, `withTestWorkers`), with the value
  `stepTests.coreBudget / stepTests.runs` (default half the host's cores shared among 6 runs, 1 to 32;
  set `runs` to the dispatch's `maxRunning`; see the [configuration reference](../reference/configuration.md)).
  A value that is not a positive integer is ignored. Run it by hand the same way:
  `SYSTEM_TEST_MAX_WORKERS=4 pnpm test:related <files>`.
- **Time.** `SYSTEM_TEST_TIME_FACTOR` (a number from 1 to 20, default 1) multiplies the waits for
  the browser stack in the browser and real-Xvfb specs: a test's timeout, an Xvfb start-up bound, a
  `waitFor` timeout, through `scaled(ms)` in
  [`provider-core/conformance/time.ts`](../../packages/provider-core/conformance/time.ts). The
  browser-patchright specs, `display-virtual`'s real-Xvfb specs, and the display, browser, and
  deletion conformance suites use it. It scales a wait only, never an assertion: a bound a test
  asserts on (`expect(elapsed).toBeLessThan(10_000)`) is the product's own and is not loosened, and a
  fake Xvfb's start-up bound that a test expects to time out stays as it is. On a shared host at a
  load of thousands, set it to 3 or more.

### Real-browser tests in a Worker's confinement

The web UI's browser tests run a **headless** Chrome: they need Chrome, not Xvfb, and they run
inside a Worker's confinement as on the host (T247). What makes that so:

- **Chrome is found there.** Inside the confinement `HOME` is the Worker's private home (an agent's
  shell) or the daemon's (a check), and `DSH_HOME` is scrubbed, so `findTestChrome` in
  [`support.ts`](../../packages/plugins/browser-patchright/tests/support.ts) looks for the managed
  build (`.dsh/system/browsers`) and the developer cache (`.cache/system-chrome`) in the account's
  own home too (the password database's, not `HOME`). The confinement binds
  `$DSH_HOME/system/browsers` back read-only by default (agent-runtimes `readOnly`), a browser build
  and nothing secret, and names where in `SYSTEM_BROWSERS_DIR`, set inside the confinement, which
  the tests look in first: under a custom `DSH_HOME` no home holds it; a system Chrome or `~/.cache/system-chrome` is on the read-only host already.
  A Chrome elsewhere under a hidden directory needs `CHROME_PATH` and a `readOnly` entry.
- **Chrome's own sandbox is off.** Patchright adds `--no-sandbox` unless a launch asks for
  `chromiumSandbox`, which the headless tests never do: the confinement (its own PID namespace, no
  network in a check, the host read-only) isolates it, and a nested setuid or user-namespace sandbox
  is what a confinement may refuse. The product's own launches keep Chrome's sandbox
  (`IGNORED_DEFAULT_ARGS`).
- **`/dev/shm` and fonts are there.** `/dev/shm` is hidden as a private tmpfs, which Chrome writes
  its shared memory to; fontconfig reads `/etc/fonts` and `/usr/share/fonts` on the read-only host.
  Chrome's profile is a temporary directory in the private `/tmp`.
- **Chrome writes nothing under `HOME`.** A test launches it with `headlessLaunchOptions()`: its
  own `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and `XDG_DATA_HOME` in the temporary directory. Chrome
  keeps its crash database under `XDG_CONFIG_HOME` (default `~/.config`), not its profile, and where
  `HOME` is read-only (a check's host, an agent's private home) its crash handler exits
  (`chrome_crashpad_handler: --database is required`) and takes Chrome with it.
- **A skip says why, loudly.** A headless browser test is declared with `headlessIt(name, fn)`:
  where no Chrome can run it is skipped with the note `browser tests did not run: <why>`, never
  silently. Whether one can run is decided by doing it: a Chrome found is started once, headless, on
  a blank page; a sandbox that forbids what Chrome needs (an agent's own Bash sandbox refuses unix
  sockets: `socket() failed: Operation not permitted`) skips the tests with that line.
  `SYSTEM_REQUIRE_BROWSER=1` (CI) runs them anyway, so there they fail instead. The suite's reporter ([`scripts/browser-skips.ts`](../../scripts/browser-skips.ts))
  counts those skips and prints, as the run's last line, `!!! BROWSER TESTS DID NOT RUN: <n> browser
  tests skipped: <why>. A pass of this run says nothing of them.` In a run's check it also appends
  `browser-tests-not-run: <detail>` to the check's report file, the path `SYSTEM_CHECK_REPORT_PATH`
  names (a file, so it reaches the suite through pnpm's lifecycle runner, which passes only fds 0
  to 2): the check keeps its outcome, its reason says what did not run, and the acceptance's reasons
  tell the review that the pass does not cover those tests
  ([a run's checks](../design/agent-runtimes.md#a-runs-checks)). A report file it cannot write
  fails the run (`!!! THE CHECK WAS NOT TOLD: …`), so the check never reads the skips' silence as a
  pass.
- **vite writes two places in the worktree:** its cache (`node_modules/.vite`) and its bundled
  configuration (`node_modules/.vite-temp`). A check sees the worktree read-only, so a repository
  whose checks run vitest names both in `checkScratch`, or vitest fails to start (`EROFS`).
- [`confined-browser.spec.ts`](../../packages/plugins/web-ui/tests/confined-browser.spec.ts) runs
  one web UI browser test with vitest under a check's confinement (the agents' read confinement, the
  host read-only, no network, a private `/tmp`, vite's two directories as check scratch), started
  through the check's own launcher with its report file, and asserts it passed, not skipped; then, with every Chrome hidden and through the whole chain a check
  runs (the launcher, `pnpm run test:group surfaces -- <file> --testNamePattern <name>`, the runner,
  vitest), that it was skipped with its reason, said at the end, and reported to the check. That
  case needs the suite run under pnpm (`npm_execpath`), as CI and a check run it. It needs real bubblewrap and a Chrome on the host, as CI
  has; under `SYSTEM_REQUIRE_BROWSER=1` a Chrome that cannot run fails it rather than skipping it.
- **In a Worker's own tool call** (T265), `corepack pnpm exec vitest run <a web-ui browser spec>`
  runs in the runtime's command sandbox, inside the confinement. That sandbox gets the managed
  Chrome readable, `/dev/shm` and the run's report file writable
  ([design](../design/agent-runtimes.md#credentials-and-egress)); under Claude Code its commands
  may also make the unix sockets Chrome needs (the runtime's `unixSockets`, on by default, the
  host's own sockets masked in the run first). A run whose tests skipped says so: its report file
  gets `browser-tests-not-run: <why>`, its result `notRun`, and its review a note; a report file
  that could not be made or read, `reportUnread`, and a note that it is not known.
  [`worker-tool-browser.spec.ts`](../../packages/plugins/web-ui/tests/worker-tool-browser.spec.ts)
  runs one web UI browser test through the real thing: the claude-agent-sdk runtime runs the
  installed Claude Code under the agents' confinement with a writing run's production settings,
  only its model scripted (a local Messages endpoint that answers with one Bash call of
  `corepack pnpm exec vitest run <spec>` and reads back its result), and asserts the test passed;
  then, every Chrome hidden, that it was skipped and the run's report file says so. It needs
  Claude Code on `PATH`, bubblewrap, and a Chrome, and is skipped, with why, without any of them.
- **A test of a confinement's mask puts the masked path where the child sees it**: under a
  directory the confinement binds back. The host's `/tmp` is a private tmpfs inside, so a socket
  under the host's temporary directory that nothing binds back is rightly left unmasked (T265).
- **A sandbox's placeholders are not changes.** Inside a Worker's tool sandbox git lists the empty
  placeholders the sandbox mounts in the worktree (`.bashrc`, `.gitconfig`, `.claude/settings.json`,
  …) as untracked files. `pnpm test:affected` leaves an empty one out of the changed files
  (`sandboxPlaceholder`), so it no longer runs the whole suite for them; one with content counts.

## Test groups

`pnpm test` runs the whole suite, at most 32 test files at once, one per CPU but one on a smaller
host ([`vitest.config.ts`](../../vitest.config.ts)): vitest's own default of one per CPU ran every
file at once on a 256-CPU host, where in-process tests passed their bounds. Its wall time is the
longer of its slowest file and the sum of its files over those 32, so the slow files must start
first. vitest's own order reads its duration cache from the last run on that checkout; with none (a
fresh worktree, every CI run) it starts the largest files first, so a short file of slow tests
started among the last, and a cold run took about 40 s more than a warm one. The suite's sequencer
([`scripts/test-durations.ts`](../../scripts/test-durations.ts)) orders by a committed table
instead, [`scripts/test-durations.json`](../../scripts/test-durations.json) (each file's path →
seconds): the files the table does not hold first (a new file is not known to be short), in
vitest's own order, then the rest longest first, cache or none. Refresh the table after adding,
splitting, or slowing files, from a full run on a quiet host, and commit it:

```sh
pnpm test --reporter=json --outputFile=$TMPDIR/vitest-report.json
pnpm gen:test-durations $TMPDIR/vitest-report.json
```

A stale table only costs time: a removed file is ignored, and a new one starts first. A
file whose tests take about a minute or more together is split by theme, its shared setup in a
module beside it (the agent Worker source's specs on `agent-workers/tests/stack.ts`, the login
profile pool's on `browser-patchright/tests/profile-stack.ts`, the
[browser specs](#real-display-and-browser-tests) on their package's `tests/stack.ts`). Every workspace
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
  closed).

### Tests scale with the change

With up to nine tasks at once, a full run per check (3,309 tests in 283 files, 240 s) was the
bottleneck: tests with a 5 s bound failed under the load (T299). The full suite now runs once per
task, at the landing; everything before it runs what the change relates to.

- `pnpm test:related <file>…` (`--dry-run` to print the selection only; vitest's options follow, with or without `--`, as in
  `test:related a.ts --silent --reporter=dot`: the files end at the first word that starts with `-`) runs the test files related
  to the files given: each given test file; and, for any other file, the tests of its package and of
  every package that depends on it, through the same graph as `test:affected` (code, test helpers,
  and the packages that locate its data files). The scripts' tests, which check the whole repository
  (architecture, docs, manifests), run for any change but a test file's. A `package.json` (in any
  directory), the lockfile, `pnpm-workspace.yaml`, `tsconfig*.json`, `vitest*.ts`, CI, or a path the
  script cannot place widens to the whole suite (fail closed). Arguments after `--` go to vitest.
- **A writing Worker** runs `pnpm test:related` on the files it changed, while it develops and in its
  evidence, never the full suite. In its sandbox the command is admitted unasked when every path is
  absolute and inside the worktree (the gate's `workspace-write`; it only runs tests there).
- **The acceptance `tests` check** runs `pnpm test:affected` as before, told its scope
  (`SYSTEM_CHECK_SCOPE=acceptance`) and the commit its run's worktree was cut at
  (`SYSTEM_CHECK_BASE`): it runs the tests related to the files the result itself changed since that
  commit, never what its branch gained before it, and the whole suite when the result changed shared
  configuration, or when no such commit is recorded.
- **The landing** runs the same command with `SYSTEM_CHECK_SCOPE=landing` on the tree it is to merge:
  the rebased tree when the base moved, the committed tree when it did not. That is the whole suite,
  once per landing, before the merge is asked, in the check queue like any check
  ([T292](#running-the-suite-inside-a-runs-check)). A failure sends the result back as another
  attempt, with its failing tests named in the reason and in the task's dossier.
- Run by hand without a scope, `pnpm test:affected` still runs the affected groups.

#### Browser tests run only when the change touches what they exercise (T305)

A browser test is marked by the gate it is written with in `browser-patchright/tests/support.ts`:
`describe.runIf(canRunBrowser…)`, `headlessIt`, or `browserUnavailable`. The mark is per test, so
there is no tag or list to keep, and a file that mixes plain in-process tests with browser ones
(web-ui's specs, the drivers' `driver.spec.ts`, ui-ops' engine) keeps its plain tests running.
`pnpm test:related` (the acceptance), `pnpm test:affected` by hand, and the landing's whole suite
leave the browser tests out unless the change is in the browser stack (`BROWSER_STACK`:
browser-patchright, display-virtual, ui-ops, login, the two `provider-*-web` drivers, turns,
web-ui), edits the spec's own file, or edits a helper in its tests directory. Leaving them out, the
run sets `SYSTEM_SKIP_BROWSER_TESTS=1`: every gate closes, each such test is skipped with the note
`browser test left out: …` (never counted as a browser test that could not run, so a check's pass is
not held for it), and a spec whose every test is gated (a browser spec as a whole) is not even
selected. The specs the change touches run in a second vitest run, browser tests and all. A change
that affects everything runs them all, and so does `pnpm test:affected --all-browser`. A
workflow-only change runs no browser test. The landing is told the commit its run's worktree was
cut at (`SYSTEM_CHECK_BASE`, as the acceptance is) and reads the change from it; with none it runs
every test. The rebased tree can hold what dev gained since, which then counts as the change: more
browser tests run, never fewer.

A daily run of every browser spec on dev's tip runs inside System (T305b, D104): the workflow plugin's `dailyCheck` (off unless `enabled`, with `projectId` and `repository`; `ref` default `dev`, `hourUtc` default 4, `timeoutMinutes` 180; the configuration reference lists them) asks the Worker source that holds the repository for its `tests` check on the ref's tip once a day (`ctx.workers.checkTip`). The source cuts a worktree of its own at that commit, sets it up as it does a run's, and runs the repository's `tests` command at the scope `daily`, which `pnpm test:affected` reads as the whole suite with every browser test (what `--all-browser` runs), confined and read-only like an acceptance check, in the same queue of checks (`checks.maxConcurrent`), and only while the worktree is exactly that commit with nothing on top of it: a setup that changed a tracked file or left an untracked one is refused, never checked. A pass is recorded; an exit 0 that reports its browser tests did not run is an `error`, never a pass nor the last green commit. A failure proposes one board task, with the failing tests' names and assertions (the T270 bound), the commit, and the last green commit, and none while an earlier one is open; a run that did not run to an exit code (no source, a refused setup, a timeout) is recorded as an `error` and files nothing. `/ui` Home and `system metrics` show the last daily run.

A check's command gets its scope, its starting commit, and its alone mark (`SYSTEM_CHECK_ALONE`, `1` only for the re-run alone after timeouts, else `0`) from the source that runs it, never from the process that runs the source: this suite itself runs as a check, so a check its tests start inside a check run alone is not taken for one run alone.

Estimated, not timed, from the committed per-file durations (`scripts/test-durations.json`,
2026-10-27): the whole suite is about 3650 s of file time and the browser specs about 2485 s of it
(workflow's 24 browser specs 1013 s, turns 629 s, the two `provider-*-web` packages' gated specs
725 s, browser-patchright's three profile specs 89 s, login 30 s), plus the browser tests inside
mixed files (web-ui's 106 s, ui-ops' engine 34 s, browser-patchright's `browser.spec.ts` 26 s, the
drivers' `driver.spec.ts` 5 s: those files' plain tests still run, and the table does not split a
file, so up to 171 s more). The three most recent tasks touched no browser code: T297
(documentation), T300b (only `workflow/tests/board.spec.ts`, no browser spec) and T301
(agent-workers and the agent runtimes). Each one's landing suite is about 3650 s of file time
before and between about 1000 s and 1165 s after, 68 % to 73 % less. File times add up across parallel
workers, so the wall-clock cut is smaller. A timed run must happen where browsers run.

The related set is wider than a file-level import graph (a package's whole test suite for one source
file), so it never skips a test that imports a changed file; what it skips is the packages that
cannot import the change.

The rule:

- **A change** runs the tests related to its files (`pnpm test:related`) and `pnpm check`; the
  landing runs the full suite.
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
     beside `topic/`, and every relative Markdown link and anchor resolves; and no
     tracked text file holds an unresolved git conflict marker
     ([`scripts/check-conflicts.ts`](../../scripts/check-conflicts.ts)), named by file and
     line. A line of exactly seven `<`, `|` (diff3's base), or `>`, alone or followed by a
     space and a label, is always a marker. A line of exactly seven `=` is one only when a
     `<` marker comes before it in the same file; alone it is a Markdown setext heading
     underline. A file holding a NUL byte is binary and skipped. Two ADRs
     (`docs/decisions/adr/NNNN-*.md`) or two proposals (`docs/proposals/NNNN-*.md`) with one
     number fail, the later file named: parallel changes that each took the next number collide
     ([what parallel changes collide on](#what-parallel-changes-collide-on));
   - `check:secrets` ([`scripts/check-secrets.ts`](../../scripts/check-secrets.ts)):
     no tracked text file holds a credential, by the scan `egress` applies to
     outgoing payloads (secretlint's recommended rules plus the shapes they miss,
     in `packages/plugins/egress/src/scan.ts`). Tests make credential-shaped values
     at run time instead of committing them; there is no opt-out;
   - `check:schemas` ([`scripts/check-schemas.ts`](../../scripts/check-schemas.ts)):
     every file in `schemas/` compiles under Ajv draft 2020-12 with
     `strict: true`, every file in `schemas/examples/` validates, and no schema changes its
     contract in place: against the committed snapshot
     [`scripts/schema-snapshot.json`](../../scripts/schema-snapshot.json), a change that requires
     a property, stops requiring one, removes one, or narrows or relaxes an existing subschema
     fails unless the schema carries a newer version note
     ([schema contracts](#schema-contracts-against-a-committed-snapshot));
   - `check:migrations` ([`scripts/check-migrations.ts`](../../scripts/check-migrations.ts)): within
     each owner's store migrations, across all its `migrate` calls, no version appears twice, and
     each list's versions strictly increase in list order ([store migrations](#store-migration-versions));
   - `check:tiers` ([`scripts/check-risk-tiers.ts`](../../scripts/check-risk-tiers.ts)): the
     `system` project's policy ([`policies/system.json`](../../policies/system.json)) is a valid
     `autonomy-policy@1.1` whose path map matches every tracked path and names every package
     directory with a rule of its own, so a new package is given a risk tier on purpose
     ([ADR-0071](../decisions/adr/0071-a-changes-risk-tier-comes-from-the-policys-path-map.md));
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
   are skipped, with the reason, when `bwrap` is missing or cannot confine a command
   there, and in CI (`SYSTEM_REQUIRE_BWRAP=1`) such a one fails the run (see
   [running the suite inside a run's check](#running-the-suite-inside-a-runs-check)). On a
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

### What parallel changes collide on

Parallel runs each take "the next" number from the same tree, and each passes alone. Landing
them side by side on `dev` on 2026-10-26: two runs wrote ADR-0065, two added agent-workers store
migration 18, and one made a field of `mcp-roster@1.7` optional in place instead of adding a
version. Three checks in `pnpm check` refuse these, each with a test of a fixture that fails and of
the real tree that passes ([`scripts/collisions.spec.ts`](../../scripts/collisions.spec.ts)). A
writer takes the next free number, version, and schema version
([CONTRIBUTING](../../CONTRIBUTING.md)); after a collision, the change that lands second renumbers.

#### Numbered documents

`check:docs` groups `docs/decisions/adr/` and `docs/proposals/` by their `NNNN-` prefix; a number
held by two files fails, naming the later file and the one it collides with.

#### Store migration versions

The store records each `(owner, version)` it applied, once
([store](../../packages/plugins/store/src/index.ts)), so a second migration with a version an
install already ran never runs there. `check:migrations` reads every
`<x>.store.migrate(<owner>, <list>)` call (and any other `migrate` call with a string-literal owner
or an array-literal list) under a package's `src/` with
the TypeScript parser, without running the code: the owner is a string literal or a constant
holding one, the list an array literal or a constant holding one, and each element an object
literal with exactly one `version: <number literal>` and no object spread or computed key (either
could set the version at runtime), or a constant holding one (`GATE_MIGRATION`), in the same
file or imported from a relative module. A version twice, or a version not above the one before
it in list order, fails, and so does one owner's version declared again by another `migrate`
call (the store records it once, whichever call ran it). An owner, list, or element it cannot
read that way (a computed owner, a call, a spread, a computed or repeated version) fails too, so
no list hides from it. Tests and conformance suites, outside `src/`, are
not read: they migrate out of order on purpose.

#### Schema contracts, against a committed snapshot

[`scripts/schema-snapshot.json`](../../scripts/schema-snapshot.json) holds each schema's contract:
its newest version, and for every subschema by JSON pointer a digest of its own constraints
(descriptions, titles, examples, and defaults left out; nested subschemas are their own entries),
its `required` list, and its property names. `check:schemas` compares each schema with its entry;
a change fails when it requires a property, stops requiring one, removes a property or a
subschema, changes an existing subschema's constraints (narrows or relaxes it), or adds a
constraint subschema to an existing one (a `not`, `items`, `if`, or `dependentSchemas` entry that
was not there), unless the
schema's version moved past the snapshot's. A schema's version is the highest `<major>.<minor>` of
its file's major among the version notes in its descriptions (`1.9 adds …`, `1.4: …`, `(1.1)`,
`<name>@1.9 …`; `other@1.3` names another schema and does not count). Only descriptions count: a
`<name>@<major>.<minor>` tag elsewhere, such as an advanced `properties.schema.const`, is not a
note, so a contract change needs its note in a description.
Adding an optional property or a `$defs` entry is not a change in place.

`pnpm gen:reference` rewrites the snapshot: every schema's current contract, except a schema
changed in place, whose old entry it keeps, so regenerating never hides the change. The check also
fails while the snapshot is out of date, so every versioned change commits its new entry.

A snapshot, not a diff against the merge base with `main`: work lands on `dev` and `main` takes it
only at the operator's merge ([branches](development.md#branches-dev-and-main)), so the merge base
is a different, older tree on each branch, and a shallow checkout may not hold it. The snapshot is
in the tree, so the check answers the same everywhere, offline. Two changes that both version one
schema both rewrite its entry, and meet as a merge conflict in the snapshot. Its limit: a version
note anywhere in a schema admits a change anywhere in it, so the note must say what changed.

## Removability matrix

Operator, 2026-10-27: "when a plugin is removed, System still works normally". The
[plugin model](../architecture/plugin-model.md#required-and-optional-rows) lists which bundle rows
are required (the host and the guarantee seams) and which are optional (capability and surface
rows). The matrix ([`packages/system-bundle/tests/removability/`](../../packages/system-bundle/tests/removability/matrix.ts))
holds the optional ones: for each optional row, those that ship off included (for a row that ships
off, the case is the shipped bundle with the software-development profile on, which the matrix turns
on beside every removal; removing the profile row is the case where the template is absent), it mounts
the bundle's rows in this process on the packages' source (the plugin host reads the same composition
through a loader stub), with that row off, and a scripted Worker as the one fake. The smoke scenario,
step by step:

- `start`: every mounted row started;
- `health`: MCP `status` is not down, the plugin host's manifest check finds nothing and does not list
  the row as mounted (with `mcp-server` off, there is no endpoint: `/healthz` answers 404 and runs go
  through the engine);
- `tools`: the tools every composition has are listed, none appears that the baseline lacked, and the
  read tools still listed answer;
- `ask` and `algorithm-development`: a run on the fake Worker completes. Only when the row is the
  profile that contributes the template does the run fail, with the unknown template as its reason.

A step either succeeds or fails with the documented absence of the removed row's seam
(`ABSENT` in `matrix.ts`); a crash, a hang (each wait is bounded), or any other failure is reported as
`row <id>, step <name>: <what>`. The matrix runs by `pnpm test:removability` (no build) and daily in
[`removability.yml`](../../.github/workflows/removability.yml), not on a pull request or a push: it boots
the bundle once per row. `removability.spec.ts` runs in every `pnpm test`: it checks that each bundle
row is in exactly one of the two lists, and smokes the bundle as shipped and with `digest` and the
profile row off.

## Running the suite inside a run's check

A workflow run's `tests` check ([ADR-0063](../decisions/adr/0063-a-runs-required-checks-run-on-its-exact-result.md))
runs `pnpm test:affected` inside the run's confinement (its scope, `acceptance` or `landing`, decides
what runs: [tests scale with the change](#tests-scale-with-the-change)): bubblewrap, the host read-only but the
check's scratch paths, the worktree read-only too, a private `/tmp`, no network but loopback, its
own PID namespace and `/dev`, and the daemon's umask (077 when
[`scripts/live-update.sh`](../../scripts/live-update.sh) started it). The suite gives the verdict
there that it gives on the host (T174):

- **One helper decides what the environment can do, by doing it:**
  [`packages/agent-runtime-core/tests/host.ts`](../../packages/agent-runtime-core/tests/host.ts).
  `CAN_CONFINE` runs `true` under real bubblewrap with the features the code relies on (an agent
  child's PID namespace, a check's read-only host without network, tmpfs and bind mounts), once
  per test file; inside a check that is a nested bubblewrap, which a host can refuse. The probes'
  command lines are written out in the helper, never built by `confinedCommand`: a regression in
  the code under test then fails the confinement tests instead of skipping them. `cannotWrite(dir)` makes a directory there and removes it.
  `createdMode(mode)` creates a file and reads its mode. No environment variable stands in for
  any of these; `SYSTEM_REQUIRE_BWRAP=1` only makes a bubblewrap that cannot confine fail the
  tests instead of skipping them.
- **A test that needs what the environment cannot do skips, with the reason:** a `describe`
  whose tests run commands under real bubblewrap calls `needsBubblewrap()`, and each of its tests
  is skipped with `needs real bubblewrap: <why>` (vitest's skip note) where bubblewrap cannot
  confine. A test that needs a writable directory outside the paths hidden from agents skips
  where `cannotWrite` names why. Where the environment can, the test asserts what it does today.
- **A test whose expectation follows from the environment asserts what the code does there:**
  the Codex launcher hides `/dev/ptmx` with the null device where it is the device, and with
  `/dev/pts` where it links into `/dev/pts` (bubblewrap's own `/dev`, inside a check); a brief's
  file, created 0o444, has the mode the umask leaves (0o400 under umask 077).
- **The proof:** [`host.spec.ts`](../../packages/agent-runtime-core/tests/host.spec.ts) runs the
  tests that once failed only inside a check (the Codex launcher's command line, the brief's file
  mode) under a check's command line with umask 077, and expects them to pass.

A new test that reads host state (real bubblewrap, a device under `/dev`, a file's mode, the
host's `/tmp`, the network, the operator's home, a write outside the temporary directory) takes
its answer from this helper, never from a check of its own.
