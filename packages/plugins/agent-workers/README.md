# @tsuuanmi/system-agent-workers

The **`agents` Worker source**: agent runtimes as Workers
([design](../../../docs/design/agent-runtimes.md)).

- **On by default, with no Worker** (PROP-0010 B3): this row, `agent-runtimes`,
  and `runtime-claude-agent-sdk` are on in the default composition; Codex
  ([runbook](../../../docs/operations/runbooks.md#codex-workers)), ACP, the
  Antigravity CLI, and the software-development profile, whose `agent-review` template only
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
    and back. `maxConcurrentRunsPerAccount`, `pool`, `windows`,
    `limitCooldownSeconds`, and `limitReadSeconds` on a `providers` entry belong
    to the first shape and are refused beside hand-named Workers.

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
  Optional: `kinds`, the kinds of work the operator gives it (1 to 16 labels such
  as `code` or `docs`; [work kinds](../../../docs/design/routing.md#work-kinds),
  [ADR-0057](../../../docs/decisions/adr/0057-route-work-by-kind.md)): it is then
  described at `capability-descriptor@1.6` with them and takes only steps that
  name one of them, never a step that names none; unset, it takes any work. A
  malformed or repeated kind, an empty list, or kinds on a review member (whose
  steps name no kind) is refused at load (`config_error`). `checkConfig(config)`
  makes the same checks of the row's Workers and roles, and of its `worktreeSetup`
  entries (ADR-0058), without a host, so `system check` names such a problem
  before a restart.
- **Workers = account × role** (`src/roles.ts`; PROP-0012 phase F,
  [design](../../../docs/design/agent-runtimes.md#workers--account--role)):
  - a **role** (`roles`) is defined once: `id`, an absolute `workspace`,
    `sandbox`, `tier`, `quotaClass`, `worktreePerRun`, `reviewMember`, `kinds`
    (as a hand-named Worker's, for each of its Workers), and under
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
    (INV-2). A limit on one account never closes another's;
  - **each account's usage report** (`src/reports.ts`,
    [ADR-0059](../../../docs/decisions/adr/0059-quota-readings-from-each-accounts-own-usage-report.md),
    [an account's usage report](../../../docs/design/agent-runtimes.md#an-accounts-usage-report)):
    for each `ready` assigned account whose Workers draw on a declared pool,
    on a runtime that implements `limits`, the source reads the account's own
    usage report into its pool's windows every `limitReadSeconds` (the
    provider's; default 600, 60 to 86400, `0` off; with `pool` only, else
    `config_error`), and once after each of its runs (**Metering**, below). A
    periodic read is skipped while a read of the account, a run's own
    included, is less than a period old; at most one periodic read is in flight
    per runtime (the longest unread account first); each read goes through
    `readLimits` (30 s, aborted by a stop, which waits for it); the first pass
    runs a few seconds after a start, then each when the next account is due.
    `readUsageReports()` runs a pass now. A report that cannot be read records
    nothing and is logged (once per reason for the periodic read); the
    windows keep their last readings and `observedAt`. Why, and when, is kept
    per account in memory until a report of it is read:
    `AgentAccounts.unreadReport` gives it to the roster, which says it to the
    operator on each window with no reading yet.
- **The move from hand-named rows** (`src/migrate.ts`, `system account
  migrate`, MCP `account_migrate`, operator scope;
  [runbook](../../../docs/operations/runbooks.md#migrate-agent-workers-to-accounts--roles)):
  - `planMigration` (rule `agent-workers.migration` version 3, pure) gives the new row
    from the loaded hand-named rows: rows that agree on the work's settings
    (their `kinds` included, which the role keeps) are one role (`review` when read-only, `develop` when writing, then `review-2`,
    …; a second row of one runtime starts another role), what each runtime set
    goes under `runtimes`, and the rows' `description` when every row of the
    role gives the same one (none otherwise); slot 1 of each runtime (its configured home, adopted
    where it is) is assigned that runtime's roles by its verified id; an old
    `pool` becomes the provider's template (with its windows, `unknown`, and
    the cooldown), and `maxConcurrentRunsPerAccount` the number of the
    runtime's rows, so as many runs run at once as did;
  - blockers stop it: a runtime not registered, no account in slot 1 (for a
    runtime with no identity reader, which cannot enroll one, the cutover waits
    for a reader), slot 1 not the runtime's own home, an account not `ready` (an
    `unverified` one waits for its reader, PROP-0012 open question 1, unless
    the operator stops that runtime's Workers: `stop`), rows of one runtime on
    different pools, windows, or cooldowns, or a pool the ledger does not
    configure;
  - planning changes nothing. `apply` is refused while it has blockers or a run
    of an old Worker is queued or running (drain first); otherwise, in one
    transaction: an `enrollment` decision per old Worker (`migrated` to its new
    id, its input the account's latest enrollment decision, or `stopped`), each
    agent session and run of the old Worker moved to its new id (each move kept,
    table `agent_cutover_moves`, migration 11), and the cutover's own
    `enrollment` decision (`applied`, its inputs the moves'), kept in
    `agent_cutover`; the tool's output is checked against its schema after
    those writes and before the commit (`Cutover.apply`'s `check`), so a defect
    refuses the apply with nothing decided or moved. Applying again changes
    nothing (`already-applied`);
  - once applied, hand-named Workers already loaded are `unavailable` and start
    nothing, and a row with hand-named Workers is refused at the next load
    (`config_error`, naming `system account migrate --rollback`);
  - `rollback` (refused while a run of a moved-to Worker is queued or running)
    moves each moved session and run back unless it moved again since, lifts
    the refusal, and records `rolled-back` (its input the cutover's decision),
    its output checked before the commit as an apply's is.
    Records already written (results, usage, decisions) keep the ids they were
    written with; the `workerSessions` records of team members are not moved.
- **Description** (`capability-descriptor@1.7`): a hand-named Worker's `description`, or its
  role's for a derived Worker, is carried on its descriptor for the roster; plain text on one
  line, at most 200 characters (refused at load otherwise); never a routing input.
- **An account's label** (`assignments[].label`, T103): the operator's display name of an
  account, such as `science`; plain text on one line, at most 64 characters (refused at load
  otherwise). `AgentAccounts.labelOf` gives it to `account_agents` and the roster
  ([display names](../../../docs/design/roster.md#display-names)); it is never a routing input,
  never part of a Worker id, and never on the account's record.
- **Accounts** (`providers`, ADR-0052): a hand-named Worker runs on its
  runtime's one home, so every hand-named Worker of a runtime names the account
  `{ id: <runtime>, group: <runtime> }` (`capability-descriptor@1.5`); a derived
  Worker names `{ id: <accountId>, group: <runtime> }`. Each with its runtime's mode:
  `assigned` by default, or `pooled` only with `pooledTerms` (the operator's
  decision: who, when, which terms on what basis, ADR-0055; refused at load otherwise, and
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
    `<DSH_HOME>/system/agent-homes`). A slot is kept as an `agent-account@1.x`
    record (store table `agent_accounts`, migration 10), validated on every write;
    a quarantined one is `@1.1`, with what its reading found (`quarantine.detail`),
    which health, the roster, `system account list`, and a refused run name.
  - A runtime with no identity reader (the Antigravity CLI) takes no free slot
    (`config_error`, nothing made or recorded): its account could only be
    `unverified`, and adopting its home would hold the hand-named Workers there.
    A slot taken before can still be signed in again and verified.
  - The account id is `<runtime>:<16 hex>` of the runtime's `identity(home, key)`
    HMAC, keyed by 32 bytes made once in the credential vault
    (`system-agent-workers/identity-key`); no vault, and nothing is read.
  - `ready`, `signed-out`, or quarantined `changed`, `ambiguous`, `duplicate`
    (both slots), or `unverified` (no reader: the Antigravity CLI, or a version
    not pinned), by the rule `agent-accounts.enrollment` (`assess`). Every
    change is an `enrollment` decision (`decision@1.8`) recorded first, its
    input the slot's earlier decision, never the principal.
  - The operator's tools, operator scope, checked against
    `mcp-agent-accounts@1.2`: `account_enroll` (step `begin` takes a slot and
    returns the runtime's sign-in command for its home; step `verify` records
    who signed in; `accept` takes a `changed` slot's new principal as a new
    account), `account_remove` (frees a slot, keeping its home),
    `account_agents` (every slot with the Workers that run on its account and
    its label, and each runtime's slots and title), and `account_migrate`
    (above). A call that changes anything checks the output it would give
    before its change commits (each change in one store transaction, the check
    last), so a defect refuses it with nothing changed. Only the operator's
    `verify` lifts a quarantine or a sign-out.
  - Each probe re-reads the runtime's `ready` accounts, and each run the
    account of its home: a different principal is quarantined `changed`, none
    signed out, recorded first; a re-read never lifts anything.
  - A slot newly quarantined, or quarantined for another reason, appends
    `agent-workers.account.quarantined` (provider, slot, account id, reason,
    its Workers; the `enrollment` decision), never the principal or its hint,
    for [notifications](../../../docs/design/notifications.md); a failed append
    is logged only.
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
- **Capabilities are what `probe()` proves now** ([`src/probes.ts`](src/probes.ts)), in
  the home the Worker's runs run in: its runtime's own, or a derived Worker's account home, each
  probed on its own. A probe result stands for `probeTtlMs` (default 5 min) from when its probe
  started, never longer. Once it is half that old, the next probe starts in the background, one at
  a time per runtime and home, so a describe never waits for a re-probe (the router gives the whole
  source 5 s):
  - a describe waits only for the first probe of a runtime in a home; a result past `probeTtlMs`
    admits nothing (the Worker is `unavailable`) until the probe in the background finishes;
  - each probe, a background one included, re-reads the runtime's `ready` accounts (an account
    home's alone) before its result stands;
  - an account home is probed in the background only while a Worker whose account is `ready`
    runs in it; one that is not is forgotten, and a later read probes it first;
  - the latest result wins, failed or not: a probe that throws, or proves less, makes the Worker
    `unavailable` at once, never outlived by an older success;
  - a probe slower than half of `probeTtlMs` is logged once, and the next starts at once;
  - a run's own check before the agent starts waits for a result within `probeTtlMs`;
  - a probe not settled within `probeTtlMs` of its start (5 min with `probeTtlMs: 0`), its
    accounts' re-read included, is refused as `probe timed out`, its late answer dropped, and the
    next one starts; a stop waits for a probe in flight no longer than that;
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
    from the repository's HEAD (`git worktree add -b`), or the engine had it cut
    from the work of the task's previous attempt (carrying, below), and every later one of
    that workflow run on that repository, reviewers included, works in it. So
    a review reads the developer's tree and binds to its exact subject, and a
    remediation fix writes there. A run continued after its worktree was
    removed gets it again from its branch. Creation is one at a time per
    repository; the mapping is stored, so a restart reuses it. The run's
    `RunSpec`, its captured subject, and the result's `workspace` are the
    worktree. A worktree path that holds anything else is never taken over;
  - the repository's checked-out branch and main working tree are never written
    but by a landing's merge (below), and git always runs with `-C <path>`, fixed arguments, no shell, no hooks,
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
  - **a worktree's setup** (`worktreeSetup`, [`src/setup.ts`](src/setup.ts),
    ADR-0058 accepted, [design](../../../docs/design/agent-runtimes.md#a-worktrees-setup),
    [runbook](../../../docs/operations/runbooks.md#set-up-a-runs-worktree)): per
    repository (a `worktreePerRun` Worker's workspace, else refused at load), 1 to
    16 command lines (words split on single spaces, no shell metacharacter, at most
    200 characters, the policy's bound), optional `views`, and `timeoutSeconds`
    (default 600, at most 3600). Before an agent run works in a workflow run's
    worktree, after it is acquired and before the brief's files are written, the
    worktree is set up unless its setup already ran under the definition loaded now
    (its hash, stored on the worktree, migration 13; cleared when the worktree is
    added again). One setup at a time per worktree:
    - each command is judged by `ctx.approvals.check` as a `command` with its exact
      argv: `forbid` refuses; `auto` and `notify` run it, checks pending; `ask`
      opens one request per command (subject `content`
      `agent-worktree-setup:<repository key>/<run id>:<n>` at the setup's hash,
      requester `worker` with the agent run; kept in `agent_tool_requests`, scope
      the worktree), which the next run takes once approved (all together), waits
      on while open, and refuses on when rejected, expired, or withdrawn, queuing
      nothing new. No queue loaded: nothing runs;
    - the commands run in order, each under the read confinement with the host
      read-only but the worktree, no network (`confinedCommand` options), the
      worktree as its directory, the daemon's scrubbed environment, and the
      setup's deadline (SIGKILL), after `proveConfinement`. A view shows a host
      directory as a fresh private one under `<worktreeRoot>/.setup`, its `copy`
      files copied in (never through a link, at most 1 GiB each; one the host lacks
      is skipped) and its `readOnly` paths bound back read-only, removed after; a
      view of, or holding, a hidden path, reached through a link, or overlapping the
      worktree is refused;
    - a setup refused, waiting, or failing (exit code, signal, deadline, with the
      last 1,500 characters of its output) fails the run as `config_error`, unsent;
      the next run tries again. Each setup is a `gate` decision (rule
      `agent-workers.worktree-setup`, `start` or `refuse`) among the run's
      decisions, and an `agent-workers.worktree.setup` event (`ran`, `refused`,
      `waits`);
  - **a run's checks** (`worktreeSetup[].checks`, [`src/checks.ts`](src/checks.ts),
    T151, [ADR-0063](../../../docs/decisions/adr/0063-a-runs-required-checks-run-on-its-exact-result.md),
    [design](../../../docs/design/workflow-engine.md#a-runs-required-checks),
    [runbook](../../../docs/operations/runbooks.md#let-a-run-pass-the-required-checks)):
    a repository's setup may name the command of each check a policy can require
    (`tests`, `typecheck`, `lint`; each a command line as above, outside the
    setup's hash, so changing them asks nothing again) and `checkTimeoutSeconds`
    (default 1800, at most 3600). The source's `check` (the workers seam's) runs
    the checks a workflow run asks for on its worktree:
    - only while the worktree is intact, no agent run of its workflow run is
      unfinished or not known to be gone, and it is exactly the result's subject
      (else `refused`: `gone`, `busy`, `failed`, `moved`, nothing run);
    - each check is an `error`, never run, when the repository names no command
      for it, the worktree was not set up under the setup loaded now, no queue is
      loaded, or the policy does not let its exact argv run unasked (`auto` or
      `notify`; an `ask` opens no request: list the line in the studio policy);
    - the allowed ones run in order in the setup's confinement and views
      (`confineIn`, shared with the setup), each within its deadline. Exit 0 is
      `passed`, any other code `failed`, a timeout, signal, or start failure an
      `error`; after each, the tree is captured again, and a check that changed it is
      an `error`, the later ones not run;
    - what ran is one `check-run@1.0` evidence artifact (its inputs the commands'
      `autonomy` decisions; per check the argv, exit code, duration, and the last
      4000 characters of its output with its length and SHA-256), at the run's
      classification, returned with the results. Nothing is retried; the engine's
      acceptance reports each `passed` or `failed`, and an `error` stays pending;
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
- **Landing** (`land` on the `workers` seam, [ADR-0060](../../../docs/decisions/adr/0060-an-accepted-result-lands-on-the-operators-merge-approval.md)
  proposed, [design](../../../docs/design/agent-runtimes.md#landing-a-worktree)): for a worktree it
  holds (by workflow run and path; any other is undefined), one step at a time per repository:
  - `commit`: refused `busy` while an agent run of the workflow run is unfinished or not known to be
    gone, `gone` once the worktree was retired, `failed` when it is not intact or on its branch;
    `.system/` removed as the retention removes it; then, only while `captureGitSubject` gives the
    accepted subject, `git add --all` and one commit by the system with the engine's message and a
    `System-Subject: git:<head>:<version>` trailer (`committed`); a clean worktree whose HEAD is
    that commit on top of the accepted HEAD is `committed` with `committed: false`; anything else
    is `moved`. It answers the base (the repository's checked-out branch and head; a detached HEAD
    or a `system/run/` branch is refused `base-moved`), whether the base holds the head, and the
    `git diff --stat` against it (1,500 characters at most);
  - `merge`: `head-moved` unless the branch is at the approved head; `base-moved` unless the
    repository has the approved branch checked out at the approved head (a base that holds the head
    already is `merged`, `already: true`); `dirty` while its tracked files hold changes; then
    `git merge --no-ff --no-edit` with the engine's message (`merged`, the new head). A conflict is
    aborted (`git merge --abort`), its files named, and the repository checked to be as it was
    (`conflict`); a merge git refuses before starting changes nothing (`failed`). Never a force, a
    reset, a branch deletion, or a push.
- **A run's change** (`changes` on the `workers` seam, T122,
  [design](../../../docs/design/agent-runtimes.md#a-runs-change-for-the-operators-review)): for each
  worktree it holds of a workflow run, read only, what it holds against the commit it forked from
  on the repository's checked-out branch (where its head meets it), committed or not; once its
  branch is in the base (landed), against the commit the worktree was cut at (`forked_at`,
  migration 16; a worktree made before, whose head the base has moved past, throws: its change
  cannot be told from what was merged). Each file's status, lines, and diff, paired with its file by
  its own `diff --git` line; untracked files as added; within `CHANGE_BOUNDS`, as it reads: git's
  output is streamed, only what the bounds show is kept and the rest counted or passed over (a patch
  of any size reads as cut, never as unreadable), and an untracked file is read only while the
  bounds leave room for it, asynchronously, through descriptors opened one directory at a time from
  the worktree's own, each `O_NOFOLLOW` (a link is named, never followed). A retired worktree's from
  its branch. git runs through the worktree's own administrative directory with
  `--no-optional-locks`, after the landing's check that the worktree is intact; one that is not
  throws.
- **Carrying** (`carry` on the `workers` seam, [ADR-0061](../../../docs/decisions/adr/0061-a-tasks-next-attempt-starts-from-the-work-its-previous-attempt-left.md)
 accepted 2026-10-25, D59, [design](../../../docs/design/agent-runtimes.md#carrying-an-earlier-runs-work)): the
  workflow engine asks it before the first step of a board task's next attempt, for the earlier
  attempt's worktree (by workflow run and path; any other is undefined), one change at a time per
  repository:
  - refused `exists` when the new run has a worktree already (cut from HEAD) or its branch exists,
    `gone` once the earlier worktree was retired or removed, `busy` while an agent run of the earlier
    workflow run is unfinished or not known to be gone, `failed` when it is not intact or on its
    branch, `base-moved` unless the repository's HEAD is still the commit the earlier tree is on
    (where a fresh worktree is cut from), `moved` unless `captureGitSubject` still gives the subject
    its writing step left (after `.system/` is removed as the retention removes it), and `empty`
    when that tree holds no change; a refusal before the commit leaves the earlier tree as it was;
  - then `git add --all` and one commit by the system on the earlier branch, with the engine's
    message and `System-Subject` and `System-Carried-To: <runId>` trailers (a clean worktree whose
    HEAD is that commit on top of the base is found committed);
  - then the new worktree is added on `system/run/<runId>` at the base without a checkout
    (`--no-checkout`), recorded (`carried_from`, migration 15), and given the commit's tree, staged
    (`read-tree -u --reset`), so its HEAD is the base and the earlier change is its own; the commit
    is recorded last (`carried_commit`). A worktree cut and not yet given the tree (a crash, or a
    failure there) is never run in (`acquire` refuses it, `config_error`); the carry asked again
    gives it the tree, or, when the tree can no longer be given, puts it back to the base, a fresh
    worktree. The retention and the operator's removal put it back too before they retire it, so
    what it holds (its index empty, every file of its base staged as deleted) is never committed;
    put back is `read-tree -u --reset HEAD`, then nothing left over, and one that is not intact or
    still holds files its base does not (a reading cut short) stays marked, nothing committed, for
    the operator (`failure` says why). `acquire` refuses to add such a worktree again from a branch
    whose tip is an earlier retention's commit of that tree (by the system, `system: keep the
    uncommitted work of workflow run <runId>`). A carry asked again after it was done answers
    `carried: false`. Never a force, a reset of a branch, a deletion, or a push.
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
    its account, not only the metered one (**One account, every role**);
  - **the account's usage report after the run** (ADR-0059): once after each
    run of a derived Worker on a declared pool, and after any run that failed
    `quota_exhausted`, in the home the run ran in, before its usage is recorded
    and its reservation released, when its runtime implements `limits`. Its
    observations are recorded after the run's own, as the run's are (the same
    `windows`, cooldown, and closing of every window for an unmapped
    rejection), so the latest reading has the share, and a reset read at a
    limit wins over the cooldown fallback above. One rule is the report's
    alone: it **never opens a window that a `limited` reading closed** before
    the later of that reading's `resetsAt` and `cooldownUntil` (without end
    when it names neither); such an `ok` reading is not recorded, and is
    logged; a report's rejections are recorded first, so its own `ok` of a
    window it closes is not either. Its unmapped windows are logged once;
  - **release** the reservation once the usage is recorded, or when the run
    fails before it starts.

  Without a `pool`, runs are not metered, whether a ledger is loaded or not.
- **A usage limit with no ledger reading** (PROP-0012 phase C, INV-2): a run
  that fails `quota_exhausted` on a Worker with no `pool`, or whose ledger did
  not take the readings above, cools its **account** down (table
  `agent_cooldowns`): a hand-named Worker's runtime, whose Workers share its one
  home, or a derived Worker's account. Every Worker of it is `quota-exhausted`, and a run queued
  on one fails `quota_exhausted` before the agent starts, until the latest
  reset time a `rejected` observation of the run, or of the account's usage
  report read after it, named, else for the failing
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
  workflow engine continues the session by itself, once per approval, finding
  the request from the `agent-workers.tool.deferred` event (a board task's step
  waits on it in its live run; a plain run fails until then), and withdraws the
  requests a board task's attempt left open when it ends without a verdict
  ([a deferred tool call](../../../docs/design/workflow-engine.md#a-deferred-tool-call)).
- **Cancel (REQ-WRK-4):** a running agent is stopped, and a queued run never
  starts. Both fail as `aborted`. A run that started and that no process holds
  now (between two liveness looks after a restart) cannot be stopped from here:
  it gets a verdict first, a `reconciliation` decision with `cause: cancel`;
  `dead` ends it `aborted` as gone, anything else ends it `aborted` not known to
  be gone, held as below (`agent-workers.run.unknown`), its reservation
  released and its usage recorded as `interrupted`.
- **Deadline:** a run longer than `runTimeoutMs` (15 min) is stopped and fails
  as `timeout`. The run was submitted, so it is not retried automatically.
- **Restart:** a queued run starts. A run that had started is never run again:
  the agent may already have acted. It is reconciled only on a liveness verdict
  ([restart and liveness](../../../docs/design/agent-runtimes.md#restart-and-liveness),
  [ADR-0056](../../../docs/decisions/adr/0056-a-failed-lease-renewal-is-not-a-lost-lease-and-death-needs-a-verdict.md)):
  - each run records, fenced by its lease, its holder (this process: host,
    boot, pid, start time) and the submission as its first activity, then the
    agent process its runtime reports (`onProcess`) and its activity
    (`onActivity`, written at most once per heartbeat, a third of the 60 s
    lease);
  - `dead` (`livenessOf`: its holder's lease lapsed and its process gone, its
    agent process gone, no activity for `deadAfterSeconds`, default 120): it
    fails as `reconciliation_failed` (`USER_ACTION`) and names its native
    session, with a `reconciliation` decision (rule `agent-workers.reconcile`
    version 2) on the run naming every signal;
  - every signal gone but the activity window still open: looked at again once
    it is past, uncounted;
  - anything else (a process never reported or that cannot be read, a holder on
    another host): looked at again after a minute, doubling, at most 15 minutes;
    after `maxUnknownVerdicts` (default 3) in a row it fails as
    `reconciliation_failed` for the operator, the decision saying it is not
    declared dead, and `agent-workers.run.unknown` is appended. Its session and
    its workflow run's worktree stay held until the operator frees them (below):
    the source runs nothing more in either (`config_error`, unsent), and the
    retention sweep keeps the worktree.

  Its reservation is released,
  and its usage is not invented: no result message means no `runtime-result`
  record; its usage comes from transcript reconciliation (`source:
  transcript`), later (not built yet). Until then a metered one is recorded
  as `usage.unknown` of kind `interrupted`, under the pool its reservation drew
  on while its Worker still names it (else logged).
- **Never stranded:** a run whose `agent-run:<id>` lease another process holds
  is looked at again once that lease would expire (it finishes the run, or it
  crashed). A run whose lease was lost is looked at again after the lease
  period; a run already submitted then gets the verdict above, never run again
  (INV-4). A heartbeat whose renewal merely fails does not lose the lease
  (`ctx.leases.hold`), so a transient store error never stops a live agent.
- **Stalled:** while a run is held, at each beat a run whose agent process is
  present and that has been quiet for `stallSeconds` (default 300) is reported
  once per stall: event `agent-workers.run.stalled` (with `ctx.eventLog`) and a
  log line. Nothing is sent to it and nothing stops it; its own deadline and turn
  limit end it.
- **Held sessions** (`held`, on the `workers` seam): a session is held while any
  of its runs ended without being known to be gone, or its latest run has not
  finished or stopped
  on a deferred tool call whose approval request is still open (the run records
  the request, `deferred_request`; for older runs the gate's
  `agent-workers.tool.deferred` event names it; the queue is asked, and a queue
  that is not loaded, cannot be read, or does not hold the request cannot show it
  free). The workflow engine gives a held session no automated input.
- **Liveness told** (`liveness`, on the `workers` seam; PROP-0013): the runs
  that are stalled (running, a stall reported), being looked at (verdicts being
  taken), or unknown (ended not known to be gone, not freed), read from the
  runs' records: the verdict and looks, the reasons (the reconciliation
  decision's signals, or as this host shows them now), the session and
  worktrees each holds, and what the operator can do; at most 64, the latest
  first, with the counts of all. The surfaces (`status`, `explain`, the roster,
  the report) read it through the seam ([what the operator sees](../../../docs/design/agent-runtimes.md#what-the-operator-sees)).
- **Freeing a held run** (`free`, MCP `agent_run_free`, operator scope,
  `mcp-agent-runs@1.0`, `src/tools.ts`; `system free <run> --agent-gone`): on the
  operator's word that its agent is gone (`agentGone: true`), recorded first as
  their `reconciliation` decision (decider `operator.free`), stored on the run
  (`liveness_freed`, migration 14) and appended as `agent-workers.run.freed`;
  `held`, a later run's check, and the retention sweep then no longer count it.
  Refused, changing nothing: a run that holds nothing; one still being looked
  at, or another started run of its session or worktree not finished; its lease
  held; its holder or agent process present on this host. Its workflow run's
  worktree is removed only while nothing else of that run is unfinished or
  held, and only when clean, or with `commitWorktree` once its changes are
  committed on its branch; the branch stays, and one that stays is the
  retention's. A freed run may be freed again for its worktree only (refused
  when none is left)
  ([freeing what a run holds](../../../docs/design/agent-runtimes.md#freeing-what-a-run-holds),
  [runbook](../../../docs/operations/runbooks.md#a-runs-liveness-is-unknown)).
- **The run worktrees, for the operator** (`runWorktrees`, `removeWorktrees`; MCP
  `agent_worktrees` and `agent_worktrees_remove`, operator scope, `mcp-agent-runs@1.1`; `system
  worktrees [remove]`): every worktree not removed, at most 100, oldest first, with its state
  (`in-use`, `held`, `finished`), what it holds (`clean`, `uncommitted`, `gone`, `not-intact`), and
  when the retention removes it; and the removal of the finished ones now, every one or one
  workflow run's (`runId`), at most 50 a call: a worktree is removed only while no agent run of its
  workflow run is unfinished or not known to be gone, and only when clean, or with `commitChanges`
  once its changes are committed on its branch, exactly as the retention retires it. Recorded
  first as the operator's `retention` decision (decider `operator.worktrees`) naming each planned,
  stored on each removed; none removable, nothing decided. The tool checks its output on the plan
  before anything is decided (T103's pattern)
  ([the operator's removal](../../../docs/design/agent-runtimes.md#the-operators-removal-of-run-worktrees),
  [runbook](../../../docs/operations/runbooks.md#remove-finished-run-worktrees)).
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
  reads `resources`, `approvals`, `eventLog`, and `credentials` (the account ids'
  key) when present, and registers the `account_*` tools when `mcp` is.
