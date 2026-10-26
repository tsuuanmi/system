# @tsuuanmi/system-bundle

The `system` profile's **only** bundle. It inserts the allow-listed DSH core rows
and the `system` plugins, and it does not use `dsh-base`
([ADR-0019](../../docs/decisions/adr/0019-explicit-minimal-dsh-core.md)).

- **Owns:** the composition, which is [`cordis.patch.yml`](cordis.patch.yml).
- **Does not own:** plugin behavior. Each plugin package documents its own.
- **Allow-list:** [DSH core reuse map](../../docs/architecture/plugin-model.md#dsh-core-reuse-map).
  The e2e composition test asserts the exact row set.
- **Claude Code on by default (PROP-0010 B3):** `agent-runtimes`,
  `runtime-claude-agent-sdk`, and `agent-workers` are on, with no Worker: a Worker's
  workspace is a repository the operator names
  ([runbook](../../docs/operations/runbooks.md#agent-workers)). A host without Claude
  Code, bubblewrap, or a sign-in still boots; its Workers are unavailable, and the probe
  says why.
- **The plugin host (B7):** the [`plugin-host`](../plugins/plugin-host/README.md) row is on. It
  reads every row of the composition and the manifest its package declares, and records each
  plugin's lifecycle state (a row on `default`, a row off `candidate`), every change a decision;
  it never turns a row on or off ([plugin host](../../docs/design/plugin-host.md)). Each plugin
  package ships its `plugin-manifest.json`; the row allows exactly the DSH rows to run with none
  (`allowWithoutManifest`), and its manifest check finds any other row that does, and health is
  down.
- **Off by default (PROP-0004):** `runtime-codex-sdk` (its Workers are admitted where the
  probe proves its tool gate on the host, [Codex Workers](../../docs/operations/runbooks.md#codex-workers)),
  `runtime-acp` (it cannot ask a tool gate before each tool call, so no Worker of its is
  admitted), `runtime-antigravity-cli` (its Workers are admitted on an agy version verified
  live, [Antigravity CLI Workers](../../docs/operations/runbooks.md#antigravity-cli-workers)),
  `profile-software-development`, and both model gateways are `disabled: true`, not
  removed. An operator patch turns one back on
  ([runbook](../../docs/operations/runbooks.md#turn-an-off-row-back-on)); the e2e test
  proves that it mounts again.
- **Notifications, off:** the [`notify`](../plugins/notify/README.md) row tells the operator out of
  band what needs them, from recorded events only (an approval request opened or about to expire,
  a run failed for them, a limit wait, a quarantined agent account); the operator turns it on
  ([runbook](../../docs/operations/runbooks.md#get-notified)). Its webhook also needs egress
  declared for the `webhook` class in the `egress` row, whose default lets nothing leave for it.
- **An alternative provider, off:** `digest-extractive` provides `ctx.digests`, as `digest` does,
  extractive-first ([digests](../../docs/design/digests.md#extractive-first)). The operator swaps it
  in by one patch that turns `digest` off and it on
  ([runbook](../../docs/operations/runbooks.md#swap-the-digest-provider)); one provider of a seam
  runs at a time, and `pnpm check:packages` holds exactly one such row on by default.
- **Evolution test:** [`tests/evolution/`](tests/evolution/digest-swap.spec.ts) applies the
  operator's swap patch ([`swap-digests.yml`](tests/evolution/swap-digests.yml)) to this bundle's
  rows and digests the same fixtures before and after, recording the figures
  ([`digest-swap.record.json`](tests/evolution/digest-swap.record.json); Base exit criterion 6,
  [replacing the provider](../../docs/design/digests.md#replacing-the-provider)).
- **The approval queue and the board (B5):** the [`approvals`](../plugins/approvals/README.md)
  row carries the default studio policy, conservative: a read runs, a workspace write runs
  once tests and lint pass, and everything else asks, expiring after a day (at most 14) in
  batches of up to 10 shown within an hour. A patch that targets the row replaces its whole
  config, so it carries the policies too; `system check` names a missing or invalid one. The
  [`board`](../plugins/board/README.md) row asks for every approval through it and is mounted
  only with it; with the board off, runs work as before.
- **The landing seam (PROP-0017 L0):** the [`landing-local`](../plugins/landing-local/README.md)
  row is on and provides `ctx.landing`, so an accepted result is merged into the checked-out
  branch on the operator's approval as before
  ([ADR-0060](../../docs/decisions/adr/0060-an-accepted-result-lands-on-the-operators-merge-approval.md)).
  With the row off, nothing is merged: a landing waits at its merge, saying why, until a provider
  is registered ([the landing seam](../../docs/design/workflow-engine.md#the-landing-seam)).
- **Presets:** [`presets/`](presets/) holds named bundle layers that `system init
  --preset <name>` adds right after this bundle. [`api-first`](presets/api-first/cordis.patch.yml)
  disables every row that drives a website and both model gateways, turns every agent
  Worker row on (Codex, ACP, the Antigravity CLI, and the software-development profile included), and orders quota
  `local`, `metered`, `agent-plan`, `subscription-chat`
  ([ADR-0025](../../docs/decisions/adr/0025-api-first-composition.md)). A preset names
  no vendor, model, or tool. The e2e test asserts each preset's exact row set.
- **Crash suite:** [`tests/crash/`](tests/crash/) kills the engine at each external
  effect of the [effect register](../../docs/architecture/data-flow.md#effect-register)
  and restarts it (`pnpm test:crash`).
