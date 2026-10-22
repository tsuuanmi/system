# ADR-0036: Guarantee seams form the core; capability seams are replaceable plugins

- **Status:** Accepted
- **Date:** 2026-10-22 (accepted 2026-10-22, by the operator, with [PROP-0009](../../proposals/0009-core-and-plugin-decomposition.md))
- **Related:** [ADR-0007](0007-everything-is-a-plugin.md), [ADR-0008](0008-tool-agnostic.md),
  [ADR-0018](0018-build-on-dsh-core.md), [PROP-0008](../../proposals/0008-studio-operating-model.md),
  [INV-10](../../architecture/invariants.md#inv-10-everything-is-a-plugin)

## Context

ADR-0007 makes every part of `system` a plugin and leaves no privileged core to patch. That is
right for replaceability, but it does not say which seams carry the system's guarantees and
which only carry capability. Without that line, provider-specific code and correctness
guarantees sit side by side in the seam catalog, every change is judged the same way, and the
evolution PROP-0008 asks for (plugins replaced as better ones appear) has no safe boundary to
happen behind. PROP-0009 derives that boundary from first principles.

## Options

1. **Keep one undifferentiated seam catalog.** Every seam is equal; reviewers decide case by case
   whether a change can weaken a guarantee.
2. **A privileged core outside the plugin model.** Contradicts ADR-0007 and INV-10, and gives up
   the composition and disposal rules the core relies on.
3. **Classify seams.** Implementations stay Cordis plugins, as ADR-0007 requires, but each seam is
   either a **guarantee seam**, belonging to one of six core components whose contracts are fixed
   by the invariants, or a **capability seam**, belonging to one of eight plugin families whose
   providers are freely replaceable.

## Decision

Option 3.

**The test.** A seam belongs to the core if replacing its provider with a worse one could make
`system` incorrect (wrong results, lost data, work done twice), unsafe (an unapproved
irreversible action, leaked data), or change every other component. Otherwise it is a
capability seam: a worse provider only makes `system` less efficient.

**The six core components:** ledger of record, work state machine, runner, gate, resource
ledger and metering, plugin host. **The eight plugin families:** Worker, decision, verification,
digest, context, workflow, knowledge, surface. The
[plugin model](../../architecture/plugin-model.md#core-and-plugin-classes) assigns every seam.

**Rules that follow:**

- The core decides *that* something happens; plugins decide *how*. The core never calls a model,
  never judges content, and has no UI.
- A capability plugin depends on seam definitions, never on another plugin's implementation.
  Across families it cooperates only through the core, by artifacts or events; within one
  family, providers may build on each other's seams (a website Worker uses `ctx.browser`).
- Capability plugins fail open: an optimization that fails is bypassed and recorded. Guarantee
  seams fail closed (INV-2): the gate denies, the ledger of record stops writing until recovery.
  A verification plugin that fails means no automatic acceptance, never acceptance by default.
- Changing a guarantee seam's contract needs an ADR, like an invariant. A capability seam's
  contract changes by a versioned definition and its conformance suite (plugin rules 1 and 7).

## Consequences

- ADR-0007 stands: everything is still a plugin and still composed by configuration. This record
  adds a classification over it, not a privileged code path.
- Guarantee seams that do not exist yet become planned work: the resource ledger, the approval
  queue with the autonomy policy, and the board's project and task states. Capability seams for
  digests, context plugins, and knowledge become planned families. Their mechanisms are proposed
  in PROP-0008, which stays a draft until reviewed.
- Website drivers, UI maps, and the browser runtime are classified as the Worker family; model
  healing as a decision plugin; team review as a workflow plus verification plugins. No package
  moves in this decision.
- Revisit if a capability seam turns out to hold a guarantee (it is then promoted, with an ADR),
  or if a guarantee seam's provider has to vary by deployment.
