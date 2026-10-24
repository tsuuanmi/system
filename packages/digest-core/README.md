# @tsuuanmi/system-digest-core

Digest **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[digests](../../docs/design/digests.md)). A capability seam of the digest family: its contract
changes by a versioned definition and this conformance suite
([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Provider |
|---|---|---|
| `ctx.digests` | abstract `Digests` with `request({ sources, key? })`, `get(requestId)`, `wait(requestId, timeoutMs)`; `DigestRequest`, `DigestView`, `DigestState`, `DigestBody`, `DigestClaim`, `DigestError`, `DIGEST_LIMITS`; the quote check `quoteCheck(draft, sources, read, maxClaims)` (with why there is no digest, `QuoteFailure`), the one escalation `escalation(request, check, answer)` (`ESCALATION_TIER`), and the settling decision `settlement(request, outcome)` every provider applies; the MCP tools every provider serves, `registerDigestTools(ctx, digests)` (`digests_request`, `digests_get`; `DIGEST_TOOLS`, `DIGEST_TOOL_INPUTS`, `digestToolHandlers`, `digestTool`); `DIGESTS_CONTRACT` (1.2); `checkedRequest`, which runs a request's `check` | [`digest`](../plugins/digest/README.md) (on `ctx.store`, its row on); [`digest-extractive`](../plugins/digest-extractive/README.md) (on `ctx.store`, extractive-first, its row off); the fake `FakeDigests` |

- The types mirror `digest@1.0` and `mcp-digests@1.1`; the schemas in `schemas/` are canonical.
  It depends on Cordis, [`libs`](../libs/README.md) (`bodyText`, the text a quote is checked
  against, which a brief renders too; the schema registry), and the `ctx.mcp` definition in
  [`gateway-core`](../gateway-core/README.md) with `zod` (a peer), for the tools.
- **The MCP tools** belong to the seam, not to a provider: each provider registers them through
  `registerDigestTools` from `ctx.inject(['mcp'], …)`, so replacing the provider keeps the lead's
  tools as they are. Each call's input and structured output are checked against
  `mcp-digests.v1.json`; a refused input does nothing. `digests_request` gives the request a
  `check` of the output it would give (contract 1.2), which the provider runs inside the
  transaction that records the request, before it commits: an output its schema refuses (a
  defect) is refused with nothing recorded and no Worker asked.
- **A request's check** (1.2): `request({ sources, key?, check? })` runs `check` on the request
  as it would return it (new and pending, or the one its key names) before it is recorded; one that
  throws records nothing and takes no key, and its error is the call's.
- **The quote check** keeps a claim only when it is well formed, cites one of the request's
  sources, and quotes that source's text verbatim (at `offset`, in code points, when given); any
  other claim is dropped and recorded with why. The digest's sources are the request's, never the
  answer's. No claim left, or no status or summary: no digest.
- **One escalation** (1.1): an economy answer whose every claim failed the quote check is written
  once more on the standard tier, never higher and never twice, after an `escalation` decision
  (rule `digests.escalation`); no other answer without a digest escalates.
- A request settles once: `written`, `not-written`, or `bypassed` (it fails open), by one
  `acceptance` decision (rule `digests.quote-check`) whose three candidates say why.
- The conformance suite is [`conformance/digests.ts`](conformance/digests.ts), run through the
  [conformance runner](../libs/conformance/runner.ts) at contract 1.2:
  - a digest whose claims quote verbatim is written over exactly the requested sources, at least
    as strict as they are, with its settling decision;
  - claims with an altered quote, a wrong offset, or a citation outside the sources are dropped
    and recorded, and the rest kept; with none left, or an answer that holds no digest, nothing
    is written;
  - with no Worker, or a Worker run that fails, the request settles `bypassed`, recorded, never
    refused;
  - invalid input refused with nothing recorded; the same key, the same request; an unknown
    request;
  - since 1.1: every economy claim failing escalates once to standard, recorded first, and the
    request settles on that answer; failing there too gives up, never asking a higher tier; an
    answer that fails for another reason does not escalate;
  - since 1.2: a request's `check` sees it before it is recorded: one that throws records nothing,
    takes no key, and asks no Worker; one under a key sees the request the key names.

  It also exports `FakeDigests`, which passes it, its Worker on each tier a drafter the test gives.
- [`conformance/worker.ts`](conformance/worker.ts) is the scripted digest Worker a provider's tests
  run the suite with: a Worker source over real routing, a read-only Worker on each tier, each run
  answered by the drafter from the request's sources, its tier, and the prompt the brief rendered
  to.
