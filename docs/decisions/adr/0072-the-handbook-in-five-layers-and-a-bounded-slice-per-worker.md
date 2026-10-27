# ADR-0072: The handbook in five layers, and a bounded slice per Worker

- **Status:** Accepted (2026-10-27; the design built in T249, `88b453a4`; the slice in every brief in T259, `b311a213`; the lead's playbook in T252, `9afeb362`)
- **Date:** 2026-10-26
- **Related:** T249, T220, T237, [PROP-0016](../../proposals/0016-operating-model.md) §2 and D83 #3,
  [ADR-0041](0041-policy-changes-through-the-approval-queue.md),
  [ADR-0057](0057-route-work-by-kind.md),
  [ADR-0070](0070-workers-that-share-no-session-work-through-a-tasks-dossier.md),
  [ADR-0071](0071-a-changes-risk-tier-comes-from-the-policys-path-map.md),
  [INV-2](../../architecture/invariants.md#inv-2-fail-closed),
  [INV-9](../../architecture/invariants.md#inv-9-everything-is-bounded),
  [INV-11](../../architecture/invariants.md#inv-11-no-tool-lock-in),
  [INV-13](../../architecture/invariants.md#inv-13-every-decision-is-an-artifact),
  design: [handbook](../../design/handbook.md)

## Context

PROP-0016 (accepted 2026-10-26, D83) asks for one handbook in five layers, each with an owner, a
version, and a check, and for each Worker to get only its slice, within 6,000 tokens: a warning for
30 tasks, then a refusal (D83 #3). Today the rules are spread over the invariants and ADRs, the
autonomy policy and its path map (ADR-0071), the charters, the templates' prompts, `AGENTS.md`,
`CONTRIBUTING.md`, the engineering docs, and the lessons. A writing agent Worker's prompt carries
the lessons and its gate's note, appended by its Worker source and recorded nowhere as rules;
whether it reads `AGENTS.md` depends on its runtime; a reviewer never gets the lessons, though two
of them name the review as their check. The [inventory](../../design/handbook.md#the-rule-inventory)
counts 94 rules, 45 with no check, 13 written in two or more places, and 8 contradictions.

## Options

1. **Give every Worker the whole handbook.** Costs tokens on every run, and dilutes the rules that
   matter (PROP-0016's rejected alternative).
2. **Leave each source to append what it knows (today).** No bound across the parts, no record of
   what was given, and the parts differ by runtime.
3. **A slice selected by role, task class, risk tier, and touched paths; composed in two halves (the
   engine's, recorded with the brief; the Worker source's, for what only it knows); bounded as a
   whole with a share per layer; each layer's version recorded.** Chosen.

## Decision

1. **Five layers**, each rule in one home: constitution (operator: invariants, ADRs), organisation
   policy (operator, the lead proposing: the autonomy policy, the path map, trust tiers, escalation,
   budgets), project charter (operator with the lead: the board's charter), role playbooks (lead:
   the templates' role text and the writing rules of `AGENTS.md`, `CONTRIBUTING.md`, and the
   engineering docs), repository lessons (lead and review: `docs/engineering/lessons.md`). A higher
   layer wins; a lower one may only be stricter. Every rule names its check, or says it has none.
2. **Versions.** Layer 1: the invariants file's git blob and the highest accepted ADR. Layer 2: the
   policy's `version`, the hash of the set in force, and the map's `riskTiers.version`. Layer 3: the
   project id and `charter.version`. Layer 4: the template, its package's version, and the sha256 of
   the playbook text carried. Layer 5: the lessons file's git blob at the Worker repository's HEAD.
3. **Selection.** A part of a layer applies by role (from the step's capabilities), task class (the
   step's kind, ADR-0057, and variant), risk tier, and touched paths. The tier is the run's latest
   `workflow.risk-tier` decision (ADR-0071) where one exists; a writing step before any review reads
   the same map on the paths it knows; an unreadable change is heavy, as ADR-0071 rules; with no map,
   tiering is off and the slice has no tier lines. The paths are the exact subject's for a review,
   validation, or fix, the previous attempt's, or the task's declared ones; where none can be read,
   every path-keyed part of the role is included (INV-2). A lesson may carry an `Applies:` clause; one
   without applies to `develop` and `review`. The reviewer gets the lessons.
4. **Two halves.** The workflow engine composes layers 1, 3, 4, and layer 2's tier lines as a
   `handbook-slice@1.0` pointer (role `context`) when it drafts a brief. The Worker source renders
   the gate view (layer 2) and the lessons (layer 5), each bounded by construction, and records each
   part's version, sha256, and size on the execution it starts (an additive optional field).
5. **The bound.** The handbook part (both halves; the task, its input, pointers, files, and the
   dossier's slice not counted) is at most 6,000 tokens, estimated as `ceil(UTF-8 bytes / 4)`; no
   vendor's tokenizer is used (INV-11). Shares: layer 1 400, layer 2 1,300, layer 3 300, layer 4
   900, layer 5 3,100. The total is what is enforced; a slice over it names every layer over its
   share. The engine counts the source's half at what it renders to where that can be read before
   the Worker is routed (the lessons, with the source's own renderer), and at its constructed maximum
   where it cannot (the gate view); a source's half over its layer's share is refused in either mode
   (T259).
6. **Warn, then refuse.** The bound starts in warn mode: an over-bound slice is sent whole with a
   `gate` decision `handbook.bound` (`warn`) naming the layers. After the slice was built for 30
   distinct board tasks (`handbook.warnTasks`, default 30, 0 to 1,000), a recorded decision moves it
   to refuse mode: an over-bound slice fails its node as `config_error` before routing, nothing sent,
   the decision naming the layers and their owners. Nothing is ever cut to fit (INV-9).
7. **The brief records it.** `brief@1.4` adds the optional `handbook`: the bound and its mode, the
   selection (role, class, tier and its source, how the paths were read), and per layer its version,
   who rendered it, the rule ids it carried, and, for the engine's half, its sha256 and size. A minor
   version.
8. **The lead** gets a slice built the same way, as a file (`system handbook --role lead`), within the
   same bound, recording the same versions.
9. **Adding and retiring.** A new rule names its home, layer, owner, check (or none), where it
   applies, and fits its layer's share, else an old one is folded first; its layer's version moves
   by the change. A rule leaves the slice when a check makes it impossible to break, in the change
   that lands the check.

## Consequences

- A result traces to the rules its Worker was given, by version (INV-13); `system explain` shows
  them beside the run's tier. The number of rules without a check is measured, from 45.
- The reviewer's brief grows by the lessons (about 600 tokens today, at most about 3,100).
- A writing step whose paths are unknown is sliced as heavy: up to about 300 more tokens of layer 1,
  never a rule left out.
- `AGENTS.md` remains the router for a person or an agent outside System; inside System, the rules
  of it that bear on a role reach that role through its slice, recorded, whatever the runtime. No
  `CLAUDE.md` is added.
- A slice over the bound in refuse mode stops work until its layer's owner shortens it: the warn
  period gives 30 tasks of evidence first.
- `brief@1.4` and `handbook-slice@1.0` are new schema versions; the execution record gains an
  optional field. Implementation is I1's later parts; this ADR fixes the contract only.
- Revisit the shares once the warn period has measured 30 tasks' slices.

## Rejected alternatives

The options above; also: a model choosing the rules a Worker needs (not reproducible, PROP-0016's
reason for a path map); cutting an over-bound slice to fit (a silent cut, INV-9); and a vendor
instruction file per runtime (`CLAUDE.md`, `.codex/`), forbidden by the documentation policy and
unrecorded.
