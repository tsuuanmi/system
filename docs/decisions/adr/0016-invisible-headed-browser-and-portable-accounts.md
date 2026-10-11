# ADR-0016: Invisible headed browser and portable multi-account vault

- **Status:** Accepted
- **Date:** 2026-10-11
- **Related:** ADR-0005, CON-3, CON-5, [browser runtime](../../design/browser-runtime.md)

## Context

The maintainer requires three things:

1. The browser is **invisible but not headless**, because websites can detect
   headless browsers. The approach should learn from internet and
   codex-chatgpt-web.
2. Accounts are **saved**.
3. The design stays **provider-agnostic** and supports **multiple accounts**.

What the two repositories do:

- **internet:** patchright with system Chrome, headed on an Xvfb virtual display
  on Linux and in an off-screen window elsewhere. Portable `storageState`
  (including IndexedDB) per account, with revision guards and `0600` files. A
  native login profile used only for noVNC remote login. One browser process
  per account, a fresh context per turn, and a fixed account list.
- **codex-chatgpt-web:** an Electron window with `show:false`. Views stay
  "visible" but positioned outside the content area, because a hidden view
  collapses to 0×0. It uses focus emulation and disables background throttling.
  A single persistent partition (one account) and an embedded login view.

## Options

1. Headless Chrome with stealth patches.
2. An Electron-embedded browser (codex-chatgpt-web style).
3. **Headed system Chrome kept invisible:** Xvfb on Linux, off-screen elsewhere.
   Portable per-account state, a separate login profile, and a provider-agnostic
   vault.

## Decision

Option 3, specified in [browser runtime](../../design/browser-runtime.md).

- Headless mode is never used for provider turns.
- Invisible modes keep a real viewport, focus emulation, and no background
  throttling, which are the rendering lessons from codex-chatgpt-web.
- The account vault is generic. Provider specifics come from the driver
  (`loginUrl`, `stateOrigins`, `checkAuth`, `identity`), and the account
  catalog is configuration with any number of accounts per provider.
- The browser is genuine, not disguised. It runs the real user agent, locale, and
  time zone with no fingerprint spoofing and no automatic challenge solving.
  Automation leaks are removed.

## Consequences

- Linux servers run without a physical display. macOS and Windows windows stay
  off-screen, but may still appear in the Dock or taskbar.
- Adding a provider means implementing `ProviderAccountSupport`. Adding an
  account means editing configuration and signing in.
- Option 2 was rejected because Electron sends an `Electron/…` user agent,
  supports only one partition, and adds a desktop app dependency. Option 1 was
  rejected because it is the most detectable and the least faithful rendering.
- Xvfb, x11vnc, and noVNC are taken from system packages, not vendored
  ([dependency register](../../engineering/dependencies.md)).
