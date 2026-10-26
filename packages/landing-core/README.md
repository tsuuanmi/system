# @tsuuanmi/system-landing-core

The landing **seam definition**
([plugin model](../../docs/architecture/plugin-model.md#seam-catalog), plugin rule 2;
[ADR-0037](../../docs/decisions/adr/0037-schema-and-protocol-first.md);
[PROP-0017](../../docs/proposals/0017-github-front-door.md#one-landing-seam-two-providers) L0). A
guarantee seam of the gate (core: gate): an irreversible action goes to a person, so nothing lands
without an approval bound to the exact head and target, and a refusal changes nothing (INV-2,
INV-5). Its contract changes only through an ADR
([ADR-0036](../../docs/decisions/adr/0036-guarantee-core-and-capability-plugins.md)).

| Seam | Definition | Providers |
|---|---|---|
| `ctx.landing` | abstract `Landing` (`id`, `prepare(target)`, `land(request)`, `status(target)`), the calls every provider answers `LandingProvider`, and its vocabulary: `LandingTarget`, `LandingSubject`, `Prepared`, `LandRequest`, `Landed`, `LandingRegenerated`, `LandingRefusal` and its causes (`LANDING_REFUSAL_CAUSES`), `LandingStatus`, `sameSubject`, `SUBJECT_VERSION_MAX` (128); `LANDING_CONTRACT` (1.0) | [`landing-local`](../plugins/landing-local/README.md) (its row on): today's local merge (ADR-0060). The workflow engine consumes this definition only: with no provider registered, a landing waits |

- **Where the seam starts.** After the commit, and after a target that moved was rebased and its
  checks run again (ADR-0068): those are the same for every provider and stay in the workflow engine,
  over `workers.land` ([the landing seam](../../docs/design/workflow-engine.md#the-landing-seam)).
- **`prepare(target)`**: the subject a `merge` approval binds (the run's branch, at a version naming
  the exact head and target, at most 128 characters), and what an approval and a denial do, in words
  for the request; changes nothing.
- **`land(request)`**: only while `request.subject` is the one `prepare` gives for its target (else
  `unbound`), the branch at `head`, and the target at `base.sha`: the target's new head (`commit`)
  that holds the result, `already` when the target held it before (never landed twice), the Worker
  source that did it, and any generated files made again; or a typed refusal (`base-moved`,
  `head-moved`, `dirty`, `conflict`, `busy`, `gone`, `moved`, `failed`) with why.
- **`status(target)`**: `landed` at a commit, `open`, or `unknown` with why, when a provider cannot
  tell without acting.
- It depends on Cordis (a peer) only.
- The conformance suite is [`conformance/landing.ts`](conformance/landing.ts), run through the
  [conformance runner](../libs/conformance/runner.ts) at contract 1.0, over a `World` the test
  supplies (the repository a provider lands in, read and moved from outside it; `MemoryRepository`
  is one in memory, with the local merge's semantics):
  - `prepare` gives the same subject for the same target and another for another head or target,
    on the run's branch, within a request's subject, and changes nothing;
  - `land` lands on an approval of that subject, and the target's new head holds the result;
  - asked again, it reports the same commit as `already` and the target does not move;
  - another subject is refused as `unbound`, a moved target as `base-moved`, a moved head as
    `head-moved`, each changing nothing;
  - `status` never says landed before it is; after, landed at the reported commit, or `unknown`.

  `tests/landing.spec.ts` runs it against the fake `FakeLanding` (a `MemoryRepository` of its own);
  [`landing-local`](../plugins/landing-local/README.md)'s tests run it against the local provider.
