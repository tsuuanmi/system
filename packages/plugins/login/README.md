# @tsuuanmi/system-login

**`ctx.login`**: per-account login profiles and the **Save** flow
([browser runtime](../../../docs/design/browser-runtime.md#save-both-modes)).

- **`profileDir(account)`:** `<DSH_HOME>/system/login-profiles/<id>`, owner-only.
  It is used only for interactive login; automated turns never use it.
- **`save(account)`:**
  1. Reopen the login profile headed on the invisible display
     (`ctx.browser.captureProfile`). A profile still held by a live browser is
     refused.
  2. The driver confirms the sign-in and reads its identity hint.
  3. Capture the state for the driver's `stateOrigins`, in memory only.
  4. Verify that state signs in, in a fresh context.
  5. Store it through `ctx.accounts` (encrypted, revision-guarded), with
     `identityHash = sha256(provider, identity)`.

  A failed check saves nothing.
- **MCP tools** (when `ctx.mcp` is mounted): `account_list` (secret-free views)
  and `account_save { account }`. The `system account list|save` CLI commands
  call these tools.
- **Injects:** `accounts`, `browser`, `providers`; `mcp` is optional.
