# @tsuuanmi/system-display-virtual

The Linux provider of **`ctx.display`**
([browser runtime](../../../docs/design/browser-runtime.md#display-modes-ctxdisplay)).
The seam itself, the abstract `Display`, lives in `@tsuuanmi/system-provider-core`.

- **`prepare('invisible')`:** headed browsers draw on one plugin-owned **Xvfb**
  (`-displayfd`, `1920x1080x24`, `-nolisten tcp`), started on first use and shared.
  The result gives `env` (`DISPLAY`), window flags, the viewport, a `generation`,
  and a `lost` signal.
- **X access control:** Xvfb runs with `-auth` over a fresh owner-only
  Xauthority cookie (`XAUTHORITY` in `env`), so other local users cannot connect.
  The cookie file is removed when Xvfb exits.
- **Hidden from agents:** the cookie's directory is a registered secret path
  while the display runs: with it, a process could screenshot and drive the
  accounts' browsers ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md)).
- **Health:** when Xvfb exits, `lost` aborts with `session_broken`, and the next
  `prepare` starts a new generation. A startup failure is not cached.
- **Fails closed:** no headless mode and no fallback to the operator's `DISPLAY`
  (`config_error` with an install hint). Linux only.
- **`prepare('visible')`:** the operator's own `DISPLAY` (provided by the seam).
- **`startXvfb`:** exported for remote login, which needs its own private Xvfb.
- **Config:** `xvfbPath`, `startupTimeoutMs`, `shutdownTimeoutMs`.
- **Ported from:** tsuuanmi/internet `src/browser/display.ts`.
