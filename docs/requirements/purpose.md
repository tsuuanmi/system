# Purpose

This is the canonical answer to the question **"what is `system` for?"** Every
requirement, decision, and design choice should trace back to one of the four
purposes below. A feature that serves none of them does not belong in `system`.

> **Right Worker, right job. Spend intelligence where intelligence matters.**

## The problem

People who work with AI coding agents such as Claude Code and Codex hit the same
three walls:

1. **Token and quota cost.** Coding agents and APIs bill or limit by token. Long
   research, broad reading, and repeated reasoning burn that budget fast, even
   though most of the work is not coding.
2. **Unused capabilities.** Consumer AI websites offer capabilities that the
   agents and APIs do not expose, or charge separately for. Examples are
   provider-native Deep Research, built-in web search with citations, and
   website connectors, apps, and plugins. These capabilities sit idle while the
   agent works through the same problems in a weaker way.
3. **One agent does every job.** One Worker is asked to search the web, synthesize
   sources, read private local data, edit code, and run tests, although no single
   Worker is best at all of these.
4. **One model tier does every job.** A frontier model also does the trivial
   work, such as triage, extraction, summarizing, formatting, and status checks.
   That spends the most expensive intelligence on the least demanding work.

## The four purposes

### P1: Save tokens by spending the separate ChatGPT chat quota

Usage of a ChatGPT (or Gemini) website subscription is counted **separately** from
API billing and from coding-agent quotas such as Codex usage. `system` routes
reasoning-heavy and research-heavy work to website accounts, so that this
separate quota absorbs it. The metered or limited tokens of local agents and APIs
are kept for work that only they can do.

The same purpose drives **context economy**. Results are handed off as compact,
hash-bound syntheses instead of raw transcripts. Retained provider conversations
receive only new suffixes. Completed work is reused by input hash and never
recomputed ([workflow engine](../design/workflow-engine.md)).

*Requirements:* REQ-WRK-8, QA-12. *Design:* [routing](../design/routing.md#quota-and-cost-policy).

### P2: Use the capabilities that already exist on the websites

`system` drives the real websites, so it inherits their features without
rebuilding them:

- provider-native **Deep Research** (ChatGPT and Gemini);
- built-in **web search** with citations;
- website **connectors, apps, and plugins** enabled on the account, such as
  GitHub, Google Drive, or other data sources the provider integrates;
- other website-only features, such as file and data analysis and image
  generation, when a requirement needs them.

Each feature becomes a **capability** that a Worker must prove before it is
admitted. Proof comes from the account's plan and a feature probe, never from the
provider's name. This follows the reuse-before-build decision
([ADR-0010](../decisions/adr/0010-reuse-before-build.md)) at the level of whole
product features.

*Requirements:* REQ-PRV-6, REQ-PRV-7. *Design:* [routing](../design/routing.md#capability-vocabulary).

### P3: Right Worker, right job, with local data staying local

Each kind of Worker does what it is strongest at:

| Worker | Strength | Typical jobs |
|---|---|---|
| **Website Workers** (ChatGPT Web, Gemini Web) | searching, reading many sources, Deep Research, independent multi-account reasoning, synthesis | research, literature review, option analysis, critique, review of a provided diff |
| **Local Workers** (Claude Code, Codex, local tools) | access to local files, private data, the repository, the shell, and tests | implementation, data processing, running analyses on local datasets, validation |
| **Model Workers** (API and local models, from the operator's catalog) | one answer to one prompt; a local model keeps local-private data on this machine | economy-tier extraction and summarizing, reasoning without website quota, private-text processing on a local model |

Local and private data are processed by local Workers. Website Workers receive
only what an explicit egress policy allows, typically a question, a public
context, or a reviewed excerpt, and never the raw local dataset or repository
by default ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)).

A typical flow combines the purposes:

```text
question ─▶ website team: Deep Research + search + synthesis   (P1 quota, P2 capability)
         ─▶ economy tier: compact the report into a cited synthesis    (P4)
         ─▶ local agent: apply to local code/data, run tests   (P3 locality)
         ─▶ website reviewers: review the exact result          (P1, exact-subject binding)
```

*Requirements:* REQ-WRK-7, REQ-WRK-10. *Design:* [routing](../design/routing.md#data-locality-policy), [models](../design/models.md).

### P4: Cheap models do low-level work; strong models do hard work

Every job declares the **minimum intelligence tier** it needs, and routing picks
the *lowest* tier whose Workers prove the required capabilities:

| Tier | Typical Workers (examples, set by configuration) | Typical jobs |
|---|---|---|
| `economy` | fast or instant website modes, small API models, local models | triage and classification, extraction, summarizing and compacting handoffs, formatting and JSON shaping, translation, status polling, first-pass checklist review |
| `standard` | default reasoning modes of website models and coding agents | ordinary implementation, focused research questions, normal review |
| `frontier` | highest reasoning efforts, Pro modes, Deep Research | hard reasoning, open-ended research, architecture decisions, final synthesis and adjudication |

A job whose result fails acceptance at a lower tier may be **escalated** to the
next tier. Escalation is a declared, bounded, and logged policy step. It never
silently replaces a running turn
([INV-2](../architecture/invariants.md#inv-2-fail-closed)). Profiles name tiers
and capabilities, never models
([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)).

P4 and P1 compound. Cheap tiers absorb the high-volume work, and the separate
website quota absorbs the expensive reasoning.

*Requirements:* REQ-WRK-9, REQ-WRK-10. *Design:* [routing](../design/routing.md#intelligence-tiers).

### Purposes per preset

The default composition serves all four purposes. The `api-first` preset
([ADR-0025](../decisions/adr/0025-api-first-composition.md)), for organizations that cannot
accept automated use of consumer websites (CON-3), serves P3 and P4 with API, local, and agent
Workers only. P1 and P2 need website Workers, so they are unavailable there.

## A motivating example from building `system` itself

On 2026-10-11, choosing which existing plugins to reuse for `system` meant
reading the DSH community catalog (about 14,400 plugin versions), triaging
dozens of candidates, and reading their code and READMEs. That is exactly the
kind of broad, read-only research and synthesis that P1 and P3 say should
**not** spend frontier tokens in a local coding agent:

```text
Claude Code / Codex: "which catalog plugins fit our MCP server, vault, and DAG needs?"
  ─▶ system research (website Workers, web search or Deep Research, chat quota) P1, P2
  ─▶ economy tier: compact the findings into a cited shortlist                  P4
  ─▶ local agent: apply the decision to the repository (local data stays local) P3
```

This scenario is a demo target for MVP slice 1
([release scope](release-scope.md#delivery-order-slice-1-first)).

## Who it is for

A single operator who already has AI website subscriptions and local coding
agents, and wants them to work together as one system (CON-6).

## What it is not

- It is not a way around provider limits or terms. It uses the quota the operator
  already has, within bounded concurrency, and has no evasion features (CON-3).
- It is not a replacement for Claude Code or Codex. They remain the local
  Workers and clients ([ADR-0009](../decisions/adr/0009-claude-and-codex-first-class.md)).
- It is not a new chat UI. Its value is routing, durability, and composition.

## Success measures

| Purpose | Measure |
|---|---|
| P1 | share of research and reasoning tokens served from website quota instead of metered or agent quota, per workflow |
| P2 | number of website-native capabilities (Deep Research, search, connectors) reachable as admitted capabilities |
| P3 | zero local-data egress outside policy; local jobs run only on local Workers; acceptance rate per Worker kind and job type |
| P4 | share of jobs completed at `economy` tier; escalation rate per job type (low means tiers are declared well) |

What each release must deliver toward these purposes is defined in
[release scope](release-scope.md).
