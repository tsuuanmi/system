# @tsuuanmi/system-digest-core

Digest **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[digests](../../docs/design/digests.md)). A capability seam of the digest family: its contract
changes by a versioned definition and this conformance suite
([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.digests` | abstract `Digests` with `request({ sources, key? })`, `get(requestId)`, `wait(requestId, timeoutMs)`; `DigestRequest`, `DigestView`, `DigestState`, `DigestBody`, `DigestClaim`, `DigestError`, `DIGEST_LIMITS`; the quote check `quoteCheck(draft, sources, read, maxClaims)` and the settling decision `settlement(request, outcome)` every provider applies; `DIGESTS_CONTRACT` (1.0) | [`digest`](../plugins/digest/README.md) (on `ctx.store`); the fake `FakeDigests` |

- The types mirror `digest@1.0` and `mcp-digests@1.0`; the schemas in `schemas/` are canonical.
  It depends on Cordis and [`libs`](../libs/README.md) (`bodyText`, the text a quote is checked
  against, which a brief renders too; the schema registry).
- **The quote check** keeps a claim only when it is well formed, cites one of the request's
  sources, and quotes that source's text verbatim (at `offset`, in code points, when given); any
  other claim is dropped and recorded with why. The digest's sources are the request's, never the
  answer's. No claim left, or no status or summary: no digest.
- A request settles once: `written`, `not-written`, or `bypassed` (it fails open), by one
  `acceptance` decision (rule `digests.quote-check`) whose three candidates say why.
- The conformance suite is [`conformance/digests.ts`](conformance/digests.ts), run through the
  [conformance runner](../libs/conformance/runner.ts) at contract 1.0:
  - a digest whose claims quote verbatim is written over exactly the requested sources, at least
    as strict as they are, with its settling decision;
  - claims with an altered quote, a wrong offset, or a citation outside the sources are dropped
    and recorded, and the rest kept; with none left, or an answer that holds no digest, nothing
    is written;
  - with no Worker, or a Worker run that fails, the request settles `bypassed`, recorded, never
    refused;
  - invalid input refused with nothing recorded; the same key, the same request; an unknown
    request.

  It also exports `FakeDigests`, which passes it, its Worker a drafter the test gives.
