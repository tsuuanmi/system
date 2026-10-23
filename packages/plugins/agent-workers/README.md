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

- **Workers come from configuration only** (INV-6), in one of two shapes of the
  row, never both (`config_error`):
  - **account × role** (`roles`, `assignments`; PROP-0012 phase F, ADR-0051;
    `src/roles.ts`, below);
  - **hand-named** (`workers`), the shape before phase F. These load and run
    exactly as before until the operator applies `system account migrate`
    (below); from then on the row is refused at load, naming the way forward
    and back. `maxConcurrentRunsPerAccount`, `pool`, `windows`, and
    `limitCooldownSeconds` on a `providers` entry belong to the first shape and
    are refused beside hand-named Workers.

  A hand-named entry is `agent:<id>`
  with a `runtime` kind, an absolute `workspace`, a `sandbox` (`read-only` or
  `workspace-write`), and optional `tools` (omitted or empty: the runtime's
  minimal set), `model`, and `maxTurns`. It also
  has a `tier`, and a `quotaClass` (default `agent-plan`). The Worker is local.
  Its provider family (`capability-descriptor@1.1`) is its `family`, by
  default its runtime: give Workers of one vendor's models the same family, so
  team members of one vendor stay apart (ADR-0027). Optional,
  for metering: `pool` and `account` (set together: a pool id from the
  resources configuration and the account it belongs to), and `windows`, the
  runtime's limit window names mapped to the pool's window ids (for example
  `five_hour: five-hour`). Optional: `worktreePerRun` (default false; see
  below). Workers configured with the same workspace must agree on it, or the
  plugin refuses to load (`config_error`): a reviewer must read the tree it
  reviews. Optional: `reviewMember` (default false; see **Review members**
  below), refused at load (`config_error`) unless the sandbox is `read-only`
  (a writer never reviews), `family` is set, and `worktreePerRun` is off.
- **Workers = account × role** (`src/roles.ts`; PROP-0012 phase F,
  [design](../../../docs/design/agent-runtimes.md#workers--account--role)):
  - a **role** (`roles`) is defined once: `id`, an absolute `workspace`,
    `sandbox`, `tier`, `quotaClass`, `worktreePerRun`, `reviewMember`, and under
    `runtimes.<runtime>` what differs per runtime (`tools`, `model`,
    `maxTurns`, `family`; a review member's role names the family of each
    runtime it is assigned on);
  - an **assignment** (`assignments`) gives an enrolled account its roles, by
    the id `system account list` shows: `{ account, roles }`, one entry per
    account. An account with no assignment has no Worker;
  - each assignment of a role derives the Worker `agent:<accountId>/<role>`
    (`deriveWorkers`, a pure function: the same configuration, the same Workers
    in the same order). Its runtime is the account's provider, its family
    `runtimes.<runtime>.family` or the runtime;
  - it takes work only while its account is `ready` (REQ-ACC-11): an account no
    slot holds, enrolled and not verified, signed out, or quarantined
    (`unverified` included) leaves it `unavailable` with why, and probes
    nothing. A run queued on it fails before the agent starts. Its runs and
    probes run in its account's home (`RunSpec.home`, `probeIn`), none when
    that is the runtime's own (slot 1); the account is read again before each
    run;
  - **per account**: one scheduler per account runs
    `maxConcurrentRunsPerAccount` (its provider's, default 1, at most 16) of its
    runs at once across its roles, one per Worker; each Worker reports its
    account's `load` (`running`, `queued` across the account's Workers,
    `pending` admissions counted by `reserve` until released, `slots`), and is
    `busy` while `running` reaches `slots` (still admitted, ordered after less
    busy ones; ADR-0033); `siblings` are the account's Workers; a limit's
    cooldown is the account's (table `agent_cooldowns`, keyed by the account
    id; event data `account`);
  - **pools per account**: a provider's `pool` names a template of the
    resources row (`templates`), and each of its accounts' Workers draws on that
    account's own pool, `<pool>/<accountId>`, with the provider's `windows` and
    `limitCooldownSeconds`. The source declares each `ready` assigned account of
    a metered provider to the ledger (`declare('agents', …)`, again whenever
    that set changes or the ledger is another one); a ledger with no `declare`,
    or that refuses, leaves those pools unmade and their Workers `unavailable`
    (INV-2). A limit on one account never closes another's.
- **The move from hand-named rows** (`src/migrate.ts`, `system account
  migrate`, MCP `account_migrate`, operator scope;
  [runbook](../../../docs/operations/runbooks.md#migrate-agent-workers-to-accounts--roles)):
  - `planMigration` (rule `agent-workers.migration`, pure) gives the new row
    from the loaded hand-named rows: rows that agree on the work's settings are
    one role (`review` when read-only, `develop` when writing, then `review-2`,
    …; a second row of one runtime starts another role), what each runtime set
    goes under `runtimes`; slot 1 of each runtime (its configured home, adopted
    where it is) is assigned that runtime's roles by its verified id; an old
    `pool` becomes the provider's template (with its windows, `unknown`, and
    the cooldown), and `maxConcurrentRunsPerAccount` the number of the
    runtime's rows, so as many runs run at once as did;
  - blockers stop it: a runtime not registered, no account in slot 1, slot 1
    not the runtime's own home, an account not `ready` (an `unverified` one
    waits for its reader, PROP-0012 open question 1, unless the operator
    stops that runtime's Workers: `stop`), rows of one runtime on different
    pools, windows, or cooldowns, or a pool the ledger does not configure;
  - planning changes nothing. `apply` is refused while it has blockers or a run
    of an old Worker is queued or running (drain first); otherwise, in one
    transaction: an `enrollment` decision per old Worker (`migrated` to its new
    id, its input the account's latest enrollment decision, or `stopped`), each
    agent session and run of the old Worker moved to its new id (each move kept,
    table `agent_cutover_moves`, migration 11), and the cutover's own
    `enrollment` decision (`applied`, its inputs the moves'), kept in
    `agent_cutover`. Applying again changes nothing (`already-applied`);
  - once applied, hand-named Workers already loaded are `unavailable` and start
    nothing, and a row with hand-named Workers is refused at the next load
    (`config_error`, naming `system account migrate --rollback`);
  - `rollback` (refused while a run of a moved-to Worker is queued or running)
    moves each moved session and run back unless it moved again since, lifts
    the refusal, and records `rolled-back` (its input the cutover's decision).
    Records already written (results, usage, decisions) keep the ids they were
    written with; the `workerSessions` records of team members are not moved.
- **Accounts** (`providers`, ADR-0052): a hand-named Worker runs on its
  runtime's one home, so every hand-named Worker of a runtime names the account
  `{ id: <runtime>, group: <runtime> }` (`capability-descriptor@1.5`); a derived
  Worker names `{ id: <accountId>, group: <runtime> }`. Each with its runtime's mode:
  `assigned` by default, or `pooled` only with `pooledTerms` (who confirmed the
  plan's terms allow it, when, which terms; refused at load otherwise, and
  recorded at start as a `gate` decision, rule `agent-workers.pooled-terms`).
  A metered Worker whose pool is out says when it is back (`limitUntil`, the
  ledger's `until`), so a node that only it could take waits for the reset
  instead of failing ([assigned accounts](../../../docs/design/routing.md#assigned-accounts)).
- **Enrolled accounts** (`src/accounts.ts`, `src/tools.ts`; PROP-0012 phase E,
  ADR-0051; [design](../../../docs/design/agent-runtimes.md#enrollment-and-quarantine),
  [runbook](../../../docs/operations/runbooks.md#enroll-an-agent-account)):
  - Each runtime has `slots` (its `providers` entry, default 1, at most 64),
    each an owner-only home: slot 1 adopts the runtime's own home (`home` on its
    provider) where it is, slot `n` is `<accountHomes>/<runtime>/<n>` (default
    `<DSH_HOME>/system/agent-homes`). A slot is kept as an `agent-account@1.0`
    record (store table `agent_accounts`, migration 10), validated on every write.
  - The account id is `<runtime>:<16 hex>` of the runtime's `identity(home, key)`
    HMAC, keyed by 32 bytes made once in the credential vault
    (`system-agent-workers/identity-key`); no vault, and nothing is read.
  - `ready`, `signed-out`, or quarantined `changed`, `ambiguous`, `duplicate`
    (both slots), or `unverified` (no reader: the Antigravity CLI, or a version
    not pinned), by the rule `agent-accounts.enrollment` (`assess`). Every
    change is an `enrollment` decision (`decision@1.8`) recorded first, its
    input the slot's earlier decision, never the principal.
  - The operator's tools, operator scope, checked against
    `mcp-agent-accounts@1.1`: `account_enroll` (step `begin` takes a slot and
    returns the runtime's sign-in command for its home; step `verify` records
    who signed in; `accept` takes a `changed` slot's new principal as a new
    account), `account_remove` (frees a slot, keeping its home),
    `account_agents` (every slot with the Workers that run on its account, and
    each runtime's slots), and `account_migrate` (above). Only the operator's
    `verify` lifts a quarantine or a sign-out.
  - Each probe re-reads the runtime's `ready` accounts, and each run the
    account of its home: a different principal is quarantined `changed`, none
    signed out, recorded first; a re-read never lifts anything.
  - Hand-named Workers run in their runtime's own home, slot 1's: they take
    work while no slot holds it, or while its account is `ready` or
    `unverified` (no verified reader, as before enrollment); otherwise they are
    `unavailable` with the reason, and a queued run fails before the agent
    starts (`config_error`). Accounts in later slots run only derived Workers.
- **One account, every role** (PROP-0012 phase C): the Workers of one account
  (a hand-named Worker's: every Worker of its runtime, which share its home)
  are one account, and each sees what holds the others:
  - `siblings(worker)` names every Worker of its account, itself included, by
    id. A failover leaves them all out (ADR-0034), and a team member avoids them
    all once another member holds one (REQ-TEAM-4,
    [teams](../../../docs/design/teams.md#distinct-accounts)): two roles of one home are
    never two members.
  - A Worker is `quota-exhausted` while its account cools down (below) or while
    the pool of **any** Worker of its account is closed, with `limitUntil` the
    latest of their resets (none when one of them names none): the account is
    back only once each is. It is `unavailable` while such a pool cannot be
    read (INV-2). A run queued on it then fails before the agent starts
    (`quota_exhausted`, or `config_error` for an unreadable pool), naming the
    pool and the Worker it belongs to; its own pool stays its reservation's to
    check.
  - A session stays on its one Worker (`affinity`): it never moves to another
    role (another sandbox) of the account.
- **Capabilities are what `probe()` proves now** ([`src/probes.ts`](src/probes.ts)). A
  runtime's probe result stands for `probeTtlMs` (default 5 min) from when its probe started,
  never longer. Once it is half that old, the next probe starts in the background, one at a time
  per runtime, so a describe never waits for a re-probe (the router gives the whole source 5 s):
  - a describe waits only for a runtime's first probe; a result past `probeTtlMs` admits nothing
    (the Worker is `unavailable`) until the probe in the background finishes;
  - the latest result wins, failed or not: a probe that throws, or proves less, makes the Worker
    `unavailable` at once, never outlived by an older success;
  - a probe slower than half of `probeTtlMs` is logged once, and the next starts at once;
  - a run's own check before the agent starts waits for a result within `probeTtlMs`;
  - `probeTtlMs: 0` keeps none: every read waits for a probe.

  The capabilities:
  - `local-data`;
  - `review` only for a read-only sandbox: a review is independent of the
    change (INV-15);
  - `develop` for a writable sandbox, and `validate` only if the runtime can
    also run commands confined to the workspace (`executes`);
  - `persistent-conversation` when the runtime can resume;
  - under the review-member profile only, offers scoped to a review member's
    steps (`capability-descriptor@1.4`), granted by the profile while it is
    enforced (the Worker is ready): `reason`, and `persistent-conversation`
    (evidence `conformance`, kept by an exact replay) when the runtime cannot
    resume.

  A Worker never offers plain `reason`, so ordinary asks never spend agent-plan
  quota (P1). If the runtime is missing, cannot enforce the configured sandbox,
  does not prove `readsConfined` (ADR-0024), or cannot ask a tool gate before
  each tool call (`gatesToolCalls`), the Worker is `unavailable`: its policy is
  never loosened. The same proof is checked again before each run starts.
- **Runs** (`start`, `get`, `wait`):
  - durable at once, and idempotent by key;
  - one at a time per Worker (one writer per workspace, INV-15), and for a
    derived Worker at most `maxConcurrentRunsPerAccount` of its account's at once;
  - under a lease;
  - each result is a `report` artifact with the requirement's classification:
    `agent-result@1.2` (with `model`, `usage`, and `models`) when the runtime
    reported its token usage, `agent-result@1.1` otherwise. It carries the
    workspace the run worked in (with `worktreePerRun`, its worktree) and, when that is a git
    working tree, its exact subject after the run, which a review binds to. A working tree git
    cannot read then (any failure but git's answer that it is no repository with a commit) fails
    the run as `reconciliation_failed`: its result is never stored as if it had no subject.
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
    logged and never changes the run's own outcome. A record refused as
    `invalid` with `models` is offered again without them (the totals are what
    a cap counts). Usage the ledger could not count is recorded
    ([usage the ledger cannot count](../../../docs/design/resources.md#usage-the-ledger-cannot-count)):
    one `usage.unknown` event (with `ctx.eventLog`; the workflow run as its
    `runId`), its data `usage-unknown@1.0`: `not-reported` for a run that
    reported neither tokens nor turns, `refused` (the ledger's `failure`, and
    the refused record kept as an `evidence` artifact when it is a valid
    record) or `failed` for one it did not take, and `interrupted` below. A
    fact that cannot be appended is logged. A cap counts such a run as 0;
  - **observe** each rate-limit observation the runtime reported as a
    `limit-state` reading (source `runtime-result`) of the window `windows`
    maps it to: `limited` with `resetsAt` when `rejected`, `limited` until
    `limitCooldownSeconds` (default 3600) after the observation when
    `rejected` without a reset time, never `unknown`, `ok` otherwise. A
    `rejected` limit on a window `windows` does not map closes every window
    of the pool, so it is never retried there unseen (INV-2); any other
    unmapped window is logged and skipped. A run that fails `quota_exhausted`
    and left no `limited` reading (its runtime read no reset time,
    [limit readings](../../../docs/design/agent-runtimes.md#limit-readings))
    closes every window of the pool with a `limited`
    reading (source `limit-notice`) for `limitCooldownSeconds`; a later
    reading of a window says otherwise. A closed pool holds every Worker of
    the runtime, not only the metered one (**One account, every role**);
  - **release** the reservation once the usage is recorded, or when the run
    fails before it starts.

  Without a `pool`, runs are not metered, whether a ledger is loaded or not.
- **A usage limit with no ledger reading** (PROP-0012 phase C, INV-2): a run
  that fails `quota_exhausted` on a Worker with no `pool`, or whose ledger did
  not take the readings above, cools its **account** down (table
  `agent_cooldowns`): a hand-named Worker's runtime, whose Workers share its one
  home, or a derived Worker's account. Every Worker of it is `quota-exhausted`, and a run queued
  on one fails `quota_exhausted` before the agent starts, until the latest
  reset time a `rejected` observation of the run named, else for the failing
  Worker's `limitCooldownSeconds`, never more than seven days (INV-9). It
  survives a restart and ends only at that time. Event `agent-workers.cooldown`
  (`runtime`, a derived Worker's `account`, `worker`, `agentRun`, `until`, and
  the failure's message).
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
  transcript`), later (not built yet). Until then a metered one is recorded
  as `usage.unknown` of kind `interrupted`, under the pool its reservation drew
  on while its Worker still names it (else logged).
- **Never stranded:** a run whose `agent-run:<id>` lease another process holds
  is looked at again once that lease would expire (it finishes the run, or it
  crashed). A run whose lease was lost is looked at again after the lease
  period; a run already submitted then fails as `reconciliation_failed`, never
  run again (INV-4).
- **Sessions:** a session id is bound to its Worker (`affinity`). Later runs
  resume the agent's native session, on a runtime that reports `resume`; no
  other runtime is ever asked to resume one, and the session keeps no native
  handle there. With `worktreePerRun`, a session resumed by another workflow
  run resumes in that run's worktree. A `reset` (a compaction) starts the
  session's next run fresh: no native handle, and a new generation for a replay.
  On a runtime that cannot resume, a session's later run is refused
  (`config_error`, unsent) unless it is a review member's (below).
- **Review members**
  ([ADR-0049](../../../docs/decisions/adr/0049-read-only-agent-workers-as-review-members.md)):
  a read-only Worker configured `reviewMember: true` runs a `review` team
  member's steps (scope `review-member`, which the workflow engine names on
  each proposal, ballot, and debate of a `review` team) under the enforced
  **review-member profile**, and only those:
  - the profile grants `reason` for those steps, never for an ask, a
    brainstorm, research, a planner, or a digest; a Worker not under it never
    runs one (`config_error`, unsent);
  - the step's workspace must be an empty directory outside any git work tree,
    checked before anything is sent (`config_error`), so the member's material
    is its prompt alone; after the step it must still be empty, or the run
    fails as `reconciliation_failed`;
  - the run's gate denies every tool call (`./src/gate.ts`), each a recorded
    `gate` decision;
  - its record is `agent-result@1.3` with `profile: review-member`;
  - on a runtime that resumes, the member's steps continue its native session;
    a step whose session has earlier turns but no native handle is refused
    (`invalid_input`, unsent), never started fresh;
  - on a runtime that cannot (the Antigravity CLI), the member's conversation
    is **replayed**, not resumed: a later run's prompt is the session's earlier
    completed runs of its generation, each its own message and its answer
    exactly as recorded, in order, each between fence lines derived from its
    own text, then the new message. Every earlier run ran under the profile, so
    no tool ran in it. The runs it replays are fixed in the run's row when it is
    first prepared, and its `agent-result@1.3` names them (`replay.runs`), their
    answers (`replay.answers`, also its `inputs`), and the hash of everything
    sent (`replay.promptHash`); `promptHash` stays its own message's;
  - a replay fails closed, unsent (`invalid_input`): an earlier run still open,
    one not run under the profile, an answer no longer stored, or more than
    `maxReplayChars` (default 200,000) characters of earlier turns; a history
    is never cut (INV-9);
  - egress checks exactly what is sent, the replay included, at the strictest
    classification of the turns it holds (INV-12).
- **Injects:** `store`, `artifacts`, `leases`, `workers`, `agentRuntimes`, `egress`;
  reads `resources`, `approvals`, and `eventLog` when present.
