# Runbooks

> Current state. Commands: [CLI](../../packages/cli/README.md). Configuration:
> [catalog](../reference/configuration.md).

## First start

1. `system init` creates the profile, installs the pinned Chrome if the host
   has none, and checks Xvfb. For a composition with no website Worker, run
   `system init --preset api-first` instead ([API-first](#api-first-preset)); it
   skips Chrome and Xvfb.
2. `system start` boots the profile. MCP listens on `127.0.0.1:47317/mcp`.
   The model gateways (`/anthropic`, `/openai` on the same port) and the agent
   Workers are off by default ([turn a row on](#turn-an-off-row-back-on)).
3. Remote login needs a VNC server, either `x0vncserver` (TigerVNC) or
   `x11vnc`. Without root, unpack the package into the profile's tools
   directory and point the `login` row's `vncPath` at it:

   ```sh
   apt-get download tigervnc-scraping-server
   dpkg-deb -x tigervnc-scraping-server_*.deb /tmp/tigervnc
   install -D /tmp/tigervnc/usr/bin/x0vncserver ~/.dsh/system/tools/bin/x0vncserver
   # cordis.patch.yml: - id: login / config: / vncPath: ~/.dsh/system/tools/bin/x0vncserver
   ```

   A Codex Worker needs `codex` the same way:
   `npm i --prefix ~/.dsh/system/tools/codex @openai/codex`, then set the
   runtime's `executable` ([agent Workers](#agent-workers)).
4. Sign in each account: run `system account login <id>`, open the printed
   noVNC link through the printed `ssh -L` command, sign in, and press
   **Save account**. Alternatively, run `system account save <id>` after the
   sign-in. Each login takes a free port of its own, so several accounts can
   sign in at once; the port, and so the `ssh -L` tunnel, changes with every
   login: use the command each login prints (`remotePort` fixes one port, for
   one login at a time).
5. Map the account's tiers to modes in the account catalog (`accounts[].tiers`),
   then check `system account list`. A ChatGPT account maps its tiers to
   `instant`, `medium`, and `high`; one without a model picker cannot be used
   ([remove it](#remove-the-free-chatgpt-account)). A Gemini account maps them to
   `flash-lite`, `flash`, and `pro` (model and thinking level).
6. Connect the clients: `system mcp-config claude|codex` connects over MCP.
   With a gateway row turned on, `system claude-env` and `system codex-env`
   connect through the gateways; while it is off, they refuse and say how to
   turn it on.

## Agent Workers

An agent Worker (Claude Code, Codex, an ACP agent) runs on this machine, under
the `agent-workers` row. The Claude Code rows (`agent-runtimes`,
`runtime-claude-agent-sdk`, `agent-workers`) are on by default, with no Worker;
the Codex and ACP rows are off ([below](#turn-an-off-row-back-on)).

- **Add Claude Code Workers for a repository.** A Worker works in a workspace
  you name, so the bundle configures none. For a repository at
  `/home/me/src/project` (the top level of a git repository with a commit), add
  a reviewer and a developer to your profile patch,
  `~/.dsh/profiles/system/cordis.patch.yml`:

  ```yaml
  - id: agent-workers
    config:
      workers:
        # Reads only: proves review. Never writes, never runs a command.
        - { id: reviewer, runtime: claude-agent-sdk, workspace: /home/me/src/project, sandbox: read-only, tier: standard, worktreePerRun: true }
        # Writes in its own git worktree per workflow run, never your checkout: proves develop,
        # and validate once its commands are proven confined on this host.
        - { id: developer, runtime: claude-agent-sdk, workspace: /home/me/src/project, sandbox: workspace-write, tier: standard, worktreePerRun: true }
  ```

  Both name the same workspace, so both set `worktreePerRun`: the reviewer
  reads the developer's worktree. Then sign Claude Code in inside its Worker
  home (below), restart, and `system explain` or `/ui` shows each Worker ready,
  or why not. Every tool call still asks the approval queue first; with the
  default studio policy a command asks the operator unless a rule lists its
  exact argv.
- **Credentials:** the agent process starts without the daemon's credentials.
  Every variable whose name contains `KEY`, `PASSWORD`, `SECRET`, or `TOKEN`,
  and every `DSH_*` variable, is removed. A credential the agent needs is
  forwarded **by name** with the runtime's `forwardEnv`; its value stays in the
  daemon's environment, never in a config file or in `env`.
  - **Codex on the Responses gateway:** when a Codex Worker's model provider is
    the system gateway, keep the model token in the daemon's environment as the
    variable the provider's `env_key` names
    (`export SYSTEM_MCP_TOKEN="$(system mcp-token --scope model)"`), and set
    `forwardEnv: ['SYSTEM_MCP_TOKEN']` on the `runtime-codex-sdk` row. Without
    it, Codex cannot authenticate to the gateway. Such a Worker needs no login.
    The model token reaches only the model gateways, so the Worker cannot call
    the `system` MCP tools or the web UI with it
    ([scopes](../../packages/plugins/mcp-server/README.md#scopes)). Until agent
    Workers are confined for reads
    ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)), a
    Codex Worker can still read the other token files on disk
    ([threat model](../security/threat-model.md#threats-and-controls)).
  - **Claude Code:** an API key or OAuth token taken from the environment must
    be named in the `runtime-claude-agent-sdk` row's `forwardEnv`.
  - **ACP agents:** each `runtime-acp` agent entry has its own `forwardEnv`.
- **Claude Code Worker home:** Claude Code Workers run with their own
  `CLAUDE_CONFIG_DIR` (`runtime-claude-agent-sdk` config `home`, default
  `~/.dsh/system/claude-home`), never your `~/.claude`, which the read
  confinement hides from every agent. Sign in there once:

  ```sh
  install -d -m 700 ~/.dsh/system/claude-home          # owner-only, or the Worker refuses it
  CLAUDE_CONFIG_DIR=~/.dsh/system/claude-home claude   # then /login, and /exit
  ```

  or forward an API key or a `claude setup-token` token by name instead. Until
  then each Worker is unavailable with "not signed in inside its home".
- **Confined commands**
  ([ADR-0038](../decisions/adr/0038-confined-commands-for-claude-code-workers.md)):
  a `workspace-write` Claude Code Worker runs `Bash` inside the SDK's sandbox,
  nested in the read confinement: it writes only the run's workspace and has no
  network. Install `socat` too (`sudo apt-get install bubblewrap socat`): the
  sandbox's network proxy needs it, and without it each writing run fails at
  start rather than running a command unconfined. If `/ui` shows "commands
  cannot be confined", a sandbox does not start inside the confinement on this
  host (user namespaces refused inside a namespace, or no `bwrap` on the
  daemon's PATH): the Worker stays read-only (`review` only) until it does.
  Commands that need the network (installing packages) fail inside a Worker:
  prepare dependencies in the repository first.
- **Codex Worker home:** Codex Workers run with their own `CODEX_HOME`
  (`runtime-codex-sdk` config `home`, default `~/.dsh/system/codex-home`),
  never your `~/.codex`, which `system mcp-config codex` gives the `system` MCP
  server. Codex starts MCP servers outside its sandbox, so the Worker home must
  configure none: if it does, the Worker is unavailable and runs fail
  (`config_error`) until you remove them
  (`CODEX_HOME=~/.dsh/system/codex-home codex mcp remove <name>`). A Worker that
  uses an OpenAI or ChatGPT login must be signed in inside that home:

  ```sh
  CODEX_HOME=~/.dsh/system/codex-home codex login
  ```

- **Read confinement:** every agent (Claude Code, Codex, ACP agents) starts under
  [bubblewrap](https://github.com/containers/bubblewrap)
  ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)). It
  hides `~/.dsh`, your session's runtime directory (`/run/user/<uid>`), `/tmp`,
  `/var/tmp`, `/dev/shm`, `$CREDENTIALS_DIRECTORY`, the credential stores in your
  home and every coding agent's login there (the list is in the
  [agent-runtimes README](../../packages/plugins/agent-runtimes/README.md)), and wherever you keep the vault, its key, the store,
  or login profiles. The agent gets an empty private `/tmp`. Only
  `~/.dsh/system/tools` (read-only), the Worker's own home, and its workspace come
  back; a workspace that holds one of those paths (your home directory, say) is
  refused. Install a root-owned bubblewrap (`sudo apt-get install bubblewrap`):
  it is preferred over any copy in your own directories. If `system explain` or `/ui` shows a
  Worker unavailable with "reads cannot be confined", the host refuses
  unprivileged user namespaces: on Ubuntu 23.10 and later, allow them for bwrap
  (an AppArmor profile for `/usr/bin/bwrap` with `userns`, or
  `sysctl kernel.apparmor_restrict_unprivileged_userns=0`). Keep the agent CLI
  outside `~/.dsh` or under `~/.dsh/system/tools`; add other paths to the
  `agent-runtimes` row's `readOnly`, and other secrets to its `hide`.
- **`local-private` work:** refused at egress by default (`egress_denied`,
  nothing sent), because the agent's model is remote. Routing still admits the
  Worker, since it is local. If the agent's model runs on this machine, set the
  egress row's `workerClasses` with `local-private` added to `agent`. List
  `website`, `model`, and `model-local` too: the setting replaces the whole
  default.

## Turn an off row back on

The default composition (PROP-0004) keeps these rows in the system bundle but
off (`disabled: true`). The Claude Code agent rows (`agent-runtimes`,
`runtime-claude-agent-sdk`, `agent-workers`) are on (PROP-0010 B3).

| Rows | What they serve |
|---|---|
| `runtime-codex-sdk`, `runtime-acp` | Codex and ACP agent Workers ([agent runtimes](../design/agent-runtimes.md)); neither can ask a tool gate before each tool call, so the `agents` source admits none of their Workers until they can |
| `profile-software-development` | the `agent-review` template, for agent Workers ([templates](../reference/workflow-templates.md#agent-review)) |
| `gateway-anthropic`, `gateway-responses` | the model gateways behind `system claude-env`, `system codex-env`, and `system mcp-token --scope model` ([gateways](../design/gateways.md)) |

1. Add the row to your profile patch, `~/.dsh/profiles/system/cordis.patch.yml`,
   with `disabled: false`:

   ```yaml
   - id: profile-software-development
     disabled: false
   ```

2. Configure the row ([configuration](../reference/configuration.md)), for
   example an `agent-workers` Worker ([agent Workers](#agent-workers)).
3. Restart: `system shutdown`, then `system start`.
4. `system start --dump-config` shows the row without `disabled: true`.

To turn it off again, remove the row from your patch, or set `disabled: true`,
and restart; the Claude Code rows turn off the same way. The `api-first` preset
turns every agent row on for you ([API-first](#api-first-preset)).

At the start after the change, the plugin host records it: `system plugins` shows the row's
plugin `default` once its row is on and `candidate` once it is off, and `system artifact` of
its lifecycle decision (`system plugins --json`) shows the state it left
([plugin host](../design/plugin-host.md)). A start with the same rows records nothing.

## A plugin's manifest is refused

`system health` shows `manifests` degraded, naming the plugin and why: the plugin host refused
the `plugin-manifest.json` its package ships (it declares `_meta`, is not a valid
`plugin-manifest@1.x`, names another package, or is larger than 64 KiB). The plugin still runs
as composed, but its lifecycle is not recorded until its package ships a valid manifest; its
last recorded state stays.

1. `system plugins` shows the plugin, its rows, and why its manifest was refused.
2. A `@tsuuanmi` package's manifest is generated and checked with the code: reinstall the
   release (`system init` from it), which ships valid ones.
3. A third party's plugin: fix its manifest, or ask its publisher to; the host never repairs one.
4. Restart. The start records the plugin's state if it differs from its last record.

A row whose package ships no manifest (the DSH rows) is noted, not degraded: its lifecycle is
not recorded.

## Remove the free ChatGPT account

The ChatGPT driver cannot use an account without a model picker (ChatGPT Free,
PROP-0004; [modes](../../packages/plugins/provider-chatgpt-web/README.md)).
Until it is removed, its Workers are `unavailable` (their tiers map to the
removed `site` preset), so routing never picks them and `system health` reports
them under `workers`. Remove it from the operator configuration before, or
together with, the update that removes the preset:

1. **Profile patch:** delete its entry from the `accounts` row's `accounts`
   list in `~/.dsh/profiles/system/cordis.patch.yml`, and any tier that maps to
   the old `site` preset. Restart. `system account list` no longer shows it, and
   routing has no Worker for it.
2. **Vault entry:** its saved browser state (`system-accounts/<id>`) and login
   credentials (`system-credentials/<id>`) stay encrypted in the vault. An
   account outside the catalog is never listed or routed, and `system` has no
   command that deletes them yet (`system account remove` is planned,
   [CLI](../reference/cli.md#accounts)).
3. **Browser profile:** delete its login profile,
   `~/.dsh/system/login-profiles/<id>`, while no remote login for it is open
   ([login](../../packages/plugins/login/README.md)).

A team (`brainstorm`, `review`) puts each member on its own provider family and
account, so with one ChatGPT account left it needs another provider's account,
such as a Gemini account ([teams](../design/teams.md#membership-model-a)).
`research` needs Workers of two
provider families, such as accounts of two providers, one of them proving Web
search: its two literature reviews run on different families
([templates](../reference/workflow-templates.md#research)).

## API and local models

A model Worker is one entry of the model catalog: an API model, or a model served
on this machine ([models](../design/models.md)). Two rows of the profile's
`cordis.patch.yml` configure it; the key is never in either.

1. **A route** on the `llm-pi-ai` row: an endpoint, its wire protocol, and the
   name of the credential reference that holds its key (`apiKeyEnv`). A route
   the installed catalog already knows needs only `apiKeyEnv`; a hand-declared
   one needs `api`, `baseURL`, and `models` (the `@deepseek-ai/dsh-llm-pi-ai`
   package README lists every route field, including `retryPolicy`):

   ```yaml
   - id: llm-pi-ai
     config:
       providers:
         my-gateway:
           api: openai-completions
           baseURL: https://gateway.example/v1
           apiKeyEnv: MY_GATEWAY_KEY
           models:
             - id: small-model
   ```

2. **A catalog entry** on the `models` row: the Worker `model:<id>`, the route
   and the model on it, and what routing sees. `quotaClass` is `metered` (paid
   per token, the default) or `local`; `locality` is `remote` (the default) or
   `local`; `maxTokens` bounds every answer (default 4096); `family` is the
   Worker's provider family, by default its route: give two routes to one
   vendor the same `family`, so steps that must differ in provider never take
   both ([provider diversity](../design/routing.md#provider-diversity)):

   ```yaml
   - id: models
     config:
       models:
         - id: fast
           route: my-gateway
           model: small-model
           tier: economy
   ```

   Both are targeted patches: each replaces the row's whole config.
3. **The key:** `system model key MY_GATEWAY_KEY` reads it from stdin and
   stores it encrypted in the vault under that reference (operator scope; not
   echoed or logged). Send it again to rotate. A variable of the same name in
   the daemon's environment shadows the vault, and the vault then refuses the
   write. Agent Workers never inherit such a variable (its name contains `KEY`).
4. **Check:** `system start`, then `system ask --tier economy "…"`;
   `system usage` shows the step on `model:fast` with its tokens, and
   `system explain <runId>` shows its egress decision. A missing or refused key
   fails the step as `reauth_required` (`USER_ACTION`) with nothing sent: store
   the key, then `system continue <runId>`.

- **A local model** (a model server on this machine): set `locality: local` and
  `quotaClass: local`. Egress checks it as Worker class `model-local`, which by
  default receives what a remote model does. To give it `local-private` work,
  first make sure the route's `baseURL` is loopback (`127.0.0.1` or `localhost`):
  nothing checks it for you. Then add `local-private` to the egress row's
  `workerClasses['model-local']` (list every class: the setting replaces the
  default). A server that needs no key still
  needs a placeholder reference: the OpenAI-compatible protocol sends one.
- **Egress:** a remote model receives `public` and `operator-shared` content by
  default (Worker class `model`); a credential in a prompt is always refused.
- **Cost:** each provider request may be billed. A transiently failed request is
  re-attempted at most `maxRetries` times (default 2), and a call interrupted by
  a stop or restart is sent once more, so one call is billed at most six times
  with the defaults. `system explain` shows each resend as a `reconciliation`
  decision; the answer records its sends and attempts
  ([effect register](../architecture/data-flow.md#effect-register)).

## API-first preset

For an organization that cannot accept automated use of consumer websites
([ADR-0025](../decisions/adr/0025-api-first-composition.md)):

1. `system init --preset api-first` adds the preset's bundle layer to the
   profile, right after the system bundle. It turns off the display, browser,
   provider registry, website drivers, login, accounts, website turns, turn
   receipts, and both model gateways, turns every agent Worker row (Codex and
   ACP included) and the software-development profile on, and orders quota `local`, `metered`,
   `agent-plan`, `subscription-chat`. Your `cordis.patch.yml` is not touched,
   and a later `system init` keeps the preset.
2. Configure model Workers ([above](#api-and-local-models)) and agent Workers
   ([agent Workers](#agent-workers)).
3. `system start --dump-config` lists the composition: the turned-off rows
   carry `disabled: true`.

Work that needs a website capability fails at admission with the reason, for
example `no Worker can take this work: no Worker proves deep-research`; nothing
is sent anywhere ([templates](../reference/workflow-templates.md#presets)).
`system init --preset default` returns to the default composition.

## One provider family

When a second provider cannot serve work (for example Gemini blocked by Google's check), teams and
research fail admission: they need two provider families
([ADR-0027](../decisions/adr/0027-provider-diversity-in-routing.md)). To run them on one family
instead ([ADR-0029](../decisions/adr/0029-opt-in-same-family-fallback.md)):

1. Turn the blocked website's driver row off (`provider-gemini-web`), so nothing loads it.
2. Set `allowSameFamily: true` on the `workflow` row.
3. Restart (`system shutdown`, then start).

Two team members then share one account, each in its own conversation. The team's answer says
"same provider family", and each run spends that account's quota for both members. To return to
two families, turn the row back on and sign the account in; `allowSameFamily` can stay on, since
a second family is used whenever one is admitted.

## Account re-auth

A turn that fails with `reauth_required` or `challenge` (disposition
`USER_ACTION`) means the account's saved session no longer works.

- **First, re-verify:** `system account verify <id>` opens the site with the
  saved state, sends nothing, and checks the sign-in. If it still signs in as
  the saved account, the signed-out mark was false (a page that only looked
  signed out), and the account is ready again (`account.re-verified` in the
  event log). Nothing is saved. If it does not sign in, sign in again as
  below. Never `system account save` from an old login profile to undo a
  mark: it would replace the newer saved state with older cookies.

- **With stored credentials:**
  1. Run `system account relogin <id>`. The TOTP code is computed locally.
  2. If the site emails a code, supply it with `system account code <id> <code>`.

  A relogin never switches accounts: if the stored credentials sign in as a
  different account than the one saved, it fails with `reauth_required` and
  stores nothing. Switch accounts only through `system account login <id>`.
- **Without stored credentials:** run `system account login <id>` and sign in
  through the remote desktop, as at first start.
- Store credentials once with `system account credentials <id>` (JSON on
  stdin). They are encrypted in the vault and never logged.

- **A challenge** (`system health`: the account is `challenge`; event
  `account.challenged`) is the site's own check, such as Google's unusual-traffic
  CAPTCHA. Nothing loads the site again until you pass it: wait a while (repeated
  automated loads deepen it), run `system account login <id>`, solve the check in
  the login browser, and press Save.
  - A notice of updated terms over the input (Gemini) is handled the same way: `system` never
    acknowledges it. In the login browser, open a new chat, press the notice's own button (not a
    link in it) until the notice is gone, then press Save. Save is refused while it still shows.

- **A session-bound account** (Gemini and ChatGPT;
  [ADR-0030](../decisions/adr/0030-session-bound-accounts-use-their-login-profile.md)) works in
  its login profile. `system account verify <id>` checks it there.
  - `system account login <id>` is refused while operations run in the profile: try again when
    they finish.
  - While the login desktop is open, the account's operations fail as `overloaded` and are
    retried later, so a run may need `system continue` after a long login.
  - The account is signed in on this host only. To move it, sign it in again on the new host.
  - If a crash left a browser `system` started on the profile, it is stopped the next time the
    profile is used (event `browser.profile-orphan`). A browser you opened on the profile yourself
    is never stopped. The account's operations fail as `overloaded` until you close it, and
    `system health` shows `login-profiles` degraded, naming the process.

Then continue the failed run: `system continue <runId>`.

## Backup and restore

State lives in `~/.dsh/system`:
- the store (`system.db`);
- the encrypted vault (`vault.enc`) and its key (`vault.key`).

Login profiles and the managed browser are not state; a new login recreates
them.

- **Back up:** `system backup <empty dir>`. It is safe while the profile runs:
  the store is snapshotted with `VACUUM INTO`, and a manifest records every
  file's hash.
- **The key travels separately.** A backup holds the vault encrypted, without
  its key. Keep `vault.key` somewhere else, for example an offline copy. With
  `--include-key`, the backup holds the key, and must be kept as safe as the
  host itself. A key kept outside the state directory (see
  [key custody](#key-custody)) is never in a backup: `--include-key` is refused,
  and you back the key up where it lives.
- **Restore:**
  1. `system shutdown` stops the profile.
  2. `system restore <dir>` previews the backup and verifies every file
     against the manifest. A manifest naming any file but `system.db`,
     `vault.enc`, and `vault.key` refuses the whole backup.
  3. `system restore <dir> --yes` restores it. The replaced store is kept as
     `system.db.before-restore-<time>`. A host without the vault key is refused
     until the key is put back; name a key kept outside the state directory with
     `--key <path>`.
  4. `system start` starts the profile, and `system usage` shows the restored
     runs.
- Back up before every upgrade.

## Key custody

By default the vault key (`vault.key`) sits beside the vault. That protects
against copied files, backups, and log leaks, not against someone who can read
your whole account. On a shared or managed host, keep it apart:

1. Move the key out of the state directory to an owner-only place on another
   volume, or deliver it as a systemd credential where the host's systemd
   supports credentials for the service (the file is then
   `$CREDENTIALS_DIRECTORY/<name>`, mode `0400`, which the vault accepts).
2. Point the `credentials` row at it in your profile patch:

   ```yaml
   - id: credentials
     config:
       keyFile: /media/keys/system-vault.key
   ```

3. If it is not under `$CREDENTIALS_DIRECTORY` (always hidden from agents),
   add its path to the `agent-runtimes` row's `hide`, so agent Workers cannot
   read it either.

Back the key up where it lives; restore with `--key <path>`.

Data at rest: only credentials are encrypted by `system` (the vault). The store
(prompts, answers, decisions) and login profiles are owner-only files, so a
host that holds private data needs full-disk or home-directory encryption
([threat model](../security/threat-model.md#threats-and-controls)).

## Run as a service

Run the host as a systemd user service, so it starts with the machine and a
failure is noticed. Below, `<node>` is a supported Node (`node --version`, see
[CON-2](../requirements/constraints.md)) and `<system>` is the checkout's
`packages/cli/lib/bin.js`. Allow the user's services to run without a login
session: `loginctl enable-linger`.

`~/.config/systemd/user/system.service`:

```ini
[Unit]
Description=system harness

[Service]
ExecStart=<node> <system> start
# Drain first: no new run is admitted, running ones finish or resume on the next start.
ExecStop=<node> <system> shutdown --deadline 600
TimeoutStopSec=660
Restart=on-failure
UMask=0077

[Install]
WantedBy=default.target
```

Logs go to the journal: `journalctl --user -u system`.

**Health.** `system health` exits 0 healthy, 1 degraded, 2 down (or not
answering), and prints what to do for each check that is not ok. Run it on a
timer and let the operator's own notification run on failure:

```ini
# ~/.config/systemd/user/system-health.service
[Unit]
OnFailure=<your notifier>.service

[Service]
Type=oneshot
ExecStart=<node> <system> health

# ~/.config/systemd/user/system-health.timer
[Timer]
OnCalendar=*:0/15

[Install]
WantedBy=timers.target
```

`/healthz` on the MCP port answers `ok` with no token, for a supervisor that
only needs liveness.

**Backups.** A daily timer around [backup](#backup-and-restore):

```ini
# ~/.config/systemd/user/system-backup.service
[Service]
Type=oneshot
ExecStart=/bin/sh -c '<node> <system> backup "$HOME/backups/system-$(date +%%F)"'

# ~/.config/systemd/user/system-backup.timer
[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

Enable them: `systemctl --user enable --now system.service system-health.timer system-backup.timer`.
Prune old backup directories yourself; each one is a full snapshot.

## Upgrade with drain

1. `system backup <dir>`.
2. **Check the profile against the new code** before stopping anything: build
   the new version in its own checkout, then run its CLI against this home,
   `node <new checkout>/packages/cli/lib/bin.js check`. It loads every row of
   the profile as composed now (the operator's patch included) against the new
   plugins' config schemas and checks, such as a configured workflow template
   that uses a removed team procedure. It exits 1 and names each problem; fix
   the patch, and check again until it says `ok`.
3. `system shutdown --deadline 600`. This drains first: no new run is admitted
   (gateways answer 529 or `response.failed`), and the command waits for runs
   that are executing. Runs still executing at the deadline are durable and
   resume after the restart. When the workflow engine is not running (a plugin
   failed), there is nothing to drain: the command says so and stops the host
   directly, once `/proc` shows the discovery file's process is this home's DSH
   profile; otherwise it stops nothing.
4. Update the code, then `pnpm install && pnpm build`, or install the new
   packages.
5. `system start`. Store migrations run forward at start, per owner, each in
   one transaction. A run resumes from its durable node records; a submitted
   turn is reconciled, never blindly resent.

`system drain` and `system resume` do the same drain without stopping, for
example to let work finish before maintenance on a provider account.

**Upgrading to scoped control credentials**
([ADR-0023](../decisions/adr/0023-scoped-control-credentials.md)): the new
version creates `operator.token`, `client.token`, and `model.token` at start,
and nothing reads `mcp.token` any more, so delete it. There is no compatibility
path. Once the profile runs the new version:

- re-run `system claude-env` and `system codex-env`: a command printed before
  runs `system mcp-token` without a scope, which is refused;
- set the daemon's `SYSTEM_MCP_TOKEN` from `system mcp-token --scope model`
  again for a Codex Worker on the Responses gateway, and restart;
- a client added with `system mcp-config` keeps working, because its helper
  reads the client token on each connection. Re-running it does no harm.

## Rotate a control token

Rotate a scope's token when it may have leaked
([scopes](../../packages/plugins/mcp-server/README.md#scopes)):

1. Delete its file, for example `rm ~/.dsh/system/client.token`.
2. `system shutdown`, then `system start`. A new token is created at start, and
   the old one is refused everywhere.
3. Hand it out again where it was copied:
   - the client helpers (`system mcp-headers`, `system mcp-stdio`) and Claude
     Code's `apiKeyHelper` read the token on each connection, so they need
     nothing;
   - a Codex session started from `system codex-env` holds the old model token:
     start it again;
   - a Codex Worker on the Responses gateway reads the model token from the
     daemon's environment, which was set before the restart: set
     `SYSTEM_MCP_TOKEN` from `system mcp-token --scope model` and restart once
     more;
   - an open web UI tab holds the old operator token: open the new link from
     `system ui`.

## Why a step's answer was rejected

An acceptance contract refuses an answer with a short reason (`system explain <runId>`, on the
step's `acceptance  reject` line). To read the answer itself, take that line's `result` id:

```sh
system explain <runId>
system artifact <result id>                 # the header, then the first 20,000 characters
system artifact --offset 20000 <result id>  # the next window, as the header says
```

The header names its classification: a website answer is `local-private`, so keep it on this
machine. A result collected by retention prints as `expired`.

## Retention

- **Workflow runs** are deleted by the operator (`system delete <runId>`
  previews, `--yes` deletes that exact version), and a finished run older than
  the `workflow` row's `retainRunsDays` (default 30; 0 keeps every run) is
  deleted daily, except each session's latest run. Then the artifacts nothing
  retained references are collected (older than the `artifacts` row's
  `collectGraceHours`, default 24); `system explain` shows a collected input as
  expired.
  - **Upgrading to the 30-day default:** existing runs older than 30 days are
    expired at the first sweep after the update (at start), and the website
    chats only they used are deleted. Back up first, or set `retainRunsDays: 0`
    (or a longer period) on the `workflow` row before the update to keep them.
    The sweep logs how many runs it expired and conversations it released;
    `system health` shows it under `retention`, and `system events --type
    workflow.retention.swept` lists each sweep.
- **Private text:** after `retainDays` (default 30), a finished run's input
  text and rendered prompts are cleared, daily. Decision chains stay, so
  `system explain` still works.
- **Turns:** finished turns, their prompts, their receipts, and sessions with no
  turns left are deleted after the turn runtime's `retainDays` (default 30).
  Answers stay as artifacts.
- **Website chats:** when a run is deleted or expires, the website conversations
  its sessions created are deleted on their sites, unless a later run of the
  session still uses them
  ([conversation ledger](../design/provider-turns.md#conversation-ledger)).
  `system conversations` lists what was recorded and what became of it.
  - Only conversations `system` recorded are deleted: the ledger was filled
    from the turns kept when it was introduced, so older chats stay on the
    sites. Delete those by hand.
  - Temporary chats are left to the site. Deep research chats are kept until a
    live check shows they can be deleted.
  - Deleting a chat on the site does not bind the provider's own retention of
    it.
- **The event log** keeps every entry unless the `event-log` row sets
  `retainDays`; then entries older than that are deleted at start and daily.
  Nothing references an entry, so `system explain` and readers' cursors keep
  working. Freed space is reused by the store, not returned to the disk. `system health` looks back only `driftWindowHours`, so a short
  retention does not hide recent drift.
- **Backups** are yours to rotate.

## An approval request expired

Every request in the approval queue expires: at its creation plus the shortest `expiresSeconds`
of the rules that apply to its class, else the policy's `expiry.defaultSeconds` (a day in the
bundle's studio policy), never more than `expiry.maxSeconds` (14 days). An unanswered request is
denied, and the work that waited on it never starts
([approvals](../design/approvals.md#a-request)).

What you see:

- The request leaves the queue on `/ui` (`system ui`), which lists open and batched requests
  only. The queue rejects expired requests at start and every `sweepSeconds` (60), so one can show
  for up to a minute after its time; a verdict on it is refused (`expired`) and changes nothing.
- MCP `approvals_get <requestId>` shows `state: rejected` and `resolution.cause: expired`;
  `approvals_list` with `states: ["rejected"]` lists the closed ones. `resolution.decision` is the
  `approval` decision `denied:expired` (rule `approvals.expiry`): `system artifact <id>` reads it.
  Cause `verdict` is a verdict of yours; `withdrawn` means the waiting work ended first, or the
  policy changed ([policy](#change-the-autonomy-policy)).

What happened to the waiting work, by the request's subject:

| The request was for | The work now |
|---|---|
| a charter, `project:<id>:charter:<n>` | a first charter: the project is closed `abandoned`, and its open tasks are cancelled (`project-closed`). An amendment: dropped, and the approved charter stays |
| a task's attempt, `board-task:<id>:attempt:<n>` (version `approval-needed`, `budget-spent`, or `reconciliation-failed`) | the task waits for input, `waiting.reason: rejected`, and nothing starts. Left alone, it is cancelled (`input-expired`) after `inputExpirySeconds` (7 days) |
| a Worker's tool call, `agent-tool-call:<agent run>:<tool>` | the call is denied. The run that asked already failed (`config_error`) and is not continued; a later run of that session making the same exact call is denied too, and nothing new is queued |
| a remediation fix, `artifact <plan id> @ git:<HEAD>:<hash>` | the gate closes, the fix never runs, and the run fails as `gate_timeout`. `system continue <runId>` asks again on a new request |

The board moves a task on its own sweep (every `sweepSeconds`, 60), so the new state shows within
about a minute. It also applies the expiry itself, at the task's `waiting.expiresAt`, when the
queue did not resolve the request or no longer knows it. A planner's plan gate (`system approve
<runId>`) is not on this queue; a remediation fix's is ([below](#a-remediation-fix-waits-on-the-queue)).

To ask again or plan again:

1. Read why the work waited: `board_task` gives `waiting` and `lastDecision`; `system artifact
   <lastDecision>` lists each candidate and its reasons.
2. **A task:** nothing revives a `rejected` wait (`board_update` refuses it). If the work is still
   wanted, cancel the task (`board_cancel`, through the Lead) and propose it again
   (`board_propose`): the policy is asked again for the new task. A task that
   `writes` a subject holds it while it is open, so cancel first, or the proposal is refused
   (`conflict`). Tasks that depend on the cancelled one are cancelled on the next sweep:
   propose them again too. After `reconciliation-failed`, look at the run first (`run.runId` of
   `board_task`, then `system explain <runId>`): its worktree may hold the work
   ([a run's worktree](#a-runs-worktree)).
3. **A charter:** found an abandoned project again with `board_charter`, under a new
   `clientRequestId` (the old key returns the project it founded). Make a dropped amendment again
   with the same `projectId` and the next charter version.
4. **A Worker's call:** start the work again in a new session, or let the agent make a different
   call: a different input is a different call, with a request of its own.
5. If requests keep expiring, answer sooner, or lengthen the wait: raise the class's
   `expiresSeconds` or `expiry.defaultSeconds` (up to `expiry.maxSeconds`)
   ([policy](#change-the-autonomy-policy)).

## A board task is blocked or waiting for input

A task waits in one of three states: `waiting-for-approval` (a request in the queue),
`waiting-for-input`, or `review` held for you. Find them with MCP `board_projects` (task counts per
state), `board_tasks` (`states`: `waiting-for-input`, `waiting-for-approval`, `review`), and
`board_task`: its `waiting` gives the `reason`, `since`, and `expiresAt` (and `questions`,
`pendingChecks`, or `approvalRequest`), and `lastDecision` is the `board` decision behind the move
(`system artifact <id>` shows its reasons). The CLI has no board command: ask the Lead, since the
`board_*` tools are client scope. `/ui` shows only the approval queue and the reviews.

| `waiting.reason` | What it means | What you can do |
|---|---|---|
| `approval-needed` (waiting for approval) | the policy asks before an attempt: a new task, or the next attempt after a rejected review or an answered question | decide its request on `/ui` (subject `board-task:<id>:attempt:<n>`). Approve: the task is ready on the board's next sweep. Deny or expiry: `rejected` |
| `question` (waiting for input) | a step of the task's run answered with questions it cannot go on without (its run failed as `question`, outcome `blocked`; [a question from a run](../design/workflow-engine.md#a-question-from-a-run)) | answer every one, by index, with `board_update` `answers` (through the Lead); the next attempt goes through the gate again, and its brief points at your answers |
| `rejected` | an approval was denied or expired, or none could be asked (a lost or spent run under a policy that does not ask) | nothing revives it (see below) |
| `retries-spent` | every attempt is used (`attempts.count` equals `max`, the board's `maxAttempts`, 3): a review rejected the last one, a run failed with none left, or an approval to go on or an answered question had none left to start | nothing revives it. The last result stays on the task, to read or to take |
| `review-expired` | no accepting decision came: the reviewer's lease lapsed, or the review held for you reached its expiry | nothing revives it. The work is still on its run's branch ([worktree](#a-runs-worktree)) |
| `operator-review` (in `review`) | the result waits for your acceptance: the checks its class requires have not passed, or the policy forbids the class | Accept or Reject on `/ui` ([review](#accept-or-reject-a-review)) until `expiresAt`; then `review-expired` |
| `budget-spent` (waiting for approval) | a line of the task's `budget` is reached: the ledger refused the reservation of its next run (failed as `budget_spent`, nothing of it run, outcome `blocked`; [a task's budget](../design/workflow-engine.md#a-tasks-budget)): a `funding` request, which always asks | see what was spent with MCP `resources_usage` (`taskId`). Approve: another attempt, through the gate, but the ledger refuses it again while the line is reached, so raise the budget by proposing the work again as a new task with larger lines. Deny or expiry: `rejected` |
| `reconciliation-failed` (waiting for approval) | the run's holder was lost mid-run and its outcome is not known: a `remediation` request, which always asks | look at the run first (`run.runId`, then `system explain <runId>`). When the engine can report the run's outcome it does, and withdraws the request itself. Approve: another attempt, through the gate; the old run is never started again. Deny or expiry: `rejected` |

**When nothing revives a wait.** Only a question wait takes input. `rejected`, `retries-spent`,
and `review-expired` end in `cancelled` (`input-expired`) after `inputExpirySeconds` (7 days), or
sooner by `board_cancel`. To go on, propose the work as a new task (`board_propose`); cancel the
old one first when it `writes` a subject, and propose again the tasks that depended on it, which
are cancelled with it. Every approval wait ends at its request's expiry in `rejected`, and no wait
ever starts work ([board](../design/board.md#what-ends-an-input-wait)).

## Accept or reject a review

A board task reaches review when the run that served an attempt submits its result. Under the
bundle's studio policy every `workspace-write` task stops here for you: the policy requires `tests`
and `lint`, the engine reports only the checks it ran itself (`schema`, `review`), so the board
holds the review for the operator ([board](../design/board.md#required-checks-bind-at-acceptance)).
A task of a class that needs no check (`read`) or that the policy asked about before its attempt
is accepted by the engine's own decision and never shows here. A run whose own check failed is
rejected by the engine as another attempt, also without you.

1. `system ui` prints the link: open it on the host, or over `ssh -L <port>:127.0.0.1:<port>
   host`. **Reviews** lists every task in review, those held for you first, by expiry. Each row
   gives the task and its action class, its project, the exact subject (`git-head <commit> @
   <hash of the changes>`, or an `artifact`), the result's artifacts, the checks still pending,
   a link to the run, and `yours until <time>`. A row that says `reviewer until` is still held by
   the run's lease; the engine settles it.
2. Read the result: the run's page, `system artifact <artifact id>` for an answer, and for a
   `git-head` subject the run's worktree, which is that exact tree
   ([worktree](#a-runs-worktree)). Run the pending checks there yourself: **your Accept applies
   whatever is pending**, since nothing else has run them.
3. Add a note if you like, then press **Accept** or **Reject**. The page sends the exact subject it
   showed. A result that changed since, or a task no longer in review, is refused (`409`), nothing
   is decided, and the page's status line says why.
4. What happens:
   - **Accept:** your `acceptance` decision is applied, and the task is `done` with
     `result.acceptance` set. Tasks that depend on it become ready on the board's next sweep. Nothing
     merges or commits the work: take it from the worktree or its branch yourself.
   - **Reject:** another attempt while `attempts.count` is under `max`, through the gate again:
     `ready` when the policy says `auto` or `notify` (nothing starts a ready task: the Lead
     starts it with `run` and `task`, which claims it, as a new run with a worktree of its own),
     `waiting-for-approval` when it asks (a new request in the queue), cancelled when it
     forbids. With no attempt left the task waits for input (`retries-spent`). Your note is the
     decision's rationale (`system artifact <decision id>`); no brief carries it to the next
     attempt yet, so tell the Lead.
   - **No verdict:** at `yours until` the task waits for input (`review-expired`) and the row
     leaves the list. The wait is the policy's for the class: a day in the bundle's studio policy.

## A remediation fix waits on the queue

When an exact-subject review of an agent's change asks for changes with blocking findings, the
run grows a fix and a re-review, and the fix waits for you: it writes, so it never runs on a
policy alone ([remediation on the queue](../design/workflow-engine.md#remediation-on-the-approval-queue)).

Where it shows:

- The run waits (`system result <runId>` returns at once): its `blocked` gate names the plan and
  `approvalRequest`, and the CLI prints `waiting on approval request apr-… for plan sha256:…`. The
  run's page on `/ui` says the same, with no plan buttons: `system approve` refuses this gate.
- The request is in the queue on `/ui`: class `remediation`, subject `artifact <plan id> @
  git:<HEAD>:<hash>` (the plan, and the subject the review read), a summary naming the fix step,
  and the plan among its refs (`system artifact <plan id>` shows the fix's prompt, which quotes the
  findings).

To decide:

1. Read the review's findings (`system explain <runId>`, the review step's assessment) and the
   change in the run's worktree ([worktree](#a-runs-worktree)).
2. **Approve:** within `approvalPollSeconds` (15 s) the gate opens, the fix runs once, and a review
   of the changed subject follows. Leave the worktree as the review read it until then: the gate
   captures it again before it opens, and if it changed (the request's subject is no longer the
   tree), the run fails as `stale_subject` and the fix never runs. **Deny:** the run fails as
   `plan_rejected`, and the fix never runs. **No answer** by the request's expiry (a day under the
   bundle's studio policy), or a queue the engine cannot read by then: the run fails as
   `gate_timeout`.
3. To ask again after a deny or an expiry, `system continue <runId>`: the gate puts the plan to the
   queue on a new request. After `stale_subject`, put the worktree back to the reviewed subject
   first (the request's `git:<HEAD>:<hash>`); continuing asks on that same subject again. A policy change that withdrew the request closes the gate too
   (`plan_rejected`, "withdrawn"); continue asks under the policy now.

With no approval queue loaded, the fix waits on the run's plan gate instead: `system approve
<runId> --plan <plan id>` within `gateTimeoutHours` (24).

## A Worker's tool call is deferred on an approval

Every tool call of an agent run passes the run's gate. A call the policy asks about is deferred:
the run stops at it, and the call waits in the queue
([a Worker's tool calls](../design/approvals.md#a-workers-tool-calls)). This needs an agent Worker
on a runtime that can ask the gate first (Claude Code; [turn the rows
on](#turn-an-off-row-back-on)), and a policy that asks. Under the bundle's studio policy a Claude
Code Worker's reads and edits are `read` and `workspace-write`, both `auto`; a `workspace-write`
run's `Bash` command asks unless the policy lists its exact argv, and the runtime offers no
`WebFetch` or `WebSearch`. Only a run in a session can wait: in a run with none (a step whose
conversation is temporary, such as `algorithm-development`'s `validate:1`), a call the policy asks
about is denied, nothing is queued, and the agent goes on without it
([pilot](pilot.md#name-the-repository-and-the-workers)).

Where it shows:

- The run fails `config_error`: `<worker> stopped at its <tool> call, which waits for the operator's
  approval (approval request apr-…); nothing of that call ran`. `system result <runId>`,
  `system explain <runId>`, and the run's page on `/ui` show it.
- Event `agent-workers.tool.deferred` (`system events --type agent-workers.tool.deferred`) names the
  agent run, the Worker, the tool, the request, and the session; never the call's input.
- The request is in the queue on `/ui`: its class, its subject `content
  agent-tool-call:<agent run>:<tool> @ <content id of the input>`, a summary that names the tool
  and what it touches (`Bash: <command>`, `Write <file>`), and what approving does.

To approve:

1. Read the summary: the request is for exactly that call. A command is its argv, the words
   split on single spaces; the same tool with another input is another call, with a request of its
   own.
2. Press **Approve** (or **Deny**), for the request or its batch. One approval is one call: it runs
   once, and the same call later asks again. Deny, or no answer before the request expires: the
   call is denied in that session from then on.
3. **What runs the call.** The workers seam has no waiting status, so the run is over; what
   continues its session once you approve depends on who owns the run:
   - a run outside a board task continues by itself: within `approvalPollSeconds` (15 s) of your
     approval the engine reopens the failed step as a new attempt in its session, with a line
     saying the call was approved, and the call runs once. It is a `recovery` decision (rule
     `workflow.approved-call`, `system explain <runId>`) and a `workflow.run.continued` event naming
     the request; one approval continues the run once. A deny or an expiry continues nothing, and
     nor does an approval for a run you already continued, stopped, or deleted. To go on without
     the call, `system continue <runId>` reopens the step yourself (before a verdict it defers again
     on the same request, queuing nothing new);
   - a run for a board task is not continued: its failure is reported to the board as an attempt,
     the task goes through the gate again, and the Lead starts the next attempt with `run` and
     `task`, naming the earlier `sessionId` (the event shows it) to continue that session.

A call the policy forbids is not deferred: the agent is told the reason and goes on, and the denial
is recorded (`agent-workers.tool.denied`, `system explain <decision id>`). With no approval queue
loaded, every call is denied, reads included.

## Change the autonomy policy

Two ways, both the operator's alone ([a policy change](../design/approvals.md#a-policy-change)):
**on `/ui`, through a `policy-change` approval**, with no restart, or **by configuration and a
restart**. No Worker can do either: the proposal routes take the operator's token or scope only,
and the DSH home is hidden from agents.

1. **Read what is in force:** the **Autonomy policy** page on `/ui` (`system ui` prints the link),
   or MCP `approvals_policy` (a `projectId` adds that project's policy). It shows the set's hash,
   whether it is the configuration or a change you approved (`source: store`), and the effective
   mode of each action class.
2. **Settle the queue first** if you can: decide what waits on `/ui`, and see which tasks wait on
   a request (`board_tasks`, `states: ["waiting-for-approval"]`). A verdict cannot be given on a
   request a change withdraws.

**Through the queue (no restart):**

3. On the policy page, pick the policy (or *a new project policy*), edit the record in the editor
   (it starts at the next version: a change must raise it), and press **Show diff** to compare it
   with the record in force. Add why in the note, then **Propose**. MCP `approvals_policy_propose`
   (operator scope) does the same with `{policy, note?}`.
   A proposal the configuration's rules would refuse is refused at once and nothing is stored
   (`400`, naming each problem); so is one when the policy forbids `policy-change` (`409`).
4. **Approve it in the approval queue.** The `policy-change` request (on the exact hash of the
   whole set) shows its consequences; **Show change** lists the effective modes it moves and the
   record's diff. Approve it there (or deny it: nothing changes). It applies at once, recorded as a
   `policy-change` decision with the old and new hashes; open requests are judged again at once,
   and the board puts its waiting tasks to the new policy on its next sweep. A second proposal on
   the same set is withdrawn once the first comes into force: propose it again on the new set.
5. **Verify:** the policy page shows the new set, `source: store`, and the change `applied` in its
   history. The applied set is kept in the store: a restart keeps it while the configuration is
   unchanged.

**By configuration and a restart:**

3. **Edit `~/.dsh/profiles/system/cordis.patch.yml`.** A patch that targets a row replaces its whole
   config, so write the whole `policies` list: copy the `approvals` row of the
   [bundle](../../packages/system-bundle/cordis.patch.yml), then change the rule.

   ```yaml
   - id: approvals
     config:
       policies:
         - schema: 'autonomy-policy@1.0'
           id: studio-default
           version: 2              # raise it with every change: requests are made under a version
           scope: studio
           rules:
             - { actionClass: workspace-write, mode: ask }   # was auto, requires tests and lint
             # … every other rule of the bundle's policy
           default: ask
           expiry: { defaultSeconds: 86400, maxSeconds: 1209600 }
           batch: { maxSize: 10, maxWaitSeconds: 3600 }
       # supersedes: 'sha256:…'    # only if you applied a change on /ui: see below
   ```

   Exactly one studio policy; a project policy has `scope: project`, its `projectId`, and
   `narrows` the studio policy's `id`, and can only be stricter
   ([example](../../schemas/examples/autonomy-policy.project.json)). The classes that always ask
   (`external-send`, `deploy`, `delete-data`, `spend`, `charter`, `funding`, `remediation`,
   `policy-change`) cannot be given `auto` or `notify`.

   **If a change you approved on `/ui` is in force** (`source: store`), a changed configuration
   does not replace it silently: at start the queue is refused, and its log names the stored
   set's hash and the configuration's. Either keep the configuration the change was derived from,
   or let the new configuration replace the stored set by naming that set's exact hash in
   `supersedes` (the hash the policy page shows as in force): at start the change is retired,
   recorded as a `policy-change` decision, and the configuration is in force. Copying the stored
   set itself into the patch also agrees with it.
4. **Check it before stopping anything:** `system check`. It loads every row against the code and
   names each problem of the policy set (a rule twice, an expiry above its maximum, a batch wait
   not under the shortest expiry, a listed command with a shell metacharacter); fix the patch until
   it says `ok`. It cannot see the store, so it does not report a mismatch with a stored set. A set
   that fails at start, or a stored set that no longer matches the configuration with no
   `supersedes` naming it, refuses the plugin: no queue, `/ui` answers `503` for it, the board is
   not mounted, nothing that needs a person runs, and every Worker tool call is denied.
5. **Restart:** `system shutdown`, then `system start`. At start the queue rejects expired requests
   and withdraws the open ones the loaded policies no longer ask for.
6. **Verify:** `approvals_policy` shows the new effective modes and `source: configuration`.

What happens to what is open:

| The change | Open requests |
|---|---|
| a policy's `version` raised, or its `id` gone | every unexpired open request made under the old version is withdrawn, at start or at once when the change is approved on `/ui`: cause `withdrawn`, rule `approvals.policy`, the reason names the change |
| a class that asked now says `auto`, `notify`, or `forbid` (same version) | its open requests are withdrawn: `it now gives <class> <mode>` |
| a class still asking, same version | they stay, and a verdict still counts. Their expiry never changes |
| a class that did not ask now asks | nothing to withdraw. The board asks the policy when a task becomes ready and before each further attempt, not at claim or start, so a task already `ready` or `claimed` is not asked again. A Worker's gate asks on every tool call, so its next calls follow the new policy |

A withdrawn request is not a verdict. On its next sweep the board puts each task or charter that
waited on one to the new policy again ([board](../design/board.md#where-the-tables-leave-room)): a
task waiting for approval becomes ready when its class is now `auto` or `notify`, waits on one new
request when it still asks, and is cancelled (`forbidden`) on `forbid`; a spent budget or a lost run
asks again or waits for input; a charter is asked about again, or refused. A Worker's gate denies
the same call again in that session (it reads the withdrawn request as the answer): run the work
again to have the new policy judge it.

## A resource pool is limited

Only a Worker with a `pool` is metered ([agent Workers](../../packages/plugins/agent-workers/README.md)).
The bundle's `resources` row configures no pool, so until you configure one a Worker that names a
pool is unavailable, and one that names none is never limited. A pool with two rolling windows,
and a Worker that draws on it:

```yaml
- id: resources
  config:
    pools:
      - pool: max.agents
        account: max
        kind: programmatic
        unknown: available        # a window with no reading yet leaves the pool open
        windows:
          - { id: five-hour, kind: rolling, seconds: 18000 }
          - { id: seven-day, kind: rolling, seconds: 604800 }
- id: agent-workers
  config:
    workers:
      - { id: claude-dev, runtime: claude-agent-sdk, workspace: /home/me/project, sandbox: workspace-write, tier: standard,
          pool: max.agents, account: max, windows: { five_hour: five-hour, seven_day: seven-day } }
```

Without `unknown: available`, a window nobody has read yet fails the pool closed, and a closed pool
admits no run that could give it a reading: only a run's result records readings today, so set it
on a pool whose windows report only after a run. The runtime's window names (`five_hour`) are mapped to
your window ids by the Worker's `windows`.

Reading a limit:

- MCP `resources_pools` (`account` narrows it) gives each pool: `available`, `until` while it is
  not, and the latest reading of each window: `state` (`ok`, `limited`, `unknown`),
  `usedPercentage`, `resetsAt`, `cooldownUntil`, `source`, and `observedAt`.
- A window is `limited` until the later of its `cooldownUntil` and `resetsAt`. A limit the runtime
  reports without a reset time is `limited` for the Worker's `limitCooldownSeconds` (an hour by
  default). A limit it cannot place on a configured window closes every window of the pool. A
  window with no reading, or `unknown`, counts as not available unless the pool is `unknown:
  available`.
- `system health` lists the Worker as `agent:<id> (quota-exhausted)` while its pool is not
  available, and routing skips it. A run that reaches it anyway fails `quota_exhausted`
  (`USER_ACTION`) before the agent starts, with a `budget` decision whose reasons name the pool and
  `until` (`system explain <runId>`). A run that hit the limit while working fails the same way and
  is never retried on that pool.

What to do:

1. **Wait.** The pool opens by itself at `until`. No command ends a limit early (website
   accounts have `system account clear-cooldown`; the ledger has no counterpart), and a limited
   pool admits no run that could read it open again.
2. **Or add capacity:** configure another pool and account for a second Worker, which routing then
   picks; or point the Worker's `pool` and `account` at another pool and restart.
3. Then `system continue <runId>` for a run that failed on the limit.

Usage: MCP `resources_usage` lists the counted usage records, oldest first, a page at a time
(`limit`, `after`), filtered by `runId`, `projectId`, `taskId`, `account`, `pool`, `since`, and
`until`. Its `totals` per pool (tokens, turns, cost, records) cover every match, not just the
page. A record comes from the runtime's own result message, never the model's report, so a run
that reported no numbers has no record, and a crashed run has none until a transcript is read
(not built yet). `system usage` lists runs, not the ledger.

## A run's worktree

A Worker with `worktreePerRun: true` works, for each workflow run, in a git worktree of its own
instead of the configured workspace
([agent Workers](../../packages/plugins/agent-workers/README.md)). The workspace must be the top
level of a git repository with a commit, outside the worktree root, and git must be 2.17 or later;
otherwise the Worker is `unavailable` (`system health`), with the reason in the log.

- **Where:** `<worktreeRoot>/<repository name>-<12 hex digits>/<workflow run id>`, by default
  `~/.dsh/system/worktrees` (owner-only), on the branch `system/run/<workflow run id>`, cut from the
  repository's HEAD when the run's first agent run starts. Every later agent run of that workflow
  run, reviewers included, uses it; the repository's own working tree and branch are never written.
  Find it with `ls ~/.dsh/system/worktrees/*/<run id>`, `git -C <repository> worktree list`, or
  the daemon log line `run <id> works in <path> on <branch>`. A task's attempts are separate
  runs, so each has a worktree and a branch of its own (`run.runId` of `board_task`).
- **Retention:** while one of its agent runs is queued or running, a worktree is kept. Then, after
  `worktreeRetentionHours` (168; 0 keeps every worktree), at start and hourly (at most 50 a sweep),
  `system` commits what the worktree holds on its branch (author `system <system@localhost>`,
  message `system: keep the uncommitted work of workflow run <id>`) and removes it, never forced
  (files the repository ignores go with it). A `retention` decision records it (`system explain
  <decision id>`). The branch is never deleted.
- **Recover work:**
  1. While the worktree exists it holds the exact tree a review was bound to, committed or not:
     `git -C <worktree> status` and `git -C <worktree> diff HEAD`. Run the checks there. Leave it
     alone while a run for it is live, and until a review of its task is decided.
  2. To keep it, commit in the worktree (`git -C <worktree> add --all`, then `commit`), or wait for
     the retention commit. Then take the branch: `git -C <repository> merge system/run/<id>`,
     `cherry-pick`, or `diff <base>...system/run/<id>`. A branch checked out in a worktree can still
     be merged from the main tree.
  3. After retention the work is the branch's last commit: `git -C <repository> log
     system/run/<id>`. `git -C <repository> worktree add <path> system/run/<id>` opens it again; a
     run continued after its worktree was removed gets it again from that branch by itself.
  4. Merging is yours: no board move or policy class merges a branch yet. Delete the branches you no
     longer need.
- **A worktree that stays:** one that cannot be committed or removed (locked, say) stays, with the
  reason logged once, and the next hourly sweep tries again. Unlock it with `git -C <repository>
  worktree unlock <path>`. One removed by hand is forgotten once git no longer lists it:
  `git -C <repository> worktree prune`.
- **A `.git` file changed by the agent:** a run whose worktree's `.git` file no longer points to
  its own directory fails `reconciliation_failed` ("changed the .git file of its worktree …"), and
  the worktree is left for you; a later run of it fails `config_error`. Do not run git inside it.
  Read the files directly, and use `git -C <repository> worktree list` and the branch from the
  repository. Once the work is saved, `git -C <repository> worktree remove --force <path>`.
- **A path that is not the run's:** a path that already exists and is not that run's worktree is
  never taken over (`config_error`). Move it away.
- **Disk:** each worktree is a full checkout, kept a week by default. Lower
  `worktreeRetentionHours` when disk is short.
