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
6. A run that serves a board task, or stopped at a tool call the policy asks about, waits on the
   approval queue or the board, not on a plan: see [a waiting board
   task](runbooks.md#a-board-task-is-blocked-or-waiting-for-input) and [a deferred tool
   call](runbooks.md#a-workers-tool-call-is-deferred-on-an-approval).

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

When a UI-map error rule recognizes the site's limit text (the operator can add one in the
overlay, with no release: an element for the text and a `quota_exhausted` rule, `on: answer`
when the site answers with it), the account is **cooled**
([ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md)):

- `system account list` shows its `cooldowns`: the feature (`*` for the whole account), until
  when, and the limit's message. Event `account.cooldown` records each one.
- Work that needs a cooled feature routes to another provider's Worker; under a `pooled`
  provider also to another account of the provider. Under an `assigned` provider (the default)
  it never moves to another account of the provider: it
  [waits for the reset](#work-waits-for-an-accounts-limit). Otherwise, with nothing admitted, it
  fails `quota_exhausted` and names the limit. Other work still runs on the account.
- It ends on its own (6 h for a feature, 1 h for the account; `featureLimitCooldownMs`,
  `accountLimitCooldownMs`), when a turn that used the feature succeeds, or with
  `system account clear-cooldown <id> [feature]` once you know the limit reset. A feature probe
  never ends it: a tool still shown is not quota left.
- The account stays `ready`: nothing needs a login.

- Wait for the limit to reset, then `system continue <runId>`.
- Or add capacity:
  - map another account's tiers in the account catalog, then continue: routing
    picks any admitted Worker at the step's tier or above;
  - or run the work at another tier with `--tier`.
- `system usage` shows which quota class each step spent.

## Work waits for an account's limit

Accounts are `assigned` unless you recorded that a provider's terms allow pooling
([ADR-0052](../decisions/adr/0052-accounts-are-assigned-unless-pooling-is-recorded.md)): your
subscriptions are personal, so a limit on one account never moves its work to another account of
the same provider.

- **What you see.** The run's view (MCP `result`, `/ui`) shows the node `READY` with
  `waitingUntil`; `system explain <runId>` shows its `recovery` decision with outcome `wait`, the reset
  (`until`), and when it first waited (`since`); its input, the `admission` decision, names the
  limited Worker and, for each other account of the provider, the `assignment` refusal ("w:a is
  at its limit until …; assigned accounts do not take another account's work at its limit"). The
  event log has `workflow.node.waiting`.
- **Why it does not move.** The provider is assigned (the default). Work of another provider
  still runs; a Worker of another provider could have taken this step, and none was admitted.
- **What happens next.** At the reset the node routes again and runs, on that account or, once the
  limit is gone, on any admitted Worker. Nothing was sent and no attempt was spent. It waits at
  most `maxLimitWaitHours` (default 24) in all from its first wait; a reset beyond that, or none
  known, fails it `quota_exhausted` (a weekly limit, say), and you decide.
- **What you can do.** Nothing, and it runs at the reset. Or end the limit early once you know it
  reset (`system account clear-cooldown <id>` for a website account), or `system stop <runId>`.
  To let a provider's accounts take each other's work, record its terms: see
  [pool a provider's accounts](runbooks.md#pool-a-providers-accounts).

## A provider UI change

Website UIs change. Operations are data (UI maps), so a change shows up as
drift and does not silently break.

- **Detection:**
  - a `ui.drift` event when an element resolves only through a fallback or a
    heal (`kind: fallback`), when an action's target resolves through nothing
    (`unresolved`), or when an action does not reach its postcondition
    (`postcondition`; its `element` is the action);
  - a step that fails with `ui_drift` when nothing resolves;
  - the driver's fixture test fails when the shipped map no longer matches the
    recorded structure.
  - `system health` reports `ui-drift` while any of these happened within
    `driftWindowHours`. It counts each stale element of a map once, however
    many turns resolve it on a fallback, and names it (`chatgpt-web
    composer.form`). `system events --type ui.drift` lists every occurrence.
- **A composer that rewrote a prompt** (`readback differs from the inserted text`) is a
  `ui.drift` of kind `readback`. Its `readback` field gives the lengths, lines, and the first
  difference (line, offset, character class), and its outline shows the composer. A punctuation
  mark named there, such as a backtick, points at a composer that formats what is pasted.
- **A stalled turn** (`provider_stalled`) is outlined the same way: event
  `provider.stall` (`system events --type provider.stall`) carries the page's
  outline as evidence, with its `visibilityState`, focus, and path, so a stall
  can be read without the operator's browser. Phase `research-start` (ChatGPT)
  is a Deep research reply returned as a clarifying question because no run
  showed in time: when the reply was an acknowledgement, the outline shows where
  the run's progress stood.
- **A conversation loaded once more** (Gemini): event `provider.reload` (phase
  `research-plan`) marks a Deep research plan the page never rendered; the
  `provider.stall` just before it outlines the page as it hung. Nothing is sent
  again. Repeated reloads point at the site, not the map.
- **A Copy not kept**: event `provider.copy-refused` says an answer was read as
  rendered text (tables come out cell by cell, citation chips as loose lines)
  because its Copy was empty, failed, or its words were not the page's. For
  `words` it gives counts only: the Markdown's prose words, the rendered words,
  how many prose words were found in order (`matched`), its links and their
  words, and the extra rendered words allowed. `matched` below `prose` means
  the Markdown has words the page lacks; `shown − prose` above `allowance` means
  the page shows words the Markdown lacks (chips, say).
- **A Deep research report as read** (ChatGPT): event `provider.report-read` gives
  its path (`frame` or `inline`), its length, and the source links it carries,
  counts only. A report refused for citing no source with `links: 0` was read
  without its citations: compare with a read-only `system conversation inspect`,
  whose outline records each link's target as a kind (`external`, `site`, `none`).
- **Read the evidence.** A `ui.drift` event's `outline` names a local-private
  `evidence` artifact: the structure of the region around the element, never
  its text ([drift evidence](../design/ui-operations.md#drift-evidence)).
  `system evidence <outline id>` shows it (operator only). It holds no text, and
  email addresses and the account's name are masked, but it is local-private:
  pasting it into a model session is the operator's own egress choice. To map
  the element again:
  1. Find the node that plays the element's part by its role, label, test id,
     or state (for a toggle, the `pressed`, `checked`, or `expanded` state that
     flips; for a notice that is gone, a state on the control itself).
  2. Write a candidate from what is stable on it, in this order: a role with an
     accessible name, a test id, a `data-*` attribute, then a CSS path through
     the parents the outline shows (`form:has([role=textbox])` only when the
     textbox sits under the form).
  3. Make the fake site render that structure, so a test fails on the old map
     and passes on the new one.
- **A fallback that wins every turn** means the primary candidate is stale,
  even though nothing fails. Promote the fallback to primary in the shipped map,
  keep the old one as a fallback, and change the fake site to match the
  structure the drift events show.
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

## A website conversation that could not be deleted

When a run is deleted or expires, the website conversations of its sessions are deleted on
their sites ([conversation ledger](../design/provider-turns.md#conversation-ledger)).

- **Detection:** `system health` reports `conversations` as degraded once a deletion failed
  three times. `system conversations --state failed` lists each, with the last error in
  `reason`; `system events --type conversation.delete-failed` shows when.
- **A UI change** (`ui_drift`) is the usual cause: the delete flow's map entries are stale.
  `system conversation inspect <account> <binding>` outlines the conversation's page and its
  own menu without choosing anything; `system evidence <id>` shows each outline. Update the
  `conversation.*` entries of the site's UI map and its fake site as for any
  [UI change](#a-provider-ui-change).
- **Waiting on `unverified-map`** is not a failure either: the delete flow's map entries are
  not yet checked on the live site, so nothing is deleted. Check them on a throwaway chat
  `system` creates itself: `system ask --persist "ping"`, then `system conversation inspect`
  and `system evidence`; check in the outline that `conversation.pane` holds the conversation's
  own menu button and none of the history list (whose rows carry other chats' buttons); fix the
  entries from the outlines, remove their `unverified: true`,
  re-gate and release; only then delete that ping run (`system delete <runId> --yes`) and
  confirm with `system conversations`.
- **A signed-out account** is not a failure: its conversations stay due and are deleted on the
  next hourly pass after it signs in again.
- Nothing is ever deleted that `system` did not record; a chat deleted by hand on the site is
  found gone and recorded as deleted.
