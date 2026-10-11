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

A turn completes when generation has stopped and the response text has been
unchanged for `stableMs`. Completion and canonical conversation binding are
awaited together, so a turn without a canonical binding fails. A hard timeout and a
stall timeout are reported as distinct errors.

## Write-back

After completion, the receipt is marked `COMPLETED`, auth state is recaptured, and
it is written back **only if** both the account revision and the scheduler lease
generation are still current. Otherwise the write is dropped
([scheduling-and-leases](scheduling-and-leases.md)).

## Large inputs

When a prompt exceeds the measured composer budget, the runtime either fails
before opening a browser turn or, if the capability allows it, sends a multipart
transfer. Each part carries complete records and must be acknowledged with its
exact SHA-256 before the next one is sent. Any failure aborts the whole transfer.
Budgets are measured with a tokenizer, not guessed.
