# ADR-0027: Routing may require a different provider family; it never names one

- **Status:** Accepted; superseded in part by [ADR-0029](0029-opt-in-same-family-fallback.md)
- **Date:** 2026-10-16 (accepted 2026-10-16)
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
- **The predicate.** A template node may declare `differentFrom: [<nodeId>…]`.
  - The work requirement given to Workers is unchanged. The engine resolves the
    named nodes to the families of the Workers that served them, and passes those
    families to routing as an exclusion (`RouteOptions.exclude`) with a reason
    that names the nodes.
  - Admission refuses a Worker of an excluded family, and a Worker that declares
    no family, with the check `diversity`.
  - When no admitted Worker satisfies it, the node fails admission with that
    reason (INV-2). Routing never silently falls back to the same family.
  - The exclusion works both ways: a node also excludes the families of routed
    nodes whose `differentFrom` names it.
  - A retry, an escalation, or a continuation clears the node's Worker, so a
    stale family is never compared.
- **Readiness.** A node with `differentFrom` routes only beside, or after, the
  nodes it names.
  - While a named node has no Worker and is not executing, the node defers and
    sends nothing. It does not block the rest of its batch, so the two still run
    in parallel, one routing turn apart.
  - When a named node fails, the node sends nothing and the run fails on that
    node.
  - Preflight refuses a `differentFrom` that names the node itself, an unknown
    node, a dependent, or a cycle.
- **Teams.** Members are ordered: member *k* must differ from members 1 to
  *k*−1, and members route in that order. A team with more members than
  families fails admission on the first member that cannot differ.
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
- The admission check enum gains `diversity`, and a Worker descriptor gains
  `family` (a minor version of each schema).
- **Known limits.**
  - A named node's family is read from the live Worker descriptors when the
    exclusion is computed, not recorded when that node routed. If the Worker is
    no longer listed, the node fails with `config_error` (fail closed). If its
    family changed in between, the comparison uses the new value.
  - Families follow the Worker source. One vendor reached through a website, an
    API route, and an agent runtime counts as three families, unless the
    operator's model catalog sets the same family. A per-account or per-runtime
    override is a later change; the MVP composition has only website Workers.
  - For model Workers, two routes to one upstream model are different families
    unless the operator's catalog says otherwise.
