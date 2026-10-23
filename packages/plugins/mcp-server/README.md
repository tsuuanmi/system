# @tsuuanmi/system-mcp-server

An MCP Streamable HTTP endpoint inside the `system` profile, on DSH
`ctx.webServer`, published as **`ctx.mcp`**. It serves any MCP client, such as
Claude Code and Codex, and the `system` CLI. It is the primary client interface
([ADR-0011](../../../docs/decisions/adr/0011-mvp-integration-via-mcp.md)).

- **Security:** the request guard every client endpoint shares
  ([`gateway-core`](../../gateway-core/README.md#the-request-guard)):
  - Host allow-list: `421` otherwise, which blocks DNS rebinding.
  - No browser origins: `403`, and no CORS.
  - The operator or client token compared in constant time over SHA-256
    digests: `401` otherwise, the model token included
    ([scopes](#scopes)).
  - Plain HTTP on a non-loopback host is refused (`assertSafeBind`).
  - 1 MiB body limit (`maxBodyBytes`).
- **Discovery:** writes `{url, tokenFiles: {operator, client, model}, pid}` to a
  `0600` file (default `<DSH_HOME>/system/mcp.json`) and removes it on unload.
  This pattern comes from dsh-codex-bridge.
- **Tools contributed by plugins:** `ctx.mcp.tool(name, { description,
  inputSchema, scope }, handler)` registers a tool for the calling plugin's
  lifetime, so unloading the plugin removes it. A name is unique, except that a
  built-in placeholder may be replaced. For example, `login` contributes
  `account_list` and `account_save`.
- **Built-in tools:** `status`, `ask`, `research`, `result` (`client` scope),
  and `events`, `evidence`, `artifact` (`operator` scope):
  - `evidence` and `artifact` read local-private content, which no client scope
    reads (INV-12): a drift outline, and any artifact's header and a bounded
    window of its body
    ([reading](../../../docs/design/artifacts.md#reading)).
  - `events` reads the event log in order (QA-7), optionally for one run,
    session, or type, a page of at most 1000 after `afterSeq`; it returns the
    page and `next`, the cursor for the following one.
  - `status` reports the store, artifacts, kernel seams, registered providers,
    for the operator only `plugins` (every plugin of the composition with its rows, whether one
    is on, its manifest's state, version, and class, its recorded lifecycle, and what the manifest
    check found in it with the decision that recorded it, from `ctx.pluginHost` when mounted;
    REQ-HOST-7), and **health** (REQ-HOST-6, `src/health.ts`):
    each check (plugins of the composition, their manifests, refused workflow templates, runtime, store integrity, free
    disk, vault key custody, accounts to sign in again or signed in as one person
    (`duplicateIdentities`), Worker availability,
    login profiles held for a login, open with their kept tabs, or blocked by a
    process that could not be stopped (`login-profiles`, from `browser`), provider UI drift within
    `driftWindowHours`, usage the resource ledger could not count) as `ok`,
    `degraded`, or `down`, and the worst of them. Only an operator-scope caller
    sees the details; a client sees each check's name and state. It reads the
    mounted services (`credentials`, `accounts`, `workers`, `eventLog`, `browser`, `resources`), skips
    those not mounted, and reports a check whose source throws as down. Workers
    count as available only when `ready` or `busy`. `workers` lists the Workers,
    then reads how each Worker source answered its last read (`ctx.workers.sources()`,
    when the router keeps them): it names every source that was silent (no answer
    within the router's 5 s) or failed, with when, and is degraded while one is,
    down when no Worker answered or a source's failure failed the read
    ([sources that do not answer](../../../docs/design/routing.md#sources-that-do-not-answer)).
    A vault key beside the vault
    is advice, never degraded (the default must not page). The store integrity
    check is reused for `storeCheckMinutes`.
  - `plugins` is down when a plugin failed to activate (with its error) or is
    still pending on a required service no plugin supplies, read from the
    Cordis registry's own fiber states. Only named plugins count: an anonymous
    `ctx.inject` callback inside a running plugin (DSH waiting for a `settings`
    service this composition never supplies) is not a plugin of the composition. `manifests` is
    down while the plugin host's manifest check found something in a plugin a row mounts (no
    manifest it allows, or a consumed seam its providers do not satisfy), naming each finding:
    the host cannot keep that row from running (ADR-0048). It is degraded when the host refused
    the manifest of a row that is off, and notes the packages that run with none as the host's
    configuration allows. `templates` is degraded when the
    workflow engine refused a configured template at load (with why); every
    other template still works.
  - `usage` (with `resources` and `eventLog`) is degraded while a configured pool has a run whose
    usage the ledger could not count (a valid `usage.unknown` entry,
    [resources](../../../docs/design/resources.md#usage-the-ledger-cannot-count)) in its current
    window that the ledger has not counted a record of since (`resources.usage` by run and pool),
    naming each pool, its count, and the kinds: each run once, by its first entry; an entry that is
    not a valid `usage-unknown@1.0` record, or that names a pool the ledger does not configure (an
    `unconfigured pool` line), is counted and said, never skipped. A pool's current
    window is its longest one, back from now; a pool with a window of no length (a credit
    balance) reads every entry the log keeps. It reads the entries a page at a time, at most
    10,000, and past them it is degraded, saying so, never `ok`. A cap still counts such a run as
    0 (D25).
- **`GET /healthz`:** liveness for a supervisor, with no token and no data
  (`ok`).
  - `ask`, `research`, and `result` are placeholders. When `ctx.workflow` is
    mounted (it is in the `system` bundle), the engine's tools replace them.
    Otherwise they return an explicit "not installed" error and never pretend to
    work.
- **Config:** `path`, `tokenDir`, `discoveryFile`, `allowedHosts`,
  `maxBodyBytes`, `minFreeBytes` (default 1 GiB), `driftWindowHours`
  (default 24), `storeCheckMinutes` (default 15).
- **Injects:** `webServer`. It uses `ctx.get('artifacts')`, `ctx.get('store')`,
  `ctx.get('providers')`, `ctx.get('accounts')`, `ctx.get('workers')`,
  `ctx.get('eventLog')`, `ctx.get('pluginHost')`, and `ctx.get('resources')` optionally.

## Scopes

Every client endpoint authorizes by the token it is shown
([ADR-0023](../../../docs/decisions/adr/0023-scoped-control-credentials.md)).
Each scope has an owner-only token file under `tokenDir` (default
`<DSH_HOME>/system`) holding 32 random bytes, used as base64url
(`scopeTokens` and `tokenFile` in
[`gateway-core`](../../gateway-core/README.md#the-request-guard)). This
endpoint creates all three at start, so the CLI and its helpers find them, and
it refuses to start if two files hold the same token (a copied file would hand
one scope another's rights).

| Scope | Token file | Reaches | Handed out by |
|---|---|---|---|
| `operator` | `operator.token` | every MCP tool, and `/ui` | the `system` CLI's own tool calls, `system ui` |
| `client` | `client.token` | the client tools on `/mcp`: `ask`, `research`, `brainstorm`, `review`, `vote`, `run`, `result`, `status`, `explain`, `usage`, `session_send`, `session_inbox`, `resources_pools`, `resources_usage`, the `board_*` tools except `board_pause`, `board_resume`, and `board_close`, and `approvals_list`, `approvals_get`, `approvals_policy` | `system mcp-headers` (an HTTP client's headers, such as Claude Code's `headersHelper`), `system mcp-stdio` (a stdio client, such as Codex) |
| `model` | `model.token` | `/anthropic` and `/openai` only; `/mcp` and `/ui` answer `401` | `system claude-env`, `system codex-env`, `system mcp-token --scope model` (a Codex Worker on the Responses gateway); each refuses while its gateway row is off ([runbook](../../../docs/operations/runbooks.md#turn-an-off-row-back-on)) |

- **Tool scope:** a tool declares `scope: 'client' | 'operator'` in its
  `ToolSpec`. A tool that declares none is the operator's (fail closed), so
  `approve`, `approvals_decide`, `approvals_policy_propose`, `board_pause`, `board_resume`, `board_close`, `stop`, `continue`, `delete`, `supersede`, `drain`, `resume`,
  `events`, `artifact`, `evidence`, `conversation_list`, `conversation_inspect`, `model_key`, and
  every `account_*` tool, `account_probe` included, are operator-only.
- **Listing:** `tools/list` returns only the tools the caller's scope may use,
  each with `_meta: { "system/scope": … }`. The operator sees every tool.
- **Handlers** are told the caller's scope (`ToolContext`), so what a tool
  records can name who acted.
- **Calls:** a `tools/call` of a registered tool outside the caller's scope,
  also inside a JSON-RPC batch, is refused before the MCP server runs: `403`,
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="operator"`, and
  the JSON body `{ "error": "insufficient_scope", "error_description": … }`.
- **Hidden from agents:** the three token files are registered secret paths
  while the endpoint runs, wherever `tokenDir` puts them
  ([ADR-0024](../../../docs/decisions/adr/0024-agent-workers-confined-for-reads.md));
  web-ui and the gateways register the token they read.
- **Rotation:** delete the scope's token file and restart
  ([runbook](../../../docs/operations/runbooks.md#rotate-a-control-token)).
