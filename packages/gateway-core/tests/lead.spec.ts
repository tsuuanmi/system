// The lead principal (ADR-0076): its token files, how the guard maps its token, and its closed rights.
import type { IncomingMessage } from 'node:http'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { guardRequest, issueLeadToken, leadId, leadMayDecide, leadTokenFile, leadTokens, listLeads, revokeLeadToken, scopeTokens, tokenFile } from '../src/index.ts'

const req = (headers: Record<string, string>): IncomingMessage => ({ headers } as unknown as IncomingMessage)
const dir = (): string => {
  const made = mkdtempSync(join(tmpdir(), 'system-lead-'))
  onTestFinished(() => rmSync(made, { recursive: true, force: true }))
  return made
}
const bearer = (token: string) => req({ host: 'localhost:1', authorization: `Bearer ${token}` })

describe('lead token files', () => {
  it('issues an owner-only token of 32 random bytes beside the operator token, per project, and never touches the operator token', () => {
    const d = dir()
    const before = scopeTokens(d)
    const operatorMode = statSync(tokenFile(d, 'operator')).mode
    const operatorBytes = readFileSync(tokenFile(d, 'operator'))
    const { file, replaced } = issueLeadToken(d, 'system')
    expect(file).toBe(leadTokenFile(d, 'system'))
    expect(file).toBe(join(d, 'lead-system.token'))
    expect(replaced).toBe(false)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(file).mode & 0o777).toBe(statSync(tokenFile(d, 'operator')).mode & 0o777)
    expect(readFileSync(file)).toHaveLength(32)
    expect(listLeads(d)).toEqual(['system'])
    // The operator's file is as it was: bytes, mode, and the set of scope tokens.
    expect(readFileSync(tokenFile(d, 'operator')).equals(operatorBytes)).toBe(true)
    expect(statSync(tokenFile(d, 'operator')).mode).toBe(operatorMode)
    expect(scopeTokens(d)).toEqual(before)
  })

  it('rotates by issuing again, and revokes by removing the file', () => {
    const d = dir()
    issueLeadToken(d, 'system')
    const first = leadTokens(d).get('system')!
    expect(issueLeadToken(d, 'system').replaced).toBe(true)
    const second = leadTokens(d).get('system')!
    expect(second).not.toBe(first)
    expect(revokeLeadToken(d, 'system')).toBe(true)
    expect(revokeLeadToken(d, 'system')).toBe(false)
    expect(leadTokens(d).size).toBe(0)
    expect(listLeads(d)).toEqual([])
  })

  it('refuses a project id that is no file name, and ignores a token file that is not owner-only', () => {
    const d = dir()
    for (const bad of ['', '../x', 'a/b', '.hidden', 'a b']) expect(() => issueLeadToken(d, bad)).toThrow(/not a project id a lead token can be issued for/)
    issueLeadToken(d, 'system')
    chmodSync(leadTokenFile(d, 'system'), 0o644)
    expect(leadTokens(d).size).toBe(0)
    writeFileSync(leadTokenFile(d, 'short'), 'x', { mode: 0o600 })
    expect(leadTokens(d).has('short')).toBe(false)
  })

  it('names the decider lead:<project>', () => {
    expect(leadId('system')).toBe('lead:system')
  })
})

describe('the guard and a lead token', () => {
  it('maps a lead token to the client scope with its project, only while its file exists (a revoked token is refused)', () => {
    const d = dir()
    const tokens = scopeTokens(d)
    issueLeadToken(d, 'system')
    const lead = leadTokens(d).get('system')!
    const options = { tokens: { operator: tokens.operator, client: tokens.client }, allowedHosts: ['localhost'], leads: () => leadTokens(d) }
    expect(guardRequest(bearer(lead), options)).toEqual({ ok: true, scope: 'client', lead: 'system' })
    // The scope tokens answer as before, with no project.
    expect(guardRequest(bearer(tokens.operator), options)).toEqual({ ok: true, scope: 'operator' })
    expect(guardRequest(bearer(tokens.client), options)).toEqual({ ok: true, scope: 'client' })
    // An endpoint that names no leads takes none.
    expect(guardRequest(bearer(lead), { tokens: options.tokens, allowedHosts: ['localhost'] })).toMatchObject({ ok: false, status: 401 })
    revokeLeadToken(d, 'system')
    expect(guardRequest(bearer(lead), options)).toMatchObject({ ok: false, status: 401, reason: 'missing or invalid token' })
  })

  it('tells two projects\' leads apart', () => {
    const d = dir()
    issueLeadToken(d, 'system')
    issueLeadToken(d, 'other')
    const tokens = leadTokens(d)
    const options = { tokens: {}, allowedHosts: ['localhost'], leads: () => leadTokens(d) }
    expect(guardRequest(bearer(tokens.get('other')!), options)).toEqual({ ok: true, scope: 'client', lead: 'other' })
    expect(guardRequest(bearer(tokens.get('system')!), options)).toEqual({ ok: true, scope: 'client', lead: 'system' })
  })
})

describe('the lead\'s closed rights', () => {
  const dev = ['dev']
  const may = (over: Partial<Parameters<typeof leadMayDecide>[0]>) => leadMayDecide({ project: 'system', of: 'system', action: 'command', devBranches: dev, ...over })

  it('allows commands and dispatch starts of its own project', () => {
    expect(may({ action: 'command' })).toEqual({ ok: true })
    expect(may({ action: 'dispatch' })).toEqual({ ok: true })
  })

  it('allows a merge or an acceptance on a listed dev branch only', () => {
    for (const action of ['merge', 'acceptance']) {
      expect(may({ action, branch: 'dev' })).toEqual({ ok: true })
      expect(may({ action, branch: 'main' })).toMatchObject({ ok: false, reason: expect.stringMatching(/main is not one/) })
      expect(may({ action, branch: undefined })).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be read/) })
      expect(may({ action, branch: 'dev', devBranches: [] })).toMatchObject({ ok: false, reason: expect.stringMatching(/none listed for the project/) })
    }
  })

  it('refuses another project\'s decision, and every action class off the list, with a reason', () => {
    expect(may({ of: 'other' })).toMatchObject({ ok: false, reason: expect.stringMatching(/decides only for project system; this belongs to project other/) })
    expect(may({ of: undefined })).toMatchObject({ ok: false, reason: expect.stringMatching(/belongs to no project/) })
    for (const action of ['policy-change', 'charter', 'funding', 'deploy', 'external-send', 'delete-data', 'spend', 'remediation', 'promotion', 'workspace-write', 'read', 'token-issue']) {
      expect(may({ action, branch: 'dev' }), action).toMatchObject({ ok: false, reason: expect.stringContaining(`lead:system may not decide ${action}`) })
    }
  })
})
