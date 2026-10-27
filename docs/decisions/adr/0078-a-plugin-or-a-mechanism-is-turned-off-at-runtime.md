# ADR-0078: An optional plugin or a gate-like mechanism is turned off at runtime, on the operator's word

- **Status:** Proposed
- **Date:** 2026-10-27
- **Related:** T322, T317, D108,
  [ADR-0036](0036-guarantee-core-and-capability-plugins.md),
  [ADR-0048](0048-the-plugin-host-checks-the-composition-at-start.md),
  [ADR-0076](0076-the-lead-is-a-principal-of-its-own-with-a-closed-list-of-rights.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-6](../../architecture/invariants.md#inv-6-authority-comes-from-trusted-envelopes),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact)

## Context

The operator, 2026-10-27 (D108): "everything as plugins; if something is not right, just turn it off
as DSH plugins do; with it off System still works, without many restarts". Until now a row was turned
off only by `disabled: true` in the profile's patch and a restart, and a gate-like mechanism (the
evidence gate, the handbook bound, the lead-rights check) only by a code change. Several of them were
switched on at once and broke the flow.

ADR-0048 kept the plugin host a record: it "never mounts, stops, or gates a plugin", partly because
stopping a running fiber from outside makes the DSH loader persist `disabled: true` into the entry
tree it came from. Read again: the loader writes that back only when a fiber unloads while its entry
is still enabled; `Entry.update({ disabled })` sets the entry's flag first, disposes the fiber without
writing, and applies it again on `disabled: false`. So the host can turn a row in the running daemon
without rewriting the operator's configuration, and write the operator's patch itself.

The plugin host is a guarantee seam: its contract changes only by an ADR, additively.

## Options

1. **Restart only.** The operator edits the patch and restarts: what the operator asked to stop.
2. **The host turns a row on the operator's word, and holds each mechanism's live mode** (chosen).
3. **Each mechanism reads its own configuration live** (a volatile config key per row). A Cordis
   volatile key would change one plugin's mode without a restart, but each row would need its own,
   the change would not be a decision, and the operator would have no one place to read them.

## Decision

Option 2. The plugin host's contract moves from 1.1 to 1.2, as a minor: each addition is optional.

- **Rows.** `rows()` lists every row: on or off, required or optional (`rowRequirement`: a core class
  is required, a plugin family optional, no manifest required unless the host's
  `optionalWithoutManifest` names the package), and its last runtime turn. `turn(row, on, reason)`
  refuses a required row and an unknown one, and refuses to turn off a row whose plugin provides a
  seam the switches are served on (`ctx.mcp`, `servesSwitches`): a switch never removes its own
  control surface, since nothing could turn it on again (its patch still turns it off). It edits the
  profile's patch by lines first (one it cannot edit refuses the turn), records the turn's `lifecycle`
  decision with the reason before anything moves (INV-13), turns the loader's entry, and waits, within
  `quiesceSeconds`, for the plugin's disposal (its disposers finishing or handing back its in-flight
  work, plugin rule 3) or its start. Past the bound, or on a failed start, the row is put back and a
  decision chained to the turn's records that it did not complete; the patch is not written (INV-9,
  INV-2). Then, in one store transaction, the plugin's and the turn's records and the patch. A crash
  between the decision and that transaction leaves the decision unanswered, and the next start
  reconciles from the patch (INV-4). One turn at a time.
- **Mechanisms.** `MECHANISMS` (libs) names each gate-like mechanism, its owning row and key, and the
  modes it takes. The owning row's `enforce.<key>` is the start value; `setEnforce(mechanism, mode)`
  sets a live override, a `gate` decision of rule `plugin-host.enforce` first, kept in the store across
  restarts; `configured` clears it. `enforced(mechanism)` is read by the mechanism at each use.
  `lead-rights` takes only `on`: each refusal of the lead's closed list is a bound of authority
  (ADR-0076, INV-6); the way to stop a lead is to revoke its token.
- **Surfaces.** MCP `plugin` and `enforce` (operator), `system plugin` and `system enforce`.
- **The rule for a new mechanism**: it lands as an optional row or behind such a switch, off or warn,
  and moves to on only after 7 days clean ([plugin model](../../architecture/plugin-model.md#turning-a-plugin-off)).

This supersedes in part ADR-0048's boundary that the host never stops a plugin: it still never stops
one by itself, and its manifest check still refuses nothing.

## Consequences

- An optional row is turned off and on again with no restart; the removability matrix does so for
  every optional row, smoking after each turn: off then on for each row on in its baseline, on then
  off for each that ships off (`digest-extractive` swapped with `digest`, one provider at a time).
  `mcp-server` is the exception: its runtime turn off is refused.
- The manifest check runs at start only: a row turned on at runtime is checked at the next start.
- A dependant of a row turned off waits on its inject, as Cordis has it, and resumes when it is on.
- The fake provider holds no loader and stays at contract 1.1.
- Revisit when the autonomy policy gains a field for the days clean, or DSH offers its own runtime
  toggle.
