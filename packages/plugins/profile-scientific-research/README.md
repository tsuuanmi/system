# @tsuuanmi/system-profile-scientific-research

The **scientific-research profile**: the second domain on the same engine, and
the architecture test (REQ-WF-9, PROP-0001). It was added with **no change to
any engine package**:
- its procedures come through `ctx.workflow.template`;
- its structured steps use the engine's `resultSchema` (REQ-ART-5);
- its other checks come through `ctx.workers.contract`;
- its typed artifacts come through `ctx.artifacts`, from the engine's own
  event log.

It still holds no engine code. The engine features it later took up, a node's
`variants` and `differentFrom`, are generic template fields that any template
may use.

## `research`

| Step | Capability, tier | Acceptance | Produces |
|---|---|---|---|
| `frame:1` | `reason`, standard, the run's conversation | `resultSchema: hypothesis-set@1.0` | 2 to 4 testable hypotheses, as a `criteria` artifact (`hypothesis-set@1.0`) |
| `literature:1` | `reason` + `web-search`, standard, temporary; variant `deep`: `reason` + `deep-research`, frontier, its own conversation | `acceptance.cited` | review A: a cited review of the published evidence |
| `literature:2` | `reason`, standard, temporary, on another provider family than `literature:1`; variant `deep`: as `literature:1` | `acceptance.cited` | review B, in parallel with review A; its citations gate it, since its provider need not prove a search |
| `evidence:1` | `reason`, economy, the run's conversation | `resultSchema: evidence-table@1.1` | claims from both reviews with source URLs, which review states each (`reviews`), and their bearing on each hypothesis, as an `evidence` artifact (`evidence-table@1.1`) |
| `critique:1` | `reason`, standard, temporary, on another provider family than `evidence:1` | `acceptance.answer` | an independent critique that sees only the hypotheses and the evidence, never the reviews |
| `conclusion:1` | `reason`, standard, the run's conversation | `acceptance.cited-conclusions` | a conclusion per hypothesis, citing evidence as `[E1]`, saying where the reviews agree and differ |

The synthesis steps share the run's one conversation, in order. The reviews and
the critique each have their own, so they stay independent of the thread they
feed or judge. That makes four conversations per run, not six.

`research` needs Workers of two provider families; with one, `literature:2`
fails admission, fail closed, unless the operator sets the engine's
`allowSameFamily` (ADR-0029)
([templates](../../../docs/reference/workflow-templates.md#research)).

- **Contract:** it registers `acceptance.cited-conclusions`: the conclusion
  names at least one hypothesis (`H1`, …) and cites evidence (`[E1]`, …).
- **Typed artifacts:** an accepted `frame:1` or `evidence:1` result becomes a
  typed artifact derived from it (`inputs: [result]`).
- **Invalidation:** when the operator supersedes a result (`system supersede`),
  the engine runs everything downstream again. The new typed artifact
  supersedes the last one (`lineage.supersedes`).
- **Live checks:** see the
  [release checklist](../../../docs/validation/release-checklist.md).
- `system research` and the MCP tool `research` run `research`; `--deep` (MCP
  `deep: true`) runs its `deep` variant
  ([variants](../../../docs/design/workflow-engine.md#variants)). The
  `research-deep` template is gone (PROP-0004); its earlier runs still produce
  typed artifacts when the operator supersedes a step.
- **Injects:** `workflow`, `workers`, `artifacts`, `eventLog`.
- **Conformance:** [`profiles`](../workflow/conformance/profiles.ts).
