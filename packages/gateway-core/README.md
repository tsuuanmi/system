# @tsuuanmi/system-gateway-core

Gateway **seam definitions**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2),
the **request guard** every client endpoint shares, and the **roster** every surface serves.

| Seam | Definition | Provider |
|---|---|---|
| `ctx.mcp` | abstract `McpTools` with `tool(name, spec, handler)`, plus `ToolSpec` (with its `scope`), `ToolScope`, `ToolHandler`, and `ToolContext` (the caller's scope), and `reply` and `outline` for a handler's answer ([replies](#replies)) | `@tsuuanmi/system-mcp-server` |

Plugins that contribute tools depend on this package only, so the
provider-runtime layer never imports the gateway's implementation.
The tools each plugin contributes and their contracts are in
[MCP tools](../../docs/reference/mcp-tools.md).

Each tool declares the scope that may call it; one that declares none is
operator-only ([scopes](../plugins/mcp-server/README.md#scopes)). The client-protocol
gateways are plain plugins and use no seam; they share the
[`gateway-turns`](../gateway-turns/README.md) library. The
conformance suite is [`conformance/mcp-tools.ts`](conformance/mcp-tools.ts): a
tool lives for its plugin's lifetime, and a tool that declares no scope is
listed to the operator only.

## Replies

`reply.ts` holds how a tool answers, once (QA-12; the rule is in the mcp-server
[token budget](../plugins/mcp-server/README.md#token-budget)):

- **`reply(structured, summary)`**: the result whose `structuredContent` is the
  answer and whose one text block is `summary`, a short line for a person, a log,
  or a client that shows text only. Never the same JSON again.
- **`outline(value)`**: a summary for a tool with none of its own: each top-level
  field, a scalar as it is (a string over 60 characters cut), a list by its
  length, an object by its own fields one level down; at most 300 characters.

Tests: `tests/reply.spec.ts`.

## The request guard

`guard.ts` holds the one set of transport checks for every client endpoint: the
MCP endpoint, both protocol gateways (through
[`gateway-turns`](../gateway-turns/README.md)), and the web UI
([threat model](../../docs/security/threat-model.md)).

- **`guardRequest(req, options)`**, in order:
  - a `Host` on the allow-list (default `LOOPBACK_HOSTS`: `127.0.0.1`,
    `localhost`, `[::1]`), or `421`, against DNS rebinding;
  - no browser `Origin`, or `403`, so no CORS. Only `sameOrigin` (the web UI,
    which serves its own page) accepts the endpoint's own origin;
  - the bearer token compared in constant time over SHA-256 digests with every
    token the endpoint accepts (`tokens`, keyed by scope), or `401`. All of
    them are compared, so the time taken does not tell which one matched. The
    result names the matched token's scope (`{ ok: true, scope }`).
    `x-api-key` is accepted only with `apiKeyHeader` (Anthropic clients). An
    empty token never matches.
- **`scopeTokens(dir)`** (one scope's: `scopeToken(dir, scope)`) reads every scope's token, creating a missing one (32
  random bytes, owner-only), as base64url; **`tokenFile(dir, scope)`** is its
  path, `<dir>/<scope>.token`. The scopes are `SCOPES`
  ([ADR-0023](../../docs/decisions/adr/0023-scoped-control-credentials.md),
  [scopes](../plugins/mcp-server/README.md#scopes)).
- **`assertSafeBind(bound)`** throws on plain HTTP on a non-loopback host, so
  the token never travels in clear text over a network. Every endpoint calls it
  before it registers its route.
- **`endpointUrl(bound, path)`** builds the URL from the bound protocol, host
  (IPv6 bracketed), and port.
- **`readJsonBody(req, maxBytes)`** reads a bounded JSON body: empty is
  `undefined`, invalid is `400`, too large is `413`.

Tests: `tests/guard.spec.ts`.

## The roster

`roster.ts` holds the one read model of every Worker
([roster](../../docs/design/roster.md), REQ-HOST-8), which MCP `roster` (in
[`mcp-server`](../plugins/mcp-server/README.md)), `system roster`, and the
[web UI](../plugins/web-ui/README.md)'s Workers tab serve:

- **`readRoster(services, { scope, now? })`** reads each service it is given
  once, bounded (`ROSTER_BOUNDS`): the Worker registry (`list`, `sources`,
  `siblings`), the agent accounts (`agentAccounts.list`, `workersIn`, and,
  when it has them, `labelOf`, `unreadReport` for why a window of the
  account has no reading yet, and `providers` for the runtimes' titles), the
  website accounts (`list`, `duplicateIdentities`), the resource ledger
  (`pools`, `usage`), the event log (`usage.unknown`, counted by
  `countUnknownUsage` in [`libs`](../libs/README.md); each listed step's
  `workflow.node.started`, `NODE_STARTED`), the workflow engine
  (`usage`), and the board (`task`). A service not given, or whose read
  throws, makes only its own fields `{ unknown: why }`. With a router that tells
  liveness (`workers.liveness`, PROP-0013) it is read once, and each Worker with
  a run stalled, looked at, or held for want of a verdict gets `liveness`, each
  run in one sentence (`unknown` on every Worker without one listed when a
  source could not tell). With an engine that tells its `teams.excludeWorkers`
  (`workflow.teamExclusion`, D58) it is read once, and each Worker it leaves out
  gets `teams`, in one sentence (`unknown` on every Worker when it could not
  tell). It then makes `now`, capacity now (below), reading the board's ready
  tasks (`projects`, `tasks`) and their templates' steps (`workflow.templateSteps`)
  when it has them. The record is checked against `mcp-roster@1.7`
  before it is returned; one its schema refuses throws (a defect).
- **`readCapacity(services, { scope, now? })`**: the roster's `now`, capacity now
  ([capacity now](../../docs/design/roster.md#capacity-now), `capacity.ts`):
  each account's windows and whether it takes new work now; the free Workers,
  the one whose quota would be lost unused soonest first (`urgency`); those
  whose quota cannot be read, never counted free (`quotaUnknown`); the stalled
  runs; the accounts with no quota left; the Workers that cannot work; and the
  ready tasks with the Worker a start would most likely go to (`canTakeStep`,
  the start preview's own test). Each list at most 16 (`CAPACITY_BOUNDS`).
  `projectCapacity` is its pure projection, `formatCapacity` its *Right now*
  block for a terminal, the last of `formatRoster`'s.
- **`projectRoster(input, { scope, now })`** is the pure projection of what was
  read: Workers in id order, each with its description (or `unknown`), a
  `derived` line, and its display `name` (`<runtime> · <account> · <role or
  tier> [<kinds>]`, [display names](../../docs/design/roster.md#display-names)),
  its account and the account's record, role, availability (`ready`, `busy` N of M, `resting` until its reset,
  `unavailable` with why, `quarantined` with what its reading found), load, limits, siblings, current
  work (each step with `since` and its one-sentence `summary`, `spanText` for
  how long), and pools with their windows. The same input and time give the same
  record. A `client` scope gets no account label, in the record or in a name.
- **`formatRoster(roster)`**: the record for a terminal, one block per Worker,
  then the sources that did not answer and the usage entries no pool counts. A
  silent source still describing for the first time (`describing`, `@1.5`) makes
  the count read `so far` and is named `describing…`, so a first probe after a
  start never reads as every Worker.

The services are typed by shape (`RosterServices`), so this package still
depends on `system-libs` alone; each surface passes the services it has
mounted, and its manifest names them. Tests: `tests/roster.spec.ts`,
`tests/capacity.spec.ts`.

## Dependency direction

Depends on `system-libs` only, for the secret-file rules. The MCP SDK, Cordis,
and zod are peer dependencies.
