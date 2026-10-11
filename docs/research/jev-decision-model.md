# Jev decision model for routing decisions

Non-normative. Researched on 2026-10-11. Supports the draft
[PROP-0002](../proposals/0002-decision-assisted-routing.md).

> **Source caveat.** Jev entered early access on 2026-09-15. Almost every source
> below is a third-party guide or a reseller's documentation. TypeSafe's own API
> reference did not surface. Field names, limits, and prices must be checked
> against the official documentation before implementation.

## What Jev is

Jev is TypeSafe's first "System One" model, a **decision model**. It does not
generate prose. Given a text `state` and one or more typed questions, it returns
typed answers with probabilities:

| Question type | Returns | Notes |
|---|---|---|
| **Choice** | `choice`, `probabilities` per option, `confidence` | up to 255 options |
| **Score** | `score` (probability-weighted), `probabilities` per level, `confidence` | 2–10 ordered levels with a rubric |
| **Noul** (yes/no) | `noul`: a probability in 0–1 that a proposition holds | no separate `confidence`; some SDKs call this type `boolean` / `probability` |

- Several questions can be asked in **one request**. In one benchmark, 13
  questions in a single request cost about 12× less and ran about 10× faster than
  13 separate requests.
- `confidence` is derived from the shape of the probability distribution.
  Calibration holds across many samples, not for any single answer.
- **Limits:** text only; a 64k-token context (state plus questions), with the
  state plus the longest question at most 32k.
- **Language:** English is the primary training language. Other languages
  "work" but are not equally accurate. This matters for us because the operator
  often writes in Vietnamese.
- **Not a security boundary.** Vendor guidance says Jev must not be relied on as,
  for example, a prompt-injection filter.
- **Cost and latency (claimed):** about $0.042 per million input tokens, output
  free, roughly 100 ms per query; one routing call costs about $0.00003.
- **Access:** through TypeSafe directly and through gateways (AIMLAPI
  `POST /v1/decisions` with `"model": "typesafe/jev"`, LiteLLM pass-through,
  OpenRouter, ZenMux). Versions can be pinned (`jev-1.13.0`); `jev-latest` floats.
  No self-hosting or open weights were found.

## Prior art: jev-router for Claude Code

`@ediri/jev-router` is a local proxy that sits between Claude Code and the
Anthropic API and changes only the `model` field. On each new user message it
asks Jev three questions in one call:

1. **Choice, work type:** `mechanical` / `routine` / `complex` / `deep`, mapped to
   fast, balanced, and frontier models.
2. **Noul, risk:** does the request touch production, credentials, permissions,
   or billing? If ≥ 0.7, use the top tier.
3. **Noul, tier claims:** does the message assert its own tier? If ≥ 0.5, do not
   drop below the reference tier.

Design points worth copying:

- **Per-tier confidence thresholds:** 85% for the fast tier, 60% for balanced, and
  30% for frontier. If the top pick misses its threshold, the router takes the
  more capable of the top two.
- **Guards only raise the tier.** Deterministic checks (explicit pins, a secret
  scanner) run in code before Jev is asked.
- **Tier is sticky within a session.** It only moves up, because switching model
  chills the prompt cache. It is re-decided after idle time, compaction, or
  `/clear`.
- Tool steps and subagents inherit the tier of the message that spawned them.
- A labeled evaluation set (58 prompts) is used to tune the thresholds.
- Its only reported figure is "51% saved" in a demo session. There is no broader
  benchmark.

The general literature splits routing into **pre-generation** routing, which
classifies the query before any model runs (Jev's sweet spot), and
**post-generation** routing or cascading, which judges an output and escalates
if needed.

## Brainstorm: where a decision model could help `system`

The scoring weighs value against what `system` already decides deterministically.

| # | Decision point | Jev question | Value | Notes |
|---|---|---|---|---|
| D1 | **Tier for unspecified work** (P4): an MCP `ask` with no tier, ad-hoc requests | Choice `mechanical / routine / complex / deep` → `economy / standard / frontier` | **High** | the core use case; profiles that declare tiers stay authoritative |
| D2 | **Capability need** (P2): does the question need live web search or Deep Research, or can it be answered from model knowledge? | Choice `knowledge / web-search / deep-research` | **High** | avoids spending Deep Research quota on simple questions |
| D3 | **Website vs local** (P3): does this need local files, data, or the repository? | Noul `needs-local-context` | Medium | selects candidates only; egress enforcement stays deterministic (below) |
| D4 | **Risk raise:** does the work mutate production, credentials, billing, or VCS state? | Noul `high-impact` | Medium | may only raise tier or require approval |
| D5 | **Escalation pre-check** (post-generation): is this economy-tier result likely to pass acceptance? | Score against the node's acceptance rubric | Medium | triggers an early escalation; never replaces the acceptance contract |
| D6 | **Research compaction:** which sources and passages are relevant? | Noul per (question, passage) | Medium | a cheap reranker before economy-tier compaction |
| D7 | **Egress hint:** does this payload look like it contains private or local data? | Noul `contains-private-data` | Low, deny-only | can only *add* a block or a prompt to the operator; never a permit |
| D8 | **Team need:** is one Worker enough, or is this contested and worth an independent team? | Score `contestedness` | Low–medium | a later candidate, once teams exist |

### Where a decision model must **not** be used

These must stay deterministic, because a probabilistic answer would break an
invariant:

- **Provider reconciliation** (WAIT / RECOVER / RESUBMIT / AMBIGUOUS), INV-4.
- **Admission proofs.** Capabilities are proven by probes, not predicted (REQ-WRK-1).
- **Authority, sandbox, and egress *permits*,** INV-6 and INV-12. A model may
  tighten but never loosen.
- **Exact-subject gates and acceptance contracts,** INV-3 and INV-5.
- Anything presented as a security control, as the vendor guidance says.

### Tensions with current invariants, and resolutions

| Tension | Resolution |
|---|---|
| REQ-WRK-2 requires deterministic routing | Record each decision as a **decision receipt** (input hash, question-set version, pinned model version, answers). Routing is deterministic *given* the receipt, and retries and restarts reuse it, the same way node results are reused by input hash. |
| INV-11 no tool lock-in | Put it behind a `ctx.decisions` seam with several providers: `decisions-jev`, `decisions-llm` (an economy-tier model with structured output), and `decisions-rules` (heuristics). |
| INV-12 data egress | Sending the request text to TypeSafe *is* egress. Send only what the egress policy allows (for `local-private` work, a feature summary or nothing), or use a local provider. |
| INV-2 no silent fallback | Decisions are **advisory inputs** with a declared outcome when they are unavailable: use the declared or default tier, and record `decision: unavailable`. This is a defined path, not a hidden switch. |
| Language accuracy | Build the evaluation set in Vietnamese and English, and enforce only after the Vietnamese results meet the threshold. |
| Early-access API churn | Pin the version, use the seam, and treat answers as advisory. |

### Rough economics

A routing call costs about $0.00003 and about 100 ms, against website turns that
take seconds to minutes and Deep Research runs that take tens of minutes. Even
one avoided frontier turn or Deep Research run (D1, D2) pays for many thousands of
decisions. The real cost is **wrong down-routing**, a hard task sent to the
economy tier. Conservative thresholds, guards that only raise the tier, and
bounded escalation limit that cost.

## Sources

- [What Is Jev? TypeSafe's Decision Model Explained for Developers (OpenRouter)](https://openrouter.ai/blog/insights/what-is-jev/)
- [Jev API reference (AIMLAPI)](https://docs.aimlapi.com/api-references/decision-models/typesafe/jev)
- [TypeSafe AI (Jev) pass-through (LiteLLM)](https://docs.litellm.ai/docs/pass_through/typesafe)
- [Jev Decision Model: Extracting Structured Judgments from LLMs for Code-Driven Routing](https://www.besthub.dev/articles/jev-decision-model-extracting-structured-judgments-from-llms-for-code-driven-routing-044d92bc4bf4)
- [A Coding Guide to TypeSafe AI Jev (MarkTechPost)](https://www.marktechpost.com/2026/09/23/a-coding-guide-to-typesafe-ai-jev/)
- [A deep dive into Jev (flaviocopes)](https://flaviocopes.com/jev/)
- [Route every Claude Code message to the right model with Jev (Pulumi)](https://www.pulumi.com/blog/route-every-claude-code-message-to-the-right-model-with-jev/)
- [How to use Jev for LLM routing with ZenMux](https://zenmux.ai/blog/how-to-use-jev-for-llm-routing-with-zenmux-a-developer-guide)
- [Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey](https://arxiv.org/pdf/2603.04445)
