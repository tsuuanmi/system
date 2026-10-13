/**
 * Secrets audit of the repository: every tracked text file is scanned with secretlint's
 * recommended rules, the same rules `egress` applies to outgoing payloads. A finding names the
 * file, line, and rule, never the secret. Test fixtures that need a credential-shaped value
 * opt out per line with secretlint's own `secretlint-disable-line` comment.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintSource } from '@secretlint/core'
import { creator as recommended } from '@secretlint/secretlint-rule-preset-recommend'

export interface SecretFinding { file: string; line: number; rule: string }

const MAX_BYTES = 1024 * 1024

/** Scan one text; findings carry the line and rule only. */
export async function scanText(file: string, content: string): Promise<SecretFinding[]> {
  const result = await lintSource({
    source: { filePath: file, content, contentType: 'text' },
    options: { config: { rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: recommended }] }, maskSecrets: true },
  })
  return result.messages.map((m) => ({ file, line: m.loc.start.line, rule: m.ruleId }))
}

/** Scan every tracked file that is text and at most 1 MiB. */
export async function checkSecrets(root: string): Promise<SecretFinding[]> {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
  const findings: SecretFinding[] = []
  for (const file of files) {
    let buffer: Buffer
    try {
      buffer = readFileSync(join(root, file))
    } catch {
      continue // deleted in the working tree
    }
    if (buffer.length > MAX_BYTES || buffer.includes(0)) continue
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
