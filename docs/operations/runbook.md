---
type: operations
status: active
reviewed: 2026-11-07
covers: [bin/system, bin/service.mjs, packages/app/src/index.ts, packages/app/src/client.ts, packages/host/src/process.ts]
---

# Runbook

How to run the Host of the default home (`~/.dsh`) as a user service, and
what to do when it does not. The design is in [Host](../architecture/host.md#running-it).

**Status:** release R1. The Host runs as a process and the CLI is its thin
client: every command but `init`, `host` and `doctor` talks to the Host on
`$DSH_HOME/system/host.sock`, so a Host must run for them. The old mode, where
each command ran Work in its own process, is gone.

## Cutover to the Host (R1)

Do these in order, on the default home. For another home, set `DSH_HOME` and
run `system host` in a terminal instead of step 4.

1. **No old `system` process is running.** The old mode left one DSH process per
   command, and a Work it was running would be written twice.
   ```
   pgrep -af -- '--profile system' ; pgrep -af 'bin/system'
   ```
   Both print nothing (a `pgrep` matching only itself does not count). Let a
   `system work run` or `retry` of the old mode finish or `kill` it, and run
   `system work list` after the cutover to see what was left interrupted.
2. **Back up the store.** With nothing running, copy it with its WAL files:
   ```
   mkdir ~/system-backup-$(date +%F) && cp -a $DSH_HOME/system/state.sqlite* ~/system-backup-$(date +%F)/
   ```
   Keep the copy until a Work has run through the Host.
3. **`system init`** from a shell that has `claude`, `codex`, `git` and `node`
   on its `PATH`: it refreshes the profile and writes the unit.
4. **`systemctl --user enable --now system`** starts the Host now and at every
   login.
5. **Delete the old control files.** The Host ignores them and never deletes
   them:
   ```
   rm -f $DSH_HOME/system/control/*.lock $DSH_HOME/system/control/*.takeover \
         $DSH_HOME/system/control/*.written $DSH_HOME/system/control/*.cancel
   rmdir $DSH_HOME/system/control
   ```
6. **`system doctor`** reports every required row mounted, the storage probe
   passing and `host: answering`. Then `system work list` shows the old Works.
   A Work that was `running` when the old mode stopped stays so until
   `system work run <id>`.

## Rollback

To go back to the previous release, in this order:

1. **Stop the Host first:** `systemctl --user disable --now system`. Stopping
   it kills the attempts it started; whatever was running is left interrupted.
2. **Check that no attempt is still running:**
   ```
   systemctl --user status system      # inactive (dead)
   pgrep -af 'system host|claude|codex' # nothing from this home
   ```
   Kill a leftover attempt by hand; a second writer must not start with one
   still running.
3. **Check out the previous release** in the System checkout, then
   `corepack pnpm install --frozen-lockfile && corepack pnpm build` and
   `system init` again.

**The store format is unchanged by R1:** the DSH storage units `system_work` and
`system_artifacts` stay at version 1 and the record and envelope schemas are
the same (`git diff <release before R1> -- packages/work/src/record.ts packages/artifacts/src`
shows what a release changed), so a rollback keeps the Works. One earlier
addition matters when the previous release is older than the Host (H2): a Work
changed through a command carries an optional `receipts` field, which the
strict record schema of a release before H2 refuses at open. Count them:
```
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare(\"select count(*) as n from u_system_work_work where value like '%\\\"receipts\\\"%'\").get().n)" $DSH_HOME/system/state.sqlite
```
`0` means the older release opens the store. Otherwise restore the backup of
cutover step 2, which loses the Works changed since.

## Install and start

`system init` writes `~/.config/systemd/user/system.service`, runs
`systemctl --user daemon-reload` and `loginctl enable-linger $USER`, and prints
the two commands that turn it on. It never enables or starts the service:

```
systemctl --user enable --now system
```

`system init --no-service` (or `SYSTEM_NO_SERVICE=1`) skips all of this. Run
`system init` again after moving the checkout, changing Node or changing
`PATH`: the unit holds the Node binary and the `PATH` of the last init.

## Stop, restart, status

```
systemctl --user stop system       # SIGTERM: the Host stops and exits 0
systemctl --user restart system
systemctl --user status system
```

Clients still connected do not delay the stop: the Host lets admitted calls
finish for 2 s, then closes every connection, and the CLI says the Host is not
running.

Whatever was running when the Host stopped is lost at the next start and is
left interrupted; nothing runs again until `system work run` or `retry`. (A
Host that stopped itself for new code waits for its attempts first; see
[Upgrading](#upgrading).)

## Upgrading

Nothing to do after a merge or a `corepack pnpm build`: the Host looks at its
code every 10 s and restarts itself on new code.

1. It logs `system host: upgrading: this Host runs <old>, the code on disk is
   <new>; ...`, starts no new attempt, and lets the running ones finish
   (however long they take; it never interrupts one). Works can still be
   submitted and run: they wait.
2. With no attempt running it logs `stopped for the upgrade ... exiting 75`
   and exits 75. The unit restarts on that status (`RestartForceExitStatus=75`);
   `system host --supervise` runs it again (foreground, development: nothing
   else restarts it, and a crash or a SIGTERM ends the supervisor).
3. The new Host recovers as on any start and logs `continuing N Works held for
   the upgrade`: the Works whose runs waited at the gate go on, and nothing
   that was interrupted does.

A command run meanwhile waits up to 3 s for the swap before it says the Host
is not running. If the Host is still draining, `system host`'s log says what it
waits for; `systemctl --user restart system` (or SIGTERM) stops it at once and
interrupts the attempts, as any stop does. After a build that is still
half-written the new Host may fail to start: build again, then
`systemctl --user restart system`.

## Changing the profile's config

An entry of the profile's own patch (`$DSH_HOME/profiles/system/cordis.patch.yml`,
or a `--patch` file) changes the bundle's `config` of that row instead of
replacing it (milestone B; [patches](../../patches/README.md)): objects merge
as JSON Merge Patch (RFC 7386, `null` removes a key), and a list of objects
with a `ref` (or `id`) merges item by item on it, as Kubernetes' strategic
merge patch does. So one account is changed, added or removed alone:

```yaml
- id: agents
  config:
    accounts:
      - ref: codex/default                # change: only what is named
        capabilities: [code-write, brainstorm.idea-b, research]
      - ref: chatgpt-web/second           # add
        runtime: chatgpt-web
        capabilities: [research]
      - ref: claude-code/default          # remove
        $patch: delete
```

A list of names (such as `capabilities`) is replaced whole. `$patch: replace`
in the `config` takes it whole, as the overlay used to. `system workers` shows
the accounts that result.

## Attempts at once, and held slots

Each Account (an `agents` account such as `claude-code/default`) runs one
attempt at a time; other steps and Works that need it wait in the Host. To allow
more, set `maxConcurrentAttempts` (a whole number of at least 1, else the account
is skipped and `system workers` says why) in the profile's `agents` row, then
restart the Host:

```yaml
- id: agents
  config:
    maxConcurrentAttempts: 1      # every account; default 1
    accounts:
      - ref: claude-code/default
        maxConcurrentAttempts: 2  # this account only
```

Codex accounts share one `auth.json`; with several attempts at once only the
first refresh is copied back.

A Host that stops with attempts running leaves them lost at the next start, and
their Account slots **held** while their process may still run. An agent attempt
is gone when its pid file (`$DSH_HOME/system/attempts/<attempt>.pid`) is absent or
names no live process. The Host checks at start and again when a waiting Work
has nothing of its own running, so a held slot clears after `system work run`
once the process is gone. If it never does, a process is still alive: find it
with `pgrep -fa claude` or `pgrep -fa codex`.

## The chatgpt-web account

A Worker that runs a step in the operator's signed-in ChatGPT web session
([PROP-0005](../proposals/PROP-0005-chatgpt-website-worker.md); options in the
[agents README](../../packages/agents/README.md#the-chatgpt-web-runtime)). It is
**not enabled by default**: add it to the profile's `agents` row (for example in
`$DSH_HOME/profiles/system/cordis.patch.yml`; it is added to the bundle's
accounts, see above), then restart the Host:

```yaml
- ref: chatgpt-web/default
  runtime: chatgpt-web
  capabilities: [research, web-search]
```

It needs `Xvfb` (`apt install xvfb`) and a recent Chrome. System picks the
Chrome like System 1: `executablePath`, then `CHROME_PATH`, then a system Chrome
no older than the browser engine's Chromium (an old one, such as Chrome 95, is
passed over), then the pinned Chrome for Testing
(`packages/agents/chrome.lock.json`), which it downloads under
`$DSH_HOME/system/browsers` the first time an attempt or a login needs it
(about 150 MB; it is not done at startup, and a failed download names the
cause). It launches the browser as a genuine one: no automation flags, no
sandbox switch, a real keyring, and Chrome's `TMPDIR` shortened when yours is too
deep for its profile socket. `system workers` shows the account as `available`
once Xvfb is found and the Chrome path exists; that says nothing about the
sign-in. It is `unavailable` with a reason that names what is missing.

**The browser is never headless.** System always runs a real, headed Chrome, on
your `DISPLAY` if the Host has one and otherwise on its own invisible Xvfb that
it starts for each attempt and stops with it (also on cancel and on the time
limit). A real headed browser is closer to yours and is challenged less. There
is no `headless` option; an account that sets it is `unavailable`.

**Sign in, once.** Three ways:
- `system workers login chatgpt-web/default --cookies <file>`: a JSON export from
  a browser extension, or a Netscape `cookies.txt`, of chatgpt.com taken from
  your own signed-in browser. The CLI reads it once and sends it to the Host;
  only chatgpt.com and openai.com cookies are kept, a session cookie gets a
  30-day lifetime, and your file is left as it is: delete it yourself when done,
  because it is as good as a password.
- `system workers login chatgpt-web/default --remote`: for a server with no
  display, and for a Cloudflare challenge. See below.
- With neither, on a machine with a display: a window opens on the **Host's**
  `DISPLAY` (a user service has none unless you run
  `systemctl --user import-environment DISPLAY` and restart it). Sign in by hand;
  it waits up to ten minutes.

Each then loads the page and prints `signed in`, or `not signed in:` and why
(exit 1). It never prints a cookie value. Do not log in while an attempt of the
account runs: Chrome holds the profile.

**Sign in over SSH (`--remote`).** On the server, as the user that runs the
Host:

```
system workers login chatgpt-web/default --remote
```

It prints three steps, for example:

```
1. On your own machine, open the tunnel (keep it running):
     ssh -L 41873:127.0.0.1:41873 me@server
2. Open this address in your browser:
     http://127.0.0.1:41873/<64 hex characters>/
3. Sign in and clear any check by hand, then press Save. ...
```

1. On **your own machine**, run the `ssh -L ...` line exactly as printed. The
   `user@host` part is the Host's user and its host name; replace the host with
   the name or address you reach the server by if they differ.
2. Open the URL in your browser. It shows the ChatGPT tab; click, scroll and
   type in it as in a normal browser. Anything without the long token in the
   address gets `403`.
3. Sign in, and if a "verify you are human" check shows, clear it yourself.
   System never clicks it.
4. Press **Save**. The page says `Signed in` or `Not signed in: <why>`, and the
   command prints the same and exits 0 or 1. **Cancel**, Ctrl-C on the server,
   or 15 minutes end the session without saving.

The viewer listens on `127.0.0.1` only and no debugging port is opened; the
browser, its Xvfb and the server are stopped when the session ends. One remote
sign-in per account at a time, and not while an attempt of the account runs.

**A sign-in wall.** An attempt that fails with `the page shows a sign-in wall`
means the session ended (a sign-out, a password change, an expired cookie). Run
the login again. The attempt's `screenshot` partial output shows what the page
looked like: `system work show <id>`, then `system artifact cat <id> > shot.png`.

**A challenge that does not clear.** If "Verify you are human" appears again
however often you tick it, the Chrome is the first thing to check (`system
workers` shows its path; an old or automation-flagged build loops). System 1's
remote login uses VNC, so the clicks are real X input; the viewer here sends
them over CDP. If a challenge still loops with a current Chrome, that is the
difference left (PROP-0005); report it.

**A CAPTCHA or Cloudflare challenge.** The attempt fails with `a CAPTCHA or
Cloudflare challenge is showing`; System never types into or solves one, and
retrying at once will meet it again. Clear it by hand, in the profile the
attempts use: run `system workers login chatgpt-web/default --remote` (as above),
pass the check in the viewer, press **Save**, and retry the Work. The check
stays cleared as long as `cf_clearance` lives, which Cloudflare decides. If it
reappears, repeat the same steps. If it keeps coming back, slow down or stop
using the account for a while; an automated session is against OpenAI's Terms of
Use, a risk the operator accepted for their own account.

**The profile** is `$DSH_HOME/system/chatgpt-web/<name>` (or `profileDir`), a
Chrome user-data directory created mode 0700. It holds the live session: treat
it as a password. Keep it out of backups, sync and version control, never copy
it to another machine or hand it to another Worker, and delete the directory to
sign the account out of System. An attempt that finds the page in an unknown
state fails after the `load` timeout with that reason and a screenshot.

## The dev branch

Parallel Works each pass their own checks; their merges no longer break `dev`
together, because System merges a Work's change into an allowlisted base
(`mergeInto`) only through its merge queue: `dev` moves to exactly a commit whose required checks
passed, the change's merge with the current tip when `dev` has moved, by a
push with a lease. A conflict fails the publish step naming the files; a
check that fails on the merge names it in the reason. Do not require pull
requests in `dev`'s branch protection: the push would be refused.

## Another home

Only `~/.dsh` gets the unit. For any other `DSH_HOME`, run
`DSH_HOME=<home> system host` in a terminal; Ctrl-C stops it. A socket path is
limited to about 100 bytes, so keep that home's path short.

## Logs

```
journalctl --user -u system            # everything
journalctl --user -u system -f         # follow
```

The Host writes one line to stderr at start (`system host: started for <home>,
listening on <socket>`) and one at stop (`system host: stopped`).

## Host not running

The CLI prints one line and exits 1 when nothing answers at
`$DSH_HOME/system/host.sock`:

```
system: the System Host is not running for <home>: systemctl --user start system (or run: system host)
```

1. `systemctl --user status system`: is it `active`? If not, start it.
2. If it failed, read `journalctl --user -u system -e`. A missing `claude`,
   `codex` or `git` is a `PATH` captured at init that no longer holds: run
   `system init` again from a shell that has them.
3. `Node >=24.9.0` errors: `bin/system` runs the newest Node 24 under
   `~/.nvm/versions/node/` by itself; with none, install one (`nvm install 24`).
4. `another Host already runs for <home>`: one is running, perhaps one in a
   terminal. Stop it; there is one Host per home.

A stale `host.sock` file is not a problem: the Host removes it once it holds
the home.

## The Host is not answering

```
system: the System Host for <home> is not answering (...): see docs/operations/runbook.md, "The Host is not answering"
```

The socket accepts connections but a call got no answer in 10 seconds. A call
that changes something (`submit`, `run`, `retry`, `cancel`, `approve`) is sent
once more with the same `commandId`, so the Host does it once: look at
`system work list` before sending it again yourself.

1. `systemctl --user status system` and `journalctl --user -u system -e`: is
   the Host alive, and busy or stuck?
2. `system doctor` boots DSH beside the Host and says whether it answers.
3. If it is stuck, `systemctl --user restart system`. Whatever was running is
   left interrupted; nothing runs again until `system work run` or `retry`.

## Following a Work, and detaching

`work submit`, `work run`, `work retry`, `approve` and `deny` return once the
Host has admitted the operation, then poll `work.events` every second until the
Work is terminal, and exit 0 (succeeded), 1 (failed), 3 (held) or 5
(cancelled). `work cancel --wait` follows the same way.

Ctrl-C **detaches**: the CLI prints `detached; <work> goes on in the Host` and
exits 0; the Work is not touched. With `--cancel-on-interrupt` Ctrl-C sends
`work.cancel` instead and follows the Work to its end; a second Ctrl-C then
detaches. Closing the terminal or killing the CLI never cancels a Work: only
`system work cancel` does. Read what happened with `system work show <id>`.

While Worker attempts run, `work show` also prints `live`: for each attempt
its start, last activity, elapsed and quiet seconds, and what its Runtime last
reported (Claude Code and Codex: turns, the last tool, tokens so far). An
attempt quiet for `stallMinutes` (10 by default; the `work` row's config) is
`stalled: true`, and watchers get one `work.changed` with `stalled: true`. A
stall is a notice, not a verdict: the attempt is not stopped. `live` is never
recorded; it is gone once the attempt reports.

## Goals and their budget

A Goal bounds what an agent session may spend. Write one at a terminal:

```
system goal new --aim "..." --scope "..." --attempts 10 --tokens 2000000
```

It prints the Goal's ID after you type the code it shows. Submit Works under it
with `system work submit ... --goal <id> --input <task>` (a Goal's Work needs
an input Task); each gets the Goal's context (the
Charter by default) as Task context. `system goal show <id>` and
`system work report <work>` show the spend: attempts, tokens (fresh input, cache
writes and output), and how many attempts had unknown usage.

A Work that is admitted and not finished counts as at least one attempt, so
many Works cannot be admitted before the first runs. Once the spend reaches the budget, `work submit --goal` fails with `the budget
of Goal ... is used up`; running Works finish. To go on, write a new Goal with
`--supersedes <old id>` (the newest version only) and the raised budget; the old ID then resolves to it,
and the spend of the old versions still counts.

## Using System from an agent

`system mcp` lets an agent session such as Claude Code use System's agent
operations as MCP tools. It runs without DSH and talks to the running Host, so
start the Host first. Write a Goal (above), then add the server with its ID:

```
claude mcp add system -- system mcp --goal <goal-id>
```

A Workflow submitted through `work.submit` may use Sub-workflows without
sending them: the Host reads each from `workflows/` at the input Task's base
commit, else beside its own code.

Without `--goal` the session is a plain agent: it may use every agent
operation on every Work.

With `--goal` it is an Orchestrator for that Goal. It may:

- submit Works, which always name its Goal, and run, retry and cancel them;
- read the Works of the Goal and of the Goals it supersedes, their events,
  reports and Artifacts;
- store Tasks and files, and list the Workers.

Each Work in scope is also an MCP resource, `system://work/<id>`; reading it
gives `work.show`. To be told instead of polling, subscribe to it
(`resources/subscribe`): the server sends `notifications/resources/updated`
when the Work becomes terminal, is held, waits for approval, or one of its
attempts stalls. With `--goal`
it also sends `notifications/resources/list_changed` when a new Work of the
Goal appears. A notice only wakes the session: read the Work's events with
`work.events` from your last `seq`. A session that was away misses no event,
only the wake-up.

**Replacing the Orchestrator session.** Its state lives in System, so a new
session takes over like a new Worker: it starts from `goal.brief` (`system goal
brief <goal>`: the Goal and its budget left, its Works with their current step
and live progress, its decisions, and what waits), and records each choice it
makes with `decision.add` (`system decision add`: question, options, choice,
reason, and the Artifacts it rests on, such as a synthesis or a review). A
decision is a record, never an authority. When a check failed for a reason
outside the change, it records that and tells the operator: only a human
runs `system work retry <work> --step checks.checks`.

It cannot approve or deny, store a conversation, set credentials, write a Goal,
sign an account in, or merge into `main`. It is refused, with the reason, any
call on another Goal's Works or their Artifacts. The budget of the Goal still
stops new Works.

## Errors

An error is one line, `system: <message>`, never a stack. `SYSTEM_DEBUG=1`
prints the stack as well.
