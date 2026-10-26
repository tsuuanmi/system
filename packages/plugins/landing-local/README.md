# @tsuuanmi/system-landing-local

`ctx.landing`, local: the [landing seam](../../landing-core/README.md)'s provider that wraps today's
local landing unchanged
([ADR-0060](../../../docs/decisions/adr/0060-an-accepted-result-lands-on-the-operators-merge-approval.md);
[PROP-0017](../../../docs/proposals/0017-github-front-door.md#one-landing-seam-two-providers) L0;
[the landing seam](../../../docs/design/workflow-engine.md#the-landing-seam)). Bundle row
`landing-local`, on.

| Call | What it does |
|---|---|
| `prepare(target)` | the subject `{ git-head, system/run/<runId>, landing:merge:<base>:<head> }` (`landingVersion`), and the consequences: on approval, the system merges the branch into the base as one merge commit, never a force or a push, a conflict or a moved branch changing nothing; denied or unanswered, nothing is merged. A version longer than a request's subject holds (128) is refused (`failed`): merge it by hand |
| `land(request)` | on an approval of exactly that subject (else `unbound`, nothing asked of any source), the merge step of `workers.land`: the source that holds the run's worktree (the `agents` source) merges the branch into the repository's checked-out branch, only while the branch is at the approved head and the base at the approved SHA and clean; a base that already holds the head is `already` landed (INV-4). Its refusals pass through with their cause; no source holds the worktree: `gone`; the workers seam has no `land`: `failed` |
| `status(target)` | `unknown`: the merge step reads where a landing stands, and does nothing again when it is done |

- `LocalLanding` provides the seam over `ctx.workers` (`inject: workers`); `localLanding(workers)`
  is the same provider as a plain call over a given workers seam. The workflow engine depends on the
  seam's definition only, never on this package: with this row off, a landing waits for a provider.
- It never pushes, and never names a code host.
- `tests/landing-local.spec.ts` runs the seam's conformance suite at contract 1.0 against it twice,
  as the provider of `ctx.landing` and as a plain call, over a Worker source that merges in a
  `MemoryRepository` as the `agents` source does; and checks that it asks the merge step exactly as
  the engine did before the seam.
