#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { type AccountTarget, accountTarget, agentAccountLine, formatMigration, parseMigrate, type SignIn, signInEnvironment, signInLine, checkProfile, type EventLine, formatEvents, formatHealth, healthExit, hostHealth, formatPlugins, hostPlugins, parseEvents, assertRuntime, backupHost, browserDeps, callTool, claudeGatewayCommand, codexGatewayCommand, drainHost, formatTools, listTools, restoreHost, shutdownHost, ensureBrowser, formatArtifact, type ArtifactRead, formatExplanation, formatUsage, init, mcpConfig, mcpHeaders, mcpToken, parseAsk, parseReport, readAllStdin, serveStdio, start, type ToolOutcome, uiUrl, composedRows, PRESETS, type Preset, rowOffProblem } from './index.ts'

const USAGE = `Usage: system <command>

  init [--preset default|api-first]
                            create or refresh the system DSH profile (a preset is kept until changed);
                            ensure Chrome and Xvfb when the browser row is mounted
  browser install           install the managed Chrome pinned in chrome.lock.json
  ask [--persist] [--session <id>] [--tier economy|standard|frontier]
      [--classification public|operator-shared|local-private] (<prompt...> | -)
                            ask the Worker the router admits (a website account, an API or
                            local model, ...); - reads the prompt from stdin (profile must be running)
  research [--deep] [--classification <c>] (<question...> | -)
                            the research procedure: hypotheses, two cited reviews on two
                            providers, evidence, critique, conclusions (--deep: Deep research)
  brainstorm [--classification <c>] (<question...> | -)
                            decide a question as a team: proposals, sealed ballots, a debate on a split, a tie to you
  review [--repo <url> [--ref <r>] [--focus <glob>]...] [--classification <c>] (<criteria...> | -)
                            review as a team: text, or a public repository at one pinned commit; quotes are checked
  run <template> [--variant <v>] [--session <id>] [--persist] [--tier <t>] [--classification <c>]
      [--task <taskId> [--holder <owner> --generation <n>]] (<input...> | -)
                            start any workflow template (ask, brainstorm, review, research, ...); --task: the run
                            serves one attempt of that board task (it claims the ready task, or takes the claim
                            board_claim gave --holder at --generation)
  approve <runId> [--plan <id>] [--reject] [note...]
                            approve (or reject) the plan a run is waiting on, bound to that exact plan
                            (name it with --plan when several wait)
  vote <runId> --decision <id> <option|inconclusive> <rationale...>
                            break a team's tie: the deciding vote, bound to that exact tie decision
  result <runId>            wait for a run and print its answer (also: watch <runId>)
  stop <runId> [reason]     stop a run: running work is cancelled, nothing is resent
  continue <runId> [nodeId] reopen a failed run's failed node as a new attempt
  delete <runId> [--yes]    preview, then delete a finished run (artifacts stay)
  supersede <runId> <nodeId> (<text...> | -)
                            replace a completed step's result; everything downstream runs again
  usage [<limit>]           recent runs: per step, the Worker, tier, and quota class used, and whether
                            the resource ledger could count its usage
  report [--project <id>] [--since <time> | --days <n>] [--until <time>] [--json]
                            the baseline report, from recorded data only: progress, results, what asked for you,
                            usage, cost per accepted result; by default the last 7 days (the weekly investor report)
  explain [--json] <runId|artifact>
                            the decision chain behind a run (egress, tier, route, acceptance), every attempt's
  artifact [--json] [--offset <n>] [--max <n>] <id>
                            an artifact's header (kind, classification, run, node, inputs) and a window of its
                            body, e.g. a rejected attempt's answer from explain (operator; may be local-private)
  evidence <id>             the page outline a ui.drift event names (structure, never text; local-private)
  model key <NAME>          store a model route's API key from stdin, encrypted, under the
                            credential reference its apiKeyEnv names
  account list              list provider accounts and their status, agent accounts beside them (profile must be running)
  account login <id>        open a remote login desktop (noVNC over ssh -L); Save stores the account
  account login <runtime> [--slot <n>]
                            enroll an agent account: take the runtime's lowest free slot (or that one), run its
                            own sign-in in the slot's home here, then verify who signed in (ADR-0051)
  account login <accountId> sign an agent account in again in its own home; it must be the same principal
  account verify <accountId | runtime --slot <n>> [--accept]
                            read who is signed in to an agent account's home again and record it; --accept
                            takes a changed slot's new principal as a new account
  account remove <accountId | runtime --slot <n>>
                            free an agent account's slot (its home is kept as it is)
  account migrate [--apply | --rollback] [--stop <runtime>]...
                            the move from hand-named agent Workers to Workers derived as account × role:
                            printed (nothing changes), applied, or undone; --stop: a runtime whose Workers stop
                            at the cutover, its account not ready (drain first)
  account credentials <id>  store login credentials from stdin as JSON {"email","password","totpSecret"?}
  account relogin <id>      sign in again with the stored credentials (TOTP computed locally)
  account code <id> <code>  supply a one-time code a running sign-in is waiting for
  account save <id>         after an interactive login: capture, verify, store encrypted
  account probe <id>        prove which website features the account offers (Deep research, Web search, ...)
  account clear-cooldown <id> [feature]
                            end a site usage limit on the account early (one feature, or all)
  account verify <id>       re-verify a reauth-required account from its stored state (no login, nothing saved)
  conversations [--state <s>]
                            the website conversations system recorded: live, due, deleted, kept (why), failed
  conversation inspect <account> <binding>
                            outline a recorded conversation's page and menu, choosing nothing (read with evidence)
  start [dsh args...]       boot the profile (e.g. --patch ./overlay.yml)
  backup <dir> [--include-key]
                            snapshot the store and encrypted vault into an empty dir (the key only with --include-key)
  restore <dir> [--yes]     preview, then restore a backup (the profile must be stopped)
  drain [--deadline <s>]    admit no new runs and wait for running ones (default 600 s)
  resume                    admit new runs again after a drain
  events [--run <id>] [--node <id>] [--session <id>] [--turn <id>] [--type <t>] [--since <time>]
         [--after <seq>] [--limit <n>] [--json]
                            the event log in order (operator); --after the printed next for more
  health [--json]           each check (plugins, manifests, runtime, store, disk, vault key, accounts,
                            Workers, UI drift, uncounted usage) and what to do; exit 0 healthy, 1 degraded,
                            2 down or not running
  plugins [--json]          every plugin of the composition: its recorded lifecycle state, on or off, version,
                            class, rows, why a manifest is absent or refused, and what the manifest check found
  shutdown [--deadline <s>] drain, then stop the running profile (unfinished runs resume on start)
  check [--env-file <file>]  check the profile against this install's code before starting it (an update's preflight);
                            --env-file: also the daemon unit's environment file (names only, never values)
  mcp-config <claude|codex> print client configuration for the running MCP server
  claude-env                print a command that runs Claude Code with website Workers as its model
                            (needs the gateway-anthropic row, off by default)
  codex-env                 print a command that runs Codex with website Workers as its model
                            (needs the gateway-responses row, off by default)
  tools [--markdown]        list the MCP tools the running profile serves (--markdown: the reference page)
  ui                        print the web UI link: the approval queue (approve or deny one request or a batch),
                            reviews of board tasks (accept or reject), runs (approve, vote, stop, continue),
                            the Board page's projects (pause, resume, close), and the Autonomy policy page
                            (propose a change, which the queue asks for)
  mcp-token --scope model   print the model gateways' token (for a model client's environment variable;
                            needs a gateway row)
  mcp-headers               print the Authorization header as JSON (Claude Code headersHelper)
  mcp-stdio                 serve the running profile's MCP tools on stdio (Codex and other clients)
`

/** Refuse a helper whose rows are all off in this composition (PROP-0004), saying how to turn one on. */
function requireRow(...rows: string[]): void {
  let composed
  try {
    composed = composedRows()
  } catch (error) {
    throw new Error(`cannot read the system profile's composition (run \`system init\` first): ${(error as Error).message}`)
  }
  const problems = rows.map((row) => rowOffProblem(row, composed))
  if (problems.every((p) => p !== undefined)) throw new Error(problems[0])
}

interface RunOutcome {
  runId: string
  status: string
  sessionId?: string
  answer?: string
  nodes?: Array<{ nodeId: string; state: string }>
  blocked?: { kind: 'gate'; nodeId: string; plan: string; approvalRequest?: string } | { kind: 'tie'; nodeId: string; decision: string; options: Array<{ option: string; summary: string }>; until: string }
  error?: { kind: string; message: string }
}

/** Poll a run until it finishes; progress goes to stderr, the answer to stdout. */
async function awaitRun(first: ToolOutcome): Promise<number> {
  let outcome = first
  let progress = ''
  for (;;) {
    if (outcome.isError) throw new Error(outcome.text)
    const run = outcome.structured as unknown as RunOutcome
    const now = (run.nodes ?? []).map((n) => `${n.nodeId} ${n.state}`).join(', ')
    if (run.status === 'running' && now !== progress) console.error(`${run.runId}: ${(progress = now)}`)
    if (run.status === 'running' && run.blocked?.kind === 'tie') {
      const tie = run.blocked
      console.error(`the team tied; until ${tie.until} it waits for a deciding vote, then ends inconclusive:`)
      for (const o of tie.options) console.error(`  ${o.option}: ${o.summary}`)
      console.error(`system vote ${run.runId} --decision ${tie.decision} <${tie.options.map((o) => o.option).join('|')}|inconclusive> <rationale>`)
      return 0
    }
    if (run.status === 'running' && run.blocked?.kind === 'gate' && run.blocked.approvalRequest) {
      console.error(`waiting on approval request ${run.blocked.approvalRequest} for plan ${run.blocked.plan}: decide it in the approval queue (system ui, or MCP approvals_decide)`)
      return 0
    }
    if (run.status === 'running' && run.blocked?.kind === 'gate') {
      console.error(`waiting for approval of plan ${run.blocked.plan}: system approve ${run.runId} --plan ${run.blocked.plan} [--reject] [note]`)
      return 0
    }
    if (run.status === 'completed') {
      console.log(run.answer)
      if (run.sessionId) console.error(`session: ${run.sessionId}`)
      return 0
    }
    if (run.status === 'failed') throw new Error(`${run.error?.kind}: ${run.error?.message} (system explain ${run.runId})`)
    outcome = await callTool('result', { runId: run.runId, waitSeconds: 55 })
  }
}

/**
 * `system account login|verify|remove` for an agent account (ADR-0051). A login takes a slot (or
 * names a taken one), runs the runtime's own sign-in in the slot's home here, in this terminal and
 * without D-Bus (the daemon runs no interactive sign-in), then verifies who signed in. A slot 1 that
 * just adopted the runtime's own home is verified as it is, without signing in again: its Workers
 * run on that sign-in now. Exits 0 when the account is ready.
 */
async function agentAccount(action: string, target: Extract<AccountTarget, { kind: 'agent' }>, accept: boolean): Promise<number> {
  const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const outcome = await callTool(tool, args)
    if (outcome.isError) throw new Error(outcome.text)
    return outcome.structured ?? {}
  }
  const ref: Record<string, unknown> = 'accountId' in target ? { accountId: target.accountId } : { provider: target.provider, ...(target.slot !== undefined ? { slot: target.slot } : {}) }
  if (action !== 'login' && !('accountId' in target) && target.slot === undefined) throw new Error(`name the slot: system account ${action} ${target.provider} --slot <n>, or the account id`)
  if (action === 'remove') {
    const removed = (await call('account_remove', ref)).removed as { provider: string; slot: number; accountId?: string; home: string }
    console.log(`freed slot ${removed.slot} of ${removed.provider}${removed.accountId ? ` (was ${removed.accountId})` : ''}; its home ${removed.home} is kept as it is`)
    return 0
  }
  let slot = ref
  if (action === 'login') {
    if (accept) throw new Error('--accept is for system account verify')
    const begun = await call('account_enroll', { step: 'begin', ...ref })
    const account = begun.account as { provider: string; slot: number; home: string }
    const login = begun.login as SignIn
    slot = { provider: account.provider, slot: account.slot }
    if (begun.adopted === true) {
      console.log(`slot 1 of ${account.provider} adopts its own home ${account.home}, where its Workers already run: verifying the sign-in it holds now (to sign in there again: system account login ${account.provider} --slot 1)`)
    } else {
      console.log(`slot ${account.slot} of ${account.provider}: sign in with its own command, in its home ${account.home}, without D-Bus; it runs now, and the account is verified when it ends:\n  ${signInLine(login)}`)
      const ran = spawnSync(login.command, login.args, { stdio: 'inherit', env: signInEnvironment(process.env, login) })
      if (ran.error) console.error(`the sign-in command could not run (${ran.error.message}); verifying what the home holds`)
    }
  }
  const verified = await call('account_enroll', { step: 'verify', ...slot, ...(accept ? { accept: true } : {}) })
  const line = agentAccountLine(verified as { account: Record<string, unknown>; workers: string[] })
  console.log(JSON.stringify(line, null, 2))
  if (line.status !== 'ready') {
    console.log(`not ready: it takes no work until resolved (docs/operations/runbooks.md#resolve-a-quarantined-agent-account)`)
    return 1
  }
  if (!(line.workers as string[]).length) console.log('no Worker runs on it yet: give it roles in the agent-workers row (assignments, by this id); while hand-named Workers are loaded, only the account in its runtime\'s own home runs them (docs/operations/runbooks.md#migrate-agent-workers-to-accounts--roles)')
  return 0
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'init': {
      const preset = rest[0] === '--preset' ? rest[1] : undefined
      if ((rest.length && !preset) || rest.length > 2 || (preset !== undefined && preset !== 'default' && !Object.hasOwn(PRESETS, preset))) break
      assertRuntime()
      console.log(`profile ready: ${init(undefined, preset as Preset | undefined)}`)
      // Chrome and Xvfb serve the browser row only; a composition without it never needs them (ADR-0025).
      if (!composedRows().some((row) => row.id === 'browser' && row.mounted)) {
        console.log('browser: not mounted in this composition; Chrome and Xvfb are not needed')
        return 0
      }
      for (const line of await ensureBrowser()) console.log(line)
      return 0
    }
    case 'browser': {
      if (rest[0] !== 'install') break
      const deps = browserDeps()
      const { path, installed } = await deps.install()
      console.log(installed ? `installed ${path}` : `already installed: ${path}`)
      return 0
    }
    case 'ask': {
      const request = await parseAsk(rest, readAllStdin)
      if (!request || request.deep || request.variant || request.task) break
      return awaitRun(await callTool('ask', { ...request }))
    }
    case 'research': {
      const request = await parseAsk(rest, readAllStdin)
      if (!request || request.persist || request.tier || request.sessionId || request.variant || request.task) break
      const { prompt, ...options } = request
      return awaitRun(await callTool('research', { question: prompt, ...options }))
    }
    case 'brainstorm':
    case 'review': {
      // A repository and its focus first; the rest is the question or the criteria.
      const args = [...rest]
      const take = (flag: string): string[] => {
        const values: string[] = []
        for (let at = args.indexOf(flag); at >= 0; at = args.indexOf(flag)) values.push(...args.splice(at, 2).slice(1))
        return values
      }
      const [url] = take('--repo')
      const [ref] = take('--ref')
      const focus = take('--focus')
      if (command === 'brainstorm' && (url || ref || focus.length)) break
      if (!url && (ref || focus.length)) break
      const request = await parseAsk(args, readAllStdin)
      if (!request || request.persist || request.tier || request.sessionId || request.variant || request.deep || request.task) break
      const { prompt, ...options } = request
      const repository = url ? { repository: { url, ...(ref ? { ref } : {}) }, ...(focus.length ? { focus } : {}) } : {}
      return awaitRun(await callTool(command, { [command === 'review' ? 'material' : 'question']: prompt, ...options, ...repository }))
    }
    case 'run': {
      const [template, ...args] = rest
      const request = template ? await parseAsk(args, readAllStdin) : undefined
      if (!template || !request || request.deep) break
      const { prompt, ...options } = request
      return awaitRun(await callTool('run', { template, input: prompt, ...options }))
    }
    case 'approve': {
      const [runId, ...rawArgs] = rest
      if (!runId) break
      let args = rawArgs
      let plan: string | undefined
      if (args[0] === '--plan') {
        plan = args[1]
        if (!plan) break
        args = args.slice(2)
      }
      const reject = args[0] === '--reject'
      const note = (reject ? args.slice(1) : args).join(' ').trim()
      const outcome = await callTool('approve', { runId, verdict: reject ? 'rejected' : 'approved', ...(note ? { note } : {}), ...(plan ? { plan } : {}) })
      if (outcome.isError) throw new Error(outcome.text)
      console.log(`${reject ? 'rejected' : 'approved'}: ${runId}`)
      return reject ? 0 : awaitRun(await callTool('result', { runId, waitSeconds: 55 }))
    }
    case 'vote': {
      const [runId, flag, decision, option, ...words] = rest
      const rationale = words.join(' ').trim()
      if (!runId || flag !== '--decision' || !decision || !option || !rationale) break
      const outcome = await callTool('vote', { runId, decision, option, rationale })
      if (outcome.isError) throw new Error(outcome.text)
      console.error(`voted ${option}: ${runId}`)
      return awaitRun(await callTool('result', { runId, waitSeconds: 55 }))
    }
    case 'stop': {
      if (!rest[0]) break
      const outcome = await callTool('stop', { runId: rest[0], ...(rest[1] ? { reason: rest.slice(1).join(' ') } : {}) })
      if (outcome.isError) throw new Error(outcome.text)
      console.log(`stopped: ${rest[0]}`)
      return 0
    }
    case 'continue': {
      if (!rest[0]) break
      return awaitRun(await callTool('continue', { runId: rest[0], ...(rest[1] ? { nodeId: rest[1] } : {}) }))
    }
    case 'delete': {
      if (!rest[0]) break
      const preview = await callTool('delete', { runId: rest[0] })
      if (preview.isError) throw new Error(preview.text)
      const run = preview.structured as { template: string; status: string; updatedAt: string; nodes: number }
      if (rest[1] !== '--yes') {
        console.log(`${rest[0]}  ${run.template}  ${run.status}  ${run.nodes} node(s), updated ${run.updatedAt}`)
        console.log(`delete it with: system delete ${rest[0]} --yes`)
        return 0
      }
      const done = await callTool('delete', { runId: rest[0], updatedAt: run.updatedAt })
      if (done.isError) throw new Error(done.text)
      console.log(`deleted: ${rest[0]} (its artifacts stay)`)
      return 0
    }
    case 'supersede': {
      const [runId, nodeId, ...words] = rest
      const text = words.length === 1 && words[0] === '-' ? (await readAllStdin()).trim() : words.join(' ').trim()
      if (!runId || !nodeId || !text) break
      return awaitRun(await callTool('supersede', { runId, nodeId, text }))
    }
    case 'watch':
    case 'result': {
      if (!rest[0]) break
      return awaitRun(await callTool('result', { runId: rest[0], waitSeconds: 55 }))
    }
    case 'usage': {
      const outcome = await callTool('usage', rest[0] ? { limit: Number(rest[0]) } : {})
      if (outcome.isError) throw new Error(outcome.text)
      for (const line of formatUsage(outcome.structured as unknown as Parameters<typeof formatUsage>[0])) console.log(line)
      return 0
    }
    case 'report': {
      const input = parseReport(rest.filter((a) => a !== '--json'))
      if (!input) break
      const outcome = await callTool('report', input)
      if (outcome.isError) throw new Error(outcome.text)
      console.log(rest.includes('--json') ? JSON.stringify(outcome.structured, null, 2) : outcome.text.trimEnd())
      return 0
    }
    case 'explain': {
      const id = rest.find((a) => a !== '--json')
      if (!id) break
      const outcome = await callTool('explain', { id })
      if (outcome.isError) throw new Error(outcome.text)
      const explained = outcome.structured as unknown as Parameters<typeof formatExplanation>[0]
      // A run prints as its decision chain; any other artifact as its input tree; --json as it is.
      console.log(!rest.includes('--json') && Array.isArray(explained.nodes) ? formatExplanation(explained).join('\n') : JSON.stringify(outcome.structured, null, 2))
      return 0
    }
    case 'model': {
      if (rest[0] !== 'key' || !rest[1]) break
      // Read from stdin, never from arguments: a key must not reach the process list or history.
      // Nor from a terminal, which would echo it: pipe it in (system model key NAME < file).
      if (process.stdin.isTTY) throw new Error('pipe the key on stdin (system model key <NAME> < file); a terminal would echo it')
      const value = (await readAllStdin()).trim()
      if (!value) throw new Error('no key on stdin')
      const outcome = await callTool('model_key', { name: rest[1], value })
      if (outcome.isError) throw new Error(outcome.text)
      console.log(outcome.text)
      return 0
    }
    case 'conversations': {
      const at = rest.indexOf('--state')
      const outcome = await callTool('conversation_list', at >= 0 ? { state: rest[at + 1] } : {})
      if (outcome.isError) throw new Error(outcome.text)
      console.log(JSON.stringify((outcome.structured as { conversations?: unknown } | undefined)?.conversations ?? [], null, 2))
      return 0
    }
    case 'conversation': {
      if (rest[0] !== 'inspect' || !rest[1] || !rest[2]) throw new Error('usage: system conversation inspect <account> <binding>')
      const outcome = await callTool('conversation_inspect', { account: rest[1], binding: rest[2] })
      if (outcome.isError) throw new Error(outcome.text)
      console.log(outcome.text)
      return 0
    }
    case 'account': {
      // An agent account (ADR-0051) is named by its id (it has a `:`) or by its runtime; anything else is a website account.
      if ((rest[0] === 'login' || rest[0] === 'verify' || rest[0] === 'remove') && rest[1]) {
        const agents = await callTool('account_agents', {}).catch(() => undefined)
        const providers = agents && !agents.isError ? ((agents.structured as { providers?: Array<{ provider: string }> } | undefined)?.providers ?? []).map((p) => p.provider) : []
        const target = accountTarget(rest.slice(1), providers)
        if (target.kind === 'agent') return agentAccount(rest[0], target, rest.includes('--accept'))
        if (rest[0] === 'remove') throw new Error(`${rest[1]} is not an agent account: a website account leaves the catalog through configuration`)
      }
      if (rest[0] === 'migrate') {
        // The move from hand-named agent Workers to account × role (PROP-0012 phase F): planned unless --apply or --rollback.
        const options = parseMigrate(rest.slice(1))
        const outcome = await callTool('account_migrate', { ...(options.apply ? { apply: true } : {}), ...(options.rollback ? { rollback: true } : {}), ...(options.stop.length ? { stop: options.stop } : {}) })
        if (outcome.isError) throw new Error(outcome.text)
        const printed = formatMigration(outcome.structured ?? {})
        console.log(printed.text)
        return printed.exit
      }
      if (rest[0] === 'verify' && rest[1]) {
        const outcome = await callTool('account_verify', { account: rest[1] })
        if (outcome.isError) throw new Error(outcome.text)
        console.log(outcome.text)
        return (outcome.structured as { verified?: boolean } | undefined)?.verified ? 0 : 1
      }
      if (rest[0] === 'probe' && rest[1]) {
        const outcome = await callTool('account_probe', { account: rest[1] })
        if (outcome.isError) throw new Error(outcome.text)
        console.log(`${rest[1]}: ${outcome.text}`)
        return 0
      }
      if (rest[0] === 'list') {
        const outcome = await callTool('account_list', {})
        if (outcome.isError) throw new Error(outcome.text)
        // With each account's usage limits in force, when the website runtime is loaded (ADR-0034).
        const limits = await callTool('account_cooldowns', {}).catch(() => undefined)
        const cooldowns = limits && !limits.isError ? ((limits.structured as { cooldowns?: Array<{ account: string; feature: string; until: string; source: string }> } | undefined)?.cooldowns ?? []) : []
        const accounts = ((outcome.structured as { accounts?: Array<{ id: string }> } | undefined)?.accounts ?? []).map((a) => {
          const own = cooldowns.filter((c) => c.account === a.id).map((c) => ({ feature: c.feature, until: c.until, source: c.source }))
          return own.length ? { ...a, cooldowns: own } : a
        })
        // Agent accounts beside them, when the agents source is loaded (ADR-0051).
        const agents = await callTool('account_agents', {}).catch(() => undefined)
        const enrolled = agents && !agents.isError ? ((agents.structured as { accounts?: Array<{ account: Record<string, unknown>; workers: string[] }> } | undefined)?.accounts ?? []) : []
        console.log(JSON.stringify([...accounts, ...enrolled.map(agentAccountLine)], null, 2))
        return 0
      }
      if (rest[0] === 'clear-cooldown' && rest[1]) {
        const outcome = await callTool('account_clear_cooldown', { account: rest[1], ...(rest[2] ? { feature: rest[2] } : {}) })
        if (outcome.isError) throw new Error(outcome.text)
        console.log(outcome.text)
        return 0
      }
      if (rest[0] === 'login' && rest[1]) {
        const id = rest[1]
        const revision = async (): Promise<number | undefined> => {
          const listed = await callTool('account_list', {})
          return ((listed.structured as { accounts?: Array<{ id: string; revision: number }> } | undefined)?.accounts ?? []).find((a) => a.id === id)?.revision
        }
        const before = await revision()
        if (before === undefined) throw new Error(`unknown account ${id}`)
        const opened = await callTool('account_login', { account: id })
        if (opened.isError) throw new Error(opened.text)
        const info = opened.structured as { url: string; sshCommand: string; expiresAt: string }
        console.log(`1. On your machine: ${info.sshCommand}`)
        console.log(`2. Open: ${info.url}`)
        console.log(`3. Sign in, then press "Save account" (open until ${info.expiresAt}).`)
        // Save stores the account with a new revision; wait for it or for the desktop to expire.
        while (Date.parse(info.expiresAt) > Date.now()) {
          await new Promise((done) => setTimeout(done, 5000))
          const now = await revision()
          if (now !== undefined && now > before) {
            console.log(`saved ${id} (revision ${now})`)
            return 0
          }
        }
        throw new Error('the remote login desktop expired before the account was saved')
      }
      if (rest[0] === 'credentials' && rest[1]) {
        // Read from stdin, never from arguments: a password must not reach the process list or history.
        const input = JSON.parse(await readAllStdin()) as { email?: string; password?: string; totpSecret?: string }
        const outcome = await callTool('account_set_credentials', { account: rest[1], email: input.email, password: input.password, ...(input.totpSecret ? { totpSecret: input.totpSecret } : {}) })
        if (outcome.isError) throw new Error(outcome.text)
        console.log(outcome.text)
        return 0
      }
      if (rest[0] === 'relogin' && rest[1]) {
        const outcome = await callTool('account_relogin', { account: rest[1] })
        if (outcome.isError) throw new Error(outcome.text)
        console.log(`signed in ${rest[1]}`)
        return 0
      }
      if (rest[0] === 'code' && rest[1] && rest[2]) {
        const outcome = await callTool('account_code', { account: rest[1], code: rest[2] })
        if (outcome.isError) throw new Error(outcome.text)
        console.log(outcome.text)
        return 0
      }
      if (rest[0] === 'save' && rest[1]) {
        const outcome = await callTool('account_save', { account: rest[1] })
        if (outcome.isError) throw new Error(outcome.text)
        console.log(`saved ${rest[1]}: ${JSON.stringify(outcome.structured)}`)
        return 0
      }
      break
    }
    case 'start':
      assertRuntime()
      return start(rest)
    case 'mcp-config': {
      const client = rest[0]
      if (client !== 'claude' && client !== 'codex') break
      console.log(mcpConfig(client))
      return 0
    }
    case 'mcp-stdio':
      await serveStdio()
      // Serve until the client closes stdin.
      await new Promise<void>((done) => process.stdin.once('close', done).once('end', done))
      return 0
    case 'mcp-headers':
      console.log(mcpHeaders())
      return 0
    case 'claude-env':
      // Claude Code with website Workers as its model (the Messages gateway).
      requireRow('gateway-anthropic')
      console.log(claudeGatewayCommand())
      return 0
    case 'drain':
    case 'shutdown': {
      const at = rest.indexOf('--deadline')
      const seconds = at >= 0 ? Number(rest[at + 1]) : 600
      if (!Number.isFinite(seconds) || seconds < 0) break
      const onActive = (active: string[]): void => console.error(`waiting for ${active.length} run(s): ${active.join(', ')}`)
      const outcome = command === 'drain' ? await drainHost(seconds * 1000, { onActive }) : await shutdownHost(seconds * 1000, { onActive })
      const undrained = 'undrained' in outcome ? outcome.undrained : undefined
      console.log(undrained
        ? `not drained: ${undrained} (the workflow engine is not running, so no run can be); stopping the host directly`
        : outcome.drained ? 'drained' : `deadline reached with ${outcome.active.length} run(s) still running: ${outcome.active.join(', ')} (they resume on the next start)`)
      if (command === 'shutdown') console.log('stopped')
      return 0
    }
    case 'check': {
      // Before an update's restart: the operator's profile against this install's code.
      const at = rest.indexOf('--env-file')
      if (at >= 0 ? rest.length !== 2 || at !== 0 : rest.length) break
      const outcome = await checkProfile(undefined, at >= 0 ? rest[1] : undefined)
      for (const note of outcome.notes) console.log(`note: ${note}`)
      if (!outcome.problems.length) {
        console.log(`ok: ${outcome.rows} row(s) of the profile pass this code's checks${at >= 0 ? ', and so does its environment file' : ''}`)
        return 0
      }
      for (const problem of outcome.problems) console.error(problem)
      console.error(`${outcome.problems.length} problem(s): fix the profile patch${at >= 0 ? ' or the environment file' : ''} before starting this code (docs/operations/runbooks.md)`)
      return 1
    }
    case 'tools': {
      const tools = await listTools()
      console.log(rest.includes('--markdown') ? formatTools(tools) : tools.map((t) => `${t.name.padEnd(18)} ${(t.description ?? '').split('. ')[0]}`).join('\n'))
      return 0
    }
    case 'backup': {
      if (!rest[0]) break
      const manifest = backupHost(rest[0], { includeKey: rest.includes('--include-key') })
      console.log(`backed up ${Object.keys(manifest.files).length} file(s) to ${rest[0]}${manifest.includesKey ? ' (with the vault key: keep it as safe as this host)' : '; the vault key is not in it: keep it safe separately'}`)
      return 0
    }
    case 'restore': {
      if (!rest[0]) break
      const key = rest.indexOf('--key')
      const keyFile = key >= 0 ? rest[key + 1] : undefined
      if (key >= 0 && !keyFile) break
      const outcome = restoreHost(rest[0], { yes: rest.includes('--yes'), ...(keyFile ? { keyFile } : {}) })
      if (!outcome.applied) {
        console.log(`backup of ${outcome.manifest.createdAt}: ${Object.keys(outcome.manifest.files).length} file(s), verified${outcome.manifest.includesKey ? ', with the vault key' : ''}`)
        console.log(`restore it with: system restore ${rest[0]} --yes`)
        return 0
      }
      console.log(`restored${outcome.keptAside ? `; the previous store is kept at ${outcome.keptAside}` : ''}`)
      return 0
    }
    case 'events': {
      const filter = parseEvents(rest.filter((a) => a !== '--json'))
      if (!filter) break
      const outcome = await callTool('events', filter)
      if (outcome.isError) throw new Error(outcome.text)
      const page = outcome.structured as { events: EventLine[]; next: number }
      console.log(rest.includes('--json') ? JSON.stringify(page, null, 2) : [...formatEvents(page.events), `next: --after ${page.next}`].join('\n'))
      return 0
    }
    case 'artifact': {
      const flag = (name: string): number | undefined => {
        const at = rest.indexOf(name)
        if (at < 0) return undefined
        const value = Number(rest[at + 1])
        if (!Number.isInteger(value)) throw new Error(`${name} takes a whole number`)
        return value
      }
      const id = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--offset' && rest[i - 1] !== '--max')
      if (!id) break
      const offset = flag('--offset')
      const max = flag('--max')
      const outcome = await callTool('artifact', { id, ...(offset !== undefined ? { offset } : {}), ...(max !== undefined ? { max } : {}) })
      if (outcome.isError) throw new Error(outcome.text)
      const read = outcome.structured as unknown as ArtifactRead
      console.log(rest.includes('--json') ? JSON.stringify(read, null, 2) : formatArtifact(read).join('\n'))
      return read.state === 'stored' ? 0 : 1
    }
    case 'evidence': {
      if (!rest[0]) break
      const outcome = await callTool('evidence', { id: rest[0] })
      if (outcome.isError) throw new Error(outcome.text)
      console.log(JSON.stringify(outcome.structured, null, 2))
      return 0
    }
    case 'health': {
      const health = await hostHealth()
      console.log(rest.includes('--json') ? JSON.stringify(health, null, 2) : formatHealth(health).join('\n'))
      return healthExit(health.state)
    }
    case 'plugins': {
      const plugins = await hostPlugins()
      console.log(rest.includes('--json') ? JSON.stringify(plugins, null, 2) : formatPlugins(plugins).join('\n'))
      return 0
    }
    case 'resume': {
      const outcome = await callTool('resume', {})
      if (outcome.isError) throw new Error(outcome.text)
      console.log('admitting new runs')
      return 0
    }
    case 'codex-env':
      // Codex with website Workers as its model (the Responses gateway).
      requireRow('gateway-responses')
      console.log(codexGatewayCommand())
      return 0
    case 'ui':
      // Opened over ssh -L like the login desktop; the link carries the token in its fragment.
      console.log(uiUrl())
      return 0
    case 'mcp-token': {
      // Only the model scope is printed, and only when named (ADR-0023): the CLI uses the
      // operator token itself, and client helpers read the client token on each connection.
      if (rest[0] !== '--scope' || rest[1] !== 'model') break
      requireRow('gateway-anthropic', 'gateway-responses')
      console.log(mcpToken('model'))
      return 0
    }
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE)
      return 0
  }
  console.error(USAGE)
  return 2
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
