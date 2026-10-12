# ADR-0020: A pinned, managed Chrome when the host has no recent Chrome

- **Status:** Accepted
- **Date:** 2026-10-11
- **Amends:** [ADR-0016](0016-invisible-headed-browser-and-portable-accounts.md)
  (where the headed Chrome comes from)
- **Related:** [browser runtime](../../design/browser-runtime.md#browser-launch-ctxbrowser),
  [dependency register](../../engineering/dependencies.md)

## Context

ADR-0016 runs provider turns in a headed **system** Chrome. In practice, hosts
often have no Chrome or an old one: the first Linux test host had Chrome 95 from
2021, which patchright-core 1.63 (Chromium 153) cannot drive, and updating it
needs root. The maintainer asked for the browser to be part of the repository or
downloaded during setup. A Chrome binary is about 150 MB per platform, so it does
not belong in git.

## Decision

- The repository **pins** one Chrome for Testing stable build in
  `packages/plugins/browser-patchright/chrome.lock.json`. The pin is at least as
  new as the engine's Chromium; a test enforces that.
- `system init` keeps a usable Chrome. When none is found, it downloads the pinned
  build with `@puppeteer/browsers` (Google, Apache-2.0) into
  `<DSH_HOME>/system/browsers`, without root. `system browser install` does the
  same on demand. Xvfb stays a system package; `init` reports when it is missing.
- **Search order:** the configured `chromePath`, then `CHROME_PATH`, then a
  system Chrome **no older than the engine's Chromium**, then the managed build.
  A real, auto-updating system Chrome stays preferred. An older system Chrome is
  skipped, not launched.
- The managed build is unmodified Chrome for Testing. The no-spoofing rules of
  ADR-0016 apply unchanged.

## Consequences

- Setup works on hosts without root and with an outdated Chrome.
- The managed build does not auto-update. Bumping the pin is a one-line PR, and a
  stale pin is visible in review.
- Chrome for Testing is not the branded stable channel; for example, it has no
  Widevine. It is used only when no recent system Chrome exists.
