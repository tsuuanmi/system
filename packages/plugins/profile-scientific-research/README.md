# @tsuuanmi/system-profile-scientific-research

The **scientific-research profile**: the second domain on the same engine, and
the architecture test (REQ-WF-9, PROP-0001). It was added with **no change to
any engine package**:
- its procedures come through `ctx.workflow.template`;
- its structured steps use the engine's `resultSchema` (REQ-ART-5);
- its other checks come through `ctx.workers.contract`;
- its typed artifacts come through `ctx.artifacts`, from the engine's own
  event log.

## `research` and `research-deep`

| Step | Capability, tier | Acceptance | Produces |
|---|---|---|---|
| `frame:1` | `reason`, standard | `resultSchema: hypothesis-set@1.0` | 2 to 4 testable hypotheses, as a `criteria` artifact (`hypothesis-set@1.0`) |
| `literature:1` | `reason` + `web-search`, standard, temporary (`research`); or `reason` + `deep-research`, frontier, persistent (`research-deep`) | `acceptance.cited` | a cited review of the published evidence |
| `evidence:1` | `reason`, economy | `resultSchema: evidence-table@1.0` | claims with source URLs and their bearing on each hypothesis, as an `evidence` artifact (`evidence-table@1.0`) |
| `critique:1` | `reason`, standard | `acceptance.answer` | an independent critique that sees only the hypotheses and the evidence, never the review |
| `conclusion:1` | `reason`, standard | `acceptance.cited-conclusions` | a conclusion per hypothesis, citing evidence as `[E1]` |

- **Contract:** it registers `acceptance.cited-conclusions`: the conclusion
  names at least one hypothesis (`H1`, …) and cites evidence (`[E1]`, …).
- **Typed artifacts:** an accepted `frame:1` or `evidence:1` result becomes a
  typed artifact derived from it (`inputs: [result]`).
- **Invalidation:** when the operator supersedes a result (`system supersede`),
  the engine runs everything downstream again. The new typed artifact
  supersedes the last one (`lineage.supersedes`).
- **Live checks:** see the
  [release checklist](../../../docs/validation/release-checklist.md).
- `system research` and the MCP tool `research` run `research`.
- **Injects:** `workflow`, `workers`, `artifacts`, `eventLog`.
- **Conformance:** [`profiles`](../workflow/conformance/profiles.ts).
