/**
 * `ctx.egress`: explicit data egress (INV-12, docs/design/routing.md#data-locality-policy).
 * Before content leaves the machine for a remote Worker class, two checks run on the
 * **actual payload**: the classification policy for that class, and a scan for
 * credentials (secretlint's recommended rules plus operator deny patterns). Each check is
 * an `egress` decision artifact; findings record rule ids and positions, never the secret.
 * The seam's types and its conformance suite live in `@tsuuanmi/system-workers-core`.
 * @module @tsuuanmi/system-egress
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-ledger-core'
import { sha256 } from '@tsuuanmi/system-libs'
import {
  type Classification, type Config, Egress as EgressSeam, type EgressRequest, type EgressVerdict, type Finding, WORKER_CLASSES,
} from '@tsuuanmi/system-workers-core'
import { type NamedPattern, scanCredentials } from './scan.ts'

const CLASSIFICATIONS: readonly Classification[] = ['public', 'operator-shared', 'local-private']

export class Egress extends EgressSeam {
  static inject = ['artifacts']

  static Config: z<Config> = z.object({
    workerClasses: z.dict(z.array(z.union(['public', 'operator-shared', 'local-private']))).default({ ...WORKER_CLASSES })
      .description('Classifications each Worker class may receive'),
    defaultClassification: z.union(['public', 'operator-shared', 'local-private']).default('operator-shared').description('Classification when the caller states none'),
    scanSecrets: z.boolean().default(true).description('Scan payloads for credentials (secretlint recommended rules)'),
    denyPatterns: z.array(z.object({ name: z.string().required(), pattern: z.string().required() })).default([]).description('Operator patterns that must never leave the machine'),
  })

  private readonly denyPatterns: NamedPattern[]

  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx)
    this.denyPatterns = (config.denyPatterns ?? []).map((p) => ({ name: p.name, regex: new RegExp(p.pattern, 'g') }))
  }

  get defaultClassification(): Classification {
    return this.config.defaultClassification ?? 'operator-shared'
  }

  /** Decide whether `payload` may go to `workerClass`, and record why (INV-13). */
  async check(request: EgressRequest): Promise<EgressVerdict> {
    const classification = request.classification ?? this.defaultClassification
    const classes = this.config.workerClasses ?? WORKER_CLASSES
    const permitted = classes[request.workerClass]
    const findings = await this.scan(request.payload)
    let reason: string
    if (!CLASSIFICATIONS.includes(classification)) reason = `unknown classification ${String(classification)}`
    else if (!permitted) reason = `no egress policy for Worker class ${request.workerClass}`
    else if (!permitted.includes(classification)) reason = `${classification} content may not leave for ${request.workerClass} Workers`
    else if (findings.length) reason = `the payload carries ${findings.length} credential-like value(s): ${[...new Set(findings.map((f) => f.rule))].join(', ')}`
    else reason = `${classification} content is permitted for ${request.workerClass} Workers and no credential was found`
    const allowed = !!permitted && permitted.includes(classification) && findings.length === 0
    const decision = this.ctx.artifacts.recordDecision({
      decisionType: 'egress',
      question: `May this payload leave the machine for a ${request.workerClass} Worker?`,
      inputs: [],
      candidates: [
        { option: 'allow', selected: allowed, reasons: allowed ? [reason] : [`not allow: ${reason}`] },
        { option: 'deny', selected: !allowed, reasons: allowed ? [`not deny: the policy permits ${classification} content for ${request.workerClass} Workers, and the scan found no credential`] : [reason] },
      ],
      decider: { type: 'policy', id: 'egress.classification-and-secrets', version: '1' },
      outcome: { option: allowed ? 'allow' : 'deny', detail: { workerClass: request.workerClass, classification, payloadHash: sha256(request.payload), findings } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'egress' } })
    return { allowed, decision: decision.id, findings, reason }
  }

  private async scan(payload: string): Promise<Finding[]> {
    if (this.config.scanSecrets !== false) return scanCredentials(payload, this.denyPatterns)
    const findings: Finding[] = []
    for (const { name, regex } of this.denyPatterns) {
      for (const match of payload.matchAll(regex)) findings.push({ rule: name, at: match.index ?? 0 })
    }
    return findings
  }
}

export default Egress
