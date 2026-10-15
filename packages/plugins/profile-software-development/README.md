# @tsuuanmi/system-profile-software-development

The **software-development profile**: the `agent-review` template, contributed
to the workflow engine with `ctx.workflow.template` (REQ-WF-9). It holds no
engine code and no rules of its own.

- **`agent-review`** is one node, `review:1`, requiring `review` and
  `local-data`, at the caller's tier and in the caller's session. Only a
  read-only local agent Worker proves both, so it never routes to a website
  account ([nodes](../../../docs/reference/workflow-templates.md#agent-review)).
  Exact-subject review and remediation cycles are engine behaviour for any
  template ([workflow engine](../workflow/README.md)).
- **Off by default:** the row is off in the default composition, with the agent
  Worker rows it needs (PROP-0004); the `api-first` preset turns them on
  ([turn a row on](../../../docs/operations/runbooks.md#turn-an-off-row-back-on)).
  PROP-0004 removed the `develop` template; its earlier runs keep their records.
- **Injects:** `workflow`.
- **Conformance:** [`profiles`](../workflow/conformance/profiles.ts).
