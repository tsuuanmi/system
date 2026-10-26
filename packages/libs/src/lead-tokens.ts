/**
 * The lead principal's token files (ADR-0076, PROP-0016 I2): each project's lead acts on its own
 * token, not the operator's, so what it decides is recorded as `lead:<project>`.
 *
 * A lead token is a file `lead-<project>.token` beside `operator.token`, with the same
 * permissions (owner-only, 32 random bytes). The operator issues and revokes it with the CLI
 * (`system lead-token issue|revoke`); the host reads the files on each request, so a revoked token
 * is refused at once and a restart is never needed. The operator's token file is never touched here.
 */
import { randomBytes } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ensurePrivateDir, writeFileDurable } from './files.ts'

/** A project id a lead token can be issued for: it becomes part of a file name. */
export const LEAD_PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const FILE = /^lead-([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.token$/

/** The decider id of a project's lead on every decision it makes. */
export const leadId = (project: string): string => `lead:${project}`

/** The owner-only token file of a project's lead, `<dir>/lead-<project>.token`. */
export function leadTokenFile(dir: string, project: string): string {
  if (!LEAD_PROJECT.test(project)) throw new Error(`${JSON.stringify(project)} is not a project id a lead token can be issued for (letters, digits, '.', '_', '-'; at most 100 characters)`)
  return join(dir, `lead-${project}.token`)
}

/** The projects a lead token is issued for, sorted. */
export function listLeads(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((name) => FILE.exec(name)?.[1] ?? []).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Issue a project's lead token: 32 random bytes, owner-only like the operator's. A token already
 * issued is replaced (the old one stops working at once), which is how it is rotated. Never
 * printed: the lead reads the file.
 */
export function issueLeadToken(dir: string, project: string): { file: string; replaced: boolean } {
  const file = leadTokenFile(dir, project)
  ensurePrivateDir(dir)
  const replaced = listLeads(dir).includes(project)
  writeFileDurable(file, randomBytes(32), 0o600)
  return { file, replaced }
}

/** Revoke a project's lead token: its file is removed, and every later request with it is refused. False when none was issued. */
export function revokeLeadToken(dir: string, project: string): boolean {
  const file = leadTokenFile(dir, project)
  if (!listLeads(dir).includes(project)) return false
  rmSync(file, { force: true })
  return true
}

/** One lead token file's token as base64url; undefined when it is not a regular owner-only file of 32 bytes (a token no one may use). */
function readLead(file: string): string | undefined {
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return undefined
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size !== 32) return undefined
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.nlink !== 1 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) return undefined
    return readFileSync(fd).toString('base64url')
  } finally {
    closeSync(fd)
  }
}

/** Every issued lead token by project, read now (a revoked token is gone from it). */
export function leadTokens(dir: string): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>()
  for (const project of listLeads(dir)) {
    const token = readLead(leadTokenFile(dir, project))
    if (token !== undefined) tokens.set(project, token)
  }
  return tokens
}
