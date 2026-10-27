/** The engine's tables in the durable store (`ctx.store.migrate('workflow', MIGRATIONS)`), append-only. */
export const MIGRATIONS = [{
  version: 1,
  sql: `CREATE TABLE workflow_runs (
    run_id TEXT PRIMARY KEY, request_key TEXT UNIQUE, template TEXT NOT NULL, spec_hash TEXT NOT NULL, input TEXT NOT NULL,
    classification TEXT, session_id TEXT, status TEXT NOT NULL, result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX workflow_runs_status ON workflow_runs (status);
  CREATE TABLE workflow_nodes (
    run_id TEXT NOT NULL, node_id TEXT NOT NULL, ordinal INTEGER NOT NULL, spec TEXT NOT NULL, record TEXT NOT NULL, state TEXT NOT NULL,
    prompt TEXT, turn_id TEXT, attempt INTEGER NOT NULL DEFAULT 0, not_before TEXT, worker TEXT, served_tier TEXT, quota_class TEXT,
    error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (run_id, node_id)
  );`,
}, {
  // Runs outlive turns (retention): a node keeps its turn's decision ids for explain.
  version: 2,
  sql: 'ALTER TABLE workflow_nodes ADD COLUMN decisions TEXT;',
}, {
  // Nodes run on any Worker source, not only website turns.
  version: 3,
  sql: `ALTER TABLE workflow_nodes RENAME COLUMN turn_id TO execution_id;
  ALTER TABLE workflow_nodes ADD COLUMN source TEXT;
  UPDATE workflow_nodes SET source = 'website' WHERE execution_id IS NOT NULL;`,
}, {
  // Tier escalation after a rejected result (REQ-WRK-9).
  version: 4,
  sql: 'ALTER TABLE workflow_nodes ADD COLUMN escalations INTEGER NOT NULL DEFAULT 0;',
}, {
  // Wake-on-message: an idle session's turn on its unread messages, and where its reply goes.
  version: 5,
  sql: 'CREATE TABLE workflow_wakes (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, through_seq INTEGER NOT NULL, reply_to TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0);',
}, {
  // A review bound to an exact subject: the working tree it must review (REQ-WF-5).
  version: 6,
  sql: 'ALTER TABLE workflow_nodes ADD COLUMN subject TEXT;',
}, {
  // Long-running sessions (REQ-SES-6): compaction turns, and handoffs a session continues from.
  version: 7,
  sql: `ALTER TABLE workflow_wakes ADD COLUMN kind TEXT NOT NULL DEFAULT 'wake';
  CREATE TABLE session_handoffs (session_id TEXT PRIMARY KEY, artifact TEXT NOT NULL);`,
}, {
  // Workers a node failed over from, unsent (ADR-0034): its next routes leave them out.
  version: 8,
  sql: 'ALTER TABLE workflow_nodes ADD COLUMN excluded TEXT;',
}, {
  // The activation a wake runs under (REQ-SES-1): its settle presents it, and a superseded one is fenced.
  version: 9,
  sql: 'ALTER TABLE workflow_wakes ADD COLUMN generation INTEGER;',
}, {
  // A run that serves one attempt of a board task (docs/design/board.md): at most one live run per task.
  version: 10,
  sql: `CREATE TABLE workflow_tasks (
    run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, holder TEXT NOT NULL, generation INTEGER NOT NULL, claim TEXT NOT NULL, phase TEXT NOT NULL,
    writes TEXT, lost TEXT, result TEXT, acceptance TEXT, outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX workflow_tasks_live ON workflow_tasks (task_id) WHERE phase != 'reported';
  CREATE INDEX workflow_tasks_phase ON workflow_tasks (phase);`,
}, {
  // Briefs (docs/design/workflow-engine.md#briefs): a node's instructions, composed at promotion
  // (its record names each execution's brief), and what a board task's run adds to every brief.
  version: 11,
  sql: `ALTER TABLE workflow_nodes ADD COLUMN brief_parts TEXT;
  ALTER TABLE workflow_tasks ADD COLUMN frame TEXT;`,
}, {
  // A remediation fix's gate on the approval queue (docs/design/workflow-engine.md#remediation-on-the-approval-queue):
  // the request it waits on.
  version: 12,
  sql: 'ALTER TABLE workflow_nodes ADD COLUMN approval_request TEXT;',
}, {
  // A deferred tool call (docs/design/workflow-engine.md#a-deferred-tool-call): the request each one
  // waits on, and how it was settled; an approved one continues its session at most once.
  version: 13,
  sql: `CREATE TABLE workflow_deferrals (
    request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, node_id TEXT NOT NULL, execution_id TEXT NOT NULL, session_id TEXT NOT NULL,
    created_at TEXT NOT NULL, settled_at TEXT, outcome TEXT, decision TEXT
  );
  CREATE INDEX workflow_deferrals_open ON workflow_deferrals (created_at) WHERE settled_at IS NULL;
  CREATE INDEX workflow_deferrals_run ON workflow_deferrals (run_id);`,
}, {
  // A digest of a board task's result (docs/design/workflow-engine.md#a-digest-of-a-tasks-result):
  // where it stands, as JSON `TaskDigest`; its `requestedAt` is what the hourly bound counts.
  version: 14,
  sql: 'ALTER TABLE workflow_tasks ADD COLUMN digest TEXT;',
}, {
  // A task's budget (docs/design/workflow-engine.md#a-tasks-budget): its lines, and the run's
  // reservation of them on the resource ledger, as JSON `TaskBudget`.
  version: 15,
  sql: 'ALTER TABLE workflow_tasks ADD COLUMN budget TEXT;',
}, {
  // A question from a task's run (docs/design/workflow-engine.md#a-question-from-a-run): the
  // questions a step asked, and whether the board took the wait, as JSON `TaskQuestion`.
  version: 16,
  sql: 'ALTER TABLE workflow_tasks ADD COLUMN question TEXT;',
}, {
  // Assigned accounts (ADR-0052): the account the node's Worker ran on, the account an unsent
  // failure keeps it on within its group, and when it first waited for an account's limit.
  version: 17,
  sql: `ALTER TABLE workflow_nodes ADD COLUMN account TEXT;
  ALTER TABLE workflow_nodes ADD COLUMN assignment TEXT;
  ALTER TABLE workflow_nodes ADD COLUMN limit_wait_since TEXT;`,
}, {
  // Landing an accepted result (docs/design/workflow-engine.md#landing-an-accepted-result, ADR-0060):
  // where it stands, as JSON `TaskLanding`. A run reported before landing existed lands nothing.
  version: 18,
  sql: `ALTER TABLE workflow_tasks ADD COLUMN landing TEXT;
  UPDATE workflow_tasks SET landing = json_object('state', 'none', 'reason', 'reported before landing existed (ADR-0060): merge its branch by hand', 'at', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE phase = 'reported';`,
}, {
  // Starting from the previous attempt's work (docs/design/workflow-engine.md#starting-from-the-previous-attempts-work,
  // ADR-0061): whether the run's worktree holds it, as JSON `TaskCarry`. A run admitted before it carries nothing.
  version: 19,
  sql: 'ALTER TABLE workflow_tasks ADD COLUMN carry TEXT;',
}, {
  // Dispatch (docs/design/workflow-engine.md#dispatch-starting-ready-work-by-itself, ADR-0064): each
  // start the pass chose, asked, approved, and started, at most one live per task attempt; the pause
  // and the last pass; and on a run it started, what chose it.
  version: 20,
  sql: `CREATE TABLE workflow_dispatch (
    ask_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt INTEGER NOT NULL, project_id TEXT NOT NULL, state TEXT NOT NULL,
    worker TEXT NOT NULL, account TEXT, repository TEXT, node_id TEXT NOT NULL, version TEXT NOT NULL, request_id TEXT, run_id TEXT,
    choice TEXT NOT NULL, outcome TEXT, approved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX workflow_dispatch_live ON workflow_dispatch (task_id, attempt) WHERE state IN ('asking', 'asked', 'approved', 'starting');
  CREATE INDEX workflow_dispatch_state ON workflow_dispatch (state, created_at);
  CREATE INDEX workflow_dispatch_task ON workflow_dispatch (task_id, attempt);
  CREATE TABLE workflow_dispatch_control (id TEXT PRIMARY KEY, paused TEXT, last_pass TEXT, updated_at TEXT NOT NULL);
  ALTER TABLE workflow_tasks ADD COLUMN dispatch TEXT;`,
}, {
  // Dispatch starting by itself (PROP-0014 D2): who started a task's run (`dispatch`, `lead`, or
  // `operator`), filled for the runs admitted before it from what they recorded; and on each dispatch
  // row, how it was let start (`ask`, `board`, `auto`, `notify`) and when its run started, which the
  // hourly bound counts. Rows started before it count from their outcome's time.
  version: 21,
  sql: `ALTER TABLE workflow_tasks ADD COLUMN started_by TEXT;
  UPDATE workflow_tasks SET started_by = CASE WHEN dispatch IS NOT NULL THEN 'dispatch'
    WHEN run_id IN (SELECT run_id FROM workflow_runs WHERE request_key LIKE 'web-ui:%') THEN 'operator' ELSE 'lead' END;
  ALTER TABLE workflow_dispatch ADD COLUMN mode TEXT;
  ALTER TABLE workflow_dispatch ADD COLUMN started_at TEXT;
  UPDATE workflow_dispatch SET mode = CASE WHEN json_extract(choice, '$.board') IS NOT NULL THEN 'board' ELSE 'ask' END;
  UPDATE workflow_dispatch SET started_at = json_extract(outcome, '$.at') WHERE state = 'started';
  CREATE INDEX workflow_dispatch_started ON workflow_dispatch (started_at) WHERE started_at IS NOT NULL;`,
}, {
  // An attempt not spent on the infrastructure (ADR-0069): a failed step's mark, as JSON
  // `{ kind, reason }`, when it failed only because the host stopped it or a Worker became
  // unavailable. A step failed before it existed is unmarked, and its attempt counts.
  version: 22,
  sql: 'ALTER TABLE workflow_nodes ADD COLUMN infrastructure TEXT;',
}, {
  // A board task's dossier (docs/design/task-dossier.md, ADR-0070): its entries in order, each a
  // content-hashed `task-dossier-entry@1.0` artifact naming the one before it, carried across the
  // task's attempts. Append-only: a row is never updated (the trigger refuses it), and `seq` has no gap.
  // `step` is the node's `<attempt>:<escalations>` an entry a Worker appended was written in.
  version: 23,
  sql: `CREATE TABLE workflow_dossiers (
    task_id TEXT NOT NULL, seq INTEGER NOT NULL, project_id TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL, entry TEXT NOT NULL,
    author_type TEXT NOT NULL, run_id TEXT, node_id TEXT, step TEXT, created_at TEXT NOT NULL, PRIMARY KEY (task_id, seq)
  );
  CREATE INDEX workflow_dossiers_step ON workflow_dossiers (run_id, node_id, step);
  CREATE TRIGGER workflow_dossiers_append_only BEFORE UPDATE ON workflow_dossiers
  BEGIN SELECT RAISE(ABORT, 'a task dossier entry never changes: append another'); END;`,
}, {
  // The project a run belongs to when it serves no board task (T285, ADR-0076): a lead's ask or
  // research is tagged with the lead's project, so a lead reaches only its own project's runs. A
  // run of a board task has its task's project; a run with neither belongs to no project.
  version: 24,
  sql: 'ALTER TABLE workflow_runs ADD COLUMN project_id TEXT;',
}, {
  // Scheduled reviews (docs/design/handbook.md#scheduled-review, D93 item 8): one row per review of an
  // area of a repository at its tip, with the counts the report sums per area over time and the board
  // tasks it proposed (JSON `[{ taskId, key, title }]`), which later runs read to file nothing twice.
  // At most one scheduled (not manual) review a day. `run_id` is written as soon as its run is admitted,
  // with the subject and the files shown (JSON `{ path: lines }`), so a review a restart cut is settled
  // from its durable run on the next start.
  version: 25,
  sql: `CREATE TABLE workflow_scheduled_reviews (
    review_id TEXT PRIMARY KEY, day TEXT NOT NULL, trigger TEXT NOT NULL, area TEXT NOT NULL, guide_file TEXT NOT NULL, guide_version INTEGER NOT NULL,
    repo_ref TEXT NOT NULL, commit_sha TEXT NOT NULL, subject TEXT, shown TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL, run_id TEXT, problem TEXT,
    files_read INTEGER NOT NULL DEFAULT 0, files_left INTEGER NOT NULL DEFAULT 0,
    important INTEGER NOT NULL DEFAULT 0, confirmed INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, unverified INTEGER NOT NULL DEFAULT 0,
    nits INTEGER NOT NULL DEFAULT 0, filed INTEGER NOT NULL DEFAULT 0, duplicates INTEGER NOT NULL DEFAULT 0, capped INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
    tasks TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE UNIQUE INDEX workflow_scheduled_reviews_day ON workflow_scheduled_reviews (day) WHERE trigger = 'schedule';
  CREATE INDEX workflow_scheduled_reviews_area ON workflow_scheduled_reviews (area, started_at);
  CREATE INDEX workflow_scheduled_reviews_running ON workflow_scheduled_reviews (state) WHERE state = 'running';`,
}, {
  // The board tasks whose handbook slice the engine built (docs/design/handbook.md#the-6000-token-bound):
  // one row per task, the first time; their count moves the bound from warn to refuse.
  version: 26,
  sql: 'CREATE TABLE workflow_handbook_tasks (task_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);',
}, {
  // The daily run of every browser spec on a ref's tip (T305b, D104): one row per run, the commit it
  // checked, its state, the failing lines (JSON array), and the board task a failure proposed. At most
  // one scheduled (not manual) run a day; `check_id` names the check's worktree and stored outcome, so a
  // run a restart cut resumes its own check.
  version: 27,
  sql: `CREATE TABLE workflow_daily_checks (
    check_id TEXT PRIMARY KEY, day TEXT NOT NULL, trigger TEXT NOT NULL, repo_ref TEXT NOT NULL, commit_sha TEXT NOT NULL, state TEXT NOT NULL, problem TEXT,
    failures TEXT NOT NULL DEFAULT '[]', evidence TEXT, last_green TEXT, task_id TEXT, duplicate INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT
  );
  CREATE UNIQUE INDEX workflow_daily_checks_day ON workflow_daily_checks (day) WHERE trigger = 'schedule';
  CREATE INDEX workflow_daily_checks_state ON workflow_daily_checks (state, started_at);`,
}]
