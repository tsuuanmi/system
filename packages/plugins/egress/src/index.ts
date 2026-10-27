/**
 * `ctx.egress`: explicit data egress (INV-12, docs/design/routing.md#data-locality-policy).
 * Before content leaves the machine for a remote Worker class, two checks run on the
 * **actual payload**: the classification policy for that class, and a scan for
 * credentials (secretlint's recommended rules plus operator deny patterns). Each check is
 * an `egress` decision artifact; findings record rule ids and positions, never the secret.
 * @module @tsuuanmi/system-egress
 */
import { type Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@tsuuanmi/system-ledger-core'
import { type ContentId, sha256 } from '@tsuuanmi/system-libs'
import { type Finding, type NamedPattern, scanCredentials } from './scan.ts'

export type { Finding } from './scan.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    egress: Egress
  }
}

export type Classification = 'public' | 'operator-shared' | 'local-private'
const CLASSIFICATIONS: readonly Classification[] = ['public', 'operator-shared', 'local-private']

/** The default egress policy per Worker class (INV-12). */
export const WORKER_CLASSES: Readonly<Record<string, Classification[]>> = {
  website: ['public', 'operator-shared'],
  agent: ['public', 'operator-shared'],
  model: ['public', 'operator-shared'],
  // Not local-private by default: `locality: local` is one catalog field nothing checks against
  // the route's address, so private data needs a second, explicit act (INV-12).
  'model-local': ['public', 'operator-shared'],
  // An operator's notification webhook (the notify plugin): nothing leaves for it until the operator
  // lists what may, in this row's own configuration (INV-12, docs/design/notifications.md).
  webhook: [],
}

export interface DenyPattern {
  name: string
  /** A regular expression (JavaScript syntax). */
  pattern: string
}

export interface Config {
  /**
   * Classifications each Worker class may receive (default {@link WORKER_CLASSES}). `agent` is
   * an agent runtime Worker: it runs here, but its model is remote; widen it only for an agent
   * whose model runs on this machine. `model` is an API model; `model-local` is a model the
   * catalog says runs on this machine: widen it for local-private only once its route's address
   * is this machine's (nothing checks that for you). `webhook` is the notify plugin's webhook,
   * which receives nothing until it lists `operator-shared`.
   */
  workerClasses?: Record<string, Classification[]>
  /** Classification of content whose caller states none (default operator-shared). */
  defaultClassification?: Classification
  /** Scan payloads for credentials with secretlint's recommended rules (default true). */
  scanSecrets?: boolean
  /** Extra operator patterns that must never leave the machine. */
  denyPatterns?: DenyPattern[]
}

export interface EgressRequest {
  payload: string
  classification?: Classification | undefined
  /** The remote Worker class receiving the payload, e.g. `website`. */
  workerClass: string
}

export interface EgressVerdict {
  allowed: boolean
  decision: ContentId
  findings: Finding[]
  reason: string
}

export class Egress extends Service {
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
    super(ctx, 'egress')
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
