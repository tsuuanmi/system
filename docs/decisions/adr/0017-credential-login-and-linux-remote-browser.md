# ADR-0017: Opt-in credential login with local TOTP; Linux-first remote browser

- **Status:** Accepted; amended by [ADR-0021](0021-ui-operations-as-data.md) (UI drift is `CONFIG_FIX`)
- **Date:** 2026-10-11
- **Related:** ADR-0010, ADR-0016, CON-3,
  [research](../../research/chatgpt-login-and-remote-browser.md),
  [browser runtime](../../design/browser-runtime.md#login-flows)

## Context

The maintainer wants accounts to be able to log in with email, password, and a
2FA code, and wants the MVP to target Linux first, with a remote view through
noVNC and an SSH tunnel. Existing work had to be checked before building
anything:

- No maintained project automates ChatGPT **Web** login with TOTP. The
  reverse-engineered HTTP flows are dead, and Codex OAuth tokens do not produce a
  web session.
- codex-autologin, browser-use, and Skyvern show workable patterns: a
  deterministic form flow, a TOTP code generated locally from a stored secret,
  and a hook that supplies email or SMS codes.
- tsuuanmi/internet already ships the remote browser we need: Xvfb, x11vnc, and
  noVNC, with tokens and loopback-only access.
- OpenAI can require an **email code** on a new device or location. TOTP cannot
  satisfy that check.
- Sending a TOTP secret to a website such as 2fa.live hands over the second
  factor permanently.

## Options

1. Interactive login only (remote or visible).
2. Use an LLM browser agent (browser-use or Skyvern) for login.
3. **Build a small deterministic login state machine, opt-in per account**, with
   the TOTP code computed locally. Anything the machine cannot satisfy falls back
   to the remote browser on the same profile.

## Decision

Option 3. For the remote browser, **port** tsuuanmi/internet's implementation.

- **Login modes per account:**
  - `manual` (the default) is the interactive remote or visible login.
  - `credentials` is opt-in automatic login with email, password, and optional
    TOTP.
- **Credential login runs only after a detected sign-out** (positive evidence).
  It never runs on a schedule. It operates on the account's persistent login
  profile, so the device is recognized and the email-code check is rare.
- **The TOTP code is generated locally** with the `otpauth` library from the
  secret in the vault, minted just before submission and never reused. A secret
  is **never** sent to any website or service, 2fa.live included.
- **Code providers** sit behind a small interface:
  - `totp-local` (MVP);
  - `manual`: the operator supplies a code through the CLI or the remote view;
  - `imap`: reads the operator's own mailbox. It is opt-in and comes later.
- **Stop conditions:** an email code without an opted-in code provider, a
  Turnstile or CAPTCHA, an unknown page, a wrong code, or a second failed attempt.
  Each one raises `NEEDS_HUMAN` and opens the remote browser on the same profile.
  The machine never solves challenges and never retries in a way that risks
  locking the account (CON-3).
- **Credentials are encrypted at rest** (mandatory). The key comes from the OS
  keyring, or from a separate `0600` key file on servers without a keyring. They
  are decrypted only in memory and never logged, prompted to a model, or placed in
  an artifact.
- **Linux first.** The MVP supports Linux x64 only, with the `virtual` display
  and remote login over noVNC through an SSH tunnel. macOS and Windows
  (`offscreen` and visible login) move to v1.0.

## Consequences

- Most re-logins need no human: the persistent profile is recognized as a known
  device, and TOTP is automatic. The rest degrade cleanly to a remote session.
- OpenAI's login pages can change, so the state machine is covered by DOM
  fixtures and fails closed with `CODE_FIX` on drift.
- No bulk-account features are planned: no batch import of credential lists, no
  account creation, and no CAPTCHA services. Accounts are operator-owned and
  added one at a time.
- Porting internet's remote login is recorded in the
  [dependency register](../../engineering/dependencies.md). Switching Xvfb and
  x11vnc to TigerVNC `Xvnc` is a later improvement.
