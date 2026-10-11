# Browser runtime and account vault

> Target state. Seams: `ctx.browser`, `ctx.display`, `ctx.accounts`
> ([plugin model](../architecture/plugin-model.md#seam-catalog)).
> Decision: [ADR-0016](../decisions/adr/0016-invisible-headed-browser-and-portable-accounts.md).
> Requirements: REQ-ACC-1..9. Shape: [`account.v1.json`](../../schemas/account.v1.json).
> Evidence: how [internet](../research/internet-analysis.md) and
> [codex-chatgpt-web](../research/codex-chatgpt-web-analysis.md) run their browsers.

## Principle: a genuine browser, headed but invisible

Provider websites are consumer UIs. A headless browser behaves differently from
the browser the operator uses: rendering, feature flags, and automation signals
all differ. Sites can detect it, degrade it, or block it. The runtime therefore
always drives a **real, headed system Chrome** that the operator **does not
see**. It never uses headless mode for provider turns.

Neither reference repository runs provider turns headless:

- internet runs headed Chrome on an Xvfb virtual display on Linux, and in an
  off-screen window elsewhere;
- codex-chatgpt-web keeps its Electron views drawable but positioned outside the
  window. A truly hidden view collapses to a 0×0 viewport and breaks rendering.

"Genuine" means no disguise. The runtime runs an unmodified system Chrome with
the operator's real locale and time zone, does not override the user agent, does
not spoof fingerprints, and does not solve challenges automatically (CON-3). It
removes *automation leaks*, such as the `--enable-automation` flag and the
webdriver marker, so the browser behaves like the operator's own. It does not
pretend to be a different machine.

## Display modes (`ctx.display`)

| Mode | How | Default on | Use |
|---|---|---|---|
| `virtual` | headed Chrome on a plugin-owned **Xvfb** (`-screen 0 1920x1080x24 -nolisten tcp`, `-displayfd`); window `--window-size=1920,1080` | **Linux** (including servers without a display) | provider turns |
| `offscreen` | headed window at `--window-position=-10000,-10000` with an explicit size (≥ 1280×900) | **macOS, Windows** (v1.0; the MVP is Linux-only) | provider turns |
| `visible` | a normal on-screen window | — | interactive login, debugging, resolving a challenge |
| `headless` | Chrome headless | **never for provider turns** | only the `dev` profile with fake providers |

Rules for invisible modes, so pages render and update as if they were in the
foreground:

- Use an explicit window size and viewport. A window is never minimized or
  hidden, because a hidden view collapses its viewport.
- Enable focus emulation (`Emulation.setFocusEmulationEnabled`) so that
  background windows accept input and focus events. The engine (Playwright and
  patchright on Chromium) enables it on every page; a real-browser test guards it.
- Disable background throttling (`--disable-background-timer-throttling`,
  `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows`).
- Prevent system sleep while turns are active.
- Xvfb is health-monitored. Every prepared display carries a `lost` signal and a
  `generation`. If Xvfb dies, the signal aborts with `session_broken`, every
  browser on it is closed, and in-flight turns go through receipt reconciliation
  (INV-4). The next `prepare` starts a new Xvfb with the next generation; a
  startup failure is not cached, so the next turn retries.
- `invisible` fails closed: when Xvfb cannot start, the turn fails with
  `config_error`. It never falls back to the operator's `DISPLAY` or to headless.

## Browser launch (`ctx.browser`)

- **Engine:** `patchright-core` driving the **system Chrome stable channel**.
  The search order is the configured path, then `CHROME_PATH`, then a system
  Chrome no older than the engine's Chromium, then the **managed** Chrome for
  Testing build pinned in `chrome.lock.json`, which `system init` installs under
  `<DSH_HOME>/system/browsers` ([ADR-0020](../decisions/adr/0020-pinned-managed-chrome.md)).
  When none is usable, the turn fails closed with `config_error`.
- **Flags:** no `--enable-automation`, no `--no-sandbox` for headed runs, and the
  OS keyring is kept, without `--password-store=basic` or `--use-mock-keychain`.
- **No exposed debugging port.** Contexts are owned in-process. If a CDP endpoint
  is ever needed, it is loopback-only, uses a random port, and requires a token
  ([threat model](../security/threat-model.md)).
- **Input:** prompts are inserted with an insert-text method that does not
  trigger editor shortcuts, read back, and compared by hash before sending
  ([provider turns](provider-turns.md#submission)).

## Accounts (`ctx.accounts`): provider-agnostic, multi-account

An **account** is a named identity bound to exactly one provider. The vault is
generic. Everything provider-specific comes from the provider driver
([ADR-0005](../decisions/adr/0005-provider-runtime-interface.md)):

```ts
interface ProviderAccountSupport {          // part of ProviderDriver
  loginUrl: string;
  stateOrigins: string[];                   // origins whose cookies, localStorage, and IndexedDB are captured
  checkAuth(page): Promise<AuthState>;      // signed-in | signed-out (with evidence) | challenge | unknown
  identity(page): Promise<string>;          // stable identity hint; only its hash is stored
}
```

| Concern | Design |
|---|---|
| Catalog | accounts are **configuration**: id, provider, label, roles, quota class, and tier-to-mode map. Any number per provider, for example `chatgpt-main`, `chatgpt-2`, `gemini-main` |
| Portable state | per account: cookies, localStorage, and **IndexedDB** for `stateOrigins` only, in one revisioned record ([`account.v1.json`](../../schemas/account.v1.json)). If IndexedDB is too large to capture, the previous IndexedDB is kept and a warning is recorded |
| Login profile | a per-account native Chrome profile directory, machine-local, used **only** for interactive login and re-auth. Automated turns never use it |
| Storage | vault directory `0700`, records `0600`, atomic write (temp file, fsync, rename), reads reject wrong permissions. Encryption at rest with a key from the OS keyring is an optional provider of the same seam |
| Isolation | one browser process, scheduler, and set of conversation bindings per account. Ports are allocated dynamically, not by index. Two accounts never share a context |
| Distinct identities | at save time, `identity()` is hashed. Accounts whose hashes match are flagged, which REQ-TEAM-4 needs for independent team members |
| Write-back | after each turn, refreshed state is written only if both the account revision and the scheduler lease generation are current ([scheduling](scheduling-and-leases.md)) |
| Re-auth | only **positive** signed-out evidence (a login URL or login surface) sets `reauth-required`. A challenge or an unknown state never does |
| Removal | `system account remove <id>` deletes the record and the login profile after confirmation |

## Login flows

Decision: [ADR-0017](../decisions/adr/0017-credential-login-and-linux-remote-browser.md).
Every account has a **login mode**: `manual` (the default) or `credentials`
(opt-in).

### Interactive login (`manual`, and the fallback for everything)

A **plain Chrome with no automation attached** opens the account's login
profile, so the operator signs in exactly as usual, including SSO popups and 2FA.

| Flow | Platform | How |
|---|---|---|
| **remote** | **Linux (MVP)** | **ported from tsuuanmi/internet**: Chrome on its own Xvfb, `x11vnc -localhost` with a one-time password file, and a token-gated **noVNC** page on 127.0.0.1. The operator runs `ssh -L <port>:127.0.0.1:<port> host` and opens the printed URL. The page has Save, Cancel, and paste-from-host buttons. The session is started on demand, and its token expires after a short TTL |
| **visible** | desktop (v1.0) | Chrome opens on screen with the account's login profile |

### Credential login (`credentials`, opt-in)

A deterministic state machine runs on the **persistent login profile**, so the
device stays recognized. It starts **only after positive sign-out evidence**,
never on a schedule:

```text
probe chatgpt.com ── signed in ──▶ done (most runs end here)
   │ signed out
   ▼
email page ─▶ password page ─▶ branch on what loads (timeout per step):
   ├─ authenticator (TOTP) ──▶ code from code provider ──▶ submit once ──▶ verify
   ├─ other MFA offered first ──▶ "try another method" ──▶ authenticator
   ├─ email code / push ──▶ code provider if one is opted in, otherwise NEEDS_HUMAN
   ├─ passkey upsell ──▶ "not now"
   └─ Turnstile / CAPTCHA / unknown page / error ──▶ NEEDS_HUMAN
NEEDS_HUMAN ──▶ remote browser on the SAME profile + `account.status = reauth-required`
```

- **Steps are matched by URL path and accessible role**, not brittle CSS.
  The language is forced to `en-US`. DOM fixtures cover every page, and drift
  fails closed with `CONFIG_FIX` ([UI operations](ui-operations.md)).
- **Code providers:**
  - `totp-local` computes RFC 6238 locally with `otpauth`. If fewer than 5 seconds
    remain in the window, it waits for the next window. Codes are never reused.
  - `manual`: the operator runs `system account code <id> <code>`, or types the
    code in the remote view.
  - `imap` (later, opt-in) reads the one-time code from the operator's own mailbox.
- **Bounds:** at most 2 submission attempts per login, then `NEEDS_HUMAN`.
  Nothing is retried in a way that could lock the account. Challenges are never
  solved (CON-3).
- **Secrets:** the email, password, and TOTP secret live in an **encrypted
  credential record**. The key comes from the OS keyring, or from a `0600` key
  file on servers. Values are decrypted only in memory and never logged, sent to
  a model, or stored in an artifact. **A TOTP secret is never sent to any website
  or service** (for example 2fa.live), because that would hand over the second
  factor permanently.

### Save (both modes)

1. Close Chrome gracefully and wait for the profile lock to release.
2. Reopen the profile headed in the invisible display.
3. Capture the state for `stateOrigins`, including IndexedDB.
4. Verify it with `checkAuth` in a **fresh** context built from the captured state.
5. Hash `identity()`, then write the record with `revision + 1`.

A failed verification saves nothing.

## Context lifecycle

- **One browser process per account**, closed after `closeAfterMs` idle
  (default 30 minutes).
- **Default: a fresh context per turn**, created from the portable state. The
  turn opens the bound conversation URL, and the context is closed in `finally`.
  This gives isolation and a clean recovery path.
- **Retained page per session**, opt-in per capability. For long sessions and
  Deep Research, one page stays bound to a `SessionId`
  ([sessions](sessions-and-messaging.md)), with a TTL, a cap per account, and
  heartbeat sweeps. Eviction falls back to the fresh-context path.
- **Concurrency:** `maxConcurrentTurnsPerAccount` defaults to 2, and turns in one
  session run strictly in order ([scheduling](scheduling-and-leases.md)).

## Challenges and errors

| Situation | Handling |
|---|---|
| Cloudflare challenge response (`cf-mitigated: challenge`) **outside** an active turn | reload once, then confirm with a 2xx |
| a challenge during a turn, or after the reload | turn fails as `USER_ACTION` (`challenge`). The operator resolves it through the `visible` or `remote` view. Nothing is auto-solved |
| signed out (positive evidence) | `reauth-required`; queued work for the account fails closed (REQ-ACC-5) |
| UI drift (no candidate resolves) | bounded self-heal ([UI operations](ui-operations.md#self-heal)); if it fails, the turn fails closed with `CONFIG_FIX` and a diagnostic bundle, and a health alert is raised |
