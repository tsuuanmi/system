---
id: PROP-0005
type: proposal
status: draft
owners: [operator]
created: 2026-10-17
related-requirements: [REQ-ACC-5, REQ-TEAM-4, REQ-PRV-1]
related-decisions: [ADR-0016, ADR-0017, ADR-0027, ADR-0029]
implementation: []
---

# Proposal: Session-bound website accounts run their turns in their own login profile

## Problem

Every website turn runs in a fresh browser context built from the account's portable state (its
cookies, local storage and IndexedDB), and the login profile is used only to sign in
([ADR-0016](../decisions/adr/0016-invisible-headed-browser-and-portable-accounts.md),
[browser runtime](../design/browser-runtime.md): "Automated turns never use it"). That works for
ChatGPT. It does not work for the Gemini account, live, on 2026-10-16:

- A copy of the state worked for one turn; the next fresh context, seconds to minutes later, was
  signed out (brainstorms `run_4f112b5f0b87473b` and `run_39cdb5914a558ee3`).
- A copy saved from the signed-in login profile at 12:04 was already signed out in a fresh context
  at 12:05 (`run_26e89c411ea5829b`).
- Repeated loads then drew Google's unusual-traffic check (a reCAPTCHA) for the host, in turns and
  in the login profile alike (drift outlines `sha256:3bde29cd…`).
- Through all of it, the operator saw the login profile itself still signed in, and Save worked.

So Gemini, and with it the second provider family that teams and research are built for
([ADR-0027](../decisions/adr/0027-provider-diversity-in-routing.md)), cannot serve work. Teams now
run on one family by opt-in ([ADR-0029](../decisions/adr/0029-opt-in-same-family-fallback.md)),
which is weaker evidence.

## Goals

1. An account whose site binds its session to the browser that signed in serves turns reliably,
   for hours, without new sign-outs or challenges caused by the way `system` drives it.
2. Nothing changes for an account whose site accepts portable state (ChatGPT today).
3. No provider is named outside its driver (INV-11): the binding is a driver capability.
4. Several sessions of one account still run side by side, each in its own conversation (ADR-0015).

## Non-goals

- Solving or avoiding a challenge automatically: a challenge stays the operator's
  ([ADR-0016](../decisions/adr/0016-invisible-headed-browser-and-portable-accounts.md): no
  automatic challenge solving).
- An official API Worker for the same provider: a separate Worker source with its own quota class;
  it can come later and does not fix the website account.
- Portable copies for moving an account between hosts: a session-bound account is signed in on
  the host that uses it.

## Evidence and research

- The events and outlines above (event log of 2026-10-16, `system evidence`).
- Research run `run_233d4e56456ac0a9` (pending): why a site ends a session copied into a new
  browser context, and what maintained automation projects do instead.
- Precedent: codex-chatgpt-web, one of the projects ADR-0016 learned from, ran one persistent
  partition per account rather than fresh contexts.

## Proposed design

- **A driver capability.** A driver declares `sessionBound: true` when its site ties a session to
  the browser profile that signed in. The Gemini driver declares it; the ChatGPT driver does not.
  Nothing else names a provider.
- **Turns in the login profile.** For a session-bound account, the browser runtime opens one
  persistent context on the account's login profile (headed, on the invisible display, as Save
  does today) and keeps it open while the account works. Each turn is a new page (tab) in that
  context, closed when the turn ends. Portable state is neither loaded nor written back for it.
- **One context per account.** Chrome allows one process per profile directory, so the runtime
  holds the profile while turns run, and the operator's remote login waits for it, or closes it
  when idle; a sign-in never runs beside a turn.
- **Sessions stay apart.** Each session is its own conversation in its own tab, so several team
  members can still share the account (ADR-0015, ADR-0029).
- **Accounts.** Save keeps verifying identity from the profile. The account's portable state is
  kept only as the identity record; `account verify` and the sign-in check open the profile.
- **Pacing.** A session-bound account's turns are spaced (a minimum gap between page loads, a
  validated driver `Config` field), and an unknown page fails once, never retried
  (as `0e753c7` does today).
- **Challenge.** As today: the account is marked `challenge` and no Worker of it is admitted until
  the operator passes the check in the login profile and saves.

## Alternatives considered

1. **Re-capture from the profile before every turn.** Disproved live: a copy captured from the
   signed-in profile was signed out a minute later in a fresh context.
2. **Keep fresh contexts, slow down.** Spacing alone does not fix a copy that is signed out on its
   first reuse; it would only lower the challenge rate.
3. **Write back after every turn** (already done since `54ee63b`): the signed-out turn came right
   after a write-back, so the written-back copy is no better.
4. **An official API Worker.** Real, but another product (metered, its own quota class); it does
   not make the subscription account usable.
5. **Drop the second family.** Teams stay single-family (ADR-0029), with weaker evidence.

## Validation plan

- Fake site: a fake provider that accepts a session only in the context that signed in (its
  cookie is rejected in another context), so a fresh-context turn fails and a profile turn works;
  two sessions in two tabs answer independently; a remote login waits for, or ends, the turns.
- Crash: a host killed mid-turn restarts with the profile lock released (`releaseStaleProfileLock`)
  and reconciles the turn as today.
- Live, after the operator clears the challenge: a two-turn brainstorm with a Gemini member, then
  turns spaced over hours, then a review with members on both families; no sign-out, no challenge.

## Rollout and rollback

- The capability ships with the Gemini driver; the browser runtime gains the profile path.
- Rollback: the driver drops `sessionBound`, and its turns return to fresh contexts.
- Once two families serve work again, `allowSameFamily` may stay on: it only acts when no second
  family is admitted.

## Observability and operations

- An event when a profile context opens and closes, and health shows an account whose profile is
  held by a remote login.
- Runbook: a session-bound account is signed in on its host; moving it means signing in again.

## Security and privacy

- The login profile already holds the account's full browser state; this uses it for turns too,
  on the same host, with the same file permissions. No state leaves the host.
- A page of a turn shares the profile with the account's other tabs; sessions are separated by
  conversation, not by browser context, so one account's sessions are one trust domain (as they
  are for one account today).

## Compatibility and migration

- ADR-0016 and the browser runtime rule "automated turns never use the login profile" are
  superseded in part, for session-bound accounts only: an ADR records it.
- Existing portable state stays valid for the accounts that use it.

## Decision

Pending: the operator decides after the research run and Researcher's review.

## Implementation

None yet.
