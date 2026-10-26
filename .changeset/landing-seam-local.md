---
"@tsuuanmi/system-landing-core": minor
"@tsuuanmi/system-landing-local": minor
"@tsuuanmi/system-workflow": minor
"@tsuuanmi/system-bundle": minor
---

Landing an accepted result now goes through one seam, `ctx.landing` (PROP-0017 L0). Behaviour is unchanged.
- The new package `@tsuuanmi/system-landing-core` defines the seam: the abstract `Landing` and the calls every provider answers (`LandingProvider`), at contract 1.0. `prepare` gives the subject a `merge` approval binds and what an approval does. `land` lands only on an approval of that exact subject and reports the landed commit or a typed refusal. `status` says where a landing stands. The package also holds the seam's conformance suite (`conformance/landing.ts`) and a fake, `FakeLanding`, that passes it.
- The new plugin `@tsuuanmi/system-landing-local` (bundle row `landing-local`, on) is the local provider. It wraps today's local merge (ADR-0060) unchanged: the `agents` source merges the run's branch into the checked-out branch through `workers.land`, on the operator's approval of `landing:merge:<base>:<head>`, and never pushes. It passes the suite as `ctx.landing` and as a plain call (`localLanding`).
- The workflow engine takes the merge request's subject and consequences from the provider of `ctx.landing`, and merges through it on the subject the approved request names. It depends on `landing-core` only. With no provider registered, a landing waits as it is: nothing is asked or merged, and it never lands some other way. A provider that changed after the approval lands nothing on that approval; the merge is asked again on its own subject. The commit and ADR-0068's rebase and re-check stay in the engine. The existing landing tests pass with their assertions unchanged, the provider mounted as the bundle mounts it.
