# Provider turns

> Target state. Boundary: [provider runtime](../architecture/components.md#provider-runtime).
> Requirements: REQ-PRV-1..6, REQ-ACC-4..5.

## Driver interface

Each website is a `ProviderDriver`. The runtime never branches on provider names
([ADR-0005](../decisions/adr/0005-provider-runtime-interface.md)).

```ts
interface ProviderDriver {
  readonly provider: string;                       // "chatgpt-web", "gemini-web", ...
  checkAuth(page): Promise<AuthState>;
  open(page, binding?: ConversationBinding): Promise<void>;
  selectMode(page, mode: ModeRequest): Promise<VerifiedMode>;   // model, effort, deep research
  snapshot(page): Promise<ProviderSnapshot>;      // turn ids, generating?, last response text
  submit(page, prompt: PreparedPrompt): Promise<SubmitAck>;
  canonicalBinding(page): Promise<ConversationBinding | undefined>;
  extract(page, turn: TurnRef): Promise<Markdown>;
}
```

Shared mechanics, which are the same for every driver, live in the runtime:
receipts, completion, scheduling, auth-state write-back, and error
classification.

## Conversation modes

The runtime picks the mode from the request and never from the website's
default. Live observations are in the
[research](../research/browser-interaction-and-self-healing.md#live-check-2026-10-11-signed-in-account-read-only).

| Request | Mode | Binding | Why |
|---|---|---|---|
| a one-shot `ask` or `research` call with no session | **temporary** (ChatGPT: Temporary chat, `?temporary-chat=true`) | none kept after the turn | stays out of the operator's history; no conversation to resume |
| a turn in a Worker session (`SessionId`), or any long-running or multi-turn work | **persistent** (a normal chat) | the canonical conversation id (`/c/<id>`), stored in the receipt and the session | later turns, recovery after a crash, and Deep Research return to the same conversation |

- A temporary turn cannot be reopened after its page is gone. Its reconciliation
  can only conclude WAIT (same page still open), RESUBMIT (no submission
  evidence), or AMBIGUOUS, never RECOVER.
- A persistent conversation is opened by its bound URL. A binding never moves to
  another conversation.
- **Workspace mode is part of `selectMode`.** Before a new conversation is
  started, the composer's mode group must show **Chat** selected
  (`aria-pressed=true`). ChatGPT's **Work** mode spends a different quota (Codex),
  so it is never used for chat turns. If the mode group is shown and Chat is not
  selected after one attempt, the turn fails before sending. Temporary chat does
  not show the group; Chat is selected on the home page before switching to it.

## Modes and tiers

- **Where the knowledge lives.** The UI map holds *how* to select a mode: the
  model menu, model radios, Power slider and its status, the tools popover, and
  the Deep research chip. Configuration holds *what* to select:
  - the driver plugin's `modes` (named presets of a model and an effort level)
    and its `defaultMode`;
  - each account's catalog `tiers` (tier → preset name);
  - the turn runtime's `defaultTier`.
- **Resolution.** A turn's tier (requested, or `defaultTier`) maps through the
  account's `tiers` to a preset. A tier with no preset uses the driver's
  `defaultMode`. The choice is recorded as a `tier` decision that names the
  preset.
- **Verification.** The driver selects the model radio and steps the Power
  slider, then **reads both back**. An unknown preset, an unknown or locked
  model, or an unreachable level fails with `config_error` before anything is
  sent (INV-2). The receipt records the verified model and effort.
- **Deep research** (`feature: deep-research`) runs only in persistent
  conversations: Temporary chat does not offer it. `research` returns at once,
  with longer deadlines (default 60 min, stall 30 min).

## Turn receipt

A receipt is persisted **before** submission. It binds:

- the account, the conversation binding, and the logical request id;
- `promptHash` and `previousResponseHash`, which mark the boundary of the response
  that existed before this turn;
- status `SUBMITTED → COMPLETED`, with `responseHash` on completion.

A receipt cannot be rebound to another conversation, and cannot be completed with
content that differs from its hashes.

## Reconciliation

When a request id with an existing `SUBMITTED` receipt is seen, the runtime takes
a provider snapshot and decides:

| Observation | Decision |
|---|---|
| provider is still generating after the boundary | **WAIT**: resume observing |
| a new completed response exists after the boundary | **RECOVER**: adopt it, do not resend |
| no trace of the prompt after the boundary | **RESUBMIT**: at most `maxResubmits` (default 2) per receipt |
| anything else (boundary missing, conflicting turns) | **AMBIGUOUS**: fail closed (`provider_reconciliation_failed`) |

This applies [INV-4](../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay)
to provider turns.

## Submission

1. Prepare the page from the account's portable auth state in a fresh browser
   context, and open the bound conversation.
2. `checkAuth`. If signed out, mark the account `reauth-required` (guarded by
   revision) and invalidate its scheduler.
3. `selectMode`, then verify it again just before sending. On a mismatch, fail. Never
   continue on another model.
4. Insert the prompt by a method that bypasses editor shortcuts, read it back, and
   compare hashes before sending.
5. Bind the turn by provider turn id, not by display index.

## Two-clock completion

Completion is observed with two independent deadlines:

- **hard deadline:** the absolute upper bound for the turn;
- **stall deadline:** reset only by *meaningful* transitions, meaning response text
  changed or generation started or stopped.

**Generating** is read from the composer's action slot. While the website
generates, the slot shows **Stop**. When it is idle, the slot shows **Send** again
(disabled while the composer is empty), or a voice button on an empty home page.
The rule is:

- **running:** Stop is visible;
- **idle:** Stop is gone and Send (or the idle voice button) is back.

A turn completes when it is idle **and** the new answer's action buttons are
present (ChatGPT: "Copy", "Regenerate response") **and** the answer text has
been unchanged for `stableMs`. Idle alone is not enough, because the slot can
flip between phases of a long answer (thinking, tool calls, Deep Research).
Network streams are not used to decide "running": on ChatGPT the event stream
stays open after the answer is complete. They serve as submission evidence and
as typed error signals.

Known limitation: typing into the composer while the site is generating turns the
slot back to **Send**. The driver never types during a run, so this case is not
handled yet. In persistent mode, completion and the canonical
conversation binding are awaited together, so a turn without a canonical binding
fails. A hard timeout and a
stall timeout are reported as distinct errors.

## Write-back

After completion, the receipt is marked `COMPLETED`, auth state is recaptured, and
it is written back **only if** both the account revision and the scheduler lease
generation are still current. Otherwise the write is dropped
([scheduling-and-leases](scheduling-and-leases.md)).

## Runtime (MVP slice 1)

`@tsuuanmi/system-turns` (`ctx.turns`) runs `ask` end to end. The details are in
its [README](../../packages/plugins/turns/README.md):

- **Accept durably.** The turn is stored as `queued` before anything runs.
- **Route.** A persistent session stays on its account. Otherwise the turn goes
  to the first ready account, and the choice is recorded as a `route` decision.
- **Schedule.** The account's scheduler runs the turn.
- **Open.** A fresh context is built from the saved state.
- **Run the driver.**
  - The receipt is written in `beforeSend`.
  - Completion binds the conversation, completes the receipt, and stores the
    answer artifact in **one transaction**.
- **Restart.** A submitted turn is never resent automatically.

MCP contract: `ask { prompt, sessionId?, persist?, clientRequestId?, waitSeconds? }`
returns the turn view with `answer` once it is complete. Otherwise it returns
`status: queued | running` and a `turnId`, which `result { turnId, waitSeconds? }`
long-polls. The wait stays under common MCP client timeouts (at most 55 s).

## Large inputs

When a prompt exceeds the measured composer budget, the runtime either fails
before opening a browser turn or, if the capability allows it, sends a multipart
transfer. Each part carries complete records and must be acknowledged with its
exact SHA-256 before the next one is sent. Any failure aborts the whole transfer.
Budgets are measured with a tokenizer, not guessed.
