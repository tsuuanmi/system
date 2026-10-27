/**
 * The research role's web probe (T262, ADR-0074, ./research.ts): what a research Worker's
 * `web-search` offer rests on. One real search, on the probe's own fixed query, run as an agent run
 * of the Worker's runtime in the Worker's own home: read-only, its only tool `WebSearch`, its gate a
 * research run's in probe mode (the fixed search is the one call that may run, and it runs only as
 * the autonomy policy's web access grant lets any web call run: the egress check on the query, the
 * grant in force, recorded as every web call is). It proves `web-search` when that search ran and the
 * answer names a URL. Each probe is a `gate` decision of rule `agent-workers.web-probe` (`proven` or
 * `not-proven`, the query, why), which the offer names as its evidence. A result stands
 * {@link WEB_PROBE_TTL_MS} (a failed one {@link WEB_PROBE_RETRY_MS}); the next probe starts in the
 * background, at most one per Worker at a time, so a describe never waits on one.
 * @module
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentRuntimeProvider, RunSpec } from '@tsuuanmi/system-agent-runtime-core'
import type {} from '@tsuuanmi/system-ledger-core'
import type { ContentId } from '@tsuuanmi/system-libs'
import { runGate } from './gate.ts'
import { answersWithUrl, WEB_PROBE_PROMPT, WEB_PROBE_QUERY, WEB_PROBE_RETRY_MS, WEB_PROBE_TIMEOUT_MS, WEB_PROBE_TTL_MS } from './research.ts'

/** The probe's decider. */
export const WEB_PROBE_RULE = { type: 'rule', id: 'agent-workers.web-probe', version: '1' } as const

/** A probe's result: whether it proved a search, when it started, and its decision. */
export interface WebProof {
  proven: boolean
  /** When the probe started (ISO): the offer's evidence time. */
  at: string
  decision: ContentId
  /** Why it proved nothing, when it did not. */
  why?: string
}

/** What a probe of one Worker needs: its runtime, where it runs, and its home when it is one account's. */
export interface WebProbeTarget {
  worker: string
  workerKind: string
  provider: AgentRuntimeProvider
  workspace: string
  home?: string | undefined
  model?: string | undefined
}

/** Each research Worker's latest web probe, refreshed in the background. */
export class WebProbes {
  private readonly proofs = new Map<string, WebProof>()
  private readonly running = new Map<string, Promise<WebProof>>()

  constructor(private readonly ctx: Context, private readonly options: { stopped: AbortSignal; track: (work: Promise<unknown>) => void }) {}

  /**
   * The Worker's proof now, when its latest probe proved a search and still stands; a probe is
   * started in the background when none stands (none yet, past its time, or failed and due again).
   */
  proof(target: WebProbeTarget): WebProof | undefined {
    const now = Date.now()
    const latest = this.proofs.get(target.worker)
    const due = !latest || now - Date.parse(latest.at) >= (latest.proven ? WEB_PROBE_TTL_MS : WEB_PROBE_RETRY_MS)
    if (due && !this.running.has(target.worker) && !this.options.stopped.aborted) {
      const probe = this.probe(target).finally(() => this.running.delete(target.worker))
      this.running.set(target.worker, probe)
      this.options.track(probe)
    }
    return latest?.proven && now - Date.parse(latest.at) < WEB_PROBE_TTL_MS ? latest : undefined
  }

  /** Run one probe of the Worker and keep its result; never throws (a failure is a probe that proved nothing). */
  async probe(target: WebProbeTarget): Promise<WebProof> {
    const at = new Date().toISOString()
    const runId = `wprobe_${randomBytes(8).toString('hex')}`
    // The probe's own gate: the fixed search alone may run, under the web access grant, as any web call.
    const gate = runGate(this.ctx, { runId, worker: target.worker, workerKind: target.workerKind, workspace: target.workspace, classification: 'public', profile: 'research', webProbe: true })
    let searched = false
    const controller = new AbortController()
    const stop = (): void => controller.abort()
    this.options.stopped.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(stop, WEB_PROBE_TIMEOUT_MS)
    timer.unref?.()
    let why: string | undefined
    try {
      const spec: RunSpec = {
        prompt: WEB_PROBE_PROMPT, workspace: target.workspace, sandbox: 'read-only', tools: ['WebSearch'], web: true, maxTurns: 4,
        ...(target.model ? { model: target.model } : {}), ...(target.home ? { home: target.home } : {}),
        toolGate: async (call, signal) => {
          const verdict = await gate.gate(call, signal)
          if (verdict.decision === 'allow' && call.tool === 'WebSearch') searched = true
          return verdict
        },
      }
      const result = await target.provider.run(spec, controller.signal)
      if (!searched) why = 'it made no search the gate let run (the web access grant must be in force for the research role, and the probe\'s query must pass the egress check)'
      else if (!answersWithUrl(result.text)) why = 'it searched, but its answer names no URL of a result'
    } catch (error) {
      why = controller.signal.aborted ? `it did not end within ${WEB_PROBE_TIMEOUT_MS / 1000} s, or the source stopped` : `its run failed: ${(error as Error).message.slice(0, 200)}`
    } finally {
      clearTimeout(timer)
      this.options.stopped.removeEventListener('abort', stop)
    }
    const proven = why === undefined
    const decision = this.ctx.artifacts.recordDecision({
      decisionType: 'gate', question: `Does ${target.worker} prove web-search by a real search of the probe's own query?`, inputs: [],
      candidates: [
        { option: 'proven', selected: proven, reasons: proven ? [`it searched the probe's own query ${JSON.stringify(WEB_PROBE_QUERY)} through its gate and answered with a result's URL`] : [`not proven: ${why}`] },
        { option: 'not-proven', selected: !proven, reasons: proven ? ['not not-proven: the search ran and its answer names a URL'] : [why!] },
      ],
      decider: WEB_PROBE_RULE, outcome: { option: proven ? 'proven' : 'not-proven', detail: { worker: target.worker, probeRun: runId, query: WEB_PROBE_QUERY, searched } }, deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, classification: 'public' })
    const proof: WebProof = { proven, at, decision: decision.id as ContentId, ...(why ? { why } : {}) }
    this.proofs.set(target.worker, proof)
    return proof
  }
}
