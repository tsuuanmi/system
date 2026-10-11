#!/usr/bin/env node
import { browserDeps, callTool, ensureBrowser, init, mcpConfig, mcpHeaders, mcpToken, parseAsk, readAllStdin, serveStdio, start } from './index.ts'

const USAGE = `Usage: system <command>

  init                      create or refresh the system DSH profile; ensure Chrome and Xvfb
  browser install           install the managed Chrome pinned in chrome.lock.json
  ask [--persist] [--session <id>] [--tier economy|standard|frontier] (<prompt...> | -)
                            ask a website model through a saved account; - reads the prompt
                            from stdin (profile must be running)
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
      let outcome = await callTool('ask', { ...request })
      for (;;) {
        if (outcome.isError) throw new Error(outcome.text)
        const turn = outcome.structured as { turnId: string; status: string; sessionId?: string; answer?: string; error?: { kind: string; message: string } }
        if (turn.status === 'completed') {
          console.log(turn.answer)
          if (turn.sessionId) console.error(`session: ${turn.sessionId}`)
          return 0
        }
        if (turn.status === 'failed') throw new Error(`${turn.error?.kind}: ${turn.error?.message}`)
        outcome = await callTool('result', { turnId: turn.turnId })
      }
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
