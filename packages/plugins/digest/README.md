# @tsuuanmi/system-digest

The store-backed provider of **`ctx.digests`**
([digests](../../../docs/design/digests.md); definition
[`digest-core`](../../digest-core/README.md)): a cited `digest@1.0` of raw artifacts, written by a
read-only Worker and quote-checked. A capability plugin of the digest family
([ADR-0036](../../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)): it
depends on seam definitions only, and fails open.

- **On request** (`request`, MCP `digests_request`): 1 to 64 stored artifacts; durable at once,
  idempotent by `key` (`clientRequestId`), at most `maxPending` pending (default 4). Nothing
  digests on its own.
- **Its Worker** is whatever `ctx.workers` admits for the capabilities `review` and `local-data`
  on the configured `tier` as minimum and maximum (default `economy`): a read-only agent Worker on
  this machine (a Claude Code Worker in Base). No Worker is named in code (INV-11).
- **Its brief** (`brief@1.1`, an `objective` artifact) is recorded before the run: the sources by
  content id, never their content, the instructions, and the `digest@1.0` schema. The Worker's
  source renders it, each source between `<artifact id="…">` tags, and checks egress on what it
  rendered (INV-12). The brief, the start, and the execution's id on the request commit together.
- **The quote check** (`quoteCheck` of `digest-core`) keeps the claims whose quotes are verbatim
  in the source they cite, drops and records the rest, and keeps at most `maxClaims` (default 20).
- **Settled once**, in one transaction under the request's lease: the digest (a `report` whose
  envelope inputs are its sources, as strict as the strictest), the `acceptance` decision
  (`digests.quote-check`) that names it, and the event `digests.settled` (with `ctx.eventLog`).
- **Fails open:** no Worker admitted (its `admission` decision is named), a start refused, a
  failed run, an execution gone, or a run past `timeoutMinutes` (default 30; the run is
  cancelled) settles the request `bypassed`, recorded with why; nothing waits on it.
- **Restart:** each pending request goes on where it stood: routed again if nothing started, or
  waiting for the execution it named; a run is never started twice (INV-4).
- **MCP tools** (client scope): `digests_request` and `digests_get`, each input and output
  validated against [`mcp-digests.v1.json`](../../../schemas/mcp-digests.v1.json); both may wait up
  to 55 s for the request to settle.
- **Bundle row:** on. With no read-only Worker on its tier (the agent rows off), every request
  settles `bypassed`, recorded, which is safe.
- **Injects:** `store`, `artifacts`, `leases`, `workers`; reads `eventLog` when present; `mcp`
  is optional.
- **Tests:** the seam's conformance suite over this provider, real routing, and a scripted Worker
  ([`tests/conformance.spec.ts`](tests/conformance.spec.ts)); the brief and its rendering, the
  tier bound, restart, the time bound, the pending bound, and the MCP tools
  ([`tests/digest.spec.ts`](tests/digest.spec.ts)).
