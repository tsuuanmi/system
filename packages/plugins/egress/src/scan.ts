/**
 * The credential scan: secretlint's recommended rules plus the shapes they miss. `egress`
 * runs it on every outgoing payload, and the repository secrets audit
 * (`scripts/check-secrets.ts`) on every tracked file, so both apply the same rules.
 * Findings keep the rule and the offset, never the matched text.
 */
import { lintSource } from '@secretlint/core'
import { creator as recommended } from '@secretlint/secretlint-rule-preset-recommend'
import type { Finding } from '@tsuuanmi/system-workers-core'

export interface NamedPattern {
  name: string
  regex: RegExp
}

/**
 * Credential shapes the recommended rules miss. secretlint's AWS rule needs a word boundary
 * after the secret key, so a secret ending in `+` or `/` (about 2% of real keys) slips past
 * it; an access key id is a credential signal on its own.
 */
export const BUILT_IN_PATTERNS: readonly NamedPattern[] = [{ name: 'aws-access-key-id', regex: /\b(?:AKIA|ASIA)[A-Z2-7]{16}\b/g }]

/** Scan `text` with the recommended rules, the built-in patterns, and `extra` patterns. */
export async function scanCredentials(text: string, extra: readonly NamedPattern[] = []): Promise<Finding[]> {
  const result = await lintSource({
    source: { filePath: 'payload.txt', content: text, contentType: 'text' },
    options: { config: { rules: [{ id: '@secretlint/secretlint-rule-preset-recommend', rule: recommended }] }, maskSecrets: true, noPhysicFilePath: true },
  })
  const findings: Finding[] = result.messages.map((m) => ({ rule: m.ruleId, at: m.range[0] }))
  for (const { name, regex } of [...BUILT_IN_PATTERNS, ...extra]) {
    for (const match of text.matchAll(regex)) findings.push({ rule: name, at: match.index ?? 0 })
  }
  return findings
}
