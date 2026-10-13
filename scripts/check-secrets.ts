/**
 * Secrets audit of the repository: every tracked text file is scanned with the credential scan
 * `egress` applies to outgoing payloads (secretlint's recommended rules plus the shapes they
 * miss). A finding names the file, line, and rule, never the secret. Tests make
 * credential-shaped values at run time instead of committing them; there is no opt-out.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanCredentials } from '../packages/plugins/egress/src/scan.ts'

export interface SecretFinding { file: string; line: number; rule: string }

/** Scan one text; findings carry the line and rule only. */
export async function scanText(file: string, content: string): Promise<SecretFinding[]> {
  const findings = await scanCredentials(content)
  return findings.map((f) => ({ file, line: content.slice(0, f.at).split('\n').length, rule: f.rule }))
}

/** Scan every tracked text file; a file holding a NUL byte is binary and skipped. */
export async function checkSecrets(root: string): Promise<SecretFinding[]> {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const findings: SecretFinding[] = []
  for (const file of files) {
    let buffer: Buffer
    try {
      buffer = readFileSync(join(root, file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // deleted in the working tree
      throw error
    }
    if (buffer.includes(0)) continue
    findings.push(...(await scanText(file, buffer.toString('utf8'))))
  }
  return findings
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const findings = await checkSecrets(root)
  for (const f of findings) console.error(`secret: ${f.file}:${f.line}: ${f.rule}`)
  console.log(`secrets: ${findings.length} finding(s)`)
  process.exit(findings.length ? 1 : 0)
}
