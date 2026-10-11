#!/usr/bin/env node
import { init, mcpConfig, mcpToken, start } from './index.ts'

const USAGE = `Usage: system <command>

  init                      create or refresh the system DSH profile
  start [dsh args...]       boot the profile (e.g. --patch ./overlay.yml)
  mcp-config <claude|codex> print client configuration for the running MCP server
  mcp-token                 print the bearer token (for an environment variable)
`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'init':
      console.log(`profile ready: ${init()}`)
      return 0
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
