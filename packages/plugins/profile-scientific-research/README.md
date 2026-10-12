# @tsuuanmi/system-profile-scientific-research

The **scientific-research profile**: the second domain on the same engine, and
the architecture test (REQ-WF-9, PROP-0001). It was added with **no change to
any engine package**:
- its procedures come through the `profiles` seam (`ctx.workflow.template`);
- its structured steps use the engine's `resultSchema` (REQ-ART-5);
- its other checks come through `ctx.workers.contract`;
- its typed artifacts come through `ctx.artifacts`, from the engine's own
  event log.

## `study` and `study-deep`

| Step | Capability, tier | Acceptance | Produces |
|---|---|---|---|
| `frame:1` | `reason`, standard | `resultSchema: hypothesis-set@1.0` | 2 to 4 testable hypotheses, as a `criteria` artifact (`hypothesis-set@1.0`) |
| `literature:1` | `reason`, standard (`study`) or `deep-research`, frontier (`study-deep`) | `acceptance.cited` | a cited review of the published evidence |
| `evidence:1` | `reason`, economy | `resultSchema: evidence-table@1.0` | claims with source URLs and their bearing on each hypothesis, as an `evidence` artifact (`evidence-table@1.0`) |
| `critique:1` | `reason`, standard | `acceptance.answer` | an independent critique that sees only the hypotheses and the evidence, never the review |
| `conclusion:1` | `reason`, standard | `acceptance.cited-conclusions` | a conclusion per hypothesis, citing evidence as `[E1]` |

- **Typed artifacts:** an accepted `frame:1` or `evidence:1` result becomes a
  typed artifact derived from it (`inputs: [result]`).
- **Invalidation:** when the operator supersedes a result (`system supersede`),
  the engine runs everything downstream again. The new typed artifact
  supersedes the last one (`lineage.supersedes`).
- **Verified live on 2026-10-12:** a `study` on ChatGPT (`standard`) produced:
  - four hypotheses;
  - a review citing 17 sources;
  - a 26-claim evidence table on `economy`;
  - a critique;
  - conclusions per hypothesis citing the evidence, in 4.5 minutes.

- **Injects:** `workflow`, `workers`, `artifacts`, `eventLog`.
- **Conformance:** [`profiles`](../workflow/conformance/profiles.ts).
