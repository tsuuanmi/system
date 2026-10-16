# Provider turns

> Target state. Boundary: [provider runtime](../architecture/components.md#provider-runtime).
> Requirements: REQ-PRV-1..7, REQ-ACC-4..5.
>
> Implemented in [`turns`](../../packages/plugins/turns/README.md),
> [`turn-receipts`](../../packages/plugins/turn-receipts/README.md),
> [`provider-core`](../../packages/provider-core/README.md), and the drivers
> [`provider-chatgpt-web`](../../packages/plugins/provider-chatgpt-web/README.md) and
> [`provider-gemini-web`](../../packages/plugins/provider-gemini-web/README.md); differs from
> target: the driver steps (open, mode, submit, binding, extract) run inside `ask`; turns are not
> bound by provider turn id; large inputs and attachments are planned.

## Driver interface

Each website is a `ProviderDriver`. The runtime never branches on provider names
([ADR-0005](../decisions/adr/0005-provider-runtime-interface.md)).

```ts
interface ProviderDriver<Page> {                   // provider-core
  readonly provider: string;                       // "chatgpt-web", "gemini-web"
  readonly capabilities: readonly string[];        // proven by its tests, e.g. reason
  readonly features?: readonly string[];           // per account, e.g. deep-research
  probeFeatures?(page): Promise<string[]>;         // read from the site; sends nothing
  readonly modes?: readonly string[];              // configured preset names; a tier mapped elsewhere is unavailable
  readonly loginUrl: string;
  readonly stateOrigins: readonly string[];
  checkAuth(page): Promise<AuthState>;             // signed-in | signed-out | unknown
  identity(page): Promise<string>;                 // hashed before storage
  ask(page, prompt, { conversation, mode?, feature?, binding?, signal?, deadlines?,
                      beforeSend?, onBinding? }): Promise<AskResult>;  // { text, binding, mode }
  signIn?(page, credentials, code): Promise<void>; // credential login (ADR-0017)
  snapshot(page, binding, { feature? }): Promise<TurnSnapshot>;     // for reconciliation
}
```

`ask` holds the whole turn: open the conversation (new, bound, or Temporary chat), select and
read back the mode, insert and send the prompt, wait for completion, and read the answer as
Markdown. `beforeSend` runs after the mode is verified and immediately before the send; the
runtime writes the turn receipt there, and a throw sends nothing. `onBinding` reports a new
persistent conversation's id as soon as it appears.

The answer's Markdown comes from the site's own Copy control. It is kept only
when its prose words are the rendered answer's words in order, since the
clipboard may be shared. Link texts, reference definitions, and citation chips
may differ, because one chip can stand for several sources ("Name +2"); a
footnote renders, so it is prose. A refused Copy leaves the rendered text. Either
way, the answer's off-site links that the text lacks follow it as a `Sources:`
list, so a cited answer keeps its URLs. No URL the answer keeps carries `utm_*`
tracking parameters
([`copiedMarkdown`](../../packages/ui-ops/src/answers.ts)).

Shared mechanics, which are the same for every driver, live in the runtime:
receipts, completion, scheduling, auth-state write-back, and error
classification.

## Conversation modes

The runtime picks the mode from the request and never from the website's
default. Live observations are in the
[research](../research/browser-interaction-and-self-healing.md#live-check-2026-10-11-signed-in-account-read-only).

| Request | Mode | Binding | Why |
|---|---|---|---|
| a one-shot `ask` or `research` call with no session | **temporary** (ChatGPT: Temporary chat, `?temporary-chat=true`; Gemini: Temporary chat, shown only by its notice) | none kept after the turn | stays out of the operator's history; no conversation to resume |
| a turn in a Worker session (`SessionId`), or any long-running or multi-turn work | **persistent** (a normal chat) | the canonical conversation id (ChatGPT `/c/<id>`, Gemini `/app/<id>`), stored in the receipt and the session | later turns, recovery after a crash, and Deep Research return to the same conversation |

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
  Gemini's agent tab, **Spark**, is refused the same way: where the tabs are
  shown, the **Chat** tab must be active before sending.

## Modes and tiers

- **Where the knowledge lives.** The UI map holds *how* to select a mode: the
  model menu, model radios, Power slider and its status, the tools popover, and
  the Deep research chip. Configuration holds *what* to select:
  - the driver plugin's `modes` (named presets of a model and an effort level)
    and its `defaultMode`;
  - each account's catalog `tiers` (tier → preset name);
  - the workflow template's tier per node, which a caller may replace for
    `ask`.
- **Resolution.** A node's tier is a minimum.
  Each tier an account maps to a preset is one Worker. The router
  ([routing](routing.md#algorithm)) picks the lowest admitted tier at or above
  the minimum and records a `tier` decision. A tier the catalog does not map has
  no Worker, so it is never served by some other mode.
- **Verification.** The driver selects the model radio and steps the Power
  slider, then **reads both back**. An unknown preset, an unknown or locked
  model, or an unreachable level fails with `config_error` before anything is
  sent (INV-2). An account without a model picker (ChatGPT Free) has no mode to
  verify, so its turn fails as `ui_drift` and nothing is sent. The receipt
  records the verified model and effort.
- **Deep research** (the `deep-research` capability) runs only in persistent
  conversations: Temporary chat does not offer it. Its first reply is an
  acknowledgement, and the report arrives later in a nested frame. The driver
  waits for that frame's "Research completed" state (running while "Stop
  research" shows) and returns the report. If no frame appears, the reply was a
  clarifying question and is returned as the answer. `research` returns at once,
  with longer deadlines (default 60 min, stall 30 min).
- **Gemini's Deep research** is a two-step start. Its first reply is a plan,
  which already carries Copy, so a plain completion check would take the plan
  for the answer. The driver clicks **Start research**, which the site records
  as a user turn of its own, then follows the research card from `processing`
  to `completed`. It reads the report from the report panel, followed by the
  sources it used. A reply with no plan is a clarifying question, returned as
  the answer. A reopened Deep research conversation keeps Deep research chosen,
  so a plain turn there clears it first and sends nothing if it cannot.

## Turn receipt

A receipt is persisted **before** submission. It binds:

- the account, the conversation binding, and the logical request id;
- `promptHash` and `previousResponseHash`, which mark the boundary of the response
  that existed before this turn;
- status `SUBMITTED → COMPLETED`, with `responseHash` on completion.

A receipt cannot be rebound to another conversation, and cannot be completed with
content that differs from its hashes. It lives as long as its turn: when retention deletes a
finished turn, its receipt goes in the same transaction
([INV-9](../architecture/invariants.md#inv-9-everything-is-bounded)); the answer stays as an
artifact.

## Reconciliation

When a request id with an existing `SUBMITTED` receipt is seen, the runtime takes
a provider snapshot and decides:

| Observation | Decision |
|---|---|
| provider is still generating after the boundary | **WAIT**: resume observing; a cancel or a stop ends the wait, and consecutive WAITs are one decision |
| a new completed response exists after the boundary | **RECOVER**: adopt it, do not resend |
| the page shows the prompt as its last user turn, with no answer yet | **AMBIGUOUS**: the provider has it, so resending would duplicate it |
| no trace of the prompt after the boundary | **RESUBMIT**: at most `maxResubmits` (default 2) per receipt |
| anything else (boundary missing, conflicting turns, a page that rendered no user turn) | **AMBIGUOUS**: fail closed (`reconciliation_failed`) |

A snapshot counts only on positive evidence. A conversation that has not
rendered a user turn was not observed, and it is never read as "nothing new".
For Deep research, only the run that follows the last prompt counts, and never
its acknowledgement or plan. A reopened Gemini conversation whose plan was never
started shows the prompt with no research after it, so it is never resent.

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
5. Bind the turn by provider turn id, not by display index (planned: today the
   receipt binds the conversation and the response boundary).

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
it is written back (a background sign-in check that finds the account signed in does the same) **only if** both the account revision and the scheduler lease
generation are still current. Otherwise the write is dropped
([scheduling-and-leases](scheduling-and-leases.md)).

## Runtime (MVP slice 1)

`ctx.turns` is the website Worker source: it runs one turn end to end on the website Worker
the workflow engine admitted. The full path of a turn, from any entry point:

```mermaid
sequenceDiagram
  participant E as Entry (CLI, MCP, gateway)
  participant W as Workflow engine
  participant R as ctx.workers
  participant T as Worker source (turns)
  participant X as ctx.egress
  participant S as Account scheduler
  participant D as Driver (browser page)
  E->>W: start(template, input)
  W->>R: route(requirement)
  R-->>W: admitted Worker, tier and route decisions
  W->>T: start(key, Worker, prompt)
  T->>T: store the turn as queued (durable)
  T->>X: check(actual payload, classification)
  X-->>T: egress decision (if denied, egress_denied and nothing is sent)
  T->>S: runTurn(session), under the turn's lease
  S->>D: fresh context from the saved state; ask(...)
  D->>T: beforeSend writes the receipt (SUBMITTED)
  D-->>T: answer, binding, verified mode
  T->>T: one transaction binds, completes the receipt, stores the answer
  T-->>W: execution completed
  W->>R: accept(result, contract), an acceptance decision
  W-->>E: run view with the answer
```

An agent Worker's run takes the same path through its own source,
[`agent-workers`](../../packages/plugins/agent-workers/README.md), with a scheduler per Worker.
The Worker is local but its model is remote, so the source checks the prompt at egress too,
for the Worker class `agent`, before the agent starts.

- **Route.** A persistent session stays on its account (session affinity).
- **Order.** A session's turns run in acceptance order, decided by the store, not by one
  process's memory: a later turn waits while an earlier turn of its session is queued or
  running, including one whose lease a crashed process still holds. A turn never answers into a
  conversation that is not reconciled yet.
- **Sign-out.** A credentials-mode account signs in again once
  ([ADR-0017](../decisions/adr/0017-credential-login-and-linux-remote-browser.md)) only while
  the turn has no receipt. A sign-out seen after the receipt exists fails the turn: the prompt
  may have been sent, so it is never run again
  ([INV-4](../architecture/invariants.md#inv-4-restart-is-reconciliation-not-replay)).
- **Restart.** A submitted turn is reconciled. Persistent conversations are bound as soon as
  their id appears, then reopened and snapshotted. Temporary ones cannot be observed and end as
  AMBIGUOUS. A prompt is resent only on RESUBMIT, within the bound.

MCP contract (served by the [workflow engine](../../packages/plugins/workflow/README.md);
exact shapes in [MCP tools](../reference/mcp-tools.md)):
`ask { prompt, sessionId?, persist?, tier?, classification?, clientRequestId?, waitSeconds? }`
returns the run view with `answer` once it is complete. Otherwise it returns `status: running`
and a `runId`, which `result { runId, waitSeconds? }` long-polls.
`research { question, deep?, classification?, clientRequestId? }` returns at once with a
`runId` and a `sessionId`; `deep` runs the `deep` variant, whose literature reviews are Deep
research. The wait stays under common MCP client timeouts (at most 55 s).

## Large inputs

Planned. When a prompt exceeds the measured composer budget, the runtime either fails
before opening a browser turn or, if the capability allows it, sends a multipart
transfer. Each part carries complete records and must be acknowledged with its
exact SHA-256 before the next one is sent. Any failure aborts the whole transfer.
Budgets are measured with a tokenizer, not guessed.
