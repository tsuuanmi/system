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
   sign-in.
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
an `agent-workers` row. The agent rows are off by default; turn them on first
([below](#turn-an-off-row-back-on)).

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
  - **Claude Code:** its own sign-in in `~/.claude` needs nothing. An API key or
    OAuth token taken from the environment must be named in the
    `runtime-claude-agent-sdk` row's `forwardEnv`.
  - **ACP agents:** each `runtime-acp` agent entry has its own `forwardEnv`.
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

- **Read confinement:** Codex and ACP agents start under
  [bubblewrap](https://github.com/containers/bubblewrap)
  ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)). It
  hides `~/.dsh`, your session's runtime directory (`/run/user/<uid>`), `/tmp`,
  `/var/tmp`, `/dev/shm`, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.codex`,
  `~/.Xauthority`, `~/.config/gh`, `~/.docker/config.json`,
  `$CREDENTIALS_DIRECTORY`, and wherever you keep the vault, its key, the store,
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
off (`disabled: true`):

| Rows | What they serve |
|---|---|
| `agent-runtimes`, `runtime-claude-agent-sdk`, `runtime-codex-sdk`, `runtime-acp`, `agent-workers` | agent Workers ([agent runtimes](../design/agent-runtimes.md)) |
| `profile-software-development` | the `agent-review` template, for agent Workers ([templates](../reference/workflow-templates.md#agent-review)) |
| `gateway-anthropic`, `gateway-responses` | the model gateways behind `system claude-env`, `system codex-env`, and `system mcp-token --scope model` ([gateways](../design/gateways.md)) |

1. Add the row to your profile patch, `~/.dsh/profiles/system/cordis.patch.yml`,
   with `disabled: false`. Agent Workers need every agent row they use:

   ```yaml
   - id: agent-runtimes
     disabled: false
   - id: runtime-claude-agent-sdk
     disabled: false
   - id: agent-workers
     disabled: false
   ```

2. Configure the row ([configuration](../reference/configuration.md)), for
   example an `agent-workers` Worker ([agent Workers](#agent-workers)).
3. Restart: `system shutdown`, then `system start`.
4. `system start --dump-config` shows the row without `disabled: true`.

To turn it off again, remove the row from your patch, or set `disabled: true`,
and restart. The `api-first` preset turns the agent rows on for you
([API-first](#api-first-preset)).

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

A panel holds its members to distinct accounts, so with one ChatGPT account left
it needs another one, such as a Gemini account.

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
   `local`; `maxTokens` bounds every answer (default 4096):

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
   receipts, and both model gateways, turns the agent Worker rows and the
   software-development profile on, and orders quota `local`, `metered`,
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

## Account re-auth

A turn that fails with `reauth_required` or `challenge` (disposition
`USER_ACTION`) means the account's saved session no longer works.

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
2. `system shutdown --deadline 600`. This drains first: no new run is admitted
   (gateways answer 529 or `response.failed`), and the command waits for runs
   that are executing. Runs still executing at the deadline are durable and
   resume after the restart.
3. Update the code, then `pnpm install && pnpm build`, or install the new
   packages.
4. `system start`. Store migrations run forward at start, per owner, each in
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

## Retention

- **Workflow runs** are deleted by the operator (`system delete <runId>`
  previews, `--yes` deletes that exact version), and, when the `workflow` row
  sets `retainRunsDays`, a finished run older than that is deleted daily, except
  each session's latest run. Then the artifacts nothing retained references are
  collected (older than the `artifacts` row's `collectGraceHours`, default 24);
  `system explain` shows a collected input as expired. Back up before you first
  turn this on.
- **Private text:** after `retainDays` (default 30), a finished run's input
  text and rendered prompts are cleared, daily. Decision chains stay, so
  `system explain` still works.
- **Turns:** finished turns, their prompts, their receipts, and sessions with no
  turns left are deleted after the turn runtime's `retainDays` (default 30).
  Answers stay as artifacts.
- **The event log** keeps every entry unless the `event-log` row sets
  `retainDays`; then entries older than that are deleted at start and daily.
  Nothing references an entry, so `system explain` and readers' cursors keep
  working. Freed space is reused by the store, not returned to the disk. `system health` looks back only `driftWindowHours`, so a short
  retention does not hide recent drift.
- **Backups** are yours to rotate.
