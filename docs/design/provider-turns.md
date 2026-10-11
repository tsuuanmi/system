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
  identity(page): Promise<string>;                 // hashed before storage
  ask(page, prompt, { conversation, binding?, mode?, feature?, deadlines?, beforeSend, onBinding }): Promise<AskResult>;
  snapshot(page, binding): Promise<TurnSnapshot>;  // for reconciliation
  // (target shape; the implemented contract is ProviderDriver in provider-core)
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
- **Resolution.** A turn's tier (requested, or `defaultTier`) is a minimum.
  Each tier an account maps to a preset is one Worker. The router
  ([routing](routing.md#algorithm)) picks the lowest admitted tier at or above
  the minimum and records a `tier` decision. A tier the catalog does not map has
  no Worker, so it is never served by some other mode.
- **Verification.** The driver selects the model radio and steps the Power
  slider, then **reads both back**. An unknown preset, an unknown or locked
  model, or an unreachable level fails with `config_error` before anything is
  sent (INV-2). The receipt records the verified model and effort.
- **Deep research** (`feature: deep-research`) runs only in persistent
  conversations: Temporary chat does not offer it. Its first reply is an
  acknowledgement, and the report arrives later in a nested frame. The driver
  waits for that frame's "Research completed" state (running while "Stop
  research" shows) and returns the report. If no frame appears, the reply was a
  clarifying question and is returned as the answer. `research` returns at once,
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
| the page shows the prompt as its last user turn, with no answer yet | **AMBIGUOUS**: the provider has it, so resending would duplicate it |
| no trace of the prompt after the boundary | **RESUBMIT**: at most `maxResubmits` (default 2) per receipt |
| anything else (boundary missing, conflicting turns, a page that rendered no user turn) | **AMBIGUOUS**: fail closed (`reconciliation_failed`) |

A snapshot counts only on positive evidence. A conversation that has not
rendered a user turn was not observed, and it is never read as "nothing new".
For Deep research, only the run that follows the last prompt counts, and never
its acknowledgement. Both rules come from a live restart on 2026-10-12, where a
snapshot of a page that had not rendered yet chose RESUBMIT.

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

`@tsuuanmi/system-turns` (`ctx.turns`) runs one turn end to end. The workflow
engine calls it for every `worker` node. The details are in its
[README](../../packages/plugins/turns/README.md):

- **Accept durably.** The turn is stored as `queued` before anything runs.
- **Route.** `ctx.workers` admits one website Worker (an account at a tier) and
  records `tier` and `route` decisions, or an `admission` decision when none
  fits. A persistent session stays on its account.
- **Schedule.** The account's scheduler runs the turn.
- **Open.** A fresh context is built from the saved state.
- **Run the driver.**
  - The receipt is written in `beforeSend`.
  - Completion binds the conversation, completes the receipt, and stores the
    answer artifact in **one transaction**.
- **Restart.** A submitted turn is reconciled. Persistent conversations are
  bound as soon as their id appears, then reopened and snapshotted. Temporary ones
  cannot be observed and end as AMBIGUOUS. A prompt is resent only on RESUBMIT,
  within the bound.

MCP contract (served by the [workflow engine](../../packages/plugins/workflow/README.md)):
`ask { prompt, sessionId?, persist?, tier?, classification?, clientRequestId?, waitSeconds? }`
returns the run view with `answer` once it is complete. Otherwise it returns
`status: running` and a `runId`, which `result { runId, waitSeconds? }`
long-polls. `research { question, sessionId?, classification?, clientRequestId? }`
returns at once with a `runId` and a `sessionId`. The wait stays under common MCP
client timeouts (at most 55 s).

## Large inputs

When a prompt exceeds the measured composer budget, the runtime either fails
before opening a browser turn or, if the capability allows it, sends a multipart
transfer. Each part carries complete records and must be acknowledged with its
exact SHA-256 before the next one is sent. Any failure aborts the whole transfer.
Budgets are measured with a tokenizer, not guessed.
