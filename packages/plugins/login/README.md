# @tsuuanmi/system-login

**`ctx.login`**: per-account login profiles and the **Save** flow
([browser runtime](../../../docs/design/browser-runtime.md#save-both-modes)).

- **`profileDir(account)`:** `<DSH_HOME>/system/login-profiles/<id>`, owner-only.
  It is used for interactive login. Automated turns never use it, except on a
  session-bound account, which does all its work there
  ([ADR-0030](../../../docs/decisions/adr/0030-session-bound-accounts-use-their-login-profile.md)).
  The turn runtime asks for the path.
- **`save(account)`:**
  1. Reopen the login profile headed on the invisible display
     (`ctx.browser.captureProfile`). A profile still held by a live browser is
     refused.
  2. The driver confirms the sign-in and reads its identity hint.
  3. Capture the state for the driver's `stateOrigins`, in memory only.
  4. Verify that state signs in, in a fresh context. A session-bound account skips
     this step: step 2 already verified it in the profile, and loading a copy
     could end its session. Its stored state is only the identity record.
  5. Store it through `ctx.accounts` (encrypted, revision-guarded), with
     `identityHash = sha256(provider, identity)`.

  A failed check saves nothing.
- **`remote(account)`: the remote login desktop.** Ported from tsuuanmi/internet.
  - A plain Chrome, with no automation attached, opens the login profile on a
    private, X-authenticated Xvfb.
  - `x0vncserver` (TigerVNC) or `x11vnc` serves that display **only on an
    owner-only unix socket** (no TCP port).
  - A loopback page (default port 47318) behind a random 256-bit URL token serves
    noVNC (`@novnc/novnc`, MPL-2.0) and proxies its WebSocket (`ws`) to the
    socket. It accepts only Host `127.0.0.1`/`localhost` and sends
    `no-referrer`, `no-store`, and `DENY` framing headers.
  - **Save** (a POST that must come from the page's own origin) closes Chrome
    until it releases the profile, then runs `save`. **Cancel** tears down.
  - The desktop closes after `remoteTtlMs` (default 30 min).
  - **The profile is reserved while the desktop is open**
    (`ctx.browser.reserveProfile`). A remote login is refused while a
    session-bound account's operations still run in the profile. While the
    desktop is open, new operations fail as `overloaded` (backoff), so they never
    run beside the operator's browser.
  - A second `remote` for the same account, while the first is starting or open,
    joins it and gets the same desktop. A taken port fails as `config_error`.
  - The login browser carries `OWNED_PROFILE_SWITCH`, so the browser of a
    crashed host's login is stopped the next time the profile is used. Its Xvfb
    and VNC server hold no profile and are not reaped (roadmap P3).
- **One Save per account at a time.** That also means one automated sign-in:
  two turns that both find the account signed out run their relogins one after
  the other. A relogin is refused (`overloaded`) while a remote login for the
  account is open.
- **`relogin(account)`: credential login** (ADR-0017, opt-in per account).
  - It runs only for accounts in `credentials` mode (`accounts.setCredentials`),
    on the persistent login profile, inside the Save flow.
  - The driver's `signIn` state machine is driven by the UI map:
    - email, password, "Try another method" → "Authenticator app", "Not now";
    - one-time codes come from **`totp-local`**: computed with `otpauth`, never
      with fewer than 5 s left in the window, never reused, and the secret never
      leaves the machine;
    - an emailed code comes from the operator (`submitCode`, `system account code`,
      waiting up to `codeWaitMs`).
  - It stops at any challenge (never solved), at an unknown page, or after two
    rejected codes. In those cases the account is marked `reauth-required` and
    nothing is saved.
  - **It never switches accounts.** Its `save` passes `sameIdentity`
    (`accounts.saveState`): a sign-in as a different account than the one saved
    is refused with `reauth_required`, and nothing is stored. Only a manual Save
    at the remote login may switch the account.
  - The turn runtime calls `relogin` once when a credentials-mode account turns
    out to be signed out, and only while the turn has no receipt (nothing was
    sent).
- **MCP tools** (when `ctx.mcp` is mounted): `account_list` (secret-free views),
  `account_login { account }` (returns the URL and the `ssh -L` command),
  `account_save { account }`, and the credential-login tools
  `account_set_credentials`, `account_relogin`, and `account_code`. None of them
  returns a secret. The `system account list|login|save|credentials|relogin|code`
  CLI commands call these tools; `credentials` reads its JSON from stdin.
- **Live-verified on 2026-10-11:** `system account save chatgpt-main` against the
  running profile stored a real account (`ready`, revision 1). The vault holds only
  ciphertext.
- **Hidden from agents:** `profilesDir`, and each remote login's socket
  directory while it lives, are registered secret paths ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)).
- **Config:** `profilesDir`, `vncPath`, `chromePath`, `remoteTtlMs`, `remotePort`.
- **Injects:** `accounts`, `browser`, `providers`; `mcp` is optional.
