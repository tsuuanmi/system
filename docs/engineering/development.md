# Development

## Toolchain

`system` packages run beside DSH packages on the same Node and Cordis
([ADR-0018](../decisions/adr/0018-build-on-dsh-core.md)). **Bun is not used.**
The root [`package.json`](../../package.json) and each package's `package.json`
are canonical.

| Concern | Tool |
|---|---|
| runtime | Node `^24.18.1 \|\| >=26.5.1` (`engines`; [CON-2](../requirements/constraints.md)); the versions CI runs are in [CI gates](testing.md#ci-gates) |
| package manager | pnpm workspaces (version pinned in `packageManager`) |
| host | DSH core and `@deepseek-ai/cordis`, one exact pinned version; the `system` bundle and profile |
| language | TypeScript, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` |
| typecheck | `tsc --noEmit` over the whole workspace (root [`tsconfig.json`](../../tsconfig.json), whose `paths` map each package to its `src/`) |
| build | `tsc -p tsconfig.build.json` per package, into `lib/` ([`tsconfig.build.base.json`](../../tsconfig.build.base.json)) |
| lint | `oxlint` over `scripts/`, `spikes/`, and `packages/`, with its default rules (no configuration file) |
| tests | Vitest; bare workspace imports resolve to `src/` ([`vitest.config.ts`](../../vitest.config.ts)) |
| scripts | `tsx` for the checks and generators in [`scripts/`](../../scripts/), loaded in the process (`node --import tsx <script>`, never the `tsx` CLI, whose IPC pipe is a unix socket an agent's command sandbox refuses; [confined commands](../design/agent-runtimes.md#confined-commands)) |
| browser automation | `patchright-core` against a system or pinned managed Chrome (CON-7) |

DSH packages and `@deepseek-ai/cordis` are declared as **`peerDependencies` and
`devDependencies` at one exact version**, as DSH requires for out-of-tree
plugins.

## Workspace

pnpm workspaces ([`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)):

| Path | Holds |
|---|---|
| `schemas/` | the JSON Schemas, as the package `@tsuuanmi/system-schemas` |
| `packages/libs` | pure shared libraries: canonical JSON, content ids, schema validation, durable files |
| `packages/*-core` | seam definitions (abstract classes and conformance suites) and shared mechanisms, such as `provider-core`, `workers-core`, `agent-runtime-core`, and `gateway-core`; every package is in the [package graph](../architecture/packages.md) |
| `packages/ui-ops`, `packages/gateway-turns`, `packages/statistics` | libraries: the UI engine, the gateways' shared text tool protocol, and the evaluation engine's statistics |
| `packages/plugins/*` | every Cordis plugin, one package each |
| `packages/system-bundle` | the bundle that mounts the plugins ([`cordis.patch.yml`](../../packages/system-bundle/cordis.patch.yml)) |
| `packages/cli` | the `system` command |
| `scripts/`, `spikes/` | repository checks and generators; the test groups ([testing](testing.md#test-groups)); the release scripts ([releasing](releasing.md)); the live install's update ([runbook](../operations/runbooks.md#update-the-live-install-from-e218ae7-to-the-base-release)); the experiments' helpers ([experiments](../validation/experiments/README.md)); the statistics goldens' generator ([golden tests](../design/statistics.md#golden-tests)); the M0 spike |

Each package has a colocated `README.md` that says what it owns, what it does not
own, its entry points, and its dependency direction, and links back to
[components](../architecture/components.md).

## Composition

The host is DSH core, started with the `system` profile, which lists only the
`system` bundle. The bundle inserts the allow-listed DSH core rows (no
`dsh-base`) and every `system` plugin; the operator's patch file
(`<DSH_HOME>/profiles/system/cordis.patch.yml`) configures them
([plugin model](../architecture/plugin-model.md#composition)). There is one
shipped profile. Tests compose their own `cordis.yml` with fakes.

## Commands

The root [`package.json`](../../package.json) `scripts` are canonical:

```sh
pnpm install
pnpm build              # tsc → lib/ for every package
pnpm check              # docs, secrets, schemas, migrations; reference, packages, manifests, and traceability freshness; oxlint; typecheck
pnpm gen:reference      # regenerate docs/reference/configuration.md after changing a plugin Config, and the schema contract snapshot after a schema change
pnpm gen:packages       # regenerate docs/architecture/packages.md after changing a package or its seams
pnpm gen:manifests      # regenerate every plugin-manifest.json after changing a plugin's seams, Config, egress check, or package.json
pnpm gen:traceability   # regenerate docs/validation/traceability.md from test titles
pnpm test               # every *.spec.ts: unit, contract, driver, concurrency, and architecture tests: the whole suite
pnpm test:group <name>  # one functional group of it (testing.md#test-groups); no name lists them
pnpm test:affected      # the groups the change since origin/main affects (--base <ref>, --dry-run)
pnpm test:e2e           # build, then boot the real profile through dsh (packages/cli/tests)
pnpm test:crash         # build, then SIGKILL the engine at each crash point and restart it (testing.md)
pnpm changeset          # record a user-visible change for the next release (releasing.md)
pnpm version-packages   # apply the changesets and seed the release's upgrade fixture
pnpm release:artifacts  # tarballs, SBOMs, SHA256SUMS, and notes in dist/release/
```

A path after a test script goes to Vitest as a filter: `pnpm test scripts/checks.spec.ts`
runs one file. `pnpm test:e2e <file>` and `pnpm test:crash <file>` build first, then
run that file.

A root script that runs pnpm again (`check`, `build`, `test:e2e`, `test:crash`,
`audit:deps`) calls it as `"$npm_execpath"`, the pnpm that is running the script,
never a `pnpm` looked up on `PATH`. So every step of `pnpm check` runs on the same
pnpm, and on a host whose pnpm comes from corepack alone `corepack pnpm check`
works with no `pnpm` on `PATH`. A new root script that runs pnpm does the same.
Run the scripts through pnpm: started any other way, `npm_execpath` does not
name pnpm and the script fails. The product itself still needs one there:
`system init` installs the profile through DSH's plugin manager, which runs the
`pnpm` on `PATH`, so `test:e2e` (every suite of it boots `system init`) needs
one too (`corepack enable` puts it there).

Run it locally on Linux:

```sh
node packages/cli/lib/bin.js init              # profile with only @tsuuanmi/system-bundle
node packages/cli/lib/bin.js start             # loopback daemon; MCP on 127.0.0.1:47317/mcp
node packages/cli/lib/bin.js mcp-config claude # or codex
```

After changing an MCP tool, regenerate its reference from a running profile:
`node packages/cli/lib/bin.js tools --markdown > docs/reference/mcp-tools.md`.

## Branches: dev and main

Work flows through two long-lived branches, `dev` and then `main`:

- **`dev` integrates.** Workers' branches and the lead's batches merge into
  `dev`. CI runs the full gate on every push to `dev`, as on `main`
  ([CI gates](testing.md#ci-gates)).
- **The live install follows `dev`.** The automatic live update runs with
  `--branch dev` ([runbook](../operations/runbooks.md#update-the-live-install-automatically)),
  and only a commit whose CI passed reaches it, as a fast-forward.
- **`main` takes `dev` only by the operator.** `dev` reaches `main` only when the
  operator merges a `dev` → `main` pull request: for a release, or for a point
  that needs the operator's permission. A release tag is cut from `main` only
  ([releasing](releasing.md#cutting-a-release)).
- **A fix to something live goes to `dev` first**, never straight to `main`.

## Give work to System Workers

A lead can give a change to System itself, as the coordination did on 2026-10-25: a board task
that one run of [`algorithm-development`](../reference/workflow-templates.md#algorithm-development)
serves per attempt. The [board](../design/board.md), the
[workflow engine's board tasks](../design/workflow-engine.md#board-tasks), and
[approvals](../design/approvals.md) are canonical; this is the path through them.

1. **Propose** with MCP `board_propose`: the project, a `title`, a `goal`, the `acceptance`
   criteria (name each validation command in one, exactly as the policy lists it, with its
   `check`), `actionClass: workspace-write`, `template: algorithm-development`, and `writes`
   `{ type: git-head, ref: <HEAD> }`. The worktree is cut from HEAD when the run starts, so
   propose just before running, after merging what the task builds on
   ([pilot](../operations/pilot.md#plan-the-work), [attempts](../design/board.md#attempts)).
2. **Start an attempt** with MCP `run`: `template: algorithm-development`, `variant: docs` or
   `tests` for docs or test work (none for code), and `task: { taskId }`, which claims the ready
   task (CLI: `system run algorithm-development --variant docs --task <taskId> -`). The `input` is
   the writing step's. Write it in two parts, "Develop step" and "Validation step", each saying
   it binds only that step, so one step's orders never become another's. `validate:1` reads the
   criteria from its brief, never the input, so a command not named in a criterion is not run
   ([which inputs reach which step](../reference/workflow-templates.md#which-inputs-reach-which-step)).
   Point the develop step at [CONTRIBUTING](../../CONTRIBUTING.md): a writer takes the next free
   ADR number, store migration version, and schema version, since runs written beside it take
   "the next" from the same tree
   ([what parallel changes collide on](testing.md#what-parallel-changes-collide-on)).
3. **What a step may run.** Every tool call passes the run's gate
   ([a Worker's tool calls](../design/approvals.md#a-workers-tool-calls)). Edits inside the
   worktree are `workspace-write`. A command runs unasked only when its exact argv is in the
   studio policy's `commands`; for this repository list `corepack pnpm check`,
   `corepack pnpm test:affected`, and each `corepack pnpm gen:*` generator by its full name
   ([change the autonomy policy](../operations/runbooks.md#change-the-autonomy-policy)). Any
   other command waits on the approval queue in `develop:1`, and is denied, reported not run, in
   `validate:1`, which has no session. A fixed read-only inspection command (`cat`, `rg`, `ls`,
   `sed -n`, …) is a `read` only when every path in it is absolute; Codex Workers read through
   such commands, so tell them to use absolute paths
   ([how a call is classified](../design/approvals.md#how-a-call-is-classified)). The commands
   need the worktree's offline setup
   ([ADR-0058](../decisions/adr/0058-a-run-worktree-is-set-up-offline-before-its-agent-starts.md),
   [runbook](../operations/runbooks.md#set-up-a-runs-worktree)).
4. **Follow it**: `system explain <runId>` gives the task's admission, each step's route and
   acceptance, the result's subject, and the report to the board; `system events --run <runId>`
   (or `--type`) reads its events. MCP `board_task` gives the task's state and why it waits.
5. **Answer a question.** A step that cannot finish without a person answers
   `{"questions": [...]}`, and the task waits for input. Answer every question, by index, with
   MCP `board_update` `answers`; the next attempt goes through the gate, its brief pointing at the
   answers ([a question from a run](../design/workflow-engine.md#a-question-from-a-run)).

After the run, the engine runs the checks the studio policy requires (`tests` and `lint`) on the
result's exact tree, with the commands configured for the repository
([ADR-0063](../decisions/adr/0063-a-runs-required-checks-run-on-its-exact-result.md),
[runbook](../operations/runbooks.md#let-a-run-pass-the-required-checks)). A result whose required
checks pass at acceptance no longer waits for the operator to run them; a failed check is another
attempt; a check still pending holds the review for the operator
([a review held for the operator](../design/board.md#a-review-held-for-the-operator)):

- **Accepted**, the task is `done`. The system commits the worktree on `system/run/<runId>` and
  asks the operator to merge it into the repository's checked-out branch (keep that `dev`,
  [above](#branches-dev-and-main)), one `merge` request that always asks ([ADR-0060](../decisions/adr/0060-an-accepted-result-lands-on-the-operators-merge-approval.md),
  [landing](../design/workflow-engine.md#landing-an-accepted-result)).
- **Rejected**, another attempt runs while attempts are left, as a new run that the lead starts.
  Its brief points at the previous result; the operator's note reaches no brief, so the lead puts
  why it was not accepted in the next input. Only an attempt that failed after its writing step,
  for a reason that says nothing about the change, starts from that change
  ([ADR-0061](../decisions/adr/0061-a-tasks-next-attempt-starts-from-the-work-its-previous-attempt-left.md)).

## Data directory

Runtime state lives under `<DSH_HOME>/system/` (default `~/.dsh/system/`), with
directories `0700` and files `0600`. This includes the store, the vault and its
key, the MCP discovery file and the scope token files, login profiles, the managed Chrome, and
UI map overlays. For development, set `DSH_HOME` to another directory and use
separate provider accounts, so development never touches production state.
