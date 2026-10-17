# ADR-0030: A session-bound website account works in its own login profile

- **Status:** Accepted; amended 2026-10-17 (a session keeps its tab between its turns)
- **Date:** 2026-10-17 (accepted 2026-10-17, by the operator, in Researcher's session)
- **Related:** [PROP-0005](../../proposals/0005-session-bound-website-accounts.md),
  [ADR-0016](0016-invisible-headed-browser-and-portable-accounts.md) (superseded in part),
  [ADR-0015](0015-worker-sessions-and-peer-messaging.md),
  [ADR-0029](0029-opt-in-same-family-fallback.md),
  [browser runtime](../../design/browser-runtime.md), INV-4, INV-11

## Context

ADR-0016 and the browser runtime run every automated turn in a fresh context built from the
account's portable state. The login profile is used only to sign in: "Automated turns never use
it". Live, copies of that state died while the login profile stayed signed in. This happened on
Gemini on 2026-10-16, a minute after the copy was taken, and on ChatGPT on 2026-10-17, after six
days. The research (`run_c34e9ed099c2254b`) found four real mechanisms that fit:

- device-bound session credentials;
- provider risk controls;
- an incomplete copy;
- refresh-token rotation with reuse detection.

None of them is established as the cause, and running in the original profile avoids all four.
PROP-0005 records the evidence and the alternatives.

## Options

1. Keep fresh contexts and pace them.
2. Re-capture from the profile before every turn (disproved live).
3. One context per account, with fresh copies (`maxConcurrentTurnsPerAccount: 1`). It is applied
   as an interim, and it does not unblock Gemini.
4. **A driver capability: the account's operations run as tabs of one persistent context on its
   login profile.**

## Decision

Option 4.

- **Capability.** A driver declares `sessionBound` when its site ties a session to the browser
  profile that signed it in. Nothing outside the driver names a provider (INV-11).
- **Every operation on the account** opens a page (a tab) in one persistent context on the
  account's login profile. That covers:
  - turns and their reconciliation snapshots;
  - verify, probe and the background sign-in check;
  - conversation inspection and deletion;
  - Save.

  Portable state is neither loaded nor written back for these operations. Save verifies the
  sign-in and the identity in the profile and stores the captured state only as the identity
  record. Sessions stay apart by conversation, each in its own tab (ADR-0015, ADR-0029).
- **Lifecycle.**
  - The context opens lazily, one launch at a time, and closes after the browser's idle time
    (`closeAfterMs`).
  - If its browser dies, every in-flight operation fails with the browser's error. A submitted
    turn reconciles by its receipt, as today (INV-4).
  - A stale profile lock left by a dead process is cleared on the next open.
- **The operator's login comes first.**
  - A remote login reserves the profile: it closes the idle context first, and it is refused while
    operations still run.
  - While the reservation holds, an operation on the account fails as `overloaded` (backoff),
    never beside the operator's browser.
- **Pacing.** A session-bound driver may space the account's page loads (`pageGapMs`, a validated
  driver `Config` field).
- **Rollout.** The Gemini driver declares `sessionBound` first. The ChatGPT driver declares it
  only after Gemini's live validation passes. That validation waits until the operator has cleared
  Google's challenge, and it runs under a page-load cap.

## Consequences

- Supersedes in part ADR-0016's "a fresh context per turn from portable state" and the browser
  runtime's "automated turns never use [the login profile]": the rule no longer holds for a
  session-bound account. Everything else in ADR-0016 stands. That includes headed, invisible,
  genuine Chrome, and never headless.
- A session-bound account is signed in on its host. Moving it to another host means signing in
  again; its portable state cannot carry it.
- One account's sessions share one cookie jar. A single writer refreshes the session, which also
  removes the two-writer pattern of option 3.
- The operator and the automation take turns on the profile. A remote login waits for running
  operations and pauses new ones.
- Revisit this if a site's sessions still die inside its own profile. Then the cause is not
  portability, and alternative 4 of PROP-0005 (an API Worker) is next.

## Amendment (2026-10-17): a session keeps its tab between its turns

The decision stands: a session-bound account works in pages of its own profile, never from a
copy. Detailed in [PROP-0005's amendment](../../proposals/0005-session-bound-website-accounts.md#amendment-2026-10-17-keep-a-sessions-tab-between-its-turns),
to cut page loads at the operator's request:

- A persistent session's page stays open between its turns, as the session's tab. The next turn
  gets it back, brought to the front, and a driver does not reload a page that already shows the
  conversation. Its sign-in is checked on the page as it is.
- A page is kept only after a completed turn whose page is idle and clean. Any failure discards it.
- At most `MAX_KEPT_TABS` (4) per account, each idle for at most 10 minutes. Kept tabs close with
  their session, with the context, and on a reservation, which they never refuse.
- Temporary turns open a page each, as before.
