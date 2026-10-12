#!/usr/bin/env node
import { browserDeps, callTool, ensureBrowser, formatExplanation, formatUsage, init, mcpConfig, mcpHeaders, mcpToken, parseAsk, readAllStdin, serveStdio, start, type ToolOutcome } from './index.ts'

const USAGE = `Usage: system <command>

  init                      create or refresh the system DSH profile; ensure Chrome and Xvfb
  browser install           install the managed Chrome pinned in chrome.lock.json
  ask [--persist] [--session <id>] [--tier economy|standard|frontier]
      [--classification public|operator-shared|local-private] (<prompt...> | -)
                            ask a website model through a saved account; - reads the prompt
                            from stdin (profile must be running)
  research [--session <id>] [--classification <c>] (<question...> | -)
                            Deep research, then a cited compaction on a cheap tier; waits
  run <template> [--session <id>] [--persist] [--tier <t>] [--classification <c>] (<input...> | -)
                            start any workflow template (e.g. review, on a local agent Worker)
  approve <runId> [--reject] [note...]
                            approve (or reject) the plan a run is waiting on, bound to that exact plan
  result <runId>            wait for a run and print its answer (also: watch <runId>)
  stop <runId> [reason]     stop a run: running work is cancelled, nothing is resent
  continue <runId> [nodeId] reopen a failed run's failed node as a new attempt
  delete <runId> [--yes]    preview, then delete a finished run (artifacts stay)
  supersede <runId> <nodeId> (<text...> | -)
                            replace a completed step's result; everything downstream runs again
  usage [<limit>]           recent runs: per step, the Worker, tier, and quota class used
  explain <runId|artifact>  the decision chain behind a run (egress, tier, route, acceptance)
  account list              list provider accounts and their status (profile must be running)
  account login <id>        open a remote login desktop (noVNC over ssh -L); Save stores the account
  account credentials <id>  store login credentials from stdin as JSON {"email","password","totpSecret"?}
  account relogin <id>      sign in again with the stored credentials (TOTP computed locally)
  account code <id> <code>  supply a one-time code a running sign-in is waiting for
  account save <id>         after an interactive login: capture, verify, store encrypted
  start [dsh args...]       boot the profile (e.g. --patch ./overlay.yml)
  mcp-config <claude|codex> print client configuration for the running MCP server
  mcp-token                 print the bearer token (for an environment variable)
  mcp-headers               print the Authorization header as JSON (Claude Code headersHelper)
  mcp-stdio                 serve the running profile's MCP tools on stdio (Codex and other clients)
`

interface RunOutcome {
  runId: string
  status: string
  sessionId?: string
  answer?: string
  nodes?: Array<{ nodeId: string; state: string }>
  blocked?: { nodeId: string; plan: string }
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
    if (run.status === 'running' && run.blocked) {
      console.error(`waiting for approval of plan ${run.blocked.plan}: system approve ${run.runId} [--reject] [note]`)
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

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'init':
      console.log(`profile ready: ${init()}`)
      for (const line of await ensureBrowser()) console.log(line)
      return 0
    case 'browser': {
      if (rest[0] !== 'install') break
      const deps = browserDeps()
      const { path, installed } = await deps.install()
      console.log(installed ? `installed ${path}` : `already installed: ${path}`)
      return 0
    }
    case 'ask': {
      const request = await parseAsk(rest, readAllStdin)
      if (!request) break
      return awaitRun(await callTool('ask', { ...request }))
    }
    case 'research': {
      const request = await parseAsk(rest, readAllStdin)
      if (!request || request.persist || request.tier) break
      const { prompt, ...options } = request
      return awaitRun(await callTool('research', { question: prompt, ...options }))
    }
    case 'run': {
      const [template, ...args] = rest
      const request = template ? await parseAsk(args, readAllStdin) : undefined
      if (!template || !request) break
      const { prompt, ...options } = request
      return awaitRun(await callTool('run', { template, input: prompt, ...options }))
    }
    case 'approve': {
      const [runId, ...args] = rest
      if (!runId) break
      const reject = args[0] === '--reject'
      const note = (reject ? args.slice(1) : args).join(' ').trim()
      const outcome = await callTool('approve', { runId, verdict: reject ? 'rejected' : 'approved', ...(note ? { note } : {}) })
      if (outcome.isError) throw new Error(outcome.text)
      console.log(`${reject ? 'rejected' : 'approved'}: ${runId}`)
      return reject ? 0 : awaitRun(await callTool('result', { runId, waitSeconds: 55 }))
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
    case 'explain': {
      if (!rest[0]) break
      const outcome = await callTool('explain', { id: rest[0] })
      if (outcome.isError) throw new Error(outcome.text)
      const explained = outcome.structured as unknown as Parameters<typeof formatExplanation>[0]
      // A run prints as its decision chain; any other artifact as its input tree.
      console.log(Array.isArray(explained.nodes) ? formatExplanation(explained).join('\n') : JSON.stringify(outcome.structured, null, 2))
      return 0
    }
    case 'account': {
      if (rest[0] === 'list') {
        const outcome = await callTool('account_list', {})
        if (outcome.isError) throw new Error(outcome.text)
        console.log(JSON.stringify((outcome.structured as { accounts?: unknown } | undefined)?.accounts ?? [], null, 2))
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
    case 'mcp-token':
      console.log(mcpToken())
      return 0
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
