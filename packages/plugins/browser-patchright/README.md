# @tsuuanmi/system-browser-patchright

**`ctx.browser`**: the provider runtime's browser
([browser runtime](../../../docs/design/browser-runtime.md#browser-launch-ctxbrowser)).

- **One headed system Chrome per account**, launched with `patchright-core` on the
  invisible `ctx.display`. It is never headless, adds no fingerprint spoofing, keeps
  the sandbox and the OS keyring, and exposes no debugging port (pipe transport).
  Background-throttling flags are off.
- **`openTurn(account, { state, signal })`:** a fresh, isolated context and page
  built from the account's `PortableState`. Aborting `signal` closes the context.
  An abort while the browser is still launching (display, Chrome, a new context)
  rejects at once. The turn never waits for a stalled launch: a browser that
  arrives late stays pooled and is closed when idle, and a late context is
  closed. Under heavy load on 2026-10-12, a stalled launch made a runtime stop
  hang.
- **`openTurn(account, { profile: { dir, gapMs }, signal })`: a session-bound
  account** ([ADR-0030](../../../docs/decisions/adr/0030-session-bound-accounts-use-their-login-profile.md);
  `src/profiles.ts`).
  - The turn is a page of one persistent context on the account's login profile,
    headed on the invisible display, with session restore, so the profile's
    session-only cookies survive. The restored tabs are blanked at once. After the
    first cycle, the last session holds no site tab.
  - The context opens lazily. Launches, standalone Saves, and a reservation's
    close-and-free run one at a time per account.
  - Closing the turn closes only its page. The context closes after `closeAfterMs`
    with no open page, or when the display is lost.
  - Page opens are spaced at least `gapMs` apart. Navigations within a page are
    not spaced.
- **Who holds a profile.** On Linux, a profile is in use while a process on this
  host has `--user-data-dir=<dir>` in its command line (read from `/proc`). A
  lock file alone proves nothing: its pid may be reused, or it may name another
  host. Elsewhere, the lock's live local pid is all there is, so a held profile is
  refused and never stopped.
- **Only what system started is ever stopped.** Every browser `system` starts on
  a profile carries `OWNED_PROFILE_SWITCH` (`--system-owned-profile`): the
  automation's launches here, and the remote login's browser. Exactly those pids
  are signalled; a process that appears meanwhile never is. Any other process
  on a profile, such as a browser the operator opened, blocks the account with
  `overloaded` until it closes, and `profileStates` shows it (health
  `login-profiles`). A blocked entry clears once its process is gone.
- **Closing waits for the browser.** A closed context's Chrome must exit, so the
  next open, a Save, or the operator's login never meets it. One still running
  after 10 s is stopped (SIGTERM, then SIGKILL).
- **A browser system left in a crash** on a profile the pool does not hold
  (automation or login) is stopped when the account next opens the profile, or
  when the operator reserves it (event `browser.profile-orphan`). A page that a
  held context does not open within 30 s fails as `session_broken`.
- **`reserveProfile(account, dir)`:** for the operator's remote login. It is
  refused (`overloaded`) while profile pages are open. Otherwise it closes the
  context and returns only after that browser has exited. Profile turns then fail
  as `overloaded` until every reservation is released; each release ends one.
- **`profileStates()`:** the profiles open for work, reserved, or blocked (for
  health).
- **`capture(turn, { origins, previous })`:** cookies, localStorage, and IndexedDB
  for the driver's origins only. IndexedDB over the size cap keeps `previous`.
- **`captureProfile(account, dir, …)`** (the Save flow) uses a profile the pool
  already holds open (or is opening) in place, in a page of its own. Otherwise it
  launches the profile (with session restore) and closes it afterwards. It waits
  up to 10 s for the operator's browser to exit and never stops it.
- **Lifecycle:**
  - one launch at a time per account;
  - the browser closes after `closeAfterMs` with no open turn;
  - it also closes when the display is lost;
  - a late `disconnected` from an older process never drops its replacement.
- **Chrome:** `chromePath`, then `CHROME_PATH`, then a system Chrome no older than
  the engine's Chromium, then the managed build pinned in `chrome.lock.json`
  (`installManagedChrome`, used by `system init`;
  [ADR-0020](../../../docs/decisions/adr/0020-pinned-managed-chrome.md)). A
  missing or unlaunchable Chrome is a `config_error`.
- **Injects:** `display`. **Config:** `chromePath`, `closeAfterMs`, `maxIndexedDbBytes`.
- **Ported from:** tsuuanmi/internet `src/browser/runtime.ts` and `chrome.ts`. The
  origin filter and launch patterns come from `@anweat/dsh-browser`
  ([review](../../../docs/research/dsh-community-plugins-review.md#browser-runtime-second-pass-2026-10-11)).
