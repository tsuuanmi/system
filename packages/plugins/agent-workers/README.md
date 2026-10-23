# @tsuuanmi/system-agent-workers

The **`agents` Worker source**: agent runtimes as Workers
([design](../../../docs/design/agent-runtimes.md)).

- **On by default, with no Worker** (PROP-0010 B3): this row, `agent-runtimes`,
  and `runtime-claude-agent-sdk` are on in the default composition; Codex
  ([runbook](../../../docs/operations/runbooks.md#codex-workers)), ACP,
  and the software-development profile, whose `agent-review` template only
  these Workers can run, stay off
  ([turn them on](../../../docs/operations/runbooks.md#turn-an-off-row-back-on)).
  The bundle names no workspace, so it configures no Worker: the operator adds
  them for a repository ([runbook](../../../docs/operations/runbooks.md#agent-workers)).
  A Worker whose runtime is missing, or not signed in, is `unavailable`; the
  profile still boots.

- **Workers come from configuration only** (INV-6). Each entry is `agent:<id>`
  with a `runtime` kind, an absolute `workspace`, a `sandbox` (`read-only` or
  `workspace-write`), and optional `tools` (omitted or empty: the runtime's
  minimal set), `model`, and `maxTurns`. It also
  has a `tier`, and a `quotaClass` (default `agent-plan`). The Worker is local.
  Its provider family (`capability-descriptor@1.1`) is its runtime. Optional,
  for metering: `pool` and `account` (set together: a pool id from the
  resources configuration and the account it belongs to), and `windows`, the
  runtime's limit window names mapped to the pool's window ids (for example
  `five_hour: five-hour`). Optional: `worktreePerRun` (default false; see
  below). Workers configured with the same workspace must agree on it, or the
  plugin refuses to load (`config_error`): a reviewer must read the tree it
  reviews.
- **Capabilities are what `probe()` proves now** (cached for `probeTtlMs`):
  - `local-data`;
  - `review` only for a read-only sandbox: a review is independent of the
    change (INV-15);
  - `develop` for a writable sandbox, and `validate` only if the runtime can
    also run commands confined to the workspace (`executes`);
  - `persistent-conversation` when the runtime can resume.

  A Worker never offers plain `reason`, so ordinary asks never spend agent-plan
  quota (P1). If the runtime is missing, cannot enforce the configured sandbox,
  does not prove `readsConfined` (ADR-0024), or cannot ask a tool gate before
  each tool call (`gatesToolCalls`), the Worker is `unavailable`: its policy is
  never loosened. The same proof is checked again before each run starts.
- **Runs** (`start`, `get`, `wait`):
  - durable at once, and idempotent by key;
  - one at a time per Worker (one writer per workspace, INV-15);
  - under a lease;
  - each result is a `report` artifact with the requirement's classification:
    `agent-result@1.2` (with `model`, `usage`, and `models`) when the runtime
    reported its token usage, `agent-result@1.1` otherwise. It carries the
    workspace the run worked in (with `worktreePerRun`, its worktree) and, when that is a git
    working tree, its exact subject after the run, which a review binds to.
- **A worktree per workflow run** (`worktreePerRun`, PROP-0010 B3, INV-15):
  - the Worker's `workspace` must be the top level of a git repository with a
    commit, outside `worktreeRoot`, with git 2.17 or later. Otherwise the
    Worker is `unavailable`, the problem is logged once as a `config_error`, and
    a run started on it fails unsubmitted as `config_error`;
  - each run that belongs to a workflow run (`WorkerStart.runId`) works in that
    run's own worktree, `<worktreeRoot>/<repository name>-<hash of its real
    path>/<runId>` (default root `<DSH_HOME>/system/worktrees`, owner-only), on
    the branch `system/run/<runId>`. A run that belongs to no workflow run
    works in the configured workspace;
  - one worktree per (repository, workflow run): the first agent run creates it
    from the repository's HEAD (`git worktree add -b`), and every later one of
    that workflow run on that repository, reviewers included, works in it. So
    a review reads the developer's tree and binds to its exact subject, and a
    remediation fix writes there. A run continued after its worktree was
    removed gets it again from its branch. Creation is one at a time per
    repository; the mapping is stored, so a restart reuses it. The run's
    `RunSpec`, its captured subject, and the result's `workspace` are the
    worktree. A worktree path that holds anything else is never taken over;
  - the repository's checked-out branch and main working tree are never written,
    and git always runs with `-C <path>`, fixed arguments, no shell, no hooks,
    no system or global configuration, and a 60 s bound;
  - **a brief's files** (`brief@1.2` `files`, the board's `TASKS.md` for a board
    task's run): resolved at start like the prompt, checked at egress with it
    (one check of exactly what the agent is given, INV-12), and written into
    the run's worktree before the agent starts, under `.system/`, whose own
    `.gitignore` (`*`) makes git ignore it: never in the worktree's subject, a
    review's diff, or a commit. `.system` is opened once, as itself
    (`O_DIRECTORY | O_NOFOLLOW`), and every file is written relative to that
    descriptor (through `/proc/self/fd`), so nothing is checked by name before
    it is used and nothing swapped in at the name meanwhile is written through.
    Each file is written whole, read-only (0444), beside its name and renamed
    over it, never through a link; edits are never read back. A repository
    that tracks anything under `.system/`, a `.system`
    that is not a plain directory, or a file of it that is not a plain file,
    fails the run unsubmitted (`config_error`). The prompt names the files
    only when they are written: a run of no workflow run, or of a Worker
    without `worktreePerRun`, gets none;
  - an agent can write the worktree's `.git` file, so git never follows it: a
    run whose worktree's `.git` file no longer points to the worktree's own
    directory fails as `reconciliation_failed`, and the worktree is left for
    the operator (a later run of it fails as `config_error`);
  - **cleanup** (INV-9), at start and hourly: when every agent run of a
    workflow run has finished, and the last ended more than
    `worktreeRetentionHours` ago (default 168; 0 keeps every worktree), a
    `retention` decision (rule `agent-workers.worktree-retention`, INV-13, one
    per worktree, under the workflow run) retires the worktree: its changes are
    committed on its branch (`.system/` removed first, emptied through its
    descriptor as it was written, unless the repository tracks it or it is
    not a plain directory; then `git add --all`, author `system
    <system@localhost>`, a message naming the run), then it is removed (`git
    worktree remove`, never forced). Files the repository
    ignores go with it. A branch is never deleted. A worktree that cannot be
    committed or removed (locked, say) stays in place, with the reason logged
    once and kept on its row, and the next sweep tries again; at most 50 a
    sweep. A worktree removed by hand is forgotten once git no longer lists it.
- **Metering** ([resources](../../../docs/design/resources.md)), for a Worker
  with a `pool`, through `ctx.resources` (optional: read when present, never
  injected):
  - **admission:** `describe()` reports the Worker `quota-exhausted` while its
    pool is unavailable, so routing skips it (REQ-WRK-8). With no ledger
    loaded, a pool the ledger does not configure, or a ledger that cannot be
    read, it is `unavailable` (INV-2);
  - **reserve** before the run, after the egress check and before anything
    reaches the agent: one line, `runs` 1 on the pool, for the board task and
    project the run's brief serves, if any. The `budget` decision
    joins the run's decisions. A refused reservation fails the run unsubmitted
    as `quota_exhausted` (`config_error` when the ledger does not configure the
    pool, or no ledger is loaded), and nothing runs;
  - **record** after the run, completed, failed, or aborted: one `usage-record`
    (source `runtime-result`; `requestId` `<runtime>:<the runtime's result
    id>`, or the run id when it gives none; `runId`, `account`, `pool`,
    `worker`, `sessionId`, `taskId` and `projectId` (the board task its brief
    serves, read from the engine's brief record, never from model text), `model` (request: the configured model; response:
    the runtime's main model), `usage`, `models`, `turns`, `durationMs` (from
    submission to the end), `cost` with basis `runtime-estimate`, and
    `outcome`). Numbers the runtime did not report stay missing; a run that
    reported neither tokens nor turns gets no record. A ledger refusal is
    logged and never changes the run's own outcome;
  - **observe** each rate-limit observation the runtime reported as a
    `limit-state` reading (source `runtime-result`) of the window `windows`
    maps it to: `limited` with `resetsAt` when `rejected`, `limited` until
    `limitCooldownSeconds` (default 3600) after the observation when
    `rejected` without a reset time, never `unknown`, `ok` otherwise. A
    `rejected` limit on a window `windows` does not map closes every window
    of the pool, so it is never retried there unseen (INV-2); any other
    unmapped window is logged and skipped. A run that fails `quota_exhausted`
    and left no `limited` reading (Codex and the Antigravity CLI report no
    limit observation) closes every window of the pool with a `limited`
    reading (source `limit-notice`) for `limitCooldownSeconds`; a later
    reading of a window says otherwise;
  - **release** the reservation once the usage is recorded, or when the run
    fails before it starts.

  Without a `pool`, runs are not metered, whether a ledger is loaded or not.
- **A usage limit with no ledger reading** (PROP-0012 phase C, INV-2): a run
  that fails `quota_exhausted` on a Worker with no `pool`, or whose ledger did
  not take the readings above, cools its **runtime** down (table
  `agent_cooldowns`): its Workers share the runtime's one home, so its one
  sign-in. Every Worker of that runtime is `quota-exhausted`, and a run queued
  on one fails `quota_exhausted` before the agent starts, until the latest
  reset time a `rejected` observation of the run named, else for the failing
  Worker's `limitCooldownSeconds`, never more than seven days (INV-9). It
  survives a restart and ends only at that time. Event `agent-workers.cooldown`
  (`runtime`, `worker`, `agentRun`, `until`, and the failure's message).
- **Briefs** ([briefs](../../../docs/design/workflow-engine.md#briefs)): a run started with a
  `brief@1.x` renders its prompt from it at start (the default text rendering, each pointer
  replaced by its artifact's text); one that cannot be rendered is refused as `invalid_input`.
  A resumed session takes the brief as its next message. The source declares each Worker's
  confinement for its briefs (`sandbox`): the configured sandbox, in the run's workspace (with
  `worktreePerRun`, the workflow run's worktree, named before it exists), commands only where the
  runtime proved `executes` in a writable workspace, network as the egress policy and the tool
  gate allow.
- **Egress (INV-12):** the agent runs on this machine, but its model is remote.
  So before a run starts, its prompt is checked by `ctx.egress` with
  `workerClass: 'agent'`. The decision is part of the run's decision chain (as for website
  turns), so `system explain` shows it. A denial fails the run as `egress_denied`,
  never submitted. By default `local-private` work is refused here, although
  routing admits it (the Worker is local); see the egress plugin's
  `workerClasses`.
- **Tool gate** ([approvals](../../../docs/design/approvals.md#a-workers-tool-calls),
  [`src/gate.ts`](src/gate.ts)): every run carries a gate (`RunSpec.toolGate`)
  that its runtime asks before each tool call. It reads `ctx.approvals` when a
  call comes (optional, never injected); with none loaded, every call is
  denied, reads included (fail-closed rule 5). Otherwise:
  - it classifies the call by its tool and input only: `Read`, `NotebookRead`,
    `LS`, `Glob`, `Grep`, Codex's `view_image`, and the Antigravity CLI's
    `read_file` inside the run's workspace → `read`; `Write`, `Edit`,
    `MultiEdit`, `NotebookEdit`, the Antigravity CLI's `write_file` and
    `edit_file` of a file inside it, and Codex's `apply_patch` when every file
    its patch names is inside it → `workspace-write`; `Bash` → `command`, the
    argv the command split on single spaces (the policy's exact-argv rule);
    `WebFetch`, `WebSearch` → `external-send`. Anything else (the Antigravity
    CLI's `run_command` among it) is denied by the gate's own rule, without
    asking the policy, and so is:
    - a path whose real location (every symlink followed, `..` resolved on
      disk; for a file not yet there, its deepest existing ancestor's) is
      outside the workspace's real path, or that cannot be resolved; a `file:`
      URI is checked as the path it names;
    - an input field the tool's input type does not declare (Bash's
      `dangerouslyDisableSandbox`, say), or a declared one of another type;
    - a `Bash` argv word that is empty or holds a shell metacharacter
      (`SHELL_METACHARACTER`, the policy's own set, from `approvals-core`).

    A symlink created after the check is bounded by the runtime's own
    confinement, not by the gate;
  - it judges the action with `ctx.approvals.check` under the studio policy
    (no trusted envelope names an agent run's project yet): `forbid` denies
    with the decision's reason; `auto` and `notify` allow. A rule's required
    checks are the result's, which no tool call carries: they stay pending
    (the decision's `failedChecks`), the run's first such call of a class
    appends `agent-workers.tool.checks-pending` naming them, and they bind
    when the result is accepted (the board's `accept`); a pending check no rule
    can require denies. `notify` also appends `agent-workers.tool.notified`
    (with `ctx.eventLog`) naming the decision and any pending checks. So under
    the bundle's default studio policy a Worker reads and writes inside its
    workspace, `tests` and `lint` pending;
  - `ask`: in a run with a session, one approval request on the exact call
    (subject `content`, ref `agent-tool-call:<agent run>:<tool>`, version the
    content id of the canonical input; requester `worker` with the agent run,
    the session, and the call id), then `defer`. The run stops there: every
    later call is denied, and the run fails as `config_error` naming the
    request, whatever the runtime reported (the workers seam has no waiting
    status). A later run of the same session that makes the same exact call
    finds that request and checks it in full (subject, ref naming the agent run
    that opened it, version, action class, requester `worker` with that run and
    this session; any difference denies, never asks again), then defers again
    on the same request while it is open, runs it once approved
    (one approval, one call: the same call again asks anew), and is denied when
    it was rejected, expired, or withdrawn, with nothing new queued. A run with
    no session cannot wait, so an `ask` there is denied and nothing is queued;
  - every outcome is a recorded decision: the `autonomy` decision of `check`,
    the queue's own decision for a resolved request, or a `gate` decision (rule
    `agent-workers.tool-gate`) where the gate decided without the policy; denied
    and deferred calls also append `agent-workers.tool.denied` and
    `agent-workers.tool.deferred` (ids only, never the input). A gate that fails
    denies the call.

  The requests a gate opened are kept in `agent_tool_requests`: the session and
  exact call each is for, and when an approved one was used. Starting the later
  run once a request is approved is the work's owner's, not this source's: the
  workflow engine continues a run that serves no board task by itself, once per
  approval, finding the request from the `agent-workers.tool.deferred` event
  ([a deferred tool call](../../../docs/design/workflow-engine.md#a-deferred-tool-call));
  a board task's next attempt is the board's and the lead's.
- **Cancel (REQ-WRK-4):** a running agent is stopped, and a queued run never
  starts. Both fail as `aborted`.
- **Deadline:** a run longer than `runTimeoutMs` (15 min) is stopped and fails
  as `timeout`. The run was submitted, so it is not retried automatically.
- **Restart:** a queued run starts. A run that had started is never run again:
  the agent may already have acted. It fails as `reconciliation_failed`
  (`USER_ACTION`) and names its native session. Its reservation is released,
  and its usage is not invented: no result message means no `runtime-result`
  record; its usage comes from transcript reconciliation (`source:
  transcript`), later (not built yet).
- **Never stranded:** a run whose `agent-run:<id>` lease another process holds
  is looked at again once that lease would expire (it finishes the run, or it
  crashed). A run whose lease was lost is looked at again after the lease
  period; a run already submitted then fails as `reconciliation_failed`, never
  run again (INV-4).
- **Sessions:** a session id is bound to its Worker (`affinity`). Later runs
  resume the agent's native session. With `worktreePerRun`, a session resumed
  by another workflow run resumes in that run's worktree.
- **Injects:** `store`, `artifacts`, `leases`, `workers`, `agentRuntimes`, `egress`;
  reads `resources`, `approvals`, and `eventLog` when present.
