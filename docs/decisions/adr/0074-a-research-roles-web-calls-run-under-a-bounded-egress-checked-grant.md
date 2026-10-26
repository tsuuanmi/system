# ADR-0074: A research role's web calls run unasked under a bounded, egress-checked grant, and research's second review prefers it

- **Status:** Proposed
- **Date:** 2026-10-26
- **Related:** T262, the operator's decision D91 of 2026-10-26 (the Gemini web Worker stalled on
  research's second review three times in T229 and three in T248, so the second family is a Claude
  Worker), T260 (the single-family fallback), T261 ([ADR-0073](0073-agent-workers-offer-tiers-per-role-with-quota-per-model.md)),
  [ADR-0029](0029-opt-in-same-family-fallback.md),
  [ADR-0057](0057-route-work-by-kind.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

Research's two literature reviews run on two provider families (ADR-0029). ChatGPT's website Worker
takes the first; the second went to Gemini's, which kept stalling after the prompt, and the template
then fell back to the first family, marked single-family (T260, D89). A Claude Worker on an agent
runtime is a different family from ChatGPT and can search the web, but the agent gate judges
`WebSearch` and `WebFetch` as `external-send`, which always asks: a review of 20 searches would wait
for the operator 20 times, and an agent Worker proved no `web-search` at all.

What constrains it:

- **Fail closed** (INV-2): a web call sends a query or a URL out. Nothing about it may become unasked
  by default, by a project's policy alone, or by an unapproved edit.
- **Egress is already checked** (`egress.classification-and-secrets`): no local-private content, no
  credential pattern, a classification within the destination's.
- **Authority from the operator** (INV-6): a policy takes effect only through a policy-change request
  the operator approves.
- **No tool lock-in** (INV-11): the routing requirement names capabilities, never a vendor or family.

## Options

1. **Make `external-send` auto for web tools everywhere.** Every role could send anything out
   unasked. Rejected.
2. **Keep asking, and batch.** The review still waits on a person for each batch. Rejected: it is
   the stall this task removes, moved to the operator.
3. **A role kind with no write or shell tool, a probe that proves `web-search`, and a versioned
   autonomy-policy grant for that role only, bounded and egress-checked per call.** Chosen.

## Decision

- **A research role** (`research: true` on an agent role or worker; kind `research`). It is
  read-only, has no review membership, and its tools are `Read`, `Grep`, `Glob`, `WebSearch`,
  `WebFetch` only, in the role's tools and every tier's. Anything else is refused at load, and the
  Claude runtime refuses a run (`RunSpec.web`) that lists a writing tool or a shell or is not
  read-only. The gate denies a write or a command call of such a run (`research-role`). It is on
  the standard tier when it gives no tier (with T261's tiers, the tiers it declares) and takes
  research work only.
- **The Worker proves `reason` and `web-search` by a probe**: one real `WebSearch` of the fixed query
  `Wikipedia main page`, made in a read-only run through the gate, recorded as the decision
  `agent-workers.web-probe` (valid 24 h, retried after 1 h). It proves nothing when the grant is not
  in force (the search would ask, and a probe has no person to wait for), and a runtime that offers no
  web tools (`RuntimeEvidence.webTools`; only Claude Code does) admits no research Worker.
- **Routing prefers, never requires.** `work-requirement@1.3` adds `prefers`: capabilities the work
  would like and does not need. The router ranks a Worker that proves all of them first, after the
  quota reserve and before the tier, never refuses one that does not, and records why in the route
  decision. The template's `literature:2` needs `reason`, prefers `web-search`, and must differ in
  family from `literature:1`, so it goes to a Worker of another family that searches, then to one that
  only reasons (Gemini web, say), and T260's single-family fallback stays last.
- **A web access grant.** `autonomy-policy@1.3` adds `webAccess: { version, rules: [{ profile:
  'research', tools, maxWebCallsPerRun, maxClassification, note }] }`, `maxWebCallsPerRun` 1 to 200,
  40 when unset. The studio's grant is the
  only one that grants; a project policy's can only narrow it (fewer tools, a lower bound, a lower
  classification). It moves no effective mode: `external-send` stays `ask` in every rule, and
  `local-private` can never be granted. `policies/system.json` ships it (version 2): `WebSearch` and
  `WebFetch`, 40 calls per run, up to `operator-shared`.
- **The rule** (`agent-workers.web-access`), for a research run's `WebSearch` or `WebFetch` that the
  policy answers `ask`: a call is `auto` only when the grant names the tool, the query or URL names no
  local path, the egress check (class `agent`) allows it at a classification within the grant's, and
  the run has made fewer than `maxWebCallsPerRun` unasked calls. Otherwise it asks as today (reason
  `bound`, `local-path`, `egress`, `tool-not-granted`, or `no-grant`). Calls of a run are judged one at
  a time, so concurrent calls cannot pass the bound together. The policy is judged with the run's
  project, so a project's `forbid` binds whatever the studio's grant says; a call its session was
  denied is denied again, recorded as `deny`, and takes no place in the bound.
- **Recorded.** Each call judged is a `gate` decision of `agent-workers.web-access`, with the query
  or URL, the number of the call and the bound, the egress outcome (its decision among the inputs),
  and the reason it asked. `agent-tool-event@1.2` adds `agent-workers.tool.web` (counts, verdict, no
  query) and the denial reason `research-role`.
- **Shown.** `system explain` and the run's page on `/ui` show the run's web calls: the count, how
  many ran unasked, asked, or were denied, and each call's query or URL with its egress verdict.
- **Shipped as a request.** The grant takes effect only when the operator approves a policy-change
  request (`approvals_policy_propose`) of the studio policy with it; the request's consequences
  name the grant apart from the modes, since none moves. Until then every web call asks as before.
  The system project's policy in `policies/system.json` carries the same grant, which only narrows
  the studio's and reaches the live set through its own policy-change approval.

## Consequences

- A research run's web calls run unasked within a bound, and what leaves is checked per call; the
  operator reads them all afterwards. Every other role, and a research role without the approved
  grant, still asks for every web call.
- Research keeps two families without Gemini web: ChatGPT, then Claude.
- **Known limits.** The egress check reads a query's text, not what a fetched page returns to the
  agent; a fetched page's content is untrusted input as any tool result is. The bound counts unasked
  calls of one run, not of a day. Only Claude Code takes web runs; Codex, agy and ACP refuse them.
- Schema minors: `autonomy-policy@1.3`, `work-requirement@1.3`, `agent-tool-event@1.2`.

## Rejected alternatives

The options above; also: a per-call allow-list of domains (stale at once, and a query is the larger
leak); a grant in a project policy (a project could then widen what the studio asks); and making
`prefers` a requirement (a missing research Worker would then block the template instead of falling
back).
