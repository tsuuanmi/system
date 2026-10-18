# ADR-0032: Admission refuses input longer than a Worker takes

- **Status:** Accepted
- **Date:** 2026-10-18 (accepted 2026-10-18, by Researcher's review of the design note)
- **Related:** REQ-WRK-1, [ADR-0027](0027-provider-diversity-in-routing.md),
  [ADR-0031](0031-model-worker-sessions-by-replay.md), INV-2, INV-11

## Context

A Worker can lose an over-long input: the Gemini site drops a paste of about 30,000 characters
without an error (observed live). Only the Gemini driver refused, after routing, so the router
could admit a Worker that would refuse or drop the work, spending an attempt. Admission proved
capabilities, locality, state, and tier (REQ-WRK-1), never size.

## Options

1. Keep the refusal in each driver: routing stays blind, and a refusal costs an attempt.
2. Let the engine pick Workers by name for big inputs: names a vendor (INV-11).
3. **A Worker declares the longest input it takes; the caller states the input's length; admission
   compares them.**

## Decision

Option 3.

- **Descriptor.** `capability-descriptor@1.2` adds the optional `maxInputChars`: the longest input
  the Worker takes, in characters (code points) of what it is sent. A source declares it only when
  it knows one; absent means no declared bound.
- **Route options.** `route(requirement, { input: { chars } })`: the input as it will be sent,
  measured by whoever rendered it. The workflow engine measures a node's rendered prompt, a
  review's shown source included. It is not part of the stored requirement.
- **Check.** A new admission check, `input`, after `capability`, refuses a Worker whose
  `maxInputChars` is below the input: "the input has N characters; it takes at most M".
- **History.** A source that replays history (model sessions, ADR-0031) bounds that history itself,
  at start (`maxHistoryChars`); the declared bound is the per-turn prompt's.
- **Failure.** With no Worker left for its length, the work fails unsent as `invalid_input`, and the
  engine names the bound that sized it: a review's `repositories.maxSourceChars`, or else the input
  or the Worker's own bound.

## Consequences

- An over-long input never reaches a Worker that would drop it; another Worker that takes it is
  admitted instead, or the work fails before anything is sent (INV-2).
- The check compares numbers only: no vendor is named (INV-11). The Gemini driver declares its
  `maxPromptChars`; a model entry may declare `maxInputChars`; sources that know no bound declare
  none.
- A driver keeps its own refusal as a backstop, from the same configured value.
