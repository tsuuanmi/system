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
| `literature:2` | `reason`, standard, temporary, on another provider family than `literature:1` (preferred: else once on its family, marked single-family); variant `deep`: as `literature:1` | `acceptance.cited` | review B, in parallel with review A; its citations gate it, since its provider need not prove a search |
| `evidence:1` | `reason`, economy, the run's conversation | `resultSchema: evidence-table@1.1` | claims from both reviews with source URLs, which review states each (`reviews`), and their bearing on each hypothesis, as an `evidence` artifact (`evidence-table@1.1`) |
| `critique:1` | `reason`, standard, temporary, on another provider family than `evidence:1` (preferred, as `literature:2`) | `acceptance.answer` | an independent critique that sees only the hypotheses and the evidence, never the reviews |
| `conclusion:1` | `reason`, standard, the run's conversation | `acceptance.cited-conclusions` | a conclusion per hypothesis, citing evidence as `[E1]`, saying where the reviews agree and differ |

The synthesis steps share the run's one conversation, in order. The reviews and
the critique each have their own, so they stay independent of the thread they
feed or judge. That makes four conversations per run, not six.

The conversation stays on the Worker `frame:1` ran on. When that Worker can
never take a later synthesis step (live 2026-10-26: `frame:1` on a website that
takes 30,000 characters, `evidence:1` 56,350 with both reviews quoted), the step
runs once off the conversation on another Worker rather than failing the run.
Each synthesis step quotes every result it builds on (`{{node:frame:1}}`,
`{{node:evidence:1}}`, …), so it needs no conversation and runs without it
(`sessionless`); `conclusion:1`, back on the conversation, is handed
`evidence:1`'s result if `evidence:1` ran off it. Either way a `route` decision
by `workflow.session-move` says so
([sessions](../../../docs/design/sessions-and-messaging.md#a-step-its-sessions-worker-cannot-take)).

`research` prefers Workers of two provider families (`diversity: preferred` on
`literature:2` and `critique:1`, operator decision D89). When no Worker of
another family can take one of them (unavailable, over its input bound,
stalled after the prompt, failed on the infrastructure), it runs once on the
first family's provider in a fresh conversation that never sees the step it
differs from, and the prompt is never sent again to the Worker that failed it.
It is never silent: a `single-family` decision by `workflow.diversity` names
why, the later steps' briefs and the answer's first line say `Single family: …`,
and `/ui` shows a `single family` chip on the run. Two reviews on one family
share one blind spot (T229: the Gemini answer's unsourced claims were caught by
the ChatGPT answers), so the conclusion weighs their agreement as weaker. A run
where both families answered is unchanged
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
