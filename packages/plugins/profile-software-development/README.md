# @tsuuanmi/system-profile-software-development

The **software-development profile**: the `develop` template, contributed to
the workflow engine with `ctx.workflow.template` (REQ-WF-9). It holds no engine
code and no rules of its own. Everything after the plan is engine behaviour for
any template: graph growth, the plan approval gate, exact-subject review, and
remediation cycles ([workflow engine](../workflow/README.md)).

1. A planner (`plan:1`, `reason`) proposes implementation steps (`develop`,
   `local-data`) and one review (`review`, `local-data`) as a `plan` artifact.
2. Writing steps wait for the operator's approval of the exact plan, then run
   on a writable local agent Worker.
3. The review runs in a fresh session on a read-only Worker, bound to the
   exact subject of the change: `git:<HEAD>:<hash of every change on top>`.
   Blocking findings make the engine append a fix and a re-review, up to the
   engine config `maxReviewCycles` reviews (default 3).
4. `report:1` reports the change and what the reviews found.

- **Injects:** `workflow`.
- **Conformance:** [`profiles`](../workflow/conformance/profiles.ts).
