# Routing

> Target state. Boundary: [routing](../architecture/components.md#routing).
> Purpose: [P1–P4](../requirements/purpose.md). Requirements: REQ-WRK-1..9.

Routing turns a **work requirement** into exactly one admitted Worker, or into a
typed admission failure. It is deterministic: the same configuration, the same
Worker states, and the same requirement always give the same result
([INV-2](../architecture/invariants.md#inv-2-fail-closed)).

## Work requirement

```ts
WorkRequirement {
  capabilities: Capability[];        // all must be proven
  data: { classification: "public" | "operator-shared" | "local-private";
          refs: ArtifactRef[] };      // what the work must read
  egress: EgressPolicyRef;           // what may leave the machine (from a trusted envelope)
  tier: { min: Tier; max?: Tier };   // "economy" | "standard" | "frontier"   (P4)
  budget?: { maxTokens?, preferQuota?: QuotaClass[] };
  acceptance: AcceptanceContract;
}
```

## Capability vocabulary

Capabilities are named semantics. They are never tool names
([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)). A Worker proves
each one with evidence from the sources shown below.

| Capability | Meaning | Typical evidence |
|---|---|---|
| `reason` | general reasoning and synthesis | provider driver conformance |
| `web-search` | search the live web with citations | feature probe on the account |
| `deep-research` | provider-native multi-step research report | plan + feature probe (P2) |
| `connector:<name>` | a website connector or app enabled on the account, e.g. `connector:github` | connector probe on the account (P2) |
| `persistent-conversation` | resumable multi-turn identity | resume conformance test |
| `local-data` | can read local files and datasets in place | runs on this machine; sandbox policy allows the paths |
| `develop`, `validate` | edit code, run tests in a workspace | agent-runtime probe + sandbox mode |
| `review` | assess a provided subject against criteria | driver or runtime conformance |

Profiles express each node as capabilities, not Worker kinds. A research node
requires `deep-research` or `web-search` together with `reason`. An implementation
node requires `develop` and `local-data`.

## Algorithm

```text
candidates = registry.workers
  → filter: every required capability proven now          (admission, fail-closed)
  → filter: data locality policy                          (P3)
  → filter: account state ready, quota not exhausted      (P1)
  → filter: tier within [min, max]                        (P4)
  → order:  lowest tier first, then quota class preference (P1),
            then configured priority list, then stable id
  → first candidate, or AdmissionFailure listing why each candidate was rejected
```

Quota and health are inputs **before** admission. Once a turn starts on a Worker,
it is never moved to another one. Running out of quota mid-turn is a classified
failure (`USER_ACTION` or `BACKOFF`), not a silent switch to a different provider.

## Data locality policy

- Work whose `data.classification` is `local-private` is admitted only to Workers
  that run locally, unless the egress policy names the exact artifacts that may
  be sent, and to which Worker classes.
- Before content reaches a remote Worker, the egress check runs on the **actual
  payload**: the rendered prompt plus its attachments. Each artifact ref is
  checked against the policy. A payload that is not permitted fails closed
  ([INV-12](../architecture/invariants.md#inv-12-data-egress-is-explicit)).
- What goes back the other way is not restricted. Results from website Workers
  flow freely to local Workers as cited artifacts.

## Intelligence tiers

- Each Worker *configuration* declares its tier. A tier belongs to a Worker plus
  its mode, so the same website account can provide an `economy` Worker (instant
  mode) and a `frontier` Worker (highest effort or Deep Research). The provider
  driver verifies the mode before every send (REQ-PRV-3), so a declared tier is
  always the tier that actually runs.
- Profiles declare each node's minimum tier, for example triage → `economy`,
  research → `frontier`, compacting a handoff → `economy`, final synthesis →
  `frontier`.
- **Escalation:** if acceptance rejects a result, the policy can open a *new*
  execution at the next tier, at most `maxEscalations` times (default 1). The
  rejected result stays as evidence. Escalation is recorded in the event log and
  is never applied to a running turn.
- Planning and synthesis may use a higher tier than the steps they coordinate,
  in line with "spend intelligence where intelligence matters".

Inferring the tier for work that does not declare one, using a decision model, is
under consideration in
[PROP-0002](../proposals/0002-decision-assisted-routing.md). It is not current
design.

## Quota and cost policy

- Each account and runtime declares a **quota class**: `subscription-chat` for
  website accounts, `agent-plan` for Claude Code and Codex plans, and `metered`
  for APIs. The routing policy prefers `subscription-chat` for `reason`,
  `web-search`, `deep-research`, and `review`, and keeps `agent-plan` and
  `metered` for capabilities only they prove, such as `develop` and `local-data`
  (P1).
- Usage is recorded per account from observable signals (turn counts and
  estimated tokens) and treated as an estimate (CON-4). A provider "limit
  reached" state marks the account temporarily not ready, and routing excludes
  it.
- **Context economy.** Handoffs carry the synthesized, hash-bound result, not the
  research transcript. Retained conversations receive only new suffixes. Node
  results are reused by input hash.
