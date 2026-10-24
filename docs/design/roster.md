# Roster

> Target state. Boundary: [gateways](../architecture/components.md#gateways), plugin family
> *surface* ([ADR-0036](../decisions/adr/0036-guarantee-core-and-capability-plugins.md)).
> Requirement: [REQ-HOST-8](../requirements/SRS.md#host-req-host). Payload:
> [`mcp-roster@1.5`](../reference/schemas.md#mcp-tool-roster).
>
> Implemented in [`gateway-core`](../../packages/gateway-core/README.md#the-roster) (the
> projection), served by [`mcp-server`](../../packages/plugins/mcp-server/README.md) (MCP `roster`),
> the [CLI](../reference/cli.md#operations) (`system roster`), and
> [`web-ui`](../../packages/plugins/web-ui/README.md) (the Workers page); differs from target: a
> Worker source states no reason for an `unavailable` Worker beyond its account's, so such a
> reason is often `unknown`; a website account's usage has no pool yet, so its windows are not
> shown.

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
| workflow engine | `ctx.workflow.usage(500)` | the newest runs, each step's Worker and state, and the board task a run serves |
| board | `ctx.board.task(taskId)` | the title, project, and state of a task a listed step serves |

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
| `work` | the steps of running runs (`status: running`) whose node is `RUNNING` on this Worker, by run and node id; for each, the board task its run serves, with its title, project, and state; `since`, when its current attempt started (the latest `workflow.node.started` of that attempt); and `summary`, the step in one sentence: *Working on "\<title\>" (task \<id\>, project \<id\>): \<template\> run \<id\>, step \<id\>, for 4 min*, or *Running \<template\> run …* for a run that serves no task | the engine is not mounted or its read fails; a task's detail when the board is not mounted, fails, or is past the bound; `since` when the event log is not mounted, no longer holds the start (its retention), or past the bound |
| `liveness` | `@1.2`, present only when the router tells liveness and the Worker has such a run: its runs that are `stalled`, being looked at (`looking`), or ended without being known to be gone (`unknown`), of the latest 64 the router tells, each with `execution`, `state`, `since`, `runId`, and `summary` in one sentence: *Stalled: agent run … has shown no activity for 10 min or more; nothing is sent to it, and its own deadline ends it*, *Not known to be gone: agent run … lost its holder 2 min ago and is looked at again (1 of 3 verdicts)*, or *Held for 2 h: agent run … ended without being known to be gone, holding session … and worktree …; free it once its agent is gone (system free … --agent-gone)* | the router's read fails, or a source could not tell (then on every Worker without a run listed, never read as none) |
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

The CLI heads each Worker's block with it, the id beside it, and the Workers tab heads each card
with it, the id under it. It is at most 200 characters.

## Availability

One of five states, each with a one-line `summary` the CLI and the page show:

| State | When | Carries |
|---|---|---|
| `quarantined` | its account is an enrolled agent account in quarantine (`changed`, `ambiguous`, `duplicate`, `unverified`), and the Worker takes no work | the reason, since when, the `enrollment` decision that quarantined it, and what its reading found (`detail`, `@1.4`, when its record says it: for `unverified`, the version found and the ones admitted), also in the summary |
| `resting` | its source describes it `quota-exhausted` | `until`: the account's `limitUntil`, else the latest `until` of its account's closed pools when every one of them names one (the account is back only once each is), else `unknown` (no reset is known) |
| `unavailable` | `unavailable` or `reauth-required` | `reason`: from its account (signed out, enrolled and not verified, must sign in again, a site challenge, disabled, never signed in, signed in as the same person as another account), else `unknown`: its source gives no reason (`system explain` on a run it was refused for shows the route's) |
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

The schema bounds every string and list as well
([`mcp-roster@1.5`](../reference/schemas.md#mcp-tool-roster)).

## Surfaces

- **MCP `roster`** ([MCP tools](../reference/mcp-tools.md#roster)): client scope, as `status` is, so
  the lead plans with it; the operator's call also carries the account labels. Its structured
  content is the record, validated against `mcp-roster@1.5` before it is sent (a record its schema
  refuses is a defect, reported as an error); its text content is the rendering for a terminal.
- **`system roster [--json]`** ([CLI](../reference/cli.md#operations)): that rendering, or the
  record.
- **The Workers page** (`/ui/?view=workers`, the **Workers** tab, [web UI API](../reference/web-ui.md#roster)):
  the counts (working, idle, at a limit and when the first is back, unavailable), then one card per
  Worker grouped by status, headed by its display name with its id under it, under the page's
  security headers and the operator token, built with DOM methods and text only. **Doing now** lists its steps, then its runs whose liveness needs a
  look (a held one marked as failed), each with a link to its run. Each window of a pool reads `5 h: used 9 % — resets 23:30
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
