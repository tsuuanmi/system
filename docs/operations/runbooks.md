# Runbooks

> Current state. Commands: [CLI](../../packages/cli/README.md). Configuration:
> [catalog](../reference/configuration.md).

## First start

1. `system init` creates the profile, installs the pinned Chrome if the host
   has none, and checks Xvfb.
2. `system start` boots the profile. MCP listens on `127.0.0.1:47317/mcp`, and
   the gateways serve `/anthropic` and `/openai` on the same port.
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
   then check `system account list`. A ChatGPT account without a model picker
   (Free) maps its tiers to the empty preset `site`. A Gemini account maps
   them to `flash-lite`, `flash`, and `pro` (model and thinking level).
6. Connect the clients: `system mcp-config claude|codex` connects over MCP;
   `system claude-env` and `system codex-env` connect through the gateways.

## Agent Workers

An agent Worker (Claude Code, Codex, an ACP agent) runs on this machine, under
an `agent-workers` row.

- **Credentials:** the agent process starts without the daemon's credentials.
  Every variable whose name contains `KEY`, `PASSWORD`, `SECRET`, or `TOKEN`,
  and every `DSH_*` variable, is removed. A credential the agent needs is
  forwarded **by name** with the runtime's `forwardEnv`; its value stays in the
  daemon's environment, never in a config file or in `env`.
  - **Codex on the Responses gateway:** when a Codex Worker's model provider is
    the system gateway, keep the token in the daemon's environment as the
    variable the provider's `env_key` names, and set
    `forwardEnv: ['SYSTEM_MCP_TOKEN']` on the `runtime-codex-sdk` row. Without
    it, Codex cannot authenticate to the gateway. Such a Worker needs no login.
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

  Codex's sandbox confines writes, not reads: a Codex Worker can read whatever
  your user can ([threat model](../security/threat-model.md)).
- **`local-private` work:** refused at egress by default (`egress_denied`,
  nothing sent), because the agent's model is remote. Routing still admits the
  Worker, since it is local. If the agent's model runs on this machine, set the
  egress row's `workerClasses` with `local-private` added to `agent`. List
  `website` too: the setting replaces the whole default.

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
  host itself.
- **Restore:**
  1. `system shutdown` stops the profile.
  2. `system restore <dir>` previews the backup and verifies every file
     against the manifest. A manifest naming any file but `system.db`,
     `vault.enc`, and `vault.key` refuses the whole backup.
  3. `system restore <dir> --yes` restores it. The replaced store is kept as
     `system.db.before-restore-<time>`. A host without the vault key is refused
     until the key is put back.
  4. `system start` starts the profile, and `system usage` shows the restored
     runs.
- Back up before every upgrade.

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

## Retention

- **Workflow runs** are deleted only by the operator: `system delete <runId>`
  previews, and `--yes` deletes that exact version. Artifacts stay.
- **Private text:** after `retainDays` (default 30), a finished run's input
  text and rendered prompts are cleared, daily. Decision chains stay, so
  `system explain` still works.
- **Turns:** finished turns, their prompts, their receipts, and sessions with no
  turns left are deleted after the turn runtime's `retainDays` (default 30).
  Answers stay as artifacts.
- **Backups** are yours to rotate.
