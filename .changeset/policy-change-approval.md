---
"@tsuuanmi/system-approvals": minor
"@tsuuanmi/system-approvals-core": minor
"@tsuuanmi/system-web-ui": minor
"@tsuuanmi/system-artifacts": patch
---

The operator can change the autonomy policy without a restart, through a `policy-change` approval:
- The **Autonomy policy** page on `/ui` shows the set in force, the effective mode of each action class, and the history of changes; it proposes a new version of a policy (or a project's first), with a diff against the record in force. MCP `approvals_policy_propose` (operator scope) does the same.
- The proposal is checked with the same rules as a configured policy set, then asked in the approval queue on the exact hash of the set it makes; the queue entry shows the modes it moves and the record's diff. Only the operator's approval there applies it, recorded as a `policy-change` decision with the old and new hashes; open requests are judged again at once, and the board puts its waiting tasks to the new policy.
- The applied set is kept, so a restart keeps it while the configuration it came from is unchanged. If the configuration changed since, the approval queue does not start, and its log names both sets: restore the configuration, or set `supersedes` in the `approvals` row to the stored set's hash to let the configuration replace it.
