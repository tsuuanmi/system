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
   runtime's `executable` ([Codex Workers](#codex-workers)).
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

An agent Worker (Claude Code, Codex, an ACP agent, the Antigravity CLI) runs on
this machine, under the `agent-workers` row. The Claude Code rows
(`agent-runtimes`, `runtime-claude-agent-sdk`, `agent-workers`) are on by
default, with no Worker; the Codex, ACP, and Antigravity CLI rows are off
([below](#turn-an-off-row-back-on); [Antigravity CLI](#antigravity-cli-workers)).

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
  in a run's worktree, the repository's [setup](#set-up-a-runs-worktree)
  installs them first, offline.
- **Codex Worker home:** Codex Workers run with their own `CODEX_HOME`
  (`runtime-codex-sdk` config `home`, default `~/.dsh/system/codex-home`),
  never your `~/.codex`, which `system mcp-config codex` gives the `system` MCP
  server. Codex starts MCP servers outside its sandbox, so the Worker home must
  configure none: if it does, the Worker is unavailable and runs fail
  (`config_error`) until you remove them
  (`CODEX_HOME=~/.dsh/system/codex-home codex mcp remove <name>`). A Worker that
  uses an OpenAI or ChatGPT login must be signed in inside that home
  ([Codex Workers](#codex-workers)).

- **Read confinement:** every agent (Claude Code, Codex, ACP agents) starts under
  [bubblewrap](https://github.com/containers/bubblewrap)
  ([ADR-0024](../decisions/adr/0024-agent-workers-confined-for-reads.md)). It
  hides `~/.dsh`, your session's runtime directory (`/run/user/<uid>`), `/tmp`,
  `/var/tmp`, `/dev/shm`, `$CREDENTIALS_DIRECTORY`, the credential stores in your
  home and every coding agent's login there (the list is in the
  [agent-runtimes README](../../packages/plugins/agent-runtimes/README.md)), and wherever you keep the vault, its key, the store,
  or login profiles. The agent, and every command a run's worktree setup runs,
  gets an empty private `/tmp` as its `TMPDIR` (`TMP`, `TEMP`), whatever the
  daemon's own is; nothing it writes there reaches your `/tmp`. A check that
  listens on a unix socket (a script started by the `tsx` CLI, whose IPC pipe
  fails with `listen EPERM … /tmp/tsx-<uid>/<pid>.pipe`) still fails inside a
  Worker's commands: Claude Code's and Codex's command sandboxes refuse unix
  sockets, and nothing loosens them; run it outside the Worker, or start the
  repository's scripts without a unix socket (`node --import tsx <script>` instead
  of `tsx <script>`, as this repository's own `package.json` does)
  ([confined commands](../design/agent-runtimes.md#confined-commands)). Only
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
- **Renaming an agent Worker:** change its `id` in the `agent-workers` row of the
  profile patch, `system check`, and restart the daemon. The Worker is `agent:<new id>`
  from then on. Recorded runs, decisions, and usage keep the old id, since records never
  change. A session bound to the old Worker stays on it, so a new run starts a new session.
  Its home (`home`) and its account do not change.

### Keep Claude Code's pinned version

Claude Code's identity reader is pinned to the versions a check verified (2.1.308 to 2.1.310,
[identity readers](../design/agent-runtimes.md#identity-readers)). Each probe and each run reads
every `ready` Claude Code account again, so a Claude Code on another version turns them all
`quarantined (unverified)` and their derived Workers take no work. `system account list` and
`system health` then name the version found and the ones admitted (`found Claude Code 2.1.311
(…); its identity reader admits only 2.1.308, 2.1.309, 2.1.310`). Pin the executable with the
`runtime-claude-agent-sdk` row's `executable`.

Do not point the pin into `~/.local/share/claude/versions/`: Claude Code's updater prunes old
versions there, and a pruned pin reads `the Claude Code executable … is not there`. Keep a checked
copy where nothing prunes it, under the Workers' tools directory, which every agent sees read-only
(as Codex's executable is kept):

1. Check the version you copy: `~/.local/share/claude/versions/2.1.308 --version` names 2.1.308.
2. Copy it: `install -D -m 0755 ~/.local/share/claude/versions/2.1.308 ~/.dsh/system/tools/claude/2.1.308/claude`,
   then `~/.dsh/system/tools/claude/2.1.308/claude --version` prints the same.
3. Point the pin there in the profile patch (a targeted patch replaces the row's whole config, so
   keep its other keys):

   ```yaml
   - id: runtime-claude-agent-sdk
     config:
       executable: /home/me/.dsh/system/tools/claude/2.1.308/claude
   ```

4. `system check`, restart, and `system account list`: each Claude Code account reads `ready` again
   once verified (`system account verify <accountId>`; a quarantine never lifts by itself).

A newer version is pinned only once the reader is verified on it (a release that adds it to
`VERIFIED_IDENTITY_VERSIONS`); keep the old copy until then. Signing in again
(`CLAUDE_CONFIG_DIR=… claude`, `/login`) uses whichever `claude` you run; the Workers use the pin.

### Codex Workers

The `runtime-codex-sdk` row is off by default (PROP-0004). Its Workers are admitted only where the
probe proves, on this host, that Codex asks the run's tool gate before each tool call
([Codex's gate](../design/agent-runtimes.md#codexs-gate)); every call then goes to the approval
queue as a Claude Code Worker's does. To use one:

1. **Install `codex` where the confinement lets it run.** `npm i --prefix
   ~/.dsh/system/tools/codex @openai/codex`, then `executable:
   /home/me/.dsh/system/tools/codex/node_modules/.bin/codex`. The standalone installer puts
   Codex under `~/.codex/packages`, inside `~/.codex`, which the confinement hides: either
   install it as above, or bind its release directory back read-only and name its binary
   (an upgrade changes the path; change both):

   ```yaml
   - id: agent-runtimes
     config:
       readOnly: ['$DSH_HOME/system/tools', '/home/me/.codex/packages/standalone/releases/0.164.0-x86_64-unknown-linux-musl']
   - id: runtime-codex-sdk
     config:
       executable: /home/me/.codex/packages/standalone/releases/0.164.0-x86_64-unknown-linux-musl/bin/codex
   ```

   The release directory holds Codex's programs only; your login and configuration in
   `~/.codex` stay hidden.
2. **Sign Codex in inside its own home, once** (a Worker on the Responses gateway needs no
   login, [above](#agent-workers)):

   ```sh
   install -d -m 700 ~/.dsh/system/codex-home        # owner-only
   CODEX_HOME=~/.dsh/system/codex-home codex login   # on a remote host: codex login --device-auth
   ```

   Your own `~/.codex` login is never used. Until a Worker home is signed in, each Worker is
   unavailable with "not signed in inside its home". Configure nothing else there: no MCP
   server, no hooks.
3. **Turn the row on and name the Workers** in `~/.dsh/profiles/system/cordis.patch.yml`. The
   `workers` list replaces the whole list, so keep your Claude Code Workers in it:

   ```yaml
   - id: runtime-codex-sdk
     disabled: false
     config:
       executable: /home/me/.dsh/system/tools/codex/node_modules/.bin/codex
   - id: agent-workers
     config:
       workers:
         - { id: codex-reviewer, runtime: codex-sdk, workspace: /home/me/src/project, sandbox: read-only, tier: standard, worktreePerRun: true }
         - { id: codex-developer, runtime: codex-sdk, workspace: /home/me/src/project, sandbox: workspace-write, tier: standard, worktreePerRun: true }
   ```

   Its `config` may also name Codex's model and provider (`config: { model: …, model_provider:
   … }`); it may not hold `mcp_servers` or `hooks`, nor turn on a feature the runtime keeps off.
4. **Restart** (`system shutdown`, then `system start`), then `system explain` or `/ui` shows each
   Codex Worker ready, or why not:
   - "not signed in inside its home": step 2;
   - "reads cannot be confined", or "Codex's own sandbox does not start inside the
     confinement": the [read confinement](#agent-workers) on this host, or a `codex` the
     confinement hides (step 1);
   - "tool calls cannot be gated: …": the probe's turn showed Codex would run a tool without
     asking the gate (a hook that did not run, a terminal session, a hosted tool). Usually a
     Codex release that changed its hooks: keep the Workers off and report the reason.

## Antigravity CLI Workers

The `runtime-antigravity-cli` row runs the Antigravity CLI (`agy`) as a Worker
([runtime](../../packages/plugins/runtime-antigravity-cli/README.md)). It is off
by default. agy can be held to a policy only through its PreToolUse hook, and
that agy runs the hook before each tool call takes a model turn to show, so the
runtime admits only an agy version a supervised live check verified: 1.4.6
([ADR-0043](../decisions/adr/0043-antigravity-cli-workers-gated-on-a-version-verified-live.md)).
On that version every tool call passes the runtime's own rules, then the
approval queue, as for a Claude Code Worker. On any other version `system
explain` and `/ui` show "that agy <version> runs it before each tool call is not
proven", and no run starts.

1. Turn the row on in your profile patch ([below](#turn-an-off-row-back-on)):
   `- id: runtime-antigravity-cli` with `disabled: false`. The `api-first`
   preset turns it on for you.
2. Sign agy in once inside the Workers' Antigravity home (config `home`,
   default `~/.dsh/system/antigravity-home`), never your own `~/.gemini`, which
   the read confinement hides from every agent:

   ```sh
   install -d -m 700 ~/.dsh/system/antigravity-home   # owner-only, or the Worker refuses it
   env -u DBUS_SESSION_BUS_ADDRESS HOME="$HOME/.dsh/system/antigravity-home" AGY_CLI_DISABLE_AUTO_UPDATE=true agy
   ```

   Follow its sign-in, then exit (`Ctrl+D` twice). Without the session bus, agy
   keeps the sign-in in a file in that home, where a Worker finds it (a Worker
   never gets the bus); with it, agy may put it in your keyring instead. Every
   tool call in that session is denied ("no system tool gate is attached to this
   session"): the home is the Workers', not for your own work. A Worker can use
   an API key agy accepts instead, forwarded by name (`forwardEnv`).
3. Configure the Worker like a Claude Code one ([above](#agent-workers)). Its
   runtime is `antigravity-cli`; a Gemini-family reviewer:

   ```yaml
   - id: agent-workers
     config:
       workers:
         - { id: agy-reviewer, runtime: antigravity-cli, workspace: /home/me/src/project, sandbox: read-only, model: gemini-3.8-flash-high, tier: standard, worktreePerRun: true }
   ```

   Restart, then check with `system explain` (or `/ui`) on the Worker: "not
   signed in inside its home" until step 2; then "the hook reaches the run's
   gate inside the confinement; agy 1.4.6 runs it before each tool call
   (verified live)", and the Worker is admitted.

   - Set no `maxTurns`: agy has no turn limit, and a run with one is refused.
   - The tools are agy's own, as the live check recorded them for the
     `gemini-3.8-flash` models: `read_file` in a `read-only` run, and
     `write_file` and `edit_file` added in a `workspace-write` run. `tools` may
     narrow them. There is no tool that lists or searches a directory, and no
     command (`run_command` is denied), so a reviewer reads the files it is
     told of or finds named in what it reads: name the files in the work you
     give it.
   - A `workspace-write` Worker can `develop` but never `validate`. Its runs
     never continue a conversation (`resume` is not proven), so it is no team
     member, except a `review` member under the review-member profile, whose
     conversation the `agents` source replays ([below](#agent-workers-as-review-team-members)).
   - Another model's tools are not verified: a Worker whose `model` gives agy
     other tool names has every call denied.
4. Keep the home and the repository free of what agy would run outside the
   gate. The home must have no MCP server (`.gemini/config/mcp_config.json`), no
   enabled plugin (`HOME=… agy plugin list`), and no `hooks.json` but the one the
   runtime writes. The repository must have no `hooks.json`, `mcp_config.json`,
   `plugins.json`, or `plugins/` under `.agents/` (or `.agent/`, `_agents/`,
   `_agent/`), from the workspace up to the repository root. Each makes the
   Worker unavailable or the run refused, and the message names the file.

agy updates itself in your own sessions; a Worker's runs never do
(`AGY_CLI_DISABLE_AUTO_UPDATE`). A newer agy you install yourself is unverified,
and its Workers stop, until a reviewed code change adds it after the same
supervised live check (the [release checklist](../validation/release-checklist.md)
row, and the evidence the runtime's `VERIFIED_HOOK_VERSIONS` names): a session
in a copy of the signed-in Worker home, on a scratch workspace, whose model is
asked to read, list, search, edit, and create files, first with a recording hook
that allows, denies, and fails in each way, then through the runtime's own
bridge under the read confinement. It shows the PreToolUse hook running before
every tool step, its `deny` holding, how agy treats a failing hook, and the tool
names and input fields the hook receives; the runtime's rules and the `agents`
source's gate then take any name or field that differs. Until then, keep the
verified version installed, or the Workers off.

## Agent Workers as review team members

A read-only agent Worker (a Codex, Antigravity CLI, or Claude Code one) can be a
member of a `review` team under the **review-member profile**
([ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md)):
its member steps run with every tool call denied, in an empty
workspace, so it reviews exactly what its prompt shows, as a website member
does. It takes no other work for the profile: an ask, a brainstorm, or research
never reaches it.

1. Make an empty directory outside any repository for it, for example
   `install -d ~/experiments/review-member/empty`. Nothing goes in it: a step
   refuses to start in a directory that holds anything or that lies inside a git
   work tree, and a step after which it holds anything fails, its answer not
   trusted.
2. Add a Worker for it, apart from any reviewer that reads your repository:

   ```yaml
   - id: agent-workers
     config:
       workers:
         - { id: agy-member, runtime: antigravity-cli, workspace: /home/me/experiments/review-member/empty,
             sandbox: read-only, tier: standard, reviewMember: true, family: <family> }
   ```

   `family` is required: the provider family that keeps two members of one
   vendor apart. Give it the family other Workers of the vendor whose models it
   runs carry (a website Worker's is its account's provider; `system explain`
   shows a Worker's), so a Codex member and a ChatGPT website member never sit
   on one team unless you turn `allowSameFamily` on
   ([one provider family](#one-provider-family)). The load refuses a
   `reviewMember` Worker that is not `read-only`, has no `family`, or works in a
   worktree per run.
3. Keep instruction files the runtime reads on its own out of its way: its own
   home (the Worker's Codex or Antigravity home) and the directories above the
   empty one hold none for it. The source checks only the workspace and the
   repository around it.
4. Restart, then check with `system explain`: the Worker offers `reason` for
   review-member work only, and, on a runtime that cannot resume (the
   Antigravity CLI), `persistent-conversation` for that work only. A `review`
   then routes a member step to it when no website Worker of the family the step
   needs is admitted.

A member on a runtime that resumes (Codex, Claude Code) continues its own
session for its ballot and debates. On the Antigravity CLI the `agents` source
replays the member's earlier turns, exactly, before each later one, and records
which turns it sent with the answer (`agent-result@1.3` `replay`). A step whose
conversation can be neither resumed nor replayed whole fails, nothing sent (the
message says why); a replay longer than `maxReplayChars` (default 200,000
characters) fails the same way, and so does an Antigravity turn over its
100,000-byte prompt limit.

## Route work by kind

Give each writing agent Worker the **kinds of work** it takes, and each step goes to a Worker of its
kind ([work kinds](../design/routing.md#work-kinds),
[ADR-0057](../decisions/adr/0057-route-work-by-kind.md), accepted). This is configuration: which
runtime takes which kind is the Worker list's, never a template's.

What names a kind today ([templates](../reference/workflow-templates.md#algorithm-development)):

| Step | Kind |
|---|---|
| `algorithm-development` `develop:1`, and the fix a review grows from it | `code`; `docs` in the `docs` variant, `tests` in the `tests` variant |
| `algorithm-development` `validate:1` | `tests` |
| every review (`algorithm-development` `review:1` and its re-reviews, `agent-review`), a planner's steps, every website step (`ask`, `brainstorm`, `review` teams, `research`), digests | none |

A Worker given kinds takes only steps of those kinds, and never a step that names none; a Worker
given none takes any step it proves the capabilities for. With no Worker given kinds, everything
routes as before.

**The live install's split** (operator decisions D35 and D36, 2026-10-24): source-code changes on
Claude Code, docs and test work on Codex, reviews on any reviewer, a writing Claude Code Worker on
the system repository with a worktree per run. The rows are in
[`examples/work-kinds.patch.yml`](examples/work-kinds.patch.yml).

1. **Before:** Claude Code's commands are proven confined on this host
   ([confined commands](#agent-workers): `bubblewrap` and `socat`); otherwise the writing Claude
   Code Worker is unavailable and nothing takes `code` work. Codex is installed and signed in inside
   its Worker home ([Codex Workers](#codex-workers)); its commands are confined by its own sandbox,
   which the probe proves (`executes`), or no Worker takes `validate:1`. Back up (`system backup`).
2. **Merge the example's rows** into `~/.dsh/profiles/system/cordis.patch.yml` by row id
   (`runtime-codex-sdk`, `runtime-antigravity-cli`, `agent-workers`,
   `profile-software-development`). What it sets:
   - `claude-code`: `sandbox: workspace-write`, `worktreePerRun: true`, `kinds: [code]`, on
     `/home/tan/workspaces/system` (D36). Each workflow run writes in its own worktree on the branch
     `system/run/<runId>`, never in the checkout ([a run's worktree](#a-runs-worktree)); an accepted
     task's branch is merged on your approval ([land an accepted result](#land-an-accepted-result)).
   - `codex-writer`: the same on Codex, `kinds: [docs, tests]`: it writes in the `docs` and `tests`
     variants and runs `validate:1`.
   - The reviewers (`claude-research`, `codex-review`, `agy-review`) are given no kinds, so they take
     every review. Each now sets `worktreePerRun: true`: every Worker on a workspace must
     agree, so a reviewer reads the writer's worktree, and the load refuses a row that disagrees.
   - `claude-digest`: read-only, on the **economy** tier, given no kinds, in the review member's
     empty directory. It writes the digests of task results: a digest asks for a read-only Worker on
     the economy tier only (the `digest` row's `tier`), so with only the standard reviewers every
     task's digest is bypassed ("no Worker can write it (a read-only Worker on the economy tier)",
     T99 D5). Optionally give it the runtime's lighter model (`model:`). Instead of this Worker, you
     may set the `digest` row's `tier: standard`, an explicit choice: digests then run on a standard
     reviewer and are never escalated ([digests](../design/digests.md#the-worker)).
   - `claude-member` keeps its empty directory, never a worktree.
3. **The approval policy that gates the writers' commands** (ADR-0038) is the bundle's studio
   policy, unchanged: reads and edits run (`workspace-write` is `auto`, with `tests` and `lint`
   required at acceptance, so every result waits for your review), and every command asks. In a
   step with a session (`develop:1`) a command waits on the approval queue
   ([a deferred tool call](#a-workers-tool-call-is-deferred-on-an-approval)); in `validate:1`, which
   has none, it is denied and reported not run. Listing a command
   ([change the autonomy policy](#change-the-autonomy-policy)) lets it run unasked, as the exact
   argv. Before you list one for this repository, check it runs in a fresh worktree with no
   network: a run's worktree has no `node_modules`, so `corepack pnpm check` fails there until its
   dependencies are present; until then every validation of this repository reports its commands not
   run, and you run the checks in the worktree yourself.
4. **Check, then restart:** `system check` until it says `ok` (it names a malformed kind, kinds on a
   review member, or Workers of one workspace that disagree on `worktreePerRun`), then
   `system shutdown`, `system start`. `system explain` (or `/ui`) shows each Worker ready, or why
   not; a Worker given kinds lists them.
5. **Run by kind.** The lead starts `algorithm-development` for a board task with MCP `run` and
   `task`: source-code work with no variant, docs work with `variant: docs`, test work with
   `variant: tests` (CLI: `system run algorithm-development --variant docs …`). `system explain
   <runId>` names each step's Worker; its route decision says `takes code work, one of its kinds`,
   and a writer that lost says `takes docs, tests work only; this work is code work`.

What this split does not reach, and why:

- **Brainstorms stay on website Workers.** A `brainstorm` member's step needs `reason`, which an
  agent Worker offers only for a review member's steps
  ([ADR-0049](../decisions/adr/0049-read-only-agent-workers-as-review-members.md)); adding the Codex
  or Antigravity CLI to brainstorms needs a decision of its own, not configuration. A `review` team
  can already take them as review members ([above](#agent-workers-as-review-team-members)).
- **The Antigravity CLI reviews, and writes nothing here.** `develop:1` keeps a conversation, which
  agy cannot resume, and `validate:1` runs commands, which agy has none of; a writing agy Worker given
  `docs` would never be admitted to either. It stays a reviewer.
- **A step that names no kind needs a Worker given none.** Once every writer has kinds, a writing
  step that names none (a planner's `develop` step, where a template's growth policy allows one, or
  a configured template's) finds no writer and fails admission, saying `no Worker that proves
  develop … takes work that names no kind`; give one writer no kinds to take such steps.
- **`validate:1` is test work.** With Codex unable to confine its commands on this host, it fails
  admission; giving `claude-code` `tests` too moves both the validation and test writing to Claude
  Code.
- **After the move to accounts × roles** ([below](#migrate-agent-workers-to-accounts--roles)), the
  kinds go on the roles (`roles: [{ id: code, …, kinds: [code] }]`), and the assignments decide which
  accounts take them; `system account migrate` keeps each row's kinds on its role.

To undo, remove `kinds` from the Workers (and the writers, if you no longer want them) and restart:
every Worker then takes every step it proves the capabilities for.

## Turn an off row back on

The default composition (PROP-0004) keeps these rows in the system bundle but
off (`disabled: true`). The Claude Code agent rows (`agent-runtimes`,
`runtime-claude-agent-sdk`, `agent-workers`) are on (PROP-0010 B3).

| Rows | What they serve |
|---|---|
| `runtime-codex-sdk` | Codex agent Workers ([Codex Workers](#codex-workers)); admitted where the probe proves its tool gate on the host |
| `runtime-acp` | ACP agent Workers ([agent runtimes](../design/agent-runtimes.md)); an ACP agent cannot ask a tool gate before each tool call, so the `agents` source admits none of its Workers until it can |
| `runtime-antigravity-cli` | Antigravity CLI agent Workers ([Antigravity CLI](#antigravity-cli-workers)); admitted on an agy version a supervised live check verified |
| `profile-software-development` | the `agent-review` and `algorithm-development` templates, for agent Workers ([templates](../reference/workflow-templates.md#agent-review)); the Base pilot needs it on ([pilot](pilot.md#name-the-repository-and-the-workers)) |
| `digest-extractive` | the extractive-first digest provider, in place of `digest`: turn the `digest` row off in the same patch ([swap the digest provider](#swap-the-digest-provider)) |
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

## Swap the digest provider

The default composition digests with the `digest` row, whose Worker reads every source whole. The
`digest-extractive` row, off, provides the same seam extractive-first: code selects verbatim spans
of the sources first, the Worker reads only those, and each claim's quote is filled from them
([extractive-first](../design/digests.md#extractive-first)). Both serve the same `digests_*` tools,
and one runs at a time. Swapping them is a configuration change only (Base exit criterion 6).

1. **Between runs.** A digest pending when you swap is not finished by the other provider: the
   board task waiting on it keeps no digest, recorded with why ("the digest provider no longer
   knows request …"). Swap when no task's run has just reported.
2. **One patch, both rows.** In your profile patch, `~/.dsh/profiles/system/cordis.patch.yml`:

   ```yaml
   - id: digest
     disabled: true
   - id: digest-extractive
     disabled: false
   ```

   A row's configuration is its own: if you configured the `digest` row (`tier`, `maxClaims`,
   `maxPending`, `timeoutMinutes`), give `digest-extractive` the same `config`; it adds
   `maxExtracts`, the spans its Worker is given (default 40).
3. `system check` until it says `ok`, then `system shutdown` and `system start`.
4. **Check.** `system plugins` shows `@tsuuanmi/system-digest` `candidate` and
   `@tsuuanmi/system-digest-extractive` `default`, each with the `lifecycle` decision that recorded
   it; `system health` shows `plugins` and `manifests` ok. A new request's id starts with `dgx-`,
   and its brief (`system artifact <brief>`) points at a `digest-extract@1.0` artifact, never at a
   source.
5. **Compare** before and after, as the [release checklist](../validation/release-checklist.md)
   records it: the same kind of results digested by each provider, their claims kept and dropped
   and escalations (`digests_get`), and the tokens the digest Workers' runs recorded on the
   resource ledger (MCP `resources_usage`).

To swap back, reverse the patch (or remove both rows from it) and restart. A provider's requests
stay in its own table: while it is off, `digests_get` of one of its requests is refused
(`unknown-request`), and the report counts that digest's attachment but not its claims, and says so
in its notes; its digest and settling decision stay in the ledger (`system artifact`). Compare the
period before a swap with the report made before it.

With both rows on, the second provider to register does not start: `system health` shows
`plugins` down, naming it ("service \"digests\" has been registered"). Turn one of them off and
restart.

## The manifest check found a plugin

`system health` shows `manifests` **down**, naming each plugin and what the plugin host's
manifest check found in it at start
([the manifest check](../design/plugin-host.md#the-manifest-check)):

- **it runs with no manifest**: a row mounts a package that ships no `plugin-manifest.json` (or
  cannot be found), and the `plugin-host` row's `allowWithoutManifest` does not name it;
- **it runs with a manifest the host refused**: it declares `_meta`, is not a valid
  `plugin-manifest@1.x`, names another package, or is larger than 64 KiB;
- **it consumes a seam in a range its provider does not satisfy**: the provider's manifest
  declares a version the range does not accept (a row of another release, a third party's plugin),
  or no mounted plugin declares a seam it requires and contract 1.0 does not satisfy it.

The host cannot keep the row from running
([ADR-0048](../decisions/adr/0048-the-plugin-host-checks-the-composition-at-start.md)): treat the
plugin as unchecked until the finding is cleared.

1. `system plugins` shows each finding under its plugin, and the `gate` decision that recorded it
   (`system artifact <id>`).
2. If the plugin need not run, turn its row off in your profile patch (`disabled: true`).
3. A `@tsuuanmi` package's manifest is generated and checked with the code: reinstall the
   release (`system init` from it), which ships valid manifests and matching versions. Rows of two
   releases in one profile are what an unsatisfied range usually means.
4. A third party's plugin: fix its manifest, or ask its publisher to; the host never repairs one.
   A package that ships no manifest by design (as the DSH rows) runs only when you allow it: add
   it to the `plugin-host` row's `allowWithoutManifest` in your patch. That patch replaces the
   row's whole config, so copy the bundle's list (the four DSH rows) into it too, or each of them
   becomes a finding.
5. Restart. The start records each cleared finding once as `pass`; the same finding is never
   recorded twice.

A refused manifest in a row that is off makes `manifests` degraded instead: the plugin does not
run, but its lifecycle is not recorded until its package ships a valid manifest. The DSH rows the
bundle allows are noted, not found.

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

### A model call times out

A step on a model Worker fails as `timeout`, and since its prompt was sent the
engine does not send it again (`USER_ACTION`). The message says which bound
stopped it ([bounds](../design/models.md#a-call)):

- **`… TIMEOUT: no progress for N ms (idleTimeoutMs) after E stream event(s)
  and C characters of answer`:** the stream went silent on the last of its
  attempts (the first request and up to `maxRetries` re-attempts). A stalled
  connection or an overloaded provider, not a slow answer. Check the
  provider's status and the network path, then `system continue <runId>`.
- **`… did not finish within N ms (callTimeoutMs, the ceiling over every
  attempt)`:** the call was still answering, or re-attempting, when the
  ceiling (default 15 min) came. Either raise `callTimeoutMs` on the `models`
  row (a targeted patch: list the catalog too), or make each answer cheaper:
  a smaller entry `maxTokens`, or a lower `reasoning` level on the route if
  the model thinks at length (the `llm-pi-ai` route's reasoning tokens count
  toward `maxTokens`). Then `system continue <runId>`.

`system explain <runId>` shows the step's failure; a finished answer records
its attempts (`attempts` 2 or more: a request failed transiently first).

**A Gemini API call times out.** The Gemini API Worker (a `google` route,
`gemini-3.8-flash`) answered in 45 s to 4 min on 2026-10-23, with at most about
4,000 output tokens, and without a measurable thinking share: on a route that
sets no `reasoning`, `gemini-3.8-flash` already thinks at its lowest level
(`low`; it offers no `minimal` or `off`). Its time goes to the provider, not
to the answer's length, so raising the ceiling is the remedy for a slow call;
lowering `maxTokens` or `reasoning` does not help it. The defaults fit it: a
5 min silence bound and a 15 min ceiling.

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

## A review member fails on a website

A team member's step (`review:m<k>:propose`, a ballot, or a debate) fails on a website Worker, or
for want of one. `system explain <runId>` shows the step's decisions, and its error says which
case it is (seen live on 2026-10-23, with a ChatGPT and a Gemini member):

- **Over a website's input bound** (`invalid_input`: `no Worker can take this work: … the input
  has N characters; it takes at most M`). A website Worker takes at most what its driver
  declares: the Gemini site 30,000 characters (`maxPromptChars` on the `provider-gemini-web`
  row). That bound is the site's, not the code's: Gemini drops a longer paste without an error
  (observed 2026-10-16), so raising it only turns the refusal into a lost prompt
  (`input_dropped`). A member's input is the source it is shown plus about 1,500 characters of
  instructions; a text review's text is shown once (before 2026-10-24 it was shown twice, so a
  17,000-character text made a 36,064-character input). Such a member routes to a Worker of a
  family no earlier member has that takes it, at the step's tier or the lowest above (an API model
  Worker, or an agent Worker under the review-member profile); with none, it fails unsent and the
  message names what to shorten. For a text review, review a smaller part of the text, or lower
  `repositories.maxSourceChars` on the `workflow` row so a text that long is refused before any
  member is asked; for a repository, lower that bound or narrow `focus`. Then start the review
  again: `continue` would compose the same input.
- **A dropped prompt** (`input_dropped`): the site emptied the composer and took nothing. When the
  prompt was near `maxPromptChars`, the site's limit is lower now: lower `maxPromptChars` (a
  targeted patch on the `provider-gemini-web` row, listing its other settings too), restart, then
  `system continue <runId>`.
- **A stall** (`provider_stalled`: `… no meaningful progress for 300000ms (turns.stallTimeoutMs):
  …`). Nothing the driver reads changed for the stall bound: no answer text, no activity, no
  start or stop of generation. Read the page as it stood: `system events --type provider.stall`
  names its outline, and `system evidence <id>` shows it. A Gemini answer's thinking counts as
  progress while the answer shows it changing; a think that shows nothing new still stalls.
  - If the outline shows the answer still thinking or writing (Stop shown), the site was working
    past the bound: raise `stallTimeoutMs` on the `turns` row (below `turnTimeoutMs`, 15 min by
    default), or map the account's tier to a faster mode in the account catalog.
  - The prompt was sent, so nothing resends it on its own. If the site's conversation shows the
    answer finished meanwhile, take it with `system supersede <runId> <nodeId> -` (the answer on
    stdin): `system continue <runId>` sends the prompt again, into the same conversation.
  - A finished answer with no Copy, or the site's own error, is the site or its map, not the
    bound ([a provider UI change](playbooks.md#a-provider-ui-change)).
- **Rejected and not escalated** (`acceptance_rejected`: `…; not escalated: session … stays on its
  Worker model:… (standard), none at tier frontier or above, …`). The member's answer failed its
  contract, and its session, which keeps one Worker for the team's lifetime, has none at the next
  tier, so escalating could only fail admission. Read the answer
  ([why a step's answer was rejected](#why-a-steps-answer-was-rejected)). When the reasons say
  `the answer stopped at its Worker's output bound (N tokens)`, the answer was cut: raise that
  catalog entry's `maxTokens` on the `models` row ([API and local models](#api-and-local-models);
  a route's reasoning tokens count toward it), restart, then `system continue <runId>`. Otherwise
  `continue` runs the step again on the same Worker; to escalate a member of that family, give it
  a Worker at the next tier (a catalog entry of the same `family` at that tier).
- **`team review needs N provider families, one per member; M is ready`**: fewer families are ready
  than the team has members (Workers ready or busy that prove the step): see
  [one provider family](#one-provider-family). With enough of them the message does not say this,
  and the admission's own reasons are why.

## Pool a provider's accounts

Every provider's accounts are `assigned` by default
([ADR-0052](../decisions/adr/0052-accounts-are-assigned-unless-pooling-is-recorded.md)): each
serves its own work, and a limit on one makes its work wait for the reset instead of moving to
another account of that provider. Pooling moves unsent work to another account of the provider
when one is busy or at its limit
([ADR-0034](../decisions/adr/0034-unsent-failover-to-a-sibling-account.md)). It is your recorded
decision
([ADR-0055](../decisions/adr/0055-personal-accounts-may-be-pooled-on-the-operators-recorded-acceptance.md)),
on one of two bases, and the record says which:

- the provider's terms allow it (an organization plan's seats, say): name the terms you read;
- the accounts are personal subscriptions, whose terms restrict or prohibit rotating accounts
  around their limits, and you accept that risk: say that it is not a reading that the terms allow
  pooling, name your decision, and say that you accept the risk. `system` does not assess it.

1. Add the provider to the row that holds its accounts, with that record. A website provider goes
   on the `accounts` row, an agent runtime on the `agent-workers` row:

   ```yaml
   - id: accounts            # or agent-workers
     config:
       providers:
         - provider: chatgpt-web          # or the runtime kind, for example claude-agent-sdk
           accounts: pooled
           pooledTerms:
             confirmedBy: operator
             confirmedAt: "2026-10-24T09:00:00+07:00"
             terms: >-
               Not a reading that chatgpt-web's terms allow pooling. Operator decision D33
               (2026-10-24): move work between the operator's own personal accounts of this
               provider when one is busy or at its limit; the operator accepts the risk under
               the personal-plan terms.
   ```

   For terms that allow it, `terms` names them instead ("ChatGPT Team terms, section 3, read
   2026-10-24"). `confirmedBy` is who decided, `confirmedAt` when. The rest of the row's
   configuration stays (a targeted patch replaces the whole config).
2. Restart (`system shutdown`, then start). A pooled provider with no or partial `pooledTerms`
   fails startup with the exact path. Each start records your record as a `gate` decision (rule
   `turns.pooled-terms` or `agent-workers.pooled-terms`: "operator recorded pooling for
   chatgpt-web on …: <terms>"); `system explain` shows it.
3. To go back, set `accounts: assigned` (or remove the entry) and restart.

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

## Two accounts sign in as one person

Two catalog entries of one provider whose saved sign-ins are the same person are one account, not
two (REQ-ACC-7): counting them as two would let a team's members, or a failover, share it. So
none of them takes work. `system health` shows `accounts` degraded, naming them (`chatgpt-main and
chatgpt-2 are signed in as the same person`), and their Workers are `unavailable`; a turn already
routed to one fails `reauth_required` before anything is sent.

1. Decide which entry keeps that sign-in.
2. Sign each other entry in as a different person: `system account login <id>` and Save. Or remove
   it from the `accounts` row's catalog and restart.
3. `system health` shows `accounts` ok again once no two entries share a sign-in, and the Workers
   take work at once. Then `system continue <runId>` for a run that failed on it.

## Enroll an agent account

An agent account is one sign-in of an agent runtime (Claude Code, Codex, the Antigravity CLI) in
an enrollment slot: an owner-only home, nothing more. Its id is the runtime and a keyed hash of who
signed in (`codex-sdk:04aa5c1e9b7d3f20`), never a name you choose
([ADR-0051](../decisions/adr/0051-agent-accounts-are-enrolled-slots-identified-by-their-login.md)).
Slot 1 of each runtime is its existing home (`~/.dsh/system/claude-home`, `codex-home`,
`antigravity-home`), adopted where it is; later slots are
`~/.dsh/system/agent-homes/<runtime>/<n>`. An account runs work once the `agent-workers` row
assigns it roles ([migrate agent Workers to accounts × roles](#migrate-agent-workers-to-accounts--roles));
while the row still names hand-named Workers, they run in slot 1's home only, and an account in a
later slot is enrolled and watched, and runs nothing.

Before you start: the vault is loaded (the key of the ids lives there, and is backed up with it),
the runtime's row is on, and you are at a terminal on the host. Do not enroll a runtime whose
Workers sign in by a forwarded API key or through the gateway (`forwardEnv`, a configured model
provider): no person is behind it, so its home reads `ambiguous` or `signed-out`, and once enrolled
its Workers stop (PROP-0012 open question 4).

1. **More than one slot:** give the runtime its slots on the `agent-workers` row (default 1), and
   restart:

   ```yaml
   - id: agent-workers
     config:
       providers:
         - provider: codex-sdk
           slots: 2
       # … the rest of the row's configuration stays (a targeted patch replaces the whole config)
   ```

2. **Slot 1 (the home your Workers use now):** `system account login codex-sdk`. It adopts the home
   and verifies the sign-in it holds, without signing in again. From then on the Workers in that
   home run only while this account is `ready`: a re-sign-in there as anyone else stops them.
3. **Another account:** `system account login codex-sdk` again. It takes the lowest free slot,
   prints the runtime's own sign-in command for its home, and runs it here without D-Bus
   (`env -u DBUS_SESSION_BUS_ADDRESS CODEX_HOME=… codex login`; for Claude Code,
   `CLAUDE_CONFIG_DIR=… claude`, then `/login` and exit). Sign in as the other person, and let the
   command end: the CLI then verifies who signed in.
4. Read what it printed (also `system account list`): the account id, a masked hint (Claude Code
   shows `a…@example.com`), and the status. `ready` exits 0; anything else exits 1 and takes no
   work: see [resolve a quarantined agent account](#resolve-a-quarantined-agent-account).
5. `system explain <decision id>` shows each `enrollment` decision: the slot, the account id, the
   reader and version, and why; never the person.

- **Sign an account in again** (a token expired, `signed-out`): `system account login <accountId>`.
  It must sign in as the same person, else the account is quarantined `changed`.
- **Free a slot:** `system account remove <accountId>` (or `<runtime> --slot <n>`). The home and
  the sign-in in it are kept; to remove the sign-in itself, sign out with the runtime's own
  command in that home (for example `CODEX_HOME=… codex logout`).
- **The Antigravity CLI** has no verified way to read who is signed in, so
  `system account login antigravity-cli` is refused before anything is taken (`config_error`,
  exit 1): adopting its home would only hold the hand-named Worker running there, and its account
  could never read `ready`. Its hand-named Workers run on as before; no Worker derived for it takes
  work until a reader is verified (PROP-0012 open question 1). A slot taken before this release
  stays `unverified`; free it if you like (`system account remove antigravity-cli --slot <n>`): its
  home and sign-in are kept.
- **A new runtime version:** the readers are pinned to the versions they were checked on (Codex
  0.164.0, Claude Code 2.1.308 to 2.1.310). On another version an account reads `unverified`, saying
  the version found and the ones admitted; slot 1's hand-named Workers still run as before, derived
  ones do not, and the reader waits for a check on that version. The usage report readers are
  pinned the same way ([read each account's quota](#read-each-accounts-quota)). An installed
  Claude Code that updates itself (`~/.local/bin/claude`) leaves the pinned versions this way: at
  the next probe, `system account list` shows its accounts quarantined `unverified`, naming the
  version, and their derived Workers take no work until a release pins that version. To keep
  working meanwhile, keep a checked copy pinned
  ([keep Claude Code's pinned version](#keep-claude-codes-pinned-version)).
- **A label for each account** (optional): give its assignment a `label` in the `agent-workers`
  row, such as `science` or `lead` (plain text, at most 64 characters). The roster and the Workers
  tab then name its Workers `Claude Code · science · develop [code]`, and `system account list`
  shows it. It is for people only: ids, routing, and records do not change.

## Resolve a quarantined agent account

`system health` shows `agent-accounts` degraded, naming each account that takes no work, and
`system account list` shows its `status`, `reason`, and `detail` (what the reading that
quarantined it found). A quarantine never clears by itself; only your `system account verify` or
`login` lifts it.

| Reason | What happened | Resolve |
|---|---|---|
| `signed-out` (a status) | the runtime's own sign-in check fails in that home | `system account login <accountId>` (or `<runtime> --slot <n>`), as the same person |
| `changed` | the home now signs in as another person | sign it in again as the account it was (`system account login <accountId>`), or take the new person as a new account: `system account verify <runtime> --slot <n> --accept` (the old id keeps its history) |
| `duplicate` | two slots of one runtime sign in as one person (both are quarantined) | sign one slot in as another person, or `system account remove` it; then `system account verify` the other |
| `ambiguous` | the sign-in names no whole person (an API-key sign-in, a damaged state file), or two people share one short id | sign the slot in with a personal login; for a short-id clash, remove one of them and enroll it again |
| `unverified` | no reader is verified for the runtime or its version (a slot of the Antigravity CLI taken before; an upgraded Codex or Claude Code); `detail` names the version found and the ones admitted | pin an admitted version and `system account verify` it ([Claude Code](#keep-claude-codes-pinned-version)); otherwise slot 1's hand-named Workers run as before, its derived Workers take no work, until a reader is verified on that version |

A run that was already queued when its home changed person fails before anything is sent
(`config_error`, naming the quarantine); `system continue <runId>` once it is resolved.

## Migrate agent Workers to accounts × roles

Agent Workers are derived as account × role (PROP-0012 phase F,
[design](../design/agent-runtimes.md#workers--account--role)): the `agent-workers` row defines
roles once and assigns each enrolled account its roles; each Worker is
`agent:<accountId>/<role>`, never a name you choose. A release with this code changes nothing on
its own: the hand-named rows (`claude-research`, `codex-review`, `agy-review` on the live host)
keep loading and routing exactly as before, until you apply the move below. From then on they are
refused at load.

Before you start: back up (`system backup`), and read the Antigravity note in step 2.

1. **Enroll slot 1 of each runtime the rows use** (its existing home, adopted where it is; see
   [enroll an agent account](#enroll-an-agent-account)): `system account login claude-agent-sdk`,
   `system account login codex-sdk`. Each must read `ready`. The Antigravity CLI cannot be
   enrolled (no reader: `system account login antigravity-cli` is refused, and its Worker runs on;
   step 2).
2. **Print the move:** `system account migrate`. Nothing changes. It prints what each hand-named
   Worker becomes, what stops the move (exit 1), and, once nothing does, the new `agent-workers`
   row and any pool templates for the `resources` row. Each role keeps its rows' `kinds`, and
   their `description` when they all give the same one (rule version 3). For the live patch: one
   role `review` (the checkout, read-only, standard; `maxTurns: 4` on Claude Code, the model on the
   Antigravity CLI), assigned to the Claude Code and Codex accounts by their ids; with the work
   kinds patch, also `develop` (`kinds: [code]`) and `develop-2` (`kinds: [docs, tests]`).
   - **The Antigravity CLI** cannot be verified (no reader): no account of it can be enrolled
     (one enrolled before is `unverified`), and a derived Worker takes work only on a `ready`
     account. The move waits for its reader (PROP-0012 open question 1). To move now anyway, stop
     its Worker at the cutover: `--stop antigravity-cli` (`agy-review` then becomes no Worker, and
     anything that names it, such as the first experiment, waits for it).
   - The printed row assigns slot 1's accounts only and names no label: add the later slots'
     assignments, and a `label` per account if you want one, before you put it in.
   - Any other stop is named with what to do (enroll slot 1, resolve a quarantine, give a
     runtime's rows one pool).
3. **Drain:** `system drain` (the move is refused while a run of a hand-named Worker is queued or
   running).
4. **Apply:** `system account migrate --apply` (with the same `--stop` as step 2, if any). It
   records an `enrollment` decision per Worker and one for the cutover (`system explain <decision>`),
   and moves each Worker's agent sessions and runs to its new id, so a continued conversation stays
   on its account. Run again, it changes nothing. From now on the running hand-named Workers take
   no work. If it prints `account_migrate would make an output its schema refuses (a defect), so
   nothing changed`, nothing was decided or moved: the hand-named Workers run on; report the
   message (a defect of the release, not of your patch).
5. **Put the printed row in the profile patch** (`~/.dsh/profiles/system/cordis.patch.yml`): it
   replaces the `agent-workers` row's whole config (`workers` gone; `providers`, `roles`,
   `assignments` in). Add any printed `templates` to the `resources` row's config. Then
   `system shutdown`, `system start`, `system resume`.
6. **Check:** `system account list` names each account's Workers; `system health` is ok; a review
   run routes to `agent:<accountId>/review`.
7. **The first experiment** (`review-worker-agnostic-1`, still `proposed`) pins
   `agent:codex-review` and `agent:agy-review`: revise its record (`revision: 2`, `supersedes` 1)
   with the ids the move printed before registering it (PROP-0012 migration step 6). A changed pin
   after registration is a new experiment.

**Assign roles later:** a newly enrolled account has no Worker until the row assigns it roles
(`assignments: [{ account: <id>, roles: [review] }]`). Two accounts of one runtime can serve one
role at once; a limit on one makes its work wait, never move to the other, unless the runtime is
[pooled](#pool-a-providers-accounts).
`maxConcurrentRunsPerAccount` on the runtime's `providers` entry bounds how many of an account's
runs run at once across its roles (default 1).

**Roll back:** `system drain`, then `system account migrate --rollback`: each session and run moved
goes back to its hand-named Worker, the refusal is lifted, and a `rolled-back` decision is
recorded. Put the hand-named row back in the patch and restart. Results, usage, and decisions keep
the ids they were written with. A release downgrade alone, without the rollback, finds the
hand-named rows' sign-ins where they were (slot 1 is their home), but their moved sessions stay
under the new ids.

If the daemon refuses the `agent-workers` row at start with "the hand-named agent Workers … were
migrated", the patch still names `workers`: put the printed row in, or roll back.

## Read each account's quota

Each ready, assigned agent account whose Workers draw on a pool template has its pool's windows
read from its runtime's own usage report, without a model turn: once after each of its runs, and
every `limitReadSeconds` ([ADR-0059](../decisions/adr/0059-quota-readings-from-each-accounts-own-usage-report.md),
[design](../design/agent-runtimes.md#an-accounts-usage-report)). Two accounts on different plans
read their own shares; nothing is configured per plan. The Workers tab (and `system roster`) shows
each window as `five-hour: used 42 % of 5 h, resets 14:20 (read 14:05)`.

1. **Move to accounts × roles first** ([above](#migrate-agent-workers-to-accounts--roles)): the
   periodic read covers derived Workers' accounts only. A hand-named Worker's account is read only
   once after a run that hit a limit, for its reset.
2. **Give the runtime a pool template and map its window names** (the `resources` row's
   `templates`, the provider entry's `pool` and `windows`). For Claude Code, the five-hour and
   seven-day windows (D55):

   ```yaml
   - id: resources
     config:
       templates:
         - template: claude-plan
           group: claude-agent-sdk
           kind: interactive
           windows:
             - { id: five-hour, kind: rolling, seconds: 18000 }
             - { id: seven-day, kind: rolling, seconds: 604800 }
   - id: agent-workers
     config:
       providers:
         - { provider: claude-agent-sdk, slots: 2, pool: claude-plan, windows: { five_hour: five-hour, seven_day: seven-day }, limitReadSeconds: 600 }
   ```

   The runtimes' window names, which `windows` maps:

   | Runtime | Its windows |
   |---|---|
   | Claude Code | `five_hour`, `seven_day`, `seven_day_oauth_apps`, and a weekly window per model family, `seven_day_<family>` (the names its `rate_limit_event` uses too; the daemon's log names each window a report gives that `windows` does not map) |
   | Codex | each window by its length in minutes: `300m` (five hours), `10080m` (a week), as the account reports them |
   | Antigravity CLI | each bucket's `id`, as `HOME=<home> agy --print=/usage --output-format json` lists them under `command.data.groups[].buckets[]` |

   A window the report gives and `windows` does not map is skipped (logged once), unless it is used
   up: then every window of the pool closes until its reset (fail closed). Map each window that can
   stop the account's work, or accept that an unmapped one at 100 % holds the account.
3. **Choose `limitReadSeconds`** on the provider entry: how often each account is read (default
   600; 60 to 86400; `0` turns the periodic read off and keeps the read after each run). Each read
   starts one runtime process per account (Claude Code, `codex app-server`, or `agy`), no model
   turn: five accounts at 600 s is thirty short processes an hour, one at a time per runtime.
4. **Restart** with the patch (`system shutdown`, `system start`): the first reads run a few
   seconds after the start, the longest unread account first.
5. **Check:** each window shows `used … %` and a `read` time that moves; MCP `resources_pools`
   gives each window's latest reading, `source: runtime-result`, and `observedAt`.

When a window says unknown, or its `read` time stops moving:

- **`used unknown (its latest reading gives no used share)`**: its latest reading was a run's own
  event (Claude Code reports a share only near a limit); the next report fills it.
- **The report cannot be read.** A window with no reading yet says why in `system roster` (and the
  `/ui` Workers tab): `used unknown (no reading yet: its account's usage report could not be read at
  <time>: …)`, until a report of that account is read; a window with an older reading keeps it and
  its `read` time. The daemon's log names it too, once per reason: `the usage report of
  <accountId> (its periodic read) cannot be read, so nothing is recorded and its windows keep their
  last readings: …`. A report whose entries changed shape (`… its window <name> is not in the
  checked shape`) is a reader to fix and pin again, never misread. Most often a runtime version whose report was not checked (`… Claude Code
  2.1.311 is not verified`): the shares stay unknown until a release pins that version after
  checking it, never misread. An account on an API key has no plan windows (`… reports no plan
  limits`): give its pool `unknown: available`, or no pool.
- **A window stays `limited` though the report reads it open**: a report never opens a window a
  limit closed before that limit's reset or cooldown; the log says so (`… a report never opens a
  window a limit closed`). It opens at `until`.
- **The Antigravity CLI** has no identity reader, so its accounts are never `ready` and are not read
  periodically; a hand-named Antigravity Worker's account is read once after a run that hit its
  quota, for the reset.

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

Run the host as a systemd user service, so it starts with the machine, a
failure is noticed, and its environment is declared rather than inherited from a
shell. Below, `<node>` is the absolute path of a supported Node (`node --version`,
see [CON-2](../requirements/constraints.md)), `<checkout>` the installation that
runs (the live install: `~/workspaces/system-live`), and `<system>` its
`packages/cli/lib/bin.js`. Allow the user's services to run without a login
session: `loginctl enable-linger`.

`~/.config/systemd/user/system.service`:

```ini
[Unit]
Description=system harness

[Service]
WorkingDirectory=<checkout>
# Every variable the daemon reads, and nothing else; a missing file fails the start.
EnvironmentFile=%h/.config/system/daemon.env
ExecStart=<node> packages/cli/lib/bin.js start
# Drain first: no new run is admitted, running ones finish or resume on the next start. A daemon
# already gone (a `system shutdown` by hand, which exits 0 and is not restarted) needs no stop.
ExecStop=/bin/sh -c '[ -z "$$MAINPID" ] || exec <node> packages/cli/lib/bin.js shutdown --deadline 600'
# The drain's 600 s, the 60 s `system shutdown` waits after its SIGTERM, and a margin.
TimeoutStopSec=720
Restart=on-failure
StandardOutput=append:%h/system-backups/daemon.log
StandardError=inherit
UMask=0077

[Install]
WantedBy=default.target
```

`~/.config/system/daemon.env` (mode `600`, yours) holds `NAME=VALUE` lines: `PATH` and
`DSH_HOME`, required, and only the other names the daemon reads ([the daemon's
environment](../reference/cli.md#the-daemons-environment)). systemd expands nothing in it:
write absolute paths. `system check --env-file ~/.config/system/daemon.env` checks it against
the profile and prints names, never values. A clean `system shutdown` exits 0, so the unit is
not restarted; a crash is. The daemon's output goes to `~/system-backups/daemon.log`, the unit's
own messages to the journal: `journalctl --user -u system`.

**Health.** `system health` exits 0 healthy, 1 degraded, 2 down (or not
answering), and prints what to do for each check that is not ok. Run it on a
timer and let the operator's own notification run on failure:

```ini
# ~/.config/systemd/user/system-health.service
[Unit]
OnFailure=<your notifier>.service

[Service]
Type=oneshot
EnvironmentFile=%h/.config/system/daemon.env
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
EnvironmentFile=%h/.config/system/daemon.env
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

**Automatic update of the live install.** A timer runs one pass of the [automatic
update](#update-the-live-install-automatically) every 15 minutes, from the check checkout:

```ini
# ~/.config/systemd/user/system-auto-update.service
[Unit]
Description=system: one pass of the live install's automatic update
# A pass that stops and pauses itself exits 1, once; a paused pass exits 0.
OnFailure=<your notifier>.service

[Service]
Type=oneshot
# gh and git; the script puts Node 24 and pnpm on PATH itself.
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
# Options after the script: --settle <minutes>, --hours <HH-HH> (its section).
ExecStart=%h/workspaces/system-live-check/scripts/live-auto-update.sh
# A pass with a drain and two builds takes its time. The daemon it stops and starts is
# system.service's (systemctl), so nothing of it is in this unit: no KillMode= is needed.
TimeoutStartSec=infinity

# ~/.config/systemd/user/system-auto-update.timer
[Timer]
OnCalendar=*:0/15

[Install]
WantedBy=timers.target
```

## Upgrade with drain

1. `system backup <dir>`.
2. **Check the profile against the new code** before stopping anything: build
   the new version in its own checkout, then run its CLI against this home,
   `node <new checkout>/packages/cli/lib/bin.js check`. It loads every row of
   the profile as composed now (the operator's patch included) against the new
   plugins' config schemas and checks, such as a configured workflow template
   that uses a removed team procedure or a placeholder the engine does not
   fill. It exits 1 and names each problem; fix
   the patch, and check again until it says `ok`.
3. `system shutdown --deadline 600`. This drains first: no new run is admitted
   (gateways answer 529 or `response.failed`), and the command waits for runs
   that are executing. Runs still executing at the deadline are durable and
   resume after the restart. When the workflow engine is not running (a plugin
   failed), there is nothing to drain: the command says so and stops the host
   directly, once `/proc` shows the discovery file's process is this home's DSH
   profile; otherwise it stops nothing.
4. Update the code, then `pnpm install && pnpm build`, or install the new
   packages. The profile must link its bundle from the installation that runs
   it: the plugin host reads each plugin's manifest through that link
   ([plugin host](../design/plugin-host.md)). If the profile was set up from
   another checkout (`~/.dsh/profiles/system/package.json` names it), run
   `system init` from this one; it never rewrites your patch.
5. `system start`. Store migrations run forward at start, per owner, each in
   one transaction. A run resumes from its durable node records; a submitted
   turn is reconciled, never blindly resent.

The live install's update from e218ae7 to Base does these steps by a script, with the checks of
the upgrade suite and a rollback ([below](#update-the-live-install-from-e218ae7-to-the-base-release)).

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

## Update the live install from e218ae7 to the Base release

The live install runs from the `~/workspaces/system-live` worktree, detached at e218ae7, on Node 24,
under its user unit `system.service` ([Run as a service](#run-as-a-service); a daemon still started by
hand moves under it [once](#run-the-live-daemon-under-systemservice)), its patch
`~/.dsh/profiles/system/cordis.patch.yml`. Claude Code's `system` MCP server authenticates
through that checkout's `packages/cli/lib/bin.js mcp-headers`. [`scripts/live-update.sh`](../../scripts/live-update.sh)
takes it to the Base release (the merged `main`): the [upgrade with drain](#upgrade-with-drain),
each step checked, rolled back when one fails. It is a dry run unless `--apply`.

**What changes.**

- **The store.** Base's migrations run at its first start, per owner, each in one transaction. Every
  one from e218ae7 to Base adds tables, nullable columns, or indexes; none rewrites a row. Once Base
  has migrated the store, e218ae7 refuses it (newer than it knows), so going back restores the
  backup.

  | Owner | Migrations | Adds |
  |---|---|---|
  | `agent-workers` | 3 to 7 | a run's budget decision and reservation; its workflow run, and the worktrees; the tool gate's requests; its task and project; its brief's files |
  | `workflow` | 9 to 16 | a wake's generation; the runs that serve board tasks; briefs; a remediation's approval request; deferred tool calls; a task's digest, budget, and question |
  | `approvals` (new) | 1, 2 | the approval queue; policy changes |
  | `board` (new) | 1, 2 | projects, tasks, and client requests; a charter's expiry |
  | `digests` (new) | 1, 2 | digest requests, with their tier and escalation |
  | `plugin-host` (new) | 1 | each plugin's recorded lifecycle |
  | `resources` (new) | 1 | usage records, readings, reservations, holds |

  `artifacts` (3), `event-log` (2), `gateway-turns` (2), `leases` (1), `models` (2), `turn-receipts`
  (1), `turns` (9), and `worker-sessions` (2) do not change. At its first start Base also records
  each plugin's lifecycle state, a `lifecycle` decision each. Retention is unchanged (30 days), and a
  run still running at the stop resumes under Base.
- **The composition.** New rows, on with their defaults: `plugin-host`, `resources` (no pool),
  `approvals` (the [studio policy](../../packages/system-bundle/README.md)), `board`, `digest`, and
  `report`. `agent-runtimes`, `runtime-claude-agent-sdk`, and `agent-workers` are on now, so the live
  patch's `claude-review`, inert until now, becomes a Worker. `runtime-antigravity-cli` is new and
  off; `runtime-codex-sdk`, `runtime-acp`, `profile-software-development`, and both gateways stay off.
  A read-only agent Worker proves `review` and `local-data`, never `reason`: `ask`, teams, and
  research route to the website Workers as before.
- **The profile's link.** The live profile links its bundle from the main checkout
  (`~/workspaces/system`), not from `system-live`. The code comes from the installation either way,
  but Base's plugin host would record the main checkout's manifests (none, on its branch). The script
  runs `system init` from `system-live` (the patch is never rewritten) and puts the old link back on
  a rollback.

**The live patch.** Merge [`examples/live-base.patch.yml`](examples/live-base.patch.yml) into a copy
of it by row id: its `agent-workers` row replaces the live one and keeps the live Claude Code Worker
as it is (`claude-review` at this update; the example names it `claude-research`, its id since its
rename on 2026-10-24, [renaming an agent Worker](#agent-workers));
`runtime-codex-sdk` and `runtime-antigravity-cli` are added, and `profile-software-development` is
turned on for the pilot and the live checks (off in the bundle, the operator's decision of
2026-10-24). Keep every other row as it is:
`accounts` (`chatgpt-main`; `gemini-main` with its `argon` frontier tier), `login` (`vncPath`),
`workers` (`priority`, where you only move the Claude Code Worker first:
[pilot](pilot.md#name-the-repository-and-the-workers)), `provider-gemini-web` (`disabled: false`, the `modes` map with `argon` and
`site`, `researchMode: flash`), `workflow` (`allowSameFamily`, `repositories.maxSourceChars: 24000`),
`turns` (`maxConcurrentTurnsPerAccount: 2`), `llm-pi-ai` (`google`, `apiKeyEnv`), and `models`
(`gemini-api`). The new rows need nothing. The live patch with the fragment passes Base's `system
check` (37 rows, checked on a copy, 2026-10-23).

- **Codex.** Of the [two ways](#codex-workers) to make `codex` reachable, use the npm install under
  the Workers' tools directory. It is there already (`~/.dsh/system/tools/codex`, 0.162.1); the read
  confinement binds that directory back with no `readOnly` entry to keep in step; and its path does
  not move when your own `codex` updates itself, as the standalone release directory does. Install the
  release the runtime's gate is written against first:
  `npm i --prefix ~/.dsh/system/tools/codex @openai/codex@0.164.0`. Its Worker home
  (`~/.dsh/system/codex-home`) is signed in and configures no MCP server.
- **Antigravity.** The row names `~/.local/bin/agy`. Check that
  `AGY_CLI_DISABLE_AUTO_UPDATE=true ~/.local/bin/agy --version` says 1.4.6, the only version admitted
  ([Antigravity CLI Workers](#antigravity-cli-workers)). Its Worker home exists; its empty
  `mcp_config.json` configures no server.
- **Claude Code.** `claude-review` is unavailable ("not signed in inside its home") until Claude Code
  is signed in inside `~/.dsh/system/claude-home` ([Worker home](#agent-workers)).

**Steps.**

1. **Prepare, with the profile running.** Build the target in a checkout of its own:
   `git -C ~/workspaces/system worktree add --detach ~/workspaces/system-base <sha>`, then
   `pnpm install --frozen-lockfile && pnpm build` there (Node 24 first on `PATH`, pnpm from Node 22's:
   `export PATH="$PATH:$HOME/.nvm/versions/node/v22.23.2/bin"`). Write the candidate patch
   (`~/system-backups/live-base.cordis.patch.yml`). Install Codex 0.164.0 and check agy's version.
2. **Dry run**, from the target's checkout (never from `system-live`, whose files the update
   replaces while the script runs; it refuses): `~/workspaces/system-base/scripts/live-update.sh
   <sha> --check-with ~/workspaces/system-base --patch ~/system-backups/live-base.cordis.patch.yml`
   (and `--from <the live commit>` once it is no longer e218ae7).
   It changes nothing. It checks the tools, the live checkout (clean, at e218ae7), the target (a
   descendant), the vault key, free space, and the candidate patch against the target's code
   (`system check --env-file` on a scratch copy of the profile, with the unit's environment file);
   that the daemon runs under `system.service`; captures what the profile answers now (a read); and
   prints `system health` and the plan. Fix what it reports until it ends with the plan.
3. **Apply:** the same command with `--apply`, in a shell that outlives a disconnect (`tmux`, or
   `nohup … > ~/system-backups/live-update.out 2>&1 &`): the drain alone may take ten minutes. The
   unit starts the daemon with its environment file, never this shell's environment. Notes and the
   backup go to `~/system-backups/<date>-before-base/` (`-2`, `-3` for a later attempt).
4. **Read the outcome.**
   - Exit 0, `updated`: Base runs. `system plugins` lists each plugin's lifecycle, and `system
     health` names each agent Worker that cannot take work yet (`agent:codex-review
     (unavailable)`): [Codex Workers](#codex-workers) and [Antigravity CLI
     Workers](#antigravity-cli-workers) list the reasons and what to do.
   - Exit 1, `STOP` (nothing was changed) or `rolled back`: e218ae7 runs, on its store as it was at the
     stop. The notes say why.
   - Exit 2, `LOOK FIRST`: the script will not act on what it found, or the rollback failed. It prints
     the checkout, the daemon, and the backup; recover by hand (below).

   The same command takes up an interrupted run: each step done is checked, not done again.

**What the script checks.**

- Before the stop, as in the dry run, and that the daemon is this checkout's `dsh` under `system
  start`, the main process of `system.service`, which runs in `system-live` on Node 24 with one
  required environment file naming this DSH home, its output going to a file. A daemon started any
  other way is refused, before anything changes.
- The stop: `systemctl --user stop system.service`. Its `ExecStop` is `system shutdown --deadline
  600` (the drain), and the daemon and `system start` exit. It never kills.
- The backup, taken once the daemon has stopped, so it is the store a rollback returns to: `system
  backup` (the store by `VACUUM INTO`, and the vault; the key stays in `~/.dsh/system`, as in
  [backup and restore](#backup-and-restore)), verified by a restore preview; and the profile's files.
  Login profiles are not state, and Base pins the same Chrome, so they are not copied.
- The build: `pnpm install --frozen-lockfile`, `pnpm build`, every package of the bundle built, and
  the build stamp `packages/cli/lib/build-commit` naming the target ([build
  stamp](../../packages/cli/README.md)). A target whose build writes no stamp is refused: update to it
  with the script of its own checkout. The `--check-with` checkout's stamp must name its own commit.
  The stamp replaces `--marker`, which the script no longer takes (a command with it exits 2).
- Before the start: `system check --env-file` of the profile as it will start, with the unit's
  environment file. Then `systemctl --user start system.service` (a unit the updated code made fail
  at its start limit is reset first).
- After the start: `/healthz`, then the [upgrade suite's](../../packages/cli/tests/upgrade/upgrade.e2e.ts)
  expectations, on the live store: every run explains and answers `result` as before (one running at
  the capture may have moved on), no migration went backwards, and every step, session, and artifact
  record of a post-update snapshot validates. No health check is worse than it was (ok, degraded,
  down) or gone, and no Worker that could take work cannot; the agent Workers new in the update are
  reported, not held to it. `system plugins` names no refused manifest, and `system mcp-headers`
  prints the client token's header. A profile already down before the update (a check other than
  its Workers) is no baseline: the capture refuses it, and nothing stops.
- A failure after the stop rolls back: the updated daemon stopped, the profile's files and link put
  back, e218ae7 checked out, installed, and built (its lib stamped with its commit, or with no stamp
  for code from before the stamp, as e218ae7), `system restore <dir>/store --yes` once Base has
  started on the store, and the unit started again. What Base did in its minutes is lost with its
  store.

**By hand**, with the unit stopped (`systemctl --user stop system.service`):

1. Copy `package.json`, `pnpm-lock.yaml`, and `cordis.patch.yml` from `<dir>/profiles/system` back
   to `~/.dsh/profiles/system`, and its `node_modules` too when the bundle link differs.
2. `git -C ~/workspaces/system-live checkout --detach e218ae7`, then `pnpm install --frozen-lockfile
   && pnpm build` there.
3. If Base started, in `~/workspaces/system-live`: `node packages/cli/lib/bin.js restore
   <dir>/store`, then again with `--yes`.
4. `systemctl --user reset-failed system.service; systemctl --user start system.service`, then
   `system health`.

The script was rehearsed on a throwaway worktree and DSH home: the upgrade suite's fixture store,
a profile linked from another checkout. A start that failed rolled back to e218ae7, the store and
the profile's link restored; an update interrupted mid-build was taken up again; and updates with a
changed patch, and with the fragment's runtime rows and three reviewer Workers (none signed in
there, so each reported), completed, the seven old runs explaining as before.

## Update the live install automatically

[`scripts/live-auto-update.sh`](../../scripts/live-auto-update.sh) keeps the live install on `main`:
each pass decides whether to start an update, and the update itself is [`live-update.sh`'s](#update-the-live-install-from-e218ae7-to-the-base-release),
with its backup, upgrade checks, and rollback. A systemd user timer runs a pass every 15 minutes
([units](#run-as-a-service)). One pass:

1. Does nothing while `~/.dsh/system/auto-update.paused` exists, while another pass or a live update
   runs (their locks under `~/system-backups`), or while an update that stopped the daemon is
   unfinished (it pauses itself then: take that update up by hand, with the command its notes name).
2. `git fetch origin main` in the check checkout. Nothing to do when it is the live checkout's HEAD.
3. Refuses, and pauses itself, unless `main` descends from the live commit (a fast-forward).
4. Waits `--settle` minutes (default 30) after the pass first saw the commit, so a quick revert can
   land first; and, with `--hours 02-06`, for 02:00 to 05:59 local time (`22-04` wraps midnight;
   default any time).
5. Asks GitHub (`gh api`, signed in as `gh auth status` shows) for the commit's check runs and
   statuses. Every one must have completed with success. One still running, none yet, or no usable
   `gh` is a wait; a failed one is a refusal until `main` moves on. Neither pauses.
6. Builds the target in the check checkout (`~/workspaces/system-live-check`, a worktree of the
   live repository, never `system-live`): `git checkout --detach`, `pnpm install
   --frozen-lockfile`, `pnpm build`.
7. Runs that checkout's `scripts/live-update.sh <main> --from <live HEAD> --check-with
   ~/workspaces/system-live-check`: the dry run, then `--apply`. The [build
   stamp](../../packages/cli/README.md) tells the builds apart. A dry run that refuses (the live
   patch fails the target's `system check`, say), an update that stops or rolls back, or a target
   that does not build, pauses the timer.

Each pass appends one line to `~/system-backups/auto-update/log`: `current`, `wait`, `refused`,
`busy`, `paused`, `stopped` (it paused itself), or `updated`. A pass that built and ran the update
writes its output next to it (`<time>-<sha>.out`); the update's own notes are in its
`~/system-backups/<date>-before-base*/` directory.

**What it never does.** It never changes the profile's patch (`--patch` is never passed: a target
that needs a new patch stops at the dry run, and you update to it [by
hand](#update-the-live-install-from-e218ae7-to-the-base-release)). It never updates to a commit
that is not a fast-forward of the live one, on a red or pending CI, or while paused. It never stops
the daemon but by `systemctl --user stop system.service`, whose `ExecStop` drains, and never kills
it.

**Enable it**, once the daemon runs under `system.service` ([once](#run-the-live-daemon-under-systemservice);
until then every dry run refuses, and the first pass pauses itself):

1. `git -C ~/workspaces/system-live fetch origin main && git -C ~/workspaces/system-live worktree add
   --detach ~/workspaces/system-live-check origin/main`.
2. `gh auth status` says signed in.
3. Write the two units ([Run as a service](#run-as-a-service)), then `systemctl --user daemon-reload
   && systemctl --user enable --now system-auto-update.timer` (and `loginctl enable-linger`).
4. Run a pass now and read its line: `systemctl --user start system-auto-update.service; tail -n 1
   ~/system-backups/auto-update/log`.

The daemon an update restarts is `system.service`'s, with the unit's environment file, whatever
this timer's environment is. The dry run checks that file against the target's profile (`system
check --env-file`): a name the target no longer reads stops it there, and a name a row of the target
forwards that the file does not set is a note in the pass's output.

**Pause, and resume.** Pause by hand with `echo 'paused by hand' > ~/.dsh/system/auto-update.paused`;
stop the timer altogether with `systemctl --user disable --now system-auto-update.timer`. A pass
that pauses itself writes the reason on the file's first line, with the live and target commits and
its output. Read them, act (fix the live patch and update by hand, take up the unfinished update,
recover from `LOOK FIRST` as that section says), then `rm ~/.dsh/system/auto-update.paused`: the
next pass starts again from step 1.

## Run the live daemon under system.service

Once, before `live-update.sh` or the automatic update can stop and start the daemon: both refuse a
daemon started by hand, whose environment would be whichever shell starts it again. Afterwards the
unit ([Run as a service](#run-as-a-service)) runs it, with an environment file that declares every
variable it reads. Below, `node` is Node 24 (`~/.nvm/versions/node/v24.21.0/bin/node`).

1. **Write the environment file** from the shell that starts the daemon today (its `PATH` has
   Node 24's bin first, git, Xvfb, bwrap, and for remote login the VNC server and websockify):

   ```sh
   install -d -m 700 ~/.config/system
   (umask 077; printf 'PATH=%s\nDSH_HOME=%s\n' "$PATH" "${DSH_HOME:-$HOME/.dsh}" > ~/.config/system/daemon.env)
   ```

   Then list the names, never the values, the running daemon was started with: its parent, `system
   start`, holds the environment of the shell that started it.

   ```sh
   pid=$(node -p 'require(process.env.HOME + "/.dsh/system/mcp.json").pid')
   tr '\0' '\n' < "/proc/$(ps -o ppid= -p "$pid" | tr -d ' ')/environ" | cut -d= -f1 | sort
   ```

   Add to the file, with its value, each name of that list that [the daemon's
   environment](../reference/cli.md#the-daemons-environment) lists, or that a row forwards
   (`forwardEnv`; `SYSTEM_MCP_TOKEN` for a Codex Worker on the Responses gateway). Keep a model
   route's key (its `apiKeyEnv`) in the vault (`system model key <NAME>`), not in the file. Leave out
   the shell's own (`TERM`, `TMUX`, `SSH_*`, `DISPLAY`, …).
2. **Check it** with a CLI that has `--env-file` (the check checkout's):
   `node ~/workspaces/system-live-check/packages/cli/lib/bin.js check --env-file ~/.config/system/daemon.env`,
   until it says `ok`. It prints names, never values.
3. **Install the unit:** `~/.config/systemd/user/system.service` as in [Run as a
   service](#run-as-a-service), with `<checkout>` `%h/workspaces/system-live` and `<node>`
   `%h/.nvm/versions/node/v24.21.0/bin/node`; then `systemctl --user daemon-reload`.
4. **Move the daemon:** in `~/workspaces/system-live`, `node packages/cli/lib/bin.js shutdown
   --deadline 600` (it drains, then prints `stopped`), then `systemctl --user enable --now
   system.service` and `loginctl enable-linger`.
5. **Verify:** `systemctl --user is-active system.service` says `active`; `curl -fsS
   http://127.0.0.1:47317/healthz` (the port the discovery file names) says `ok`; `node
   packages/cli/lib/bin.js health` shows the checks it showed before; and a dry run of
   `live-update.sh` says `the daemon runs under system.service`.

**Back out**, if the daemon misbehaves under the unit: `systemctl --user disable --now
system.service` (its `ExecStop` drains), then start it by hand as before, from the old shell: `cd
~/workspaces/system-live && nohup node packages/cli/lib/bin.js start >> ~/system-backups/daemon.log
2>&1 &`. The update scripts refuse that daemon until it runs under the unit again.

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

## A Worker source does not answer

`system health` shows `workers` degraded or down, naming a Worker source, for example
`7 available; source agents did not describe its Workers within 5 s (at …): routing sees none of
its Workers until it answers`.

- **What it means.** The router gives each Worker source (`turns`, `agents`, `models`) 5 s to say
  which Workers it has and what they prove now
  ([sources that do not answer](../design/routing.md#sources-that-do-not-answer)). A source that
  took longer was left out of that read: a step routed then saw none of its Workers, and its
  decision names the source (`system explain <runId>`, a candidate `source agents`). A source that
  `failed to describe its Workers` fails every route until it answers: no step is routed, and
  health is down.
- **Right after a start**, a source whose first describe has not landed yet (the `agents` source
  probes its runtimes first) reads `describing…`: health says `N available so far; source agents
  describing… (its first describe since it registered has not landed …)`, and `system roster` (and
  the Workers page and Home on `/ui`) says `N Worker(s) so far (source agents still describing its
  Workers)` and `source agents describing…`. The Workers counted are those heard so far, not
  every one: wait for the first probe, then read again, and both count every Worker.
- **Read health again.** A source that was only slow answers in the next read, and health no
  longer names it. A step refused while it did not answer is run again with `system continue
  <runId> <nodeId>` or a new run.
- **If it stays,** the daemon's log has the source's own warning. For `agents`, each runtime's
  probe runs in the background and never holds a read once a first one has finished; a Worker
  whose last probe started more than the `agent-workers` row's `probeTtlMs` (5 min) ago reads
  `unavailable` until the next one finishes, and a probe slower than half of it is logged. A
  runtime whose probe does not finish keeps its Workers unavailable: check it as in
  [Agent Workers](#agent-workers) (`claude --version`, bubblewrap, its sign-in).

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

## A step failed on a placeholder

A step whose instructions would reach its Worker with a template's placeholder unfilled fails
before anything is sent, as `config_error`, on a `gate` decision `workflow.instructions` that names
the placeholders (`system explain <runId>`; [briefs](../design/workflow-engine.md#briefs)):

- **The template holds a placeholder the engine does not fill** (`node <id>'s template holds
  {{…}}`): a configured template like that is refused at load (health `templates`, `system check`),
  so this is a run admitted by an earlier version. Fix the template (config `templates` on the
  `workflow` row, or the profile), then start the run again: `continue` fails it the same way.
- **An earlier version stored its instructions uncomposed** (`stored by an earlier engine`): a
  re-review promoted before re-reviews were composed. `system continue <runId> <nodeId>` composes
  it as its review was, and it runs.

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

## Get notified

An unanswered approval request expires denied, and a run that waits for you waits until you look.
The `notify` row tells you out of band, from what the event log recorded
([notifications](../design/notifications.md)): a request opened, a request still open an hour
before it expires, a board task's review held for you an hour before the hold expires
(`review.expiring`; unanswered, the task waits for input and nothing revives it), a run that failed
for you (`USER_ACTION`) or was escalated, a step waiting for an account's limit, a pool closed at
its limit, an agent account quarantined. Each notice says what, which request, task, run, pool, or
account, and the command to act (`system ui`, `system explain
<runId>`, `system continue <runId> <nodeId>`, `system account verify …`). It never carries a
secret, a prompt, an answer, or a request's summary. The row is off by default.

**On the desktop.** The host runs `notify-send` (libnotify; on Debian or Ubuntu, `sudo apt
install libnotify-bin`) in the session it runs in, which needs a notification daemon on the
session bus: a desktop session, or a systemd user service of that session (its
`DBUS_SESSION_BUS_ADDRESS` is passed on). Turn the row on in your profile patch and restart:

```yaml
- id: notify
  disabled: false
```

**Through a webhook** (a phone push service, a chat webhook): its URL leaves the machine with every
notice, so it is opt-in twice. Turn the webhook on in the row, and declare the egress for it in the
`egress` row (a patch that targets a row replaces its whole config, so list every class, the
defaults included); `desktop: false` on a host with no desktop session:

```yaml
- id: notify
  disabled: false
  config:
    desktop: false
    webhook: { enabled: true }
- id: egress
  config:
    workerClasses:
      website: [public, operator-shared]
      agent: [public, operator-shared]
      model: [public, operator-shared]
      model-local: [public, operator-shared]
      webhook: [operator-shared]
```

Restart, then store the URL in the vault, from a file or a pipe, never as an argument: `system
notify webhook < webhook-url.txt` (MCP `notify_webhook`). It must be https, or http to this
machine, with any token in its path or query, not as a user or password. It is read at each
delivery, so storing a new one needs no restart; it is never logged or recorded. Each notice is
`POST`ed as a [`notification@1.0`](../reference/schemas.md#notification) JSON body, after the egress
gate checks that exact body (an `egress` decision each time).

**Tune it** in the row's config ([configuration](../reference/configuration.md#notify)): `kinds`
(drop `run.escalated` if escalations are noise to you), `expiryLeadMinutes` (60), `dedupMinutes`
(at most one notice per request, run, pool, or account and kind in 10 minutes), `maxQueue` (50),
and `link` (the `/ui` page each notice links to, without its token: the default is the loopback
page; behind `ssh -L`, the address you open it at). An event older than `maxAgeMinutes` (60) when
read makes no notice, so turning the row on after a long time off does not replay old events.

**When a notice did not come.** `system health` shows `notifications` degraded, naming the sink
and why; `system events --type notify.delivery` lists every outcome. Nothing is retried, so fix
the cause and the next notice goes:

| Why | Do |
|---|---|
| `notify-send is not on PATH` (desktop `unavailable`) | install libnotify, or set `desktop: false` |
| `notify-send failed: …` | the session has no notification daemon or bus: run the host in your desktop session, or use the webhook |
| `egress refused (decision …)` | declare `webhook: [operator-shared]` in the egress row, as above; `system artifact <decision>` says why it refused (a credential-like value in the body is refused as well) |
| `no egress gate (ctx.egress) is loaded` | turn the `egress` row on |
| `no webhook URL is stored under …` | `system notify webhook < file` |
| `the webhook answered HTTP <n>`, `the webhook request failed (<code>)`, `did not answer within …` | check the URL and the service; `timeoutSeconds` bounds each delivery (10 s) |
| `notice(s) dropped: the queue was full` | many notices at once: narrow `kinds` or raise `maxQueue` |

A failure stays in health for `driftWindowHours` (24 h) on the `mcp-server` row, or until the next
delivery to that sink succeeds. To stop notifications, turn the row off again (`disabled: true`):
nothing else changes, and the stored URL stays in the vault until you replace it.

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
| a task's attempt, `board-task:<id>:attempt:<n>` (version `approval-needed`, `budget-spent` or `budget-spent:<hash of the lines asked>`, or `reconciliation-failed`) | the task waits for input, `waiting.reason: rejected`, nothing starts, and a funding ask raises nothing. Left alone, it is cancelled (`input-expired`) after `inputExpirySeconds` (7 days) |
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
   ([policy](#change-the-autonomy-policy)). To be told when a request opens and again before it
   expires, [get notified](#get-notified).

## A board task is blocked or waiting for input

A task waits in one of three states: `waiting-for-approval` (a request in the queue),
`waiting-for-input`, or `review` held for you. Find them with MCP `board_projects` (task counts per
state), `board_tasks` (`states`: `waiting-for-input`, `waiting-for-approval`, `review`), and
`board_task`: its `waiting` gives the `reason`, `since`, and `expiresAt` (and `questions`,
`pendingChecks`, or `approvalRequest`), and `lastDecision` is the `board` decision behind the move
(`system artifact <id>` shows its reasons). The CLI has no board command: ask the Lead, since the
lead's `board_*` tools are client scope. `/ui` shows the approval queue, the reviews, and the
projects with their open tasks per state (the **Board** page), not each task.

| `waiting.reason` | What it means | What you can do |
|---|---|---|
| `approval-needed` (waiting for approval) | the policy asks before an attempt: a new task, or the next attempt after a rejected review or an answered question | decide its request on `/ui` (subject `board-task:<id>:attempt:<n>`). Approve: the task is ready on the board's next sweep. Deny or expiry: `rejected` |
| `question` (waiting for input) | a step of the task's run answered with questions it cannot go on without (its run failed as `question`, outcome `blocked`; [a question from a run](../design/workflow-engine.md#a-question-from-a-run)) | answer every one, by index, with `board_update` `answers` (through the Lead): one item `{question, answer}` per question, `question` its index from 0 in `waiting.questions`, `answer` the text (1 to 2000 characters), e.g. `{"taskId": "task-…", "answers": [{"question": 0, "answer": "Use the v2 API"}]}`; the next attempt goes through the gate again, and its brief points at your answers |
| `rejected` | an approval was denied or expired, or none could be asked (a lost or spent run under a policy that does not ask, or a funding ask past `fundingMaxPercent`) | nothing revives it (see below) |
| `retries-spent` | every attempt is used (`attempts.count` equals `max`: what the proposal named, else the board's `templateAttempts` for its template, else its `maxAttempts`, 3; [attempts](../design/board.md#attempts)): a review rejected the last one, a run failed with none left (also a last attempt whose budget was spent: its run failed as `budget_spent` and asked you for no funding, since no approval could start another attempt), or an approval to go on or an answered question had none left to start | nothing revives it. The last result stays on the task, to read or to take. For a spent budget, see what was spent with MCP `resources_usage` (`taskId`) and propose the work again with larger lines or more attempts |
| `review-expired` | no accepting decision came: the reviewer's lease lapsed, or the review held for you reached its expiry | nothing revives it. The work is still on its run's branch ([worktree](#a-runs-worktree)) |
| `operator-review` (in `review`) | the result waits for your acceptance: the checks its class requires have not passed, or the policy forbids the class | Accept or Reject on `/ui` ([review](#accept-or-reject-a-review)) until `expiresAt`; then `review-expired`. Home, the Reviews list, `system status`, and the report say when each expires; with the notify row on, `review.expiring` tells you `expiryLeadMinutes` (60) before ([get notified](#get-notified)) |
| `budget-spent` (waiting for approval) | a line of the task's `budget` is reached: the ledger refused the reservation of the next step of its run (failed as `budget_spent`, no step started after the refusal, outcome `blocked`; the steps that ran before it keep their results, and the next attempt's brief points at them; [a task's budget](../design/workflow-engine.md#a-tasks-budget)): a `funding` request, which always asks. On the task's last attempt there is none: the task waits for input (`retries-spent`). The request names the lines it would add (its summary, and `waiting.funding` on `board_task`): for each spent line, what the task overdrew plus one attempt's share of the line, from the ledger's count | see what was spent with MCP `resources_usage` (`taskId`), and read the request's summary and consequences on `/ui`. Approve: the board adds exactly those lines to the task's `budget` (recorded in its `funding`, with your approval), and the next attempt goes through the gate. Deny or expiry: `rejected`, the budget unchanged. A request with no lines (the ledger could not count the task's usage) only lets it go on, and the ledger refuses the next run again while a line is reached: propose the work again with larger lines. A request whose consequences say the resource ledger did not release a step's reservation (its run, step, and `until` time; the run's failure in `system explain <runId>` names it too) was refused by a hold that still counts, not by recorded usage: check the ledger with `system health` and `resources_pools`, wait past the `until` time, then approve; approved sooner, the next attempt's first step may be refused again on the same hold. An ask past the board's `fundingMaxPercent` (default 100% of the lines the task declared, over all its raises) opens no request: the task waits for input (`rejected`, see below); raise `fundingMaxPercent` in the `board` row for later tasks, or propose the work again |
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
   is decided, and an alert at the top of the page says why; it stays until you dismiss it.
4. What happens:
   - **Accept:** your `acceptance` decision is applied, and the task is `done` with
     `result.acceptance` set. Tasks that depend on it become ready on the board's next sweep. When
     the result is a run's worktree, the system commits it on the run's branch and asks you to merge
     it, within `approvalPollSeconds` ([land an accepted result](#land-an-accepted-result)).
   - **Reject:** another attempt while `attempts.count` is under `max`, through the gate again:
     `ready` when the policy says `auto` or `notify` (nothing starts a ready task: the Lead
     starts it with `run` and `task`, which claims it, as a new run with a worktree of its own),
     `waiting-for-approval` when it asks (a new request in the queue), cancelled when it
     forbids. With no attempt left the task waits for input (`retries-spent`). Your note is the
     decision's rationale (`system artifact <decision id>`); no brief carries it to the next
     attempt yet, so tell the Lead.
   - **No verdict:** at `yours until` the task waits for input (`review-expired`) and the row
     leaves the list. The wait is the policy's for the class: a day in the bundle's studio policy.
     Before then, Home's **Waiting for you** and the line above **Reviews** say when the first
     held for you expires, `system health` names each with when it expires (`reviews`, advice that
     never degrades health), and `system report` lists those held as it is made; with the `notify`
     row on, a notice comes `expiryLeadMinutes` before one expires
     ([get notified](#get-notified)).

## Pause, resume, or close a project

A project's state is yours alone to move: no Lead or Worker pauses, resumes, or closes it
([the operator's project moves](../design/board.md#the-operators-project-moves)). Use the
**Board** page on `/ui` (`system ui` prints the link). It lists every project, the closed ones
last, with its state, its charter version, an amendment waiting in the queue, and its open tasks
per state. The operator-scope MCP tools `board_pause`, `board_resume`, and `board_close` do the
same from an operator MCP client; a client token is refused (`403` on `/mcp`, `401` on `/ui`).

Each move opens a confirmation of what it does to that project; nothing moves until **Confirm**,
and **Cancel** leaves it as it was. The page sends the project's revision as it showed it: if the
project changed meanwhile (another move, an amendment approved or dropped), the move is refused
(`409`) and nothing moves; read the page again and decide again. Each move is recorded as a
`board` decision: `system artifact <id>` (the project's `lastDecision`) shows its reasons.

- **Pause** an `active` project to hold its work: a stop rule that says pause, a budget to
  rethink, time away. Until you resume it, no task of it is claimed or started (the Lead's `run`
  with `task` is refused, nothing started) and no proposed task is put to the policy. What already
  runs goes on to its outcome: a run finishes, its result reaches review, and you still decide
  reviews held for you. Every wait keeps its expiry, and a request you answer meanwhile still
  applies, but a task it readies waits unclaimed.
- **Resume** a `paused` project: on the board's next sweep (a minute) its proposed tasks whose
  dependencies are done go through the gate (ready, or a request in the queue), and the Lead may
  start its ready tasks again.
- **Close** an `active` or `paused` project for good, `achieved` (its criteria are met) or
  `stopped` (it ends without them). It is refused while a task runs or is in review: let the run
  finish or stop it (`system stop <runId>`), and decide the reviews held for you
  ([review](#accept-or-reject-a-review)); the confirmation says so when it applies. Otherwise every
  open task is cancelled (`project-closed`), a claimed one's lease released; then the approval
  requests its waiting tasks and an amendment were on are withdrawn, and leave the queue. Merge
  the accepted work you want first ([worktree](#a-runs-worktree)): the close removes no worktree
  or result, and a closed project takes no task or amendment again. To go on with the work, found
  a new project (`board_charter`).

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

- A run for a board task waits: its step is `BLOCKED` on the request, the run's view says
  `blocked: tool-call` with the request and until when, and the task stays `running`, its
  attempt not spent (`system result <runId>` returns at once and says so; the run's page on `/ui`
  links the request; `system explain <runId>` shows the step's `recovery` decision `wait`, rule
  `workflow.deferred-call`). It counts against `maxWaitingRuns`, not `maxActiveRuns`.
- A run outside a board task fails `config_error`: `<worker> stopped at its <tool> call, which
  waits for the operator's approval (approval request apr-…); nothing of that call ran`.
  `system result <runId>`, `system explain <runId>`, and the run's page on `/ui` show it.
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
3. **What runs the call.** The workers seam has no waiting status, so the agent run is over; the
   workflow engine continues its session once you approve:
   - a run for a board task goes on by itself: within `approvalPollSeconds` (15 s) of your
     approval the waiting step runs again as a new attempt in its session, with a line saying the
     call was approved, and the call runs once (a `recovery` decision `continue`, rule
     `workflow.approved-call`, and a `workflow.run.continued` event naming the request). The task's
     attempt goes on to its result. A deny, or no verdict by the request's expiry, ends the step as
     `call_rejected` or `call_expired` (`USER_ACTION`, which notify tells as `run.user-action`): the
     run fails, its report is an attempt the board counts, and the task goes through the gate for
     its next attempt (or waits for input, `retries-spent`, with none left). Stopping the run, or
     any other end of the attempt, withdraws every request its Workers left open, so an approval
     given later runs nothing;
   - a run outside a board task continues by itself: within `approvalPollSeconds` (15 s) of your
     approval the engine reopens the failed step as a new attempt in its session, with a line
     saying the call was approved, and the call runs once. It is a `recovery` decision (rule
     `workflow.approved-call`, `system explain <runId>`) and a `workflow.run.continued` event naming
     the request; one approval continues the run once. A deny or an expiry continues nothing, and
     nor does an approval for a run you already continued, stopped, or deleted. To go on without
     the call, `system continue <runId>` reopens the step yourself (before a verdict it defers again
     on the same request, queuing nothing new).

A call the policy forbids is not deferred: the agent is told the reason and goes on, and the denial
is recorded (`agent-workers.tool.denied`, `system explain <decision id>`). With no approval queue
loaded, every call is denied, reads included.

## Change the autonomy policy

Two ways, both the operator's alone ([a policy change](../design/approvals.md#a-policy-change)):
**on `/ui`, through a `policy-change` approval**, with no restart, or **by configuration and a
restart**. No Worker can do either: the proposal routes take the operator's token or scope only,
and the DSH home is hidden from agents. Once enabled, the queue may propose a change itself from
your repeated approvals; it still applies only on your approval
([below](#the-queue-proposes-a-policy-change)).

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
   (`merge`, `external-send`, `deploy`, `delete-data`, `spend`, `charter`, `funding`,
   `remediation`, `policy-change`, `promotion`) cannot be given `auto` or `notify`: a merge always
   asks the operator (D56).

   **If a change you approved on `/ui` is in force** (`source: store`), a changed configuration
   does not replace it silently: at start the queue is refused, and its log names the stored
   set's hash and the configuration's. Either keep the configuration the change was derived from,
   or let the new configuration replace the stored set by naming that set's exact hash in
   `supersedes` (the hash the policy page shows as in force): at start the change is retired,
   recorded as a `policy-change` decision, and the configuration is in force. Copying the stored
   set itself into the patch also agrees with it.
4. **Check it before stopping anything:** `system check`. It loads every row against the code (a
   plugin the install ships that does not load is a problem, not a row with nothing to check) and
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

## The queue proposes a policy change

When you keep approving the same exact command, the queue can propose listing it, so that it runs
without asking ([the queue proposes a policy change](../design/approvals.md#the-queue-proposes-a-policy-change),
[ADR-0050](../decisions/adr/0050-the-queue-proposes-a-policy-change-from-repeated-approvals.md)).
It only proposes: nothing changes until you approve its request, like any
[policy change](#change-the-autonomy-policy). It is off by default.

1. **Turn it on** in `~/.dsh/profiles/system/cordis.patch.yml`. A patch that targets the
   `approvals` row replaces its whole config, so carry the `policies` too (copy the bundle's row):

   ```yaml
   - id: approvals
     config:
       policies: [...]               # the whole list, as in the bundle or your change
       repeatedApprovals:
         enabled: true
         approvals: 5                # 3 to 100: approvals of one exact command
         windowSeconds: 604800       # 3600 to 7776000: among the requests of the last week
   ```

   `system check` names a value out of bounds; then `system shutdown` and `system start`.
2. **What it proposes.** Only a Worker's command judged under the studio policy, by its exact argv
   (for example `pnpm lint`, never `pnpm lint --fix`), approved at least `approvals` times among
   the requests made in the window, none of them rejected or expired. Never a project's command, a
   `local-private` one, another class, or a class that always asks; never while another policy
   change waits for you.
3. **Decide it in the approval queue.** Its summary starts *The queue proposes: list the command
   …*, and **Show change** says *Proposed by the queue, not by you*, how many times you approved
   it, and the diff: the studio policy at its next version with that one line added to `commands`.
   - **Approve** to apply it: that argv, and nothing longer, then runs as `workspace-write` (under
     the bundle's policy `auto`, its `tests` and `lint` pending until the result is accepted). The
     studio policy's version rises, so open requests made under the old one are withdrawn and
     asked again, as for any change.
   - **Deny**, or let it expire: nothing changes, and the queue never proposes that command again.
     You can still propose it yourself on the policy page.
4. **Audit:** the policy page's history marks the change *(proposed by the queue)*; its `origin`
   names the `policy-change` decision (rule `approvals.repeated-approvals`) that lists the
   approvals it counted (`system explain <decision>`, MCP `artifact`).
5. **Turn it off:** remove `repeatedApprovals` (or set `enabled: false`) and restart. A proposal
   already waiting stays in the queue until you decide it or it expires.

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
admits no run that could give it a reading: a hand-named Worker's configured pool is read only from
its runs, so set it on a pool whose windows report only after a run. An account's pool made from a
template is read from its own usage report between runs too
([read each account's quota](#read-each-accounts-quota)). The runtime's window names (`five_hour`)
are mapped to your window ids by the Worker's `windows`.

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
- Codex and the Antigravity CLI read a limit's reset time from the agent's own report
  ([limit readings](../design/agent-runtimes.md#limit-readings)): Codex's usage-limit message
  names no window, so every window of the pool reads `limited` until that time; for the
  Antigravity CLI, the source reads the account's usage report after the run, and a bucket is a
  window by its `id` (map the ids your account's `agy --print=/usage --output-format json` shows
  under `command.data.groups[].buckets[]` in the Worker's `windows`; an exhausted bucket left
  unmapped closes every window). After any run that hit a limit, the account's usage report is read
  once, and a used-up window there sets the reset. When neither gave a reset time, the run still
  fails `quota_exhausted` (Codex's error says why: `its reset time is not read: …`, a Codex
  version not verified, say; the log says why a report could not be read), and every window of the
  pool reads `limited` (source `limit-notice`) for the Worker's `limitCooldownSeconds`.
- **A Worker with no pool** is not metered, but a limit it hits cools down every Worker of its
  runtime (they share one sign-in): `system health` lists them `quota-exhausted`, a run on one
  fails `quota_exhausted` before the agent starts, and event `agent-workers.cooldown`
  (`system events --type agent-workers.cooldown`) names the runtime, the run, and `until`: the
  reset time the runtime named (in the run, or in the account's usage report read after it), else
  `limitCooldownSeconds`, at most seven days. It survives a restart and ends only at `until`.

What to do:

1. **Wait.** The pool, or a runtime's cooldown, opens by itself at `until`. No command ends a
   limit early (website accounts have `system account clear-cooldown`; the ledger and agent
   runtimes have no counterpart), and a limited pool admits no run that could read it open again.
2. **Or add capacity:** configure another pool and account for a second Worker, which routing then
   picks; or point the Worker's `pool` and `account` at another pool and restart.
3. Then `system continue <runId>` for a run that failed on the limit.

Usage: MCP `resources_usage` lists the counted usage records, oldest first, a page at a time
(`limit`, `after`), filtered by `runId`, `projectId`, `taskId`, `account`, `pool`, `since`, and
`until`. Its `totals` per pool (tokens, turns, cost, records) cover every match, not just the
page. A record comes from the runtime's own result message, never the model's report, so a run
that reported no numbers has no record, and a crashed run has none until a transcript is read
(not built yet). `system usage` lists runs, not the ledger.

## Usage the ledger could not count

Seen as `system health` showing `usage  degraded  max.agents: 2 run(s) in its current window (the
last 7d) whose usage the ledger could not count (1 not-reported, 1 refused)…`, as `usage unknown
(<why>)` on a step in `system usage`, or in the report's resources and `Not counted` lines.

The ledger counted no usage record for those runs, so every cap (a board task's budget lines)
counts them as 0, and the tokens and cost the report gives are lower bounds. They are not refused:
you chose to count them as 0 and see them (D25); failing closed for metered pools waits for
transcript reconciliation ([resources](../design/resources.md#usage-the-ledger-cannot-count)). A
pool's availability is unaffected: it comes from limit readings, not records.

1. **Read them.** `system events --type usage.unknown`: each entry's `data` names the run
   (`runId`), Worker, pool, account, board task, how it ended, `kind`, and `reason`; the entry's own
   `runId` is the workflow run (`system explain <it>`).
2. **Act on the kind:**
   - `not-reported`: the runtime gave neither tokens nor turns. A runtime that reports none (the
     Codex and ACP runtimes today, [metering](../design/agent-runtimes.md#metering)) makes every run
     of its Worker one: give its tasks `runs` budget lines rather than `tokens` or `usd`.
   - `interrupted`: the host stopped while the run ran. Its usage comes from its transcript once
     transcript reconciliation exists.
   - `refused` with `failure: unknown-pool`: the Worker's `account` is not the account the
     `resources` row gives its `pool`. Correct the Worker's `pool` and `account` and restart:
     until then every run of it is uncounted. With `failure: invalid`: the runtime reported numbers
     the ledger refuses (cached input above the input); `system artifact <data.record>` shows the
     refused record with its numbers. Report it with the runtime's version.
   - `failed`: the ledger could not record it; check the `store` check of `system health` and the
     daemon's log.
   - An `unconfigured pool` line in `system health`: the entries name a pool no `resources` row
     configures (a typo in the Worker's `pool`, or a pool removed since). Correct the Worker's
     `pool` and restart. The line stays until the ledger counts a record of those runs, or their
     entries are older than every configured pool's longest window (kept until retention removes
     them while a pool has a window of no length).
3. **Until it clears,** read the provider's own usage for that account (its status line or usage
   page) before funding a task of that pool, since its budget counted those runs as nothing.

The check clears once the runs fall out of the pool's longest window, or once the ledger counts a
record of each. A pool with a window of no length (a credit balance) keeps them until the event
log's retention removes the entries. A fact that could not be recorded at all is only in the
daemon's log (`the usage of <run> on <Worker> (pool <pool>) is unknown (…), and that could not be
recorded`).

## A run's worktree

A Worker with `worktreePerRun: true` works, for each workflow run, in a git worktree of its own
instead of the configured workspace
([agent Workers](../../packages/plugins/agent-workers/README.md)). The workspace must be the top
level of a git repository with a commit, outside the worktree root, and git must be 2.17 or later;
otherwise the Worker is `unavailable` (`system health`), with the reason in the log.

- **Where:** `<worktreeRoot>/<repository name>-<12 hex digits>/<workflow run id>`, by default
  `~/.dsh/system/worktrees` (owner-only), on the branch `system/run/<workflow run id>`, cut from the
  repository's HEAD when the run's first agent run starts (or, for a board task's next attempt, from
  the work the previous attempt left: [below](#a-tasks-next-attempt-starts-from-the-previous-attempts-work)). Every later agent run of that workflow
  run, reviewers included, uses it; the repository's own working tree and branch are written only by
  a landing you approved ([land an accepted result](#land-an-accepted-result)).
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
  4. An accepted result of a board task is committed and merged on your approval
     ([land an accepted result](#land-an-accepted-result)); anything else is yours to merge. Delete
     the branches you no longer need.
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
  `worktreeRetentionHours` when disk is short, or remove the finished ones sooner
  ([below](#remove-finished-run-worktrees)).

### Remove finished run worktrees

Seen as worktrees and `system/run/*` branches piling up under `~/.dsh/system/worktrees` (one per
attempt of a task, each a full checkout). Who removes them: the retention, on its own,
`worktreeRetentionHours` after the last agent run of each workflow run ended (at start and hourly),
whatever became of the attempt: failed, rejected, accepted, or still held for your review. Until
then each stays, so a held review's pending checks can run in it. You can remove the finished ones
sooner; nothing is ever discarded.

1. **See them:** `system worktrees` lists every one not removed yet, oldest first: its run, its
   state (`in-use` while an agent run of the run is queued or running; `held` while one ended with
   its liveness unknown; `finished`), what it holds (`clean`, `uncommitted`, `gone` from disk, or
   `not-intact`), its path and branch, and when the retention removes it.
2. **Keep the work you want:** for a result you accepted, merge its branch (`git -C <repository>
   merge system/run/<runId>`), or commit in the worktree first ([recover work](#a-runs-worktree)).
   A worktree a review of its task still waits on holds the exact tree that review is bound to:
   decide the review before removing it.
3. **Remove them:** `system worktrees remove [note]` removes every `finished` one that holds
   nothing uncommitted; `--run <runId>` only that run's. Add `--commit-changes` to remove a finished
   one with uncommitted changes too: they are committed on its branch first, as the retention does.
   It is recorded first as your `retention` decision (`system explain <decision>`), and prints each
   worktree removed or kept, and why. A `held` one stays until you free its run
   ([a run's liveness is unknown](#a-runs-liveness-is-unknown)); an `in-use` one stays until its
   agent run ends; a `not-intact` one is yours to inspect ([a `.git` file changed by the
   agent](#a-runs-worktree)). At most 50 a call: run it again while it says more are left.
4. **The branches stay:** `system` never deletes a branch. Delete the ones whose work is merged,
   which git refuses for one that is not: `git -C <repository> branch -d system/run/<runId>`
   (`git -C <repository> branch --merged main --list 'system/run/*'` lists them). A run continued
   after its worktree was removed gets it again from its branch.

## Land an accepted result

When the board has a task `done` on a result in its run's worktree (you accepted it on `/ui`, or the
engine did), the system lands it in the repository the Workers work in
([landing an accepted result](../design/workflow-engine.md#landing-an-accepted-result),
[ADR-0060](../decisions/adr/0060-an-accepted-result-lands-on-the-operators-merge-approval.md)):

1. **It commits it on the run's branch**, within `approvalPollSeconds` (15 s) of the acceptance: one
   commit by `system <system@localhost>` on `system/run/<runId>`, its message naming the task, the
   run, who reviewed that tree and how, and your acceptance decision (`git -C <repository> log -1
   system/run/<runId>`). Only while the worktree is still the tree you accepted: a file changed
   after the acceptance refuses it ("changed after the acceptance, so nothing is committed"), and
   the worktree is left as it is.
2. **It asks you to merge it**: one `merge` request in the queue on Home, "Merge the accepted result
   of task "…" into main", with the branch, both SHAs, and the `git diff --stat`. The Board shows the
   task under **Waiting for you** as **Accepted — waiting to merge into main: approve**, linked to
   the request (`/ui/?request=<id>`). It waits the policy's wait for `merge` (a day in the studio
   policy); unanswered, it counts as denied.
3. **Approve: merge it.** Within `approvalPollSeconds` the branch is merged into the checked-out
   branch of the repository as one merge commit by the system (`git -C <repository> log -1`), and
   the card says **Accepted and merged into main as <commit>**. Nothing is pushed: push it yourself
   when you want it on the remote (`git -C <repository> push origin main`). **Deny** merges nothing:
   the branch keeps the commit, for you to take or delete.

When it does not merge (the card says **Accepted — not merged:** and why; `system explain <runId>`
has the `workflow.landing` decisions under the run's last step):

- **The repository moved** (a commit on its branch since the request was asked) or **has
  uncommitted changes** to tracked files: nothing is merged, and the merge is asked again on the
  branch as it is now. Commit or stash your changes, then approve the new request.
- **A conflict:** the merge is aborted and the repository is as it was. Merge by hand:
  `git -C <repository> merge system/run/<runId>`, resolve, commit. Or reject the work and run the
  task again on the new base.
- **The repository has no branch checked out** (a detached HEAD), or another branch than the one
  asked about: check out the branch to merge into, and merge by hand.
- **A run of it may still write the worktree** (it ended without being known to be gone): the commit
  waits; free the run ([a run's liveness is unknown](#a-runs-liveness-is-unknown)).
- **The policy forbids `merge`**: refused at once, nothing asked; merge by hand.
- A task reported before this landing existed lands nothing: merge its branch by hand, as before.

The repository's checkout is written only here, by a merge you approved at the exact SHAs shown.
Never a force, a reset, a branch deletion, or a push.

## A task's next attempt starts from the previous attempt's work

Seen as a board task's attempt whose developer starts with the change already in its worktree, the
daemon log line `workflow: run <id> of board task <task> starts from the work of run <earlier>
(<commit> on system/run/<earlier>)`, and `task.carry` on the run's view. It happens when the attempt
before failed only after its writing step completed, for a reason that says nothing about the change
(T110a: the review reached its turn limit; a Worker or a session failed, a limit, the budget, a
timeout), no review judged the change, and the task writes a commit the change is on
([starting from the previous attempt's work](../design/workflow-engine.md#starting-from-the-previous-attempts-work),
[ADR-0061](../decisions/adr/0061-a-tasks-next-attempt-starts-from-the-work-its-previous-attempt-left.md)).
Nothing is asked of you: the board decides and counts the attempt as always.

1. **Read why.** `system explain <runId>` lists, among the run's own decisions, the
   `workflow.task-worktree` ones: the admission decision (`carry`, or `fresh` with the bound that
   did not hold), then what the source did (`carry` naming the earlier run, the commit on its branch,
   the base, and this run's worktree; or `fresh` with why: the tree changed or was removed, an agent
   run of it was still unfinished, the repository's HEAD moved, the source could not answer).
2. **Where the work is.** The earlier tree is committed on the earlier run's branch by the system
   (`git -C <repository> log -1 system/run/<earlier>`, with `System-Carried-To: <runId>`); this run's
   worktree is cut at the same base and holds it as uncommitted, staged changes (`git -C <worktree>
   diff --cached --stat`). The developer builds on it, the review reviews the whole change, and an
   accepted result lands as one change ([land an accepted result](#land-an-accepted-result)). The
   earlier branch's carry commit is never merged: delete that branch once the task is done.
3. **To have the next attempt start from HEAD instead**, before the Lead starts it: remove the
   earlier run's worktree, its change kept on its branch (`system worktrees remove --run <earlier>
   --commit-changes`), or move the repository's HEAD. The carry is then refused (`gone`, or
   `base-moved`), recorded, and the attempt starts from HEAD as any other. Or cancel the task and
   propose the work again.
4. **When it did not carry** although you expected it to, the `fresh` decision says which bound did
   not hold: only the attempt just before is carried; a review that asked for changes, a result the
   board judged, a stop, a question, or a task that writes no subject never is.

A worktree cut for the work and not given it (a crash at that moment) is never run in: its first
agent run fails `config_error` ("…that work is not in it"); the next carry gives it the work or puts
it back to its base. One the source could not put back is yours: read it, then
`git -C <repository> worktree remove --force <path>`.

## A run's liveness is unknown

Seen as `system health` showing `liveness  degraded  1 ended without being known to be gone, their
session and worktree held: arun_… (agent:…)`, as `liveness` in MCP `status` (the operator's), as a
step failed `reconciliation_failed` whose message ends `the operator decides … system free <run>
--agent-gone`, under **Doing now** on the Workers tab and in `system roster` (`Held for …`), and
in the report's attention section (`Still held: …`).

An agent run was running when its holder stopped (a restart, a crash, a lost lease), or you stopped
it while no process held it, and `system` could not show that its agent is gone: its process was
never reported (Codex, ACP, and the Antigravity CLI report none), ran on another host, or could not
be read ([restart and liveness](../design/agent-runtimes.md#restart-and-liveness)). A failed check
is never death, so the run ended for you to judge, and what it ran in stays held: its session takes
no input, no run starts in its workflow run's worktree, and the retention sweep keeps that worktree
(INV-15). Later work starts fresh sessions. Nothing is lost; the agent may still be writing.

1. **Read it.** `system explain <arun_…>` (or `system explain <workflow run>`) prints its verdict, how
   many looks it got, each signal (the holder's process and the agent process, with their pids, and
   the latest activity), what it holds, and what to do; `system explain <decision>` gives the
   `reconciliation` decision whole.
2. **Make sure its agent is gone.** On the host the holder names: `ps -o pid,lstart,args -p <pid>`
   for each pid among the signals; for a runtime that reports no process, look for that runtime's
   process working in the run's worktree or workspace (`ps -eo pid,lstart,args`, and
   `ls -l /proc/<pid>/cwd`). A process that is still there is the agent, and no deadline of
   `system` holds it once its holder is gone: let it finish or stop it yourself, then come back. A
   host rebooted since the run started holds none of it.
3. **Free it:** `system free <arun_…> --agent-gone [why…]`. Your word that the agent is gone is
   recorded first, as your `reconciliation` decision (`operator.free`) with the signals as the host
   shows them then and what happens to each worktree; the run's session is free again, and its
   workflow run may run in its worktree again. It is refused, changing nothing, while:
   - its liveness is still being looked at, or another started run of the same session or worktree
     has not finished: wait for it (a few minutes) and try again;
   - its holder or its agent process is present on this host: it is not gone (step 2);
   - it holds nothing (it completed, was found gone, or ended with its agent stopped by its holder).
4. **Its worktree** (a Worker with `worktreePerRun`): removed at once when it holds nothing
   uncommitted and nothing else of its workflow run is unfinished or held; the branch
   `system/run/<id>` always stays. One with uncommitted changes stays, and the output says so: read
   them first (`git -C <worktree> status`, `diff HEAD`); they may be the agent's half-done work. To
   keep them on the branch and remove the worktree now, run `system free <arun_…> --agent-gone
   --commit-worktree` (it may be run again on a freed run, for its worktree only); otherwise the
   retention sweep commits them and removes it after `worktreeRetentionHours`.

A run **stalled** (`liveness  ok  1 stalled …`) is running, its agent present and quiet for
`stallSeconds`: nothing is sent to it, and its own deadline or turn limit ends it. To end it now,
`system stop <workflow run>`. A run **being looked at** (`being looked at after their holder
stopped`) needs nothing yet: it fails as gone on a `dead` verdict, or reaches you as above after
`maxUnknownVerdicts` looks. Stopping a run that no process holds gives it a verdict too: found gone,
it simply ends; otherwise it ends `aborted` and is held as above.

## Set up a run's worktree

A new worktree holds what git tracks, so no dependencies, and a Worker's commands have no network:
its tests, lint, and typecheck cannot run there until the repository's **setup** has run
([a worktree's setup](../design/agent-runtimes.md#a-worktrees-setup),
[ADR-0058](../decisions/adr/0058-a-run-worktree-is-set-up-offline-before-its-agent-starts.md),
proposed). You declare it per repository; `system` runs it in each workflow run's new worktree
before the agent starts, offline, confined, each command allowed by the autonomy policy. For the
`system` repository with pnpm (every path absolute: `~` is not expanded):

1. **The store.** `corepack pnpm store path` in the repository names it, for example
   `/home/me/.local/share/pnpm/store/v11`. It must hold every package of the lockfile: after the
   lockfile changes, run `corepack pnpm install --frozen-lockfile` once in your own checkout (online).
   It must lie outside the paths hidden from agents (`~/.dsh`, `/tmp`, the credential stores;
   [read confinement](#agent-workers)), and so must `node` and corepack's cache
   (`~/.cache/node/corepack`), which must already hold the pnpm version `packageManager` names.
2. **The setup**, in the `agent-workers` row of your profile patch, beside the Workers whose
   workspace is the repository (they set `worktreePerRun: true`):

   ```yaml
   - id: agent-workers
     config:
       worktreeSetup:
         - repository: /home/me/src/system
           commands:
             - corepack pnpm install --frozen-lockfile --offline --store-dir=/home/me/.local/share/pnpm/store/v11 --package-import-method=copy
           views:
             # The store's index is a database pnpm opens for writing: the setup gets a private
             # copy of it; the packages' files stay the host's, read-only.
             - { path: /home/me/.local/share/pnpm/store/v11, copy: [index.db, index.db-wal], readOnly: [files] }
   ```

   Why each part: `--offline`, since the setup has no network; `--store-dir`, since pnpm otherwise
   moves to an empty store inside the worktree when it cannot link from the host's; and
   `--package-import-method=copy`, since the store is read-only and on another mount, and a copy
   keeps a Worker that writes its worktree from changing the store. Each worktree then holds its
   own `node_modules` (about 700 MB for `system`), kept as long as the worktree.
3. **The policy.** Each setup command is judged as a command, by its exact argv. Under the
   bundle's studio policy it asks the operator. The standing way (the operator's D50): list the
   exact line in the studio policy's `commands`
   ([change the autonomy policy](#change-the-autonomy-policy)), one `policy-change` approval, so it
   runs unasked in every worktree. Approving it per workflow run, then `system continue <runId>`
   (below), is for a one-off.
4. `system check`, then restart. The next workflow run's first agent run sets its worktree up;
   `system explain <runId>` shows the setup's decision (rule `agent-workers.worktree-setup`), and
   `system events --type agent-workers.worktree.setup` each setup (`ran`, `refused`, `waits`).

When a run fails at start (`config_error`, nothing sent to the agent), its message names the cause:

| The message says | Do |
|---|---|
| `waits for the operator's approval of its command (approval request apr-…)` | approve it in the queue on `/ui` (its summary names the repository, the workflow run, and the command), then `system continue <runId>`; one approval covers that worktree's setup once, under that exact setup. A board task's next attempt is a new run with a worktree of its own, which asks again: for board work, list the command in the policy (step 3) |
| `approval request apr-… was rejected by the operator` (or `unanswered when it expired`, `withdrawn`) | that worktree is never set up; start a new workflow run, or list the command in the policy |
| `the autonomy policy forbids its command n` | the policy forbids commands: the setup cannot run until it allows them |
| `its command n (…) exited with code c. Its output ended: …` | read the output. `snapshot not present in local store`: the store lacks a package of the lockfile, so install once online in your checkout (step 1), then `system continue <runId>`; the next run tries the setup again |
| `did not finish within the setup's 600 s` | raise `timeoutSeconds` (at most 3600), or find what hangs |
| `its view … lies inside, or holds, …, which is hidden from agents` | move the directory out of the hidden paths, or drop the view |
| `its commands cannot be confined on this host` | as for an agent Worker: bubblewrap missing, or user namespaces refused ([read confinement](#agent-workers)) |

A setup that ran is not run again in that worktree while its definition is unchanged; change the
setup and every worktree is set up again before its next run (and asked about again).
