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
}]
