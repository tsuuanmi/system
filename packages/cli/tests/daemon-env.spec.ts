// `system check --env-file`: the daemon unit's EnvironmentFile against what the daemon reads and
// what the profile's rows name (docs/reference/cli.md#the-daemons-environment).
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkEnvFile, configEnvNames, DAEMON_ENV, parseEnvFile, type ProfileRow } from '../src/index.ts'

const SECRET = 's3cr3t-value-never-printed'

function envFile(text: string, mode = 0o600): string {
  const path = join(mkdtempSync(join(tmpdir(), 'daemon-env-')), 'daemon.env')
  writeFileSync(path, text)
  chmodSync(path, mode)
  return path
}

const rows: ProfileRow[] = [
  { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { google: { apiKeyEnv: 'GEMINI_API_KEY' } } } },
  { id: 'runtime-codex-sdk', name: '@tsuuanmi/system-runtime-codex-sdk', config: { forwardEnv: ['SYSTEM_MCP_TOKEN'] } },
  { id: 'runtime-acp', name: '@tsuuanmi/system-runtime-acp', disabled: true, config: { forwardEnv: ['OFF_ROW_TOKEN'] } },
]
const base = 'PATH=/home/op/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin\nDSH_HOME=/home/op/.dsh\n'

describe('the daemon environment file', () => {
  it('reads systemd\'s syntax strictly: NAME=VALUE, comments, blank lines, matching quotes', () => {
    expect(parseEnvFile('# comment\n; also\n\n  TZ="Asia/Ho_Chi_Minh"\nLANG=C.UTF-8\r\n')).toEqual({
      entries: [{ name: 'TZ', line: 4, value: 'Asia/Ho_Chi_Minh' }, { name: 'LANG', line: 5, value: 'C.UTF-8' }], problems: [],
    })
    expect(parseEnvFile(`export TZ=UTC\nKEY=a\\\nb\n`).problems).toEqual(['line 1 is not NAME=VALUE', 'KEY (line 2) continues on the next line: write each value on one line', 'line 3 is not NAME=VALUE'])
  })

  it('names the credential references and forwarded names of the rows that are on', () => {
    const { credentials, forwarded } = configEnvNames(rows)
    expect([...credentials]).toEqual([['GEMINI_API_KEY', ['llm-pi-ai']]])
    expect([...forwarded]).toEqual([['SYSTEM_MCP_TOKEN', ['runtime-codex-sdk']]])
  })

  it('passes a file with the required names, owner-only; a forwarded name it lacks is a note', () => {
    expect(checkEnvFile(envFile(`${base}SYSTEM_MCP_TOKEN=${SECRET}\nTZ=UTC\n`), rows)).toEqual({ problems: [], notes: [] })
    expect(checkEnvFile(envFile(base), rows)).toEqual({ problems: [], notes: ['runtime-codex-sdk forwards SYSTEM_MCP_TOKEN, which the file does not set: its Workers start without it'] })
  })

  it('refuses a file others can read, a missing required name, an unknown or refused name, a relative path, and a name set twice', () => {
    const path = envFile(`PATH=~/bin:/usr/bin\nOFF_ROW_TOKEN=${SECRET}\nDISPLAY=:0\nHOME=/home/op\nLANG=C\nLANG=C.UTF-8\nAWS_SECRET=${SECRET}\n`, 0o644)
    const { problems } = checkEnvFile(path, rows)
    expect(problems).toEqual([
      `${path} is readable by others (mode 644): chmod 600 ${path}`,
      'PATH is not a list of absolute directories: systemd expands no variable or ~ in an environment file',
      'OFF_ROW_TOKEN is not read by the daemon, nor named by a row (apiKeyEnv, forwardEnv): remove it',
      `DISPLAY must not be set here: ${DAEMON_ENV.refused.DISPLAY}`,
      `HOME must not be set here: ${DAEMON_ENV.refused.HOME}`,
      'LANG is set twice (again on line 6)',
      'AWS_SECRET is not read by the daemon, nor named by a row (apiKeyEnv, forwardEnv): remove it',
      `DSH_HOME is required: ${DAEMON_ENV.required.DSH_HOME}`,
    ])
    expect(problems.join('\n')).not.toContain(SECRET)
    expect(checkEnvFile(envFile(base), rows, 12345).problems).toEqual([expect.stringMatching(/is owned by uid \d+, not by you \(uid 12345\)$/)])
    expect(checkEnvFile(join(tmpdir(), 'no-such-dir', 'daemon.env'), rows).problems).toEqual([expect.stringMatching(/cannot be read: ENOENT$/)])
  })

  it('allows a credential reference, with a note that it shadows the vault, and never prints its value', () => {
    const { problems, notes } = checkEnvFile(envFile(`${base}GEMINI_API_KEY=${SECRET}\nSYSTEM_MCP_TOKEN=${SECRET}\n`), rows)
    expect(problems).toEqual([])
    expect(notes).toEqual(['GEMINI_API_KEY is the credential reference of llm-pi-ai: set here, it shadows the vault, and `system model key GEMINI_API_KEY` refuses it'])
    expect(notes.join('\n')).not.toContain(SECRET)
  })
})
