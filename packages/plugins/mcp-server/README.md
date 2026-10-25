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
- **Built-in tools:** `status`, `roster`, `ask`, `research`, `result` (`client` scope),
  and `events`, `evidence`, `artifact` (`operator` scope):
  - `evidence` and `artifact` read local-private content, which no client scope
    reads (INV-12): a drift outline, and any artifact's header and a bounded
    window of its body
    ([reading](../../../docs/design/artifacts.md#reading)).
  - `events` reads the event log in order (QA-7), optionally for one run,
    session, or type, a page of at most 1000 after `afterSeq`; it returns the
    page and `next`, the cursor for the following one.
  - `status` reports the store, artifacts, kernel seams, registered providers,
    for the operator only `plugins` (each listed plugin of the composition with its rows, whether one
    is on, its manifest's state, version, and class, its recorded lifecycle, and what the manifest
    check found in it with the decision that recorded it, from `ctx.pluginHost` when mounted;
    REQ-HOST-7), and **health**. Unasked, `plugins` holds only the plugins that need a look
    (`needsLook`: the manifest check found something, the manifest was refused, or the recorded
    lifecycle is not the one the composition gives it: `default` mounted, `candidate` with its rows
    off, `retired` named by none), and `pluginsOmitted` counts the rest; `plugins: true` lists every
    one (`system plugins` asks for it). The reply is `mcp-status@1.0`
    ([`mcp-status.v1.json`](../../../schemas/mcp-status.v1.json)), checked before it is sent. Each
    check's detail is bounded where it is made: a list names at most 20 items, each cut to 300
    characters, and counts the rest, and no detail is longer than 8,000 characters (`DETAIL_CHARS`,
    well under the schema's 32,768). A reply its schema still refuses (a provider that broke its
    own bounds, say) is a defect, said in the daemon's log, and is never sent as health; the call
    still gives what health must say: the state and the names of the checks that are not `ok`
    (with `okOmitted`), its text saying the full reply was not valid and why (T127). Only when even
    that is not a valid record is the call an error. Health's `state` is always the
    worst of every check (REQ-HOST-6, `src/health.ts`); unasked, `checks` lists only the checks
    that are not `ok`, and `okOmitted` counts the rest (`compactHealth`), so the reply does not grow
    with each check that is ok; `checks: true` lists every one (`system health` asks for it). The
    report holds each check (plugins of the composition, their manifests, refused workflow templates, runtime, store integrity, free
    disk, vault key custody, accounts to sign in again or signed in as one person
    (`duplicateIdentities`), Worker availability, reviews held for the operator,
    login profiles held for a login, open with their kept tabs, or blocked by a
    process that could not be stopped (`login-profiles`, from `browser`), provider UI drift within
    `driftWindowHours`, usage the resource ledger could not count, notifications that failed) as `ok`,
    `degraded`, or `down`, and the worst of them. Only an operator-scope caller
    sees the details; a client sees each check's name and state. It reads the
    mounted services (`credentials`, `accounts`, `workers`, `eventLog`, `browser`, `resources`, `board`), skips
    those not mounted, and reports a check whose source throws as down. Workers
    count as available only when `ready` or `busy`. `workers` lists the Workers,
    then reads how each Worker source answered its last read (`ctx.workers.sources()`,
    when the router keeps them): it names every source that was silent (no answer
    within the router's 5 s) or failed, with when, and is degraded while one is,
    down when no Worker answered or a source's failure failed the read
    ([sources that do not answer](../../../docs/design/routing.md#sources-that-do-not-answer)).
    A silent source whose first describe has not landed (`describing`, right after a start)
    is named as `describing…`, and the Workers heard are counted `so far`, as the roster
    counts them from the same reads (T99 D8). A vault key beside the vault
    is advice, never degraded (the default must not page). The store integrity
    check is reused for `storeCheckMinutes`.
  - `reviews` (with `ctx.board` mounted) names each board task whose review is held for the
    operator (`operator-review`), the soonest to expire first (five named, the rest counted),
    with when it expires (`expires in 3 h (at …)`), from the projects that are not closed (the
    tasks of at most 64 read, the rest said): advice, always `ok`, as the vault key's is, since an
    unanswered review expires and its task waits for input that nothing revives (T99 D6). A board
    that cannot be read is down.
  - `liveness` (with a router that tells `ctx.workers.liveness()`, PROP-0013) is degraded while a
    run that ended without being known to be gone holds its session and worktree, or while a
    Worker source cannot tell (INV-2), naming the first five runs of each state and counting the
    rest; a stalled run, or one still being looked at, is named under `ok` and needs nothing yet.
    The router is read once per `status`: for the operator, `status` also carries `liveness`, the
    counts in each state and the latest 16 runs (`livenessView`: source, execution, Worker, state,
    since, workflow run), `runsOmitted` counting the rest and `unread` the sources that could not
    tell, only when there is any, and its text line ends with the counts; a client sees the check's
    state alone ([what the operator sees](../../../docs/design/agent-runtimes.md#what-the-operator-sees)).
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
  - `roster` (REQ-HOST-8) is the roster of every Worker
    ([roster](../../../docs/design/roster.md)), read through `readRoster` in
    [`gateway-core`](../../gateway-core/README.md#the-roster) from the mounted
    `workers`, `accounts`, `agentWorkers`, `resources`, `eventLog`, `workflow`,
    and `board`, each one absent or failing read as unknown with why. Its
    structured content is the `mcp-roster@1.6` record, checked before it is
    sent; its text content is the rendering `system roster` prints. A client
    (the lead) gets it without account labels, in its records and in each
    Worker's display name.
  - `notifications` (with `eventLog`) is shown once the [notify](../notify/README.md) plugin
    recorded a `notify.delivery` within `driftWindowHours`, and is degraded while a sink's latest
    outcome there is `failed` or `unavailable` (naming the sink, why, and how many failed), or a
    notice was dropped from a full queue; else `ok` with how many were sent. It reads the entries a
    page at a time, at most 10,000, and past them it is degraded. It reads the events, never the
    plugin ([notifications](../../../docs/design/notifications.md#health)).
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
  `ctx.get('eventLog')`, `ctx.get('pluginHost')`, and `ctx.get('resources')` optionally, and for the
  roster `ctx.get('agentWorkers')`, `ctx.get('workflow')`, and `ctx.get('board')` (which health's
  `reviews` check reads too).

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
| `client` | `client.token` | the client tools on `/mcp`: `ask`, `research`, `brainstorm`, `review`, `vote`, `run`, `result`, `status`, `roster`, `explain`, `usage`, `session_send`, `session_inbox`, `resources_pools`, `resources_usage`, the `board_*` tools except `board_pause`, `board_resume`, and `board_close`, and `approvals_list`, `approvals_get`, `approvals_policy` | `system mcp-headers` (an HTTP client's headers, such as Claude Code's `headersHelper`), `system mcp-stdio` (a stdio client, such as Codex) |
| `model` | `model.token` | `/anthropic` and `/openai` only; `/mcp` and `/ui` answer `401` | `system claude-env`, `system codex-env`, `system mcp-token --scope model` (a Codex Worker on the Responses gateway); each refuses while its gateway row is off ([runbook](../../../docs/operations/runbooks.md#turn-an-off-row-back-on)) |

- **Tool scope:** a tool declares `scope: 'client' | 'operator'` in its
  `ToolSpec`. A tool that declares none is the operator's (fail closed), so
  `approve`, `approvals_decide`, `approvals_policy_propose`, `board_pause`, `board_resume`, `board_close`, `stop`, `continue`, `delete`, `supersede`, `drain`, `resume`,
  `events`, `artifact`, `evidence`, `conversation_list`, `conversation_inspect`, `model_key`, and
  every `account_*` tool, `account_probe` included, are operator-only.
- **Listing:** `tools/list` returns only the tools the caller's scope may use.
  The operator sees every tool, and a tool only the operator may call carries
  `_meta: { "system/scope": "operator" }`; a tool without it is a client tool
  too, so a client's list carries no `_meta` ([token budget](#token-budget)).
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

## Token budget

Every MCP client pays for `tools/list` (each tool's name, description, input schema, and
`_meta`) once per session, and for every reply it reads, so the surface is bounded like any
other payload (QA-12, INV-9).

- **What is measured:** the bytes of the JSON-RPC response as this endpoint sends it (compact
  JSON, UTF-8). Tokens are estimated as `ceil(bytes / 4)`. A client's tokenizer differs by some
  tens of percent, so the bytes are what is bounded.
- **Where:** [`cli/tests/surface.e2e.ts`](../../cli/tests/surface.e2e.ts) boots the shipped
  profile through `dsh` and measures `tools/list` for the `operator` token and for the `client`
  token (the lead's), every tool's entry, and the replies of `status` in both scopes, of
  `result` for a failed `ask`, and of `usage` with that run. A Worker holds at most the `model`
  token, which `/mcp` refuses, so it pays for no list.
  [`workflow/tests/replies.spec.ts`](../workflow/tests/replies.spec.ts) measures `result` and
  `usage` on fixture runs that completed.
- **Replies:** a tool answers once. The answer is the result's `structuredContent`; its text
  block is a short summary (`reply` and `outline` in
  [`gateway-core`](../../gateway-core/README.md#replies)), never the same JSON again. A completed
  run's text is its answer, any other run's a line on where it stands (what it waits for, why it
  failed, how many steps are done). An error has no structured content: its text is the error.
  The MCP clients in use hand a model the structured content when a result carries it (Claude
  Code and Codex do, whether or not the tool declares an `outputSchema`; none here does), so a
  client loses nothing. The MCP specification asks, for clients without structured content, that
  the text also carry the JSON (a SHOULD): such a client sees the summary only, and reads the
  answer with `system` or a client that reads `structuredContent`.
- **Listing:** `tools/list` is this endpoint's own (`listing`): each tool's name, description,
  and input schema, converted from the same zod schema the SDK validates each call with. It
  leaves out what tells a client nothing: `$schema` (the schema is JSON Schema 2020-12, which MCP
  reads a schema without `$schema` as), the SDK's `execution: {taskSupport: "forbidden"}` (absent
  means the same), the 300-character `pattern` zod adds beside `format: "date-time"`, the
  safe-integer bounds (±(2^53 − 1)) zod gives an integer that sets no bound of its own (the server
  checks both with zod, as strictly as before), and the scope `_meta` of a client tool
  ([scopes](#scopes)).
- **Descriptions:** a tool's description says what it does and what a caller must know to call
  it, once: what a parameter's own description says is not repeated in the tool's, and the
  scope is the listing's `_meta`, never a word in the text. Every fact a client needs stays; the
  canonical docs keep the rationale and the references.
- **Bounded reads:** `status` lists only the checks that are not ok and the plugins that need a
  look unless asked; `usage`
  lists 10 runs unless asked for up to 500, each run with its steps' Workers, tiers, quota
  classes, and tokens only (its answer, ids, and errors are in `result`).
- **Ceilings:** in one place, [`tests/budget.ts`](tests/budget.ts), each beside the size it was
  set from, with about 10 % headroom. A test fails when a measure is over its ceiling, and the
  surface test then prints every tool's size. Raising a ceiling is a reviewed change that says
  what grew and why it is worth every session's tokens. A change that shrinks the surface lowers
  the ceiling with it, to the new size plus 10 % where that is lower; a trim never raises one.
