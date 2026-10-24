# @tsuuanmi/system-digest-extractive

A second provider of **`ctx.digests`**, extractive-first
([digests](../../../docs/design/digests.md#extractive-first); definition
[`digest-core`](../../digest-core/README.md)): before any Worker writes, code selects verbatim spans
of the sources, and the digest Worker reads only those and cites each claim by a span's id. A
capability plugin of the digest family
([ADR-0036](../../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)), beside
[`digest`](../digest/README.md): the same seam, the same conformance suite at contract 1.2, the
same MCP tools; it depends on seam definitions only, and fails open.

- **Bundle row:** `digest-extractive`, **off**. It replaces `digest` by configuration only: one
  patch turns `digest` off and this row on
  ([swap the digest provider](../../../docs/operations/runbooks.md#swap-the-digest-provider)). One
  provider of `ctx.digests` runs at a time: with both rows on, the second to register does not
  start, and health `plugins` is down, naming it.
- **The extract** (`digest-extract@1.0`, an `evidence` artifact whose envelope inputs are the
  sources, as strict as the strictest): the rule `digest-extractive.select` 1
  ([`src/extract.ts`](src/extract.ts)) splits each source's text (its body's `text`, else its
  canonical JSON, the text the quote check reads) into spans, each non-blank line without its
  surrounding whitespace, a long line cut into parts of at most 500 characters, at most the first
  1,000,000 characters of a source read; it keeps at most `maxExtracts` (default 40): each source's
  first span, then failures, risks, decisions, and metrics, each taken across the sources in turn,
  then each source's last span, then results, then the rest. Deterministic: the same sources give
  the same artifact. Sources with nothing to quote ask no Worker: the request is bypassed.
- **Its Worker** is whatever `ctx.workers` admits for `review` and `local-data` on the configured
  `tier` as minimum and maximum (default `economy`), as for `digest`. Its brief (`brief@1.1`)
  points at the extract by content id, never at a source; the Worker's source renders the extract's
  text (the sources by number, each span with its id) and checks egress on it (INV-12). The answer
  is described by a short example, not the whole `digest@1.0` schema.
- **Citations from the extract:** a claim citing `"extract": "E3"` gets that span's source, quote,
  and offset from the extract, never from the answer; a claim citing a span it was not given cites
  no source and is dropped; a claim quoting a source itself is checked as it is. Then the seam's
  quote check (`quoteCheck`, keeping at most `maxClaims`, default 20), the one escalation (`escalation`, on the same extract), and the
  settling decision (`settlement`), whose inputs also name the extract.
- **Durable as `digest` is:** requests on `ctx.store` (its own table; request ids `dgx-…`),
  idempotent by `key`, at most `maxPending` pending (default 4); the extract, the brief, the start,
  and the execution's id commit together; a restart goes on where each request stood, never
  starting a run twice (INV-4); a run past `timeoutMinutes` (default 30) is cancelled and the
  request bypassed (INV-9). The requests `digest` settled stay in its table: after a swap,
  `digests_get` of one answers that this provider does not know it.
- **MCP tools** (client scope): `digests_request` and `digests_get`, the seam's own
  (`registerDigestTools`), unchanged by the swap.
- **Injects:** `store`, `artifacts`, `leases`, `workers`; reads `eventLog` when present; `mcp` is
  optional.
- **Tests:** the seam's conformance suite over this provider, real routing, and the seam's
  scripted Worker ([`tests/conformance.spec.ts`](tests/conformance.spec.ts)); the rule: the
  schema's example, spans and offsets in code points, long lines, the scan bound, the ranking, and
  a draft's citations ([`tests/extract.spec.ts`](tests/extract.spec.ts)); the provider: the extract
  and the brief, citations by id, a span not given, blank sources, no Worker, the escalation on the
  same extract, restart, the time and pending bounds, the MCP tools, and one provider at a time
  ([`tests/extractive.spec.ts`](tests/extractive.spec.ts)). The swap itself, measured against
  `digest` on the same fixtures, is the bundle's
  ([`tests/evolution`](../../system-bundle/tests/evolution/digest-swap.spec.ts)), and the
  end-to-end test boots the shipped profile with the swap patch.
