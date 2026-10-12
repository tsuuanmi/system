# Playbooks

> Current state. The decision chain behind any run is `system explain <runId>`;
> the web UI (`system ui`) shows the same per step.

## A stuck run

1. `system usage` lists recent runs, and the state, Worker, tier, and quota
   class of each step.
2. `system explain <runId>` shows each step's decisions: egress, tier, route,
   acceptance, recovery, and gates.
3. Every wait is bounded:
   - a website turn by `turnTimeoutMs` (15 min) and its stall clock;
   - Deep research by `researchTimeoutMs`;
   - an agent run by `runTimeoutMs`;
   - a gateway request by its `timeoutMs`.
   A step that passes its bound fails; it does not hang.
4. A run that waits for approval is BLOCKED. Run
   `system approve <runId> --plan <plan id>` for the plan you read (the id is
   printed with the wait; `--plan` is required when several plans wait), or add
   `--reject`.
5. `system stop <runId>` cancels running work and resends nothing.
   `system continue <runId>` then reopens the failed step as a new attempt.

## An AMBIGUOUS reconciliation

After a restart, a turn whose prompt was submitted is reconciled before
anything is resent. When its conversation cannot be observed (a temporary
chat, or one never bound to a URL), the outcome is AMBIGUOUS, and the step fails
with `reconciliation_failed` (`USER_ACTION`). The system cannot know whether
the provider answered, so it does not guess.

- Look at the account's conversations in the provider's own UI.
- **If you find the answer:** `system supersede <runId> <nodeId> -` with the
  answer on stdin. It becomes the step's result, and every later step runs on
  it.
- **If the prompt never arrived:** `system continue <runId>` sends it again, as
  a new attempt recorded as your decision.

## Quota exhaustion

A turn that hits the provider's usage limit fails with `quota_exhausted`
(`USER_ACTION`). Nothing retries automatically against the limit.

- Wait for the limit to reset, then `system continue <runId>`.
- Or add capacity:
  - map another account's tiers in the account catalog, then continue: routing
    picks any admitted Worker at the step's tier or above;
  - or run the work at another tier with `--tier`.
- `system usage` shows which quota class each step spent.

## A provider UI change

Website UIs change. Operations are data (UI maps), so a change shows up as
drift and does not silently break.

- **Detection:**
  - a `ui.drift` event when an element resolves only through a fallback or a
    heal;
  - a step that fails with `ui_drift` when nothing resolves;
  - the driver's fixture test fails when the shipped map no longer matches the
    recorded structure.
- **Self-heal:**
  - each heal is bounded, and verified before it is used;
  - each is recorded as a `recovery` decision before the click;
  - an irreversible action (Send) is never healed by a model.
- **Overlay:** verified heals are appended to the local overlay,
  `<DSH_HOME>/system/ui/chatgpt-web.overlay.yaml`. The shipped map is never
  written.
- **When healing cannot recover:**
  1. Update the shipped map
     (`packages/plugins/provider-chatgpt-web/ui/`) from the live accessibility
     tree.
  2. Refresh the fake-site fixture to match.
  3. Release the fix.
  4. Continue the failed runs.
