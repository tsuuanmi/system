// `system lead-token issue|revoke|list` (ADR-0076): the operator's command for a project's lead principal.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { leadToken } from '../src/index.ts'

const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'system-cli-lead-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'system'), { mode: 0o700 })
  return dir
}

describe('system lead-token', () => {
  it('issues a token file beside the operator token with the same permissions, never printing the token, and leaves the operator token as it was', () => {
    const h = home()
    const operator = join(h, 'system', 'operator.token')
    writeFileSync(operator, Buffer.alloc(32, 9), { mode: 0o600 })
    const before = { bytes: readFileSync(operator), mode: statSync(operator).mode }
    const lines = leadToken('issue', 'system', h)
    const file = join(h, 'system', 'lead-system.token')
    expect(statSync(file).mode & 0o777).toBe(statSync(operator).mode & 0o777)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file)).toHaveLength(32)
    const printed = lines.join('\n')
    expect(printed).toContain(file)
    expect(printed).toContain('lead:system')
    expect(printed).not.toContain(readFileSync(file).toString('base64url'))
    expect(printed).not.toContain(readFileSync(file).toString('hex'))
    expect(readFileSync(operator).equals(before.bytes)).toBe(true)
    expect(statSync(operator).mode).toBe(before.mode)
    expect(readdirSync(join(h, 'system')).sort()).toEqual(['lead-system.token', 'operator.token'])
  })

  it('rotates a token issued before, lists the projects, and revokes', () => {
    const h = home()
    leadToken('issue', 'system', h)
    const first = readFileSync(join(h, 'system', 'lead-system.token'))
    expect(leadToken('issue', 'system', h).join('\n')).toMatch(/the one issued before no longer works/)
    expect(readFileSync(join(h, 'system', 'lead-system.token')).equals(first)).toBe(false)
    leadToken('issue', 'other', h)
    expect(leadToken('list', undefined, h).map((l) => l.split('  ')[0])).toEqual(['other', 'system'])
    expect(leadToken('revoke', 'system', h).join('\n')).toMatch(/revoked the lead token of project system/)
    expect(() => leadToken('revoke', 'system', h)).toThrow(/no lead token is issued for project system/)
    expect(leadToken('list', undefined, h).map((l) => l.split('  ')[0])).toEqual(['other'])
    leadToken('revoke', 'other', h)
    expect(leadToken('list', undefined, h)).toEqual(['no lead token is issued'])
  })

  it('refuses a project that is no file name, and a command it does not know', () => {
    const h = home()
    expect(() => leadToken('issue', '../escape', h)).toThrow(/not a project id a lead token can be issued for/)
    expect(() => leadToken('issue', undefined, h)).toThrow(/usage: system lead-token/)
    expect(() => leadToken('mint', 'system', h)).toThrow(/usage: system lead-token/)
    expect(() => leadToken(undefined, undefined, h)).toThrow(/usage: system lead-token/)
  })
})
