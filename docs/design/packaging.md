# Packaging: a project from a template

> Implemented in [`packages/cli`](../../packages/cli/src/project.ts) (`system project new`) with
> the templates in [`packages/cli/templates`](../../packages/cli/templates/README.md); differs from
> target: one kind (`software-repository`) of PROP-0016 §6's three; the attention budget, portfolio
> scheduling, reporting up, and global ids are later parts of I5.

[PROP-0016](../proposals/0016-operating-model.md) §6 packages what the `system` project was set up
with by hand into a **template by kind**, so a second project (the operator's D87: the DNA
repository) starts from a known frame instead of from the lead's memory. Each project has its own
lead session; only the operator's UI is shared (D88).

## What a template holds

A template is data: a directory per kind, `templates/<kind>/`, no code. `software-repository` v1
holds, by [handbook](handbook.md) layer:

| File | Holds | Layer |
|---|---|---|
| `charter.json` | the charter draft: objective, scope, non-goals, done-when (each a criterion with its measure), budget lines, stop rules, a first milestone | 3, project charter |
| `template.json` `policy` | the project policy's rules, default, and expiry; its commands list is rendered from the toolchain | 2, organisation policies |
| `template.json` `toolchains` | per toolchain, chosen by the lockfile at the repository's top level (`pnpm-lock.yaml`, `package-lock.json`, `Cargo.lock`, `uv.lock`): the setup command run offline, its views, the checks by kind (`tests`, `lint`), dependency files, check scratch, generated files when known | configuration of `agent-workers` |
| `template.json` `role` | the writing role `<id>-develop`: `workspace-write`, a worktree per run, the repository its workspace | configuration of `agent-workers` |
| `template.json` `autoAccept` | off: auto-accept ([ADR-0067](../decisions/adr/0067-system-accepts-a-listed-branchs-result-on-its-review-and-checks.md)) is the operator's to turn on per project | configuration of `board` |
| `lessons.md` | an empty lessons file with T220's bounds (at most 30 lines of 400 characters, each naming `Check:`) | 5, repository lessons |
| `LEAD.md` | the lead's onboarding: what to read (the lead's playbook, T252; the charter; the policy; the lessons), a checklist, and what the template could not know | 4, role playbooks (pointer) |
| `decisions.md` | the project's decisions file, its first line the project's start | records |

Values are filled into `{{name}}` placeholders: `id`, `repository`, `repositoryName`,
`targetBranch`, `coordination`, `home`, `pnpmStore`, `kind`, `templateVersion`, `date`. A
placeholder with no value is the template's fault and refuses the render.

## What the command does

`system project new --kind <kind> --id <id> --repository <path> [--target-branch <b>]
[--coordination <dir>] [--dry-run]`, in order, stopping at the first refusal with nothing written
or asked:

1. **Refusals.** An unknown kind (naming the kinds there are); an id that is not a lowercase
   letter followed by up to 23 lowercase letters, digits, or `-` (so `<id>-develop` is a role id);
   a repository that is not absolute, not there, not a git checkout, or not its top level; a
   **target branch the landing cannot honour**: a landing merges into the repository's checked-out
   branch ([ADR-0060](../decisions/adr/0060-an-accepted-result-lands-on-the-operators-merge-approval.md))
   and no configuration names another, so the target branch is the checked-out one, and a detached
   HEAD, or a `--target-branch` other than the checked-out branch, is refused; an **id in use**:
   its coordination directory exists (unless it records this creation's outstanding requests, step
   6), the board has a project of that id, or the policy set holds a policy for it; and, without
   `--dry-run`, no running profile whose board answers.
2. **Render** the template with the values. The toolchain is the first whose lockfile the
   repository holds; none is a refusal.
3. **Validate** what was rendered, every problem listed: the charter request against
   `mcp-board@1`'s `board-charter-input`; the studio and project policies against
   `autonomy-policy@1`; the policy set they make against the approval queue's own load-time rules
   (its `checkConfig`); the role and the worktree setup against the `agent-workers` config schema
   and its load-time rules (the setup beside a Worker of that workspace with a worktree per run,
   as it must be to ever run). These are the checks `system check` runs, loaded from the bundle.
4. **List every write and request.** The only directory written is the coordination directory
   (default `~/workspaces/<id>-coordination`, beside `system-coordination`): `LEAD.md`,
   `lessons.md`, `decisions.md`, `charter.json`, `policy-change.json`, `profile-patch.yml`, each
   created new, never overwritten, and `requests.json`, the ledger of which requests were filed
   (`project-requests@1.0`, [schemas](../reference/schemas.md#project-requests), validated before
   each write and when read back; one that does not validate, or of an unknown major version, is
   refused before anything is filed).
   `--dry-run` prints the list and every file, and writes and asks nothing.
5. **File** the charter (`board_charter`, retry-safe by `clientRequestId: project-new:<id>`) and
   one policy change (`approvals_policy_propose`) on the approval queue, recording each in
   `requests.json` as soon as it is filed. Nothing applies until the operator approves it.
6. **Complete a partial creation.** When filing stops part-way (the charter filed, the policy
   change not), the same command run again finds the ledger in the coordination directory and
   files only the outstanding requests, the records as first rendered (`charter.json`,
   `policy-change.json`), never refused because the board now holds the project the first run
   made. `--dry-run` names what is outstanding. A ledger of another id, or with every request
   filed, is an id in use.

The **profile patch fragment** (the role, the worktree setup, and, as comments, the account
assignment, the generated files, and auto-accept) is printed and written, **never applied**: a
patch that targets a row replaces its whole config, so the operator merges it into the rows the
profile patch has, runs `system check`, and applies it with a live update.

## The policy layer

A command runs unasked only when **every** applying commands list holds it: the studio policy's
and the project's ([approvals](approvals.md)). A project policy narrows; it never adds. So the
policy layer of a new project is two records:

- the studio policy at its next version with the project's commands added, when any is missing;
- the project policy `<id>.policy`, narrowing the studio's, its commands exactly the project's,
  `merge` asking as the `system` project's does.

Each policy-change request rests on the set in force (its `baseHash`), and a second one on the
same base is withdrawn once the first applies. The command therefore files **one**: the studio
change when commands are missing, otherwise the project policy. `policy-change.json` holds both,
each marked filed or not; the lead proposes the other once the first is decided.

The project's **risk tiers** path map (`riskTiers`, [ADR-0071](../decisions/adr/0071-a-changes-risk-tier-comes-from-the-policys-path-map.md))
is not in the template: an unmatched path is heavy, so a map must match every tracked path of the
repository, which only the repository's layout tells. The lead writes it as a later policy change.

## What stays the operator's

Every effect is a request or a file: the charter, the policy, the profile, auto-accept, and the
budget's pool are the operator's decisions (PROP-0016 §7: a new project, a budget, and a policy
change always escalate). The command never pushes, never touches the repository, and never writes
outside the coordination directory.
