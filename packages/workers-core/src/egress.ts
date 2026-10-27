import { type Context, Service } from '@deepseek-ai/cordis'
import type { ContentId } from '@tsuuanmi/system-libs'
import type { Classification } from './index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    egress: Egress
  }
}

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

/** A credential-like value the scan found: the rule and the offset, never the matched text. */
export interface Finding {
  rule: string
  /** Character offset of the match in the text; the matched text is never kept. */
  at: number
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

/**
 * `ctx.egress`: explicit data egress (INV-12, docs/design/routing.md#data-locality-policy).
 * Before content leaves the machine for a remote Worker class, two checks run on the
 * **actual payload**: the classification policy for that class, and a scan for
 * credentials. Each check is an `egress` decision artifact; findings record rule ids and
 * positions, never the secret. A guarantee seam that fails closed (INV-2): a provider passes
 * `conformance/egress.ts` (ADR-0036); it records its decisions through `ctx.artifacts`.
 */
export abstract class Egress extends Service {
  constructor(ctx: Context) {
    super(ctx, 'egress')
  }

  /** Classification of content whose caller states none. */
  abstract get defaultClassification(): Classification

  /** Decide whether `payload` may go to `workerClass`, and record why (INV-13). */
  abstract check(request: EgressRequest): Promise<EgressVerdict>
}
