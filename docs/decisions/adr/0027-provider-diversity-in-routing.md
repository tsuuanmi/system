# ADR-0027: Routing may require a different provider family; it never names one

- **Status:** Proposed
- **Date:** 2026-10-16
- **Related:** [PROP-0004](../../proposals/0004-claude-code-lead-mvp.md),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  [ADR-0008](0008-tool-agnostic.md)

## Context

PROP-0004 needs work that is judged by a *different* provider than the one whose
work it judges:
- a critique of research evidence;
- the members of a team that votes;
- a second research branch.

Live runs showed what happens without it. All five nodes of a `research` run,
and both members of a `panel`, landed on accounts of one provider, so the
"independent" critique and the two-member team were one vendor talking to
itself.

Routing today orders admitted Workers by tier, quota class, operator priority,
and Worker id. A Worker's descriptor carries a `provider` string, documented as
*informational only; routing never branches on it (INV-11)*. Teams can already
require distinct **accounts**, but two accounts of one provider pass that rule.

INV-11 says that routing, teams, workflows, and profiles name capabilities,
never tools. Its purpose is that no tool is privileged or required, so a second
provider stays plausible for every seam.

## Options

1. **Keep provider out of routing.** Diversity is then only per account, which
   live runs showed is not enough.
2. **Name preferred providers in templates or configuration** ("critique on X").
   This breaks INV-11 directly.
3. **An opaque inequality.** A node may require that its Worker's provider family
   differ from the family of the Worker that served a named node. Routing
   compares two opaque strings for equality and never reads, names, or ranks a
   family.

## Decision

Option 3.

- **Provider family.** A Worker's descriptor gains `family`: an opaque string that
  identifies who ultimately serves the work.
  - For a website or agent Worker, it is the descriptor's provider.
  - For a model Worker, the operator's catalog entry may set it. Two routes to
    one vendor then count as one family. By default it is the route.
  - Nothing outside the Worker source assigns meaning to the string.
- **The predicate.** A node's requirement may say `differentFrom: [<nodeId>…]`.
  Admission refuses a Worker whose family equals the family of the Worker that
  served any named node, with the reason `diversity`.
  - When no admitted Worker satisfies it, the node fails admission with that
    reason (INV-2). Routing never silently falls back to the same family.
  - A team's members are mutually `differentFrom`.
- **Never named.** No template, profile, preset, or routing code holds a family
  value. Tests use fake families. The architecture test that guards INV-11 also
  checks that no family literal appears in routing, templates, or profiles.
- **Recorded.** The admission decision artifact lists, for each refused
  candidate, that it failed `diversity` and against which node (INV-13). It
  never states which family won.
- `provider` stays informational. `family` is the only identity routing
  compares, and only for inequality.

## Consequences

- INV-11 is unchanged in wording and intent. Its documented corollary changes:
  routing may compare provider families for inequality, and still never names,
  prefers, or ranks one.
- Different families make independent errors more likely, but do not guarantee
  them: two vendors can share sources and assumptions. Decision records say
  "different provider family", never "independent".
- With fewer families than a team or branch needs, the work fails admission
  instead of running less diverse. A composition with one family cannot run a
  team at all, and says so.
- The admission check enum and the decision schema gain `diversity` (a minor
  version).
