#!/usr/bin/env node
import { browserDeps, callTool, ensureBrowser, init, mcpConfig, mcpToken, start } from './index.ts'

const USAGE = `Usage: system <command>

  init                      create or refresh the system DSH profile; ensure Chrome and Xvfb
  browser install           install the managed Chrome pinned in chrome.lock.json
  ask [--persist] [--session <id>] <prompt...>
                            ask ChatGPT through a saved account (profile must be running)
  account list              list provider accounts and their status (profile must be running)
  account save <id>         after an interactive login: capture, verify, store encrypted
  start [dsh args...]       boot the profile (e.g. --patch ./overlay.yml)
  mcp-config <claude|codex> print client configuration for the running MCP server
  mcp-token                 print the bearer token (for an environment variable)
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
      const args = [...rest]
      let persist = false
      let sessionId: string | undefined
      while (args[0]?.startsWith('--')) {
        const flag = args.shift()
        if (flag === '--persist') persist = true
        else if (flag === '--session') sessionId = args.shift()
        else break
      }
      const prompt = args.join(' ').trim()
      if (!prompt) break
      let outcome = await callTool('ask', { prompt, ...(persist ? { persist } : {}), ...(sessionId ? { sessionId } : {}) })
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
