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
- **`capture(turn, { origins, previous })`:** cookies, localStorage, and IndexedDB
  for the driver's origins only. IndexedDB over the size cap keeps `previous`.
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
