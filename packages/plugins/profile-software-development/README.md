# @tsuuanmi/system-profile-software-development

The **software-development profile**: the `develop` procedure, contributed to
the workflow engine through the `profiles` seam (`ctx.workflow.template`,
REQ-WF-9). It holds no engine code. The steps it relies on are engine rules
for any profile: graph growth, the plan approval gate, exact-subject review,
and remediation cycles
([workflow engine](../workflow/README.md)).

1. A planner (`plan:1`, `reason`) proposes implementation steps (`develop`,
   `local-data`) and one review (`review`, `local-data`) as a `plan` artifact.
2. Writing steps wait for the operator's approval of the exact plan, then run
   on a writable local agent Worker.
3. The review runs in a fresh session on a read-only Worker, bound to the
   exact subject of the change: `git:<HEAD>:<hash of every change on top>`.
   Blocking findings grow a fix and a re-review, at most three reviews.
4. `report:1` reports the change and what the reviews found.

- **Injects:** `workflow`.
- **Conformance:** [`profiles`](../workflow/conformance/profiles.ts).
