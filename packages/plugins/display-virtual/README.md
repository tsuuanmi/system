# @tsuuanmi/system-display-virtual

The Linux provider of **`ctx.display`**
([browser runtime](../../../docs/design/browser-runtime.md#display-modes-ctxdisplay)).
The seam itself, the abstract `Display`, lives in `@tsuuanmi/system-provider-core`.

- **`prepare('invisible')`:** headed browsers draw on one plugin-owned **Xvfb**
  (`-displayfd`, `1920x1080x24`, `-nolisten tcp`), started on first use and shared.
  The result gives `env` (`DISPLAY`), window flags, the viewport, a `generation`,
  and a `lost` signal.
- **Health:** when Xvfb exits, `lost` aborts with `session_broken`, and the next
  `prepare` starts a new generation. A startup failure is not cached.
- **Fails closed:** no headless mode and no fallback to the operator's `DISPLAY`
  (`config_error` with an install hint). Linux only.
- **`prepare('visible')`:** the operator's own `DISPLAY` (provided by the seam).
- **`startXvfb`:** exported for remote login, which needs its own private Xvfb.
- **Config:** `xvfbPath`, `startupTimeoutMs`, `shutdownTimeoutMs`.
- **Ported from:** tsuuanmi/internet `src/browser/display.ts`.
