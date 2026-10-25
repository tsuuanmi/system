# Roster

> Target state. Boundary: [gateways](../architecture/components.md#gateways), plugin family
> *surface* ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)).
> Requirement: [REQ-HOST-8](../requirements/SRS.md#host-req-host). Payload:
> [`mcp-roster@1.8`](../reference/schemas.md#mcp-tool-roster).
>
> Implemented in [`gateway-core`](../../packages/gateway-core/README.md#the-roster) (the
> projection), served by [`mcp-server`](../../packages/plugins/mcp-server/README.md) (MCP `roster`),
> the [CLI](../reference/cli.md#operations) (`system roster`), and
> [`web-ui`](../../packages/plugins/web-ui/README.md) (the Workers page); differs from target: only
> the agent Workers' source states its own reason for an `unavailable` Worker
> (`capability-descriptor@1.9` `unavailableReason`), so another source's such Worker without an
> account reason reads `unknown`; a website account's usage has no pool yet, so its windows are
> not shown.

The roster is the operator's and the lead's one place to see every Worker: who it is and what the
operator set it up for, which account it runs on and in what state that account is, what role and tier it serves, whether it
can take work now and, if not, until when or why, what it is working on and since when, and how
much of its account's quota is left. It shows the Workers only: how a Worker uses its own
subagents is not its concern. It is the "HR department" of the Workers: it reads, and it decides
nothing.

## A projection, not a store

The roster is computed on every read from the seams that already hold each fact. It adds no seam,
no table, and no record of its own: two reads of the same state give the same roster, and nothing
it shows can drift from its source. It records no decision, because it decides nothing
([INV-13](../architecture/invariants.md#inv-13-every-decision-is-an-artifact) covers decisions
that change what runs).

| Source | Read through | What it gives |
|---|---|---|
| Worker registry | `ctx.workers.list()` (every source's `describe`, under the router's bound), `sources()`, `siblings(worker)`, `liveness()` (optional) | each Worker's descriptor (`capability-descriptor@1.x`): provider, family, the operator's description (`@1.7`), account, tier, quota class, state, load, cooldowns; how each source answered its last read, and whether a silent one is still describing for the first time (`@1.5` `describing`: the Workers listed are then so far, which the text and the pages say; [sources that do not answer](routing.md#sources-that-do-not-answer)); the Workers of its account; the runs whose liveness needs a look ([what the operator sees](agent-runtimes.md#what-the-operator-sees)) |
| agent accounts | `ctx.agentWorkers.agentAccounts`: `list()`, `workersIn(account)`, and, when it has them, `labelOf(account)`, `unreadReport(account)`, and `providers()` | each enrollment slot (`agent-account@1.x`): its account id, status, quarantine (and what its reading found, `@1.1`), masked hint, and the Workers that run on it ([enrollment](agent-runtimes.md#enrollment-and-quarantine)); the operator's label of its account (`assignments[].label`); why its last usage report could not be read, and when ([usage report](agent-runtimes.md#an-accounts-usage-report)); each agent runtime's title for people |
| website accounts | `ctx.accounts`: `list()`, `duplicateIdentities()` | each catalog account's secret-free view: label and status; the accounts signed in as one person |
| resource ledger | `ctx.resources`: `pools()`, `usage({ runId, pool })` | each pool of an account, its windows and their latest readings, whether it is available and until when; whether a run's usage was counted since |
| event log | `ctx.eventLog.query({ type: 'usage.unknown' })`; `ctx.eventLog.query({ type: 'workflow.node.started', runId, nodeId })` | the runs whose usage the ledger could not count ([D25](resources.md#usage-the-ledger-cannot-count)); when a running step's current attempt started |
| workflow engine | `ctx.workflow.usage(500)`; `teamExclusion()`, when it has it | the newest runs, each step's Worker and state, and the board task a run serves; the Workers the operator keeps out of teams (`teams.excludeWorkers`, [Workers left out of teams](teams.md#workers-left-out-of-teams)) |
| board | `ctx.board.task(taskId)`; `projects({ state: 'active' })` and `tasks({ projectId, states: ['ready'] })`, when it has them | the title, project, and state of a task a listed step serves; the ready tasks of the active projects, for [capacity now](#capacity-now) |
| workflow engine's start preview | `ctx.workflow.templateSteps(template)`, when it has it | a ready task's template's steps, to tell the Worker its start would most likely go to |

Each source is read once per roster. A surface passes the services it has mounted, so its plugin
manifest names each one it consumes (optional): the roster works with any subset.

## One Worker's entry

| Field | From | Unknown when |
|---|---|---|
| `worker`, `provider`, `tier`, `quotaClass`, `locality`, `state`, `observedAt` | its descriptor | never: a listed Worker has them |
| `description` | its descriptor's `description` (`@1.7`): the operator's words from the configuration row that defines it (agent-workers `workers[]` or `roles[]`, models `models[]`; a website Worker's is its accounts `accounts[]` entry's, with its tier), plain text on one line, at most 200 characters | no description is configured for it |
| `derived` | its provider, role, tier, quota class, and locality, as one line; a surface shows it, marked as derived, when `description` is unknown | never |
| `name` | `@1.3`, its display name, `<runtime> · <account> · <role or tier> [<kinds>]` ([below](#display-names)) | never |
| `family` | its descriptor | its source declares none |
| `account` | its descriptor's `account` (`@1.5`): `id`, `group`, `mode`, `limitUntil` | its source names no account |
| `account.record` | the enrolled agent account with that id, or the one that lists the Worker among its Workers (a hand-named Worker in slot 1); else the website account with that id. `kind` (`agent`, `website`), `status`, `slot`, `quarantine`, `sameAs` (website accounts signed in as the same person), `label` | no record has that id, or the list that would hold it could not be read (named) |
| `account.record.label` | a website account's catalog `label`; an agent account's masked `hint`. **Operator scope only**: a client (the lead) gets no label | the catalog gives none, or the runtime shows no hint |
| `role` | the role of the agent account it runs on: its derived id is `…:<accountId>/<role>` ([account × role](agent-runtimes.md#workers--account--role)), for a Worker that account lists. `null` for a Worker that is no role's: a website account's tier, a model, a hand-named agent Worker | the agent accounts could not be read, and its account is not a website account |
| `availability` | below | — |
| `load` | its descriptor's `load` (`@1.3`): running, queued, pending, slots; Workers of one account report the account's | its source reports none |
| `limits` | its descriptor's `cooldowns`: capabilities held off by a usage limit until a time (the rest of the Worker still takes work) | — |
| `siblings` | `ctx.workers.siblings(worker)`, itself left out | the call throws, or there are more than 64 |
| `work` | the steps of running runs (`status: running`) whose node is `RUNNING` on this Worker, by run and node id; for each, the board task its run serves, with its title, project, and state; `since`, when its current attempt started (the latest `workflow.node.started` of that attempt); and `summary`, the step in one sentence: *Working on "\<title\>" (task \<id\>, project \<id\>): \<template\> run \<id\>, step \<id\>, for 4 min*, or *Running \<template\> run …* for a run that serves no task; `startedBy` (`@1.8`, PROP-0014 D2), who started the task's run: `dispatch` (System by itself; the summary then ends *, started by itself*, and the Workers tab shows a chip), `lead`, or `operator`, absent when the engine does not tell | the engine is not mounted or its read fails; a task's detail when the board is not mounted, fails, or is past the bound; `since` when the event log is not mounted, no longer holds the start (its retention), or past the bound |
| `liveness` | `@1.2`, present only when the router tells liveness and the Worker has such a run: its runs that are `stalled`, being looked at (`looking`), or ended without being known to be gone (`unknown`), of the latest 64 the router tells, each with `execution`, `state`, `since`, `runId`, and `summary` in one sentence: *Stalled: agent run … has shown no activity for 10 min or more; nothing is sent to it, and its own deadline ends it*, *Not known to be gone: agent run … lost its holder 2 min ago and is looked at again (1 of 3 verdicts)*, or *Held for 2 h: agent run … ended without being known to be gone, holding session … and worktree …; free it once its agent is gone (system free … --agent-gone)* | the router's read fails, or a source could not tell (then on every Worker without a run listed, never read as none) |
| `teams` | `@1.6`, present only when the engine tells its `teams.excludeWorkers` and leaves this Worker out: `excluded` and a `summary` in one sentence, *Kept out of teams by the operator: its account is named in teams.excludeWorkers, so it is never a team member; it takes every other step* (named itself, by its account, or as another Worker of a named one's account) | the engine's read fails (then on every Worker, never read as none left out) |
| `pools` | the ledger's pools whose `account` is the Worker's account id, by pool id; each window with its state, `used` (the latest reading's used share), `resets` (the later of its `resetsAt` and `cooldownUntil`), `observedAt`, `source`; and `unknownUsage`, the runs in the pool's current window whose usage the ledger could not count and has not counted since, by kind | the ledger is not mounted or fails; the Worker names no account; per window, no reading yet (for the operator, with why its agent account's last usage report could not be read, and when, while no later one was: `agentAccounts.unreadReport`), or a reading without the figure; `unknownUsage` when the event log is not mounted, or the entries passed their bound |

A fact a source could not give is `{ "unknown": "<why>" }`, never a default
([INV-2](../architecture/invariants.md#inv-2-fail-closed)): an empty list means the source said so,
`unknown` means it could not be asked or did not answer. A source that throws leaves only its own
fields unknown; the others are still read.

## Display names

A Worker id is a key that records keep for good, so it stays stable and opaque
(`agent:<accountId>/<role>`); the meaning goes in a display name, `name`, which the roster makes on
each read and nothing routes on (`mcp-roster@1.3`; its runtime title, the operator's label or the
masked hint and slot, and its kinds, `@1.4`):

```text
<runtime> · <account> · <role or tier> [<kinds>]
Claude Code · science · develop [code]
Codex · c…@example.com, slot 2 · develop-2 [docs, tests]
ChatGPT · main · frontier
Gemini API · standard
Openai · fast · standard
```

- **Runtime:** the Worker's own title (`capability-descriptor@1.8` `title`): a website Worker's is
  its site's, as its driver gives it ([driver interface](provider-turns.md#driver-interface)), a
  model Worker's the operator's `models[].title`; else the agent runtime's title as its provider
  gives it (`title`, [seam contract](agent-runtimes.md#seam-contract)); else its provider's first
  word, capitalised (a model Worker's, its family's). A title comes only from a provider plugin or
  the operator's configuration: no shared code names a vendor
  ([INV-11](../architecture/invariants.md#inv-11-no-tool-lock-in)).
- **Account:** for the operator, the account's label: an agent account's
  `assignments[].label` in the agent-workers row, else its masked hint and slot (or the slot); a
  website account's catalog label, else its id. For a client (the lead), who gets no label, an
  agent account's slot, or the account id. With no account record read, its account's id; a
  Worker that names no account (a model), the rest of its own id (`model:fast`, `fast`), or nothing
  when it has its own title, which names that one Worker (`Gemini API · standard`).
- **Work:** its role (account × role), else its tier, and the kinds of work it takes
  (`capability-descriptor@1.6`).

The CLI heads each Worker's block with it, the id beside it. The Workers tab shows each account once
under all but its work (`Claude Code · science`), and heads each of its Workers' cards with the
work (`develop [code]`); a Worker of no account's card with the whole name. The id is under the
card's details. It is at most 200 characters.

## Availability

One of five states, each with a one-line `summary` the CLI and the page show:

| State | When | Carries |
|---|---|---|
| `quarantined` | its account is an enrolled agent account in quarantine (`changed`, `ambiguous`, `duplicate`, `unverified`), and the Worker takes no work | the reason, since when, the `enrollment` decision that quarantined it, and what its reading found (`detail`, `@1.4`, when its record says it: for `unverified`, the version found and the ones admitted), also in the summary |
| `resting` | its source describes it `quota-exhausted` | `until`: the account's `limitUntil`, else the latest `until` of its account's closed pools when every one of them names one (the account is back only once each is), else `unknown` (no reset is known) |
| `unavailable` | `unavailable` or `reauth-required` | `reason`: from its account (signed out, enrolled and not verified, must sign in again, a site challenge, disabled, never signed in, signed in as the same person as another account), else its source's own (`unavailableReason`, `capability-descriptor@1.9`: a failed probe's detail, a workspace problem, a gate), else `unknown`: its source gives no reason (`system explain` on a run it was refused for shows the route's) |
| `busy` | `busy`, or any run in its slots (`load.running > 0`), or a step the engine runs on it (its `work`), whatever load its source reports (`mcp-roster@1.3`) | `running` of `slots`: "busy N of M". A Worker below its slots still takes work; routing orders it after a less busy one ([ADR-0033](../decisions/adr/0033-least-busy-routing.md)). With no load, how many is unknown |
| `ready` | `ready`, nothing running, and no step running on it | — |

A hand-named agent Worker whose runtime has no verified identity reader runs while its slot is
quarantined `unverified` ([enrollment](agent-runtimes.md#enrollment-and-quarantine)): it reads as
its source describes it, and its account record shows the quarantine.

## Bounds

Every read and every list is bounded
([INV-9](../architecture/invariants.md#inv-9-everything-is-bounded); `ROSTER_BOUNDS`):

| Bound | Limit | Past it |
|---|---|---|
| Workers listed | 256, in id order | the rest are counted in `unlisted` |
| runs read | the newest 500 (the most the engine's usage view serves) | each Worker's `work` says `unread`: an older run still running is not shown |
| steps per Worker | 32, by run and node id | the rest are counted in `more` |
| board tasks read | 64, by task id | a task past them is `unknown` |
| step starts read | 64 steps, by run and node id, each from at most 100 `workflow.node.started` entries | a step past them has its `since` `unknown` |
| siblings per Worker | 64 | `unknown`, never cut silently |
| `usage.unknown` entries | 10,000, a page at a time (the count health shares, `countUnknownUsage` in [`libs`](../../packages/libs/README.md)) | each pool's `unknownUsage` is `unknown`, never a partial number |
| pools of one account, windows of one pool | 64 and 16 (the ledger's own are 64 and 8) | its `pools` are `unknown` |
| Worker sources | 64 | `sources` is `unknown` |
| each list of `now` (`CAPACITY_BOUNDS`) | 16 | the rest are counted in its `more` |
| windows of one account in `now` | 16 | its `windows` are `unknown` |
| active projects whose ready tasks `now` reads | 32, by project id | `ready.unread` says a ready task of another is not listed |

The schema bounds every string and list as well
([`mcp-roster@1.8`](../reference/schemas.md#mcp-tool-roster)).

## Capacity now

The Workers page's *Right now* (T141) is also data, `now` on every roster (`mcp-roster@1.7`,
`readCapacity` beside `readRoster` in `gateway-core`), so the lead, in any session, reads it
through MCP `roster` or `system capacity` and gives work where capacity is free. It is made once,
on the server, from the roster just projected, the descriptors it was projected from, and the
board's ready tasks; the page renders it as it is and computes none of it. Like the roster, it
decides nothing and stores nothing.

| List | What | Order |
|---|---|---|
| `accounts` | each account: its pools' windows (`used`, `resets`, `state`), whether it takes new work now (`canWork`), and why in one line | by account id |
| `free` | the Workers that take work now: `ready`, their account not at a limit, and its quota known; each with its id, name, account, role, kinds, tier, load, and `quota`, its account's binding window (the one with the least headroom) with its used share, what is left, its `headroom` above the reserve, and its reset when the reading names one (`null`: no account quota applies to it, it names no account or its account has no pool) | below |
| `quotaUnknown` | the Workers ready as their source says whose account's quota cannot be read now, with why | by id |
| `stalled` | each stalled agent run: the Worker, the run, since when; `unread` when a Worker's liveness could not be told | the longest stalled first |
| `noQuota` | each account at a limit (its `limitUntil`, a closed pool, or a window at its limit), and until when: its `limitUntil`, else its closed pools' latest `until` when each names one, else its limited windows' latest reset, else `unknown` | by account id |
| `cannotWork` | each `unavailable` or `quarantined` Worker, with its availability's summary | by id |
| `ready` | the ready tasks of the active board projects (a paused project's cannot start), each with `likely`, the Worker a start would most likely go to | by project id, each project's oldest first |

**Use it or lose it.** `free` lists the Workers in the quota score's one headroom order
([quota in every route](routing.md#quota-in-every-route), `headroomOrderOf` in `libs`, T185): the
same function routing and dispatch call, never a second computation. An account over its reserve
(used above 80 % of a window with the default 20 % reserve) comes last while another has headroom;
then the window that resets soonest with headroom first; then the most headroom; then the id. Of two
free accounts, one at 10 % used resetting in 40 min and one at 85 % used resetting in 4 h, the
first comes first. A Worker no account quota applies to comes after every one that has a quota, by
id: it loses nothing by waiting. The reserve is the ledger's `quota()` (the defaults when it gives
none).

**Unknown is never free** ([INV-2](../architecture/invariants.md#inv-2-fail-closed)). A window
with no reading, a stale reading, no used share, or a reading from before its reset is never read
as room. A Worker whose account has a window not read now, or whose pools cannot be read, is listed
in `quotaUnknown`, never in `free`, and its account's `canWork` is `unknown`. An account is `canWork: false` when it is at a limit or none of
its Workers takes work (ready, or busy with a slot its source says is free). With no Workers read,
every list is `unknown`, never empty; with no board, `ready` is.

**The likely Worker** is told as the board's start preview tells it (T124, the same test,
`canTakeStep`): the first Worker, in the order of `free` and then `quotaUnknown`, whose descriptor
offers every capability the template's first step a Worker runs needs (an offer of no scope), at
the step's tier or above, and that takes its kind of work. `null` when none that takes work now
could; `unknown` when the task names no template (the lead chooses one), its template is not
served, or the engine does not preview steps. Routing decides at the start; this is a forecast.

The text rendering (`formatCapacity`) is the roster text's last block, *Right now (as of …)*, one
line per list; `system capacity` prints that block, `system capacity --json` the record.

## Surfaces

- **MCP `roster`** ([MCP tools](../reference/mcp-tools.md#roster)): client scope, as `status` is, so
  the lead plans with it; the operator's call also carries the account labels. Its structured
  content is the record, validated against `mcp-roster@1.8` before it is sent (a record its schema
  refuses is a defect, reported as an error), with `now` ([capacity now](#capacity-now)); its text
  content is the rendering for a terminal, ending with *Right now*.
- **`system roster [--json]`** ([CLI](../reference/cli.md#operations)): that rendering, or the
  record. **`system capacity [--json]`**: its *Right now* block, or its `now`.
- **The Workers page** (`/ui/?view=workers`, the **Workers** tab, [web UI API](../reference/web-ui.md#roster)):
  the counts (working, free, resting and until when the first is, unavailable), *Right now*
  rendered from the roster's `now` ([capacity now](#capacity-now)), then the Workers by
  account: each account once under a header with its roles, what stops it, and its quota; then its
  Workers' cards, each calm (what it is for, its status and why, what it does now, and *Kept out of
  teams by you* when the operator keeps it out of teams), every unknown,
  derived, or technical fact folded under its details and a reason that blocks work never folded
  ([web UI API](../reference/web-ui.md#roster)); under the page's security headers and the operator
  token, built with DOM methods and text only. What it does now lists its steps, then its runs
  whose liveness needs a look (a held one marked as failed), each with a link to its run. Home shows
  each account's capacity in one line, its 5 h bar beside it. Each window of a pool reads `5 h: used 9 % — resets 23:30
  (read 22:05)` beside a small bar of its share: the window named by its length (its id when it
  has none, or beside one of the same length), `used`, `resets`, and `observedAt` on the clock (an
  account's own usage report keeps them fresh,
  [ADR-0059](../decisions/adr/0059-quota-readings-from-each-accounts-own-usage-report.md)); before
  any reading, `5 h: no reading yet: <why>`, the why its account's last usage report could not be
  read with its time on the clock; and what its reading does not give as `unknown (why)`. A window
  at its limit reads `at its limit` first and is listed first, in a pool at a limit listed first.

## Rejected alternatives

- **A Worker id that carries its meaning** (`worker:<provider>:<capabilities>`, say). Two accounts
  of one runtime in one role would share it, it would change with each probe's capabilities, and
  every record keeps the id it was written with; the display name carries the meaning instead.
- **A label on the capability descriptor.** The descriptor is a guarantee seam's input, and every
  client reads it; an account's label is the operator's, so the roster reads it from the agent
  accounts and shows it to the operator only.

- **A roster table kept up to date by events.** It would be a second copy of each fact, which
  drifts on a missed event or a restart, and a new guarantee to keep. Reading on demand costs a few
  bounded reads.
- **A default for a fact that cannot be read** (an empty pool list, `ready` for a Worker with no
  account). It would read as a fact; `unknown` with why tells the operator what to look at.
- **A description kept by the roster, or written by a Worker.** The roster stores nothing, and a
  Worker's own text would be model output among the operator's facts. The description is the
  operator's configuration, carried on the descriptor as an optional field for people only
  (`@1.7`); routing never reads it.
- **A field on the descriptor for an unavailable Worker's reason.** It would change the
  `capability-descriptor` contract of every Worker source, a guarantee seam's input; the roster
  uses the reasons the account records already give, and says when it has none.
