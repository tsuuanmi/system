/**
 * The supply-chain verification of a new lockfile (T333, D112, docs/design/agent-runtimes.md#a-lockfiles-verification):
 * pnpm verifies each new lockfile against its supply-chain policy, which reads the registry's full
 * metadata, so the setup a result's checks need, run again offline, is refused `dependency_unavailable`
 * (`ERR_PNPM_NO_OFFLINE_META`) when that is the only thing it lacks. This opens one approval request
 * (class `command`) for the exact argv of the verification, once per lockfile digest of a repository;
 * approved, the host runs it once on the host's network (a confinement cannot limit it to one host),
 * none of the result's code run and the registry the only one configured, and records what it came
 * to as a `gate` decision (INV-13); the setup and then the checks run again. A digest verified once is
 * never asked again, one rejected or expired keeps the checks not run with that reason, and the
 * `lockfile-verification` mechanism (`off`, `warn`, `on`; starts `warn`, D108) records, in `warn`, the
 * request it would open, once, and opens none.
 * @module @tsuuanmi/system-agent-workers/verification
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalRequest, Approvals, ArtifactRef, AutonomyVerdict } from '@tsuuanmi/system-approvals-core'
import type {} from '@tsuuanmi/system-ledger-core'
import { type ContentId, contentId } from '@tsuuanmi/system-libs'

/** The rule of the decisions the verification records. */
const RULE = { type: 'rule', id: 'agent-workers.lockfile-verification', version: '1' } as const

/** What a repository's setup names to allow its lockfile's verification (`worktreeSetup[].lockfileVerification`). */
export interface LockfileVerificationConfig {
  /** The registry the verification talks to (an `https://` URL): the one host the request names, and the one the command is configured to use. */
  registry: string
  /** The directory (absolute) where pnpm keeps the registry's metadata: every setup run sees it read-only, the verification writes it. */
  cacheDir: string
}

/** One lockfile digest of one repository, as the ledger holds it, with the execution its request is for. */
export const VERIFICATION_MIGRATION = {
  version: 24,
  sql: `CREATE TABLE agent_lockfile_verifications (
    repository TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, request_id TEXT, spec TEXT, decision TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (repository, digest)
  );`,
}

interface Row { state: 'warned' | 'asked' | 'running' | 'verified' | 'denied' | 'expired' | 'failed'; request_id: string | null; spec: string | null; decision: string | null; reason: string | null }

/** What the verification of one lockfile digest came to, for the setup that asked. */
export type Verification =
  /** It ran, online, and exited 0 (now, or on the approval): the setup runs again. */
  | { state: 'verified'; decision: ContentId }
  /** It was verified before (from this worktree or another with this lockfile): the setup runs again, offline, once. */
  | { state: 'already'; decision: ContentId | undefined }
  /** The request is open: the checks wait on it. */
  | { state: 'waits'; requestId: string }
  /** Rejected, or expired or withdrawn unanswered. */
  | { state: 'denied'; requestId: string; reason: string; decision: ContentId }
  /** It ran and failed. */
  | { state: 'failed'; reason: string; decision: ContentId }
  /** `warn`: the request it would open was recorded. */
  | { state: 'warned'; decision: ContentId | undefined }
  /** The policy forbids the command: nothing runs. */
  | { state: 'forbidden'; reason: string }

/** What a lockfile's verification is for. */
interface VerificationRequest {
  repository: string
  /** The repository's key in subject refs (./worktrees.ts `repositoryKey`). */
  key: string
  digest: string
  /** The exact argv: the setup's install command, offline off, scripts and pnpmfile off. */
  argv: string[]
  line: string
  config: LockfileVerificationConfig
  workflowRunId: string
  sessionId?: string | undefined
  worktree: string
  classification: 'public' | 'operator-shared' | 'local-private'
  timeoutSeconds: number
}

/**
 * What an approval of a verification is for, exactly (INV-5): the digest, the argv, the registry, the
 * cache directory it writes, and its deadline, as one content id, the request's subject version. An
 * approval runs only the execution it names, never one a reloaded setup gives the same digest (another
 * argv, registry, cache, or deadline: its request replaces the stale one, whose execution no longer
 * exists). The worktree is not part of it: every held result with this lockfile shares the one request
 * of its digest, so results in two worktrees never replace each other's request, and the approval runs
 * in the first of them checked after it, whose own files were read before it runs.
 */
const specOf = (request: VerificationRequest): string => contentId({
  digest: request.digest, argv: request.argv, registry: request.config.registry, cacheDir: request.config.cacheDir, timeoutSeconds: request.timeoutSeconds,
})
const refOf = (request: VerificationRequest): string => `lockfile-verification:${request.key}/${request.digest}`

/** Runs the command online, confined; its end: `ok` on exit 0, and the tail of what it printed. */
type Execute = () => Promise<{ ok: boolean; detail: string }>

const stamp = (): string => new Date().toISOString()
const clip = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

export class LockfileVerifications {
  /** One digest at a time: two worktrees that need the same lockfile verified wait for each other, and the second finds it done. */
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly ctx: Context) {}

  /**
   * What the verification of `request.digest` is now, moving it on when it can: `warn` records the
   * request it would open, once; `on` opens one request (the policy's `ask` for the exact argv) the
   * first time, waits while it is open, runs `execute` once it is approved (used once), and keeps what
   * it came to. A digest that is `verified`, `denied` or `failed` is final: nothing is asked again.
   */
  resolve(mode: 'warn' | 'on', request: VerificationRequest, execute: Execute): Promise<Verification> {
    const key = `${request.repository}\0${request.digest}`
    const result = (this.queues.get(key) ?? Promise.resolve()).then(() => this.step(mode, request, execute))
    const settled = result.then(() => undefined, () => undefined)
    this.queues.set(key, settled)
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key)
    })
    return result
  }

  private row(request: VerificationRequest): Row | undefined {
    return this.ctx.store.db.prepare('SELECT state, request_id, spec, decision, reason FROM agent_lockfile_verifications WHERE repository = ? AND digest = ?').get(request.repository, request.digest) as Row | undefined
  }

  private put(request: VerificationRequest, state: Row['state'], more: { requestId?: string; spec?: string; decision?: string; reason?: string } = {}): void {
    const at = stamp()
    this.ctx.store.transaction((db) => {
      db.prepare(`INSERT INTO agent_lockfile_verifications (repository, digest, state, request_id, spec, decision, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (repository, digest) DO UPDATE SET state = excluded.state, request_id = COALESCE(excluded.request_id, request_id), spec = COALESCE(excluded.spec, spec), decision = COALESCE(excluded.decision, decision), reason = excluded.reason, updated_at = excluded.updated_at`)
        .run(request.repository, request.digest, state, more.requestId ?? null, more.spec ?? null, more.decision ?? null, more.reason ?? null, at, at)
    })
  }

  private async step(mode: 'warn' | 'on', request: VerificationRequest, execute: Execute): Promise<Verification> {
    const row = this.row(request)
    // What a digest came to stands in any mode: verified, rejected, or failed is said so in warn as in on.
    if (row?.state === 'verified') return { state: 'already', decision: (row.decision ?? undefined) as ContentId | undefined }
    if (row?.state === 'denied') return { state: 'denied', requestId: row.request_id ?? '', reason: row.reason ?? 'rejected', decision: row.decision as ContentId }
    if (row?.state === 'failed') return { state: 'failed', reason: row.reason ?? 'failed', decision: row.decision as ContentId }
    if (mode === 'warn') {
      if (row) return { state: 'warned', decision: (row.decision ?? undefined) as ContentId | undefined }
      const verdict = await this.ctx.get('approvals')?.check({ class: 'command', command: request.argv })
      const decision = this.decide(request, 'warn', [`the setup could not verify the lockfile ${request.digest} offline, and only that; in warn mode nothing is asked: with the mechanism on it would open one approval request for ${request.line}, which would run on the host's network, meant to reach ${request.config.registry} only`], verdict ? [verdict.decision] : [], { mode: 'warn', registry: request.config.registry, command: request.line })
      this.put(request, 'warned', { decision, reason: 'warn' })
      return { state: 'warned', decision }
    }
    const approvals = this.ctx.get('approvals')
    if (!approvals) return { state: 'forbidden', reason: 'no approval queue (ctx.approvals) is loaded, and no command runs without its autonomy decision' }
    const verdict = await approvals.check({ class: 'command', command: request.argv })
    if (verdict.mode === 'forbid') return { state: 'forbidden', reason: `the autonomy policy forbids the verification command (${request.line})` }
    if (verdict.mode === 'auto' || verdict.mode === 'notify') return this.run(request, execute, [verdict.decision])
    if (verdict.mode !== 'ask') return { state: 'forbidden', reason: `the autonomy policy gave the verification command a mode this source does not know (${String(verdict.mode)})` }
    // A run left unfinished on an unasked verdict (no request) is asked about now that the policy asks;
    // a request for another execution of this digest (a reloaded setup's argv, registry, cache, or deadline) is never used for this one: asked anew (INV-5).
    if ((row?.state === 'asked' || row?.state === 'running') && row.request_id && row.spec === specOf(request)) {
      const asked = await approvals.get(row.request_id)
      if (!asked) return { state: 'forbidden', reason: `approval request ${row.request_id} of the lockfile verification cannot be read` }
      // INV-5: the request is for exactly this execution of exactly this digest.
      const other = asked.subject.type !== 'content' ? 'subject type' : asked.subject.ref !== refOf(request) ? 'subject ref' : asked.subject.version !== specOf(request) ? 'subject version' : asked.action.class !== 'command' ? 'action class' : undefined
      if (other) return { state: 'forbidden', reason: `approval request ${asked.requestId} is for another verification than this one (its ${other} differs), so its verdict is not used` }
      if (asked.state === 'rejected') return this.denied(request, asked, verdict)
      if (asked.state !== 'approved') return { state: 'waits', requestId: asked.requestId }
      // Used once: the row moves from asked to running in one statement, only while it still holds this request for this execution;
      // a run the host left unfinished (running) is run again, which a frozen install allows.
      if (row.state === 'asked') {
        const taken = this.ctx.store.transaction((db) => Number(db.prepare("UPDATE agent_lockfile_verifications SET state = 'running', updated_at = ? WHERE repository = ? AND digest = ? AND state = 'asked' AND request_id = ? AND spec = ?").run(stamp(), request.repository, request.digest, asked.requestId, specOf(request)).changes))
        if (taken !== 1) return this.step(mode, request, execute)
      }
      return this.run(request, execute, [verdict.decision, ...(asked.resolution?.decision ? [asked.resolution.decision] : [])], asked.requestId)
    }
    return this.ask(approvals, request, verdict)
  }

  /** Open the one request for this digest. */
  private async ask(approvals: Approvals, request: VerificationRequest, verdict: AutonomyVerdict): Promise<Verification> {
    const { config } = request
    const created = await approvals.request({
      subject: { type: 'content', ref: refOf(request), version: specOf(request) },
      action: {
        class: 'command', summary: clip(`Verify the lockfile ${request.digest} of ${request.repository} (workflow run ${request.workflowRunId}) against pnpm's supply-chain policy: ${request.line}`, 500),
        consequences: clip(`Runs this exact command once, in the run worktree of this repository whose result holds this lockfile and is checked first after the approval (asked from ${request.worktree}; every result with this lockfile waits on this one request), writing only that worktree and pnpm's metadata cache ${config.cacheDir}, at most ${request.timeoutSeconds} s. `
          + `Network (INV-12): the command shares the host's network while it runs; its confinement cannot limit it to one host. It is meant to reach ${config.registry} only: it is a frozen install with lifecycle scripts and pnpmfile hooks off, so none of the result's own code runs; its environment names that registry; corepack may not download; and the result's .npmrc, pnpm-workspace.yaml, and lockfile were read against allowlists: they set only layout settings, name no registry but this one, and resolve every package from it or from a local directory. `
          + 'Approved: the setup and then the result\'s checks run again by themselves (offline), and this lockfile is never asked about again. '
          + 'Rejected, or unanswered when the request expires: the result\'s checks stay not run, naming this.', 2000),
      },
      requester: { component: 'worker', runId: request.workflowRunId, ...(request.sessionId ? { sessionId: request.sessionId } : {}) },
      verdict, command: request.argv, classification: request.classification,
    })
    this.put(request, 'asked', { requestId: created.requestId, spec: specOf(request) })
    return { state: 'waits', requestId: created.requestId }
  }

  private denied(request: VerificationRequest, asked: ApprovalRequest, verdict: AutonomyVerdict): Verification {
    const how = asked.resolution?.cause === 'verdict' ? 'rejected by the operator' : asked.resolution?.cause === 'expired' ? 'unanswered when it expired' : 'withdrawn'
    const reason = `approval request ${asked.requestId} for the verification of the lockfile ${request.digest} (${request.line}) was ${how}`
    const decision = this.decide(request, 'deny', [`${reason}, so it was not run and the checks stay not run`], [verdict.decision, ...(asked.resolution?.decision ? [asked.resolution.decision] : [])], { requestId: asked.requestId, cause: asked.resolution?.cause ?? 'withdrawn' })
    // Rejected is final for this digest; unanswered or withdrawn is reported once, and a later check asks anew.
    this.put(request, asked.resolution?.cause === 'verdict' ? 'denied' : 'expired', { requestId: asked.requestId, decision, reason })
    return { state: 'denied', requestId: asked.requestId, reason, decision }
  }

  /** Run the verification on the host and record what it came to. */
  private async run(request: VerificationRequest, execute: Execute, inputs: ArtifactRef[], requestId?: string): Promise<Verification> {
    if (!requestId) this.put(request, 'running')
    let ended: Awaited<ReturnType<Execute>>
    try {
      ended = await execute()
    } catch (error) {
      // A stop (or a command that could not start) came to nothing: the row stays running, run again next time.
      this.put(request, 'running', { ...(requestId ? { requestId } : {}), reason: 'interrupted' })
      throw error
    }
    const detail = { requestId, command: request.line, registry: request.config.registry, cacheDir: request.config.cacheDir, ok: ended.ok }
    if (ended.ok) {
      const decision = this.decide(request, 'verify', [`the verification of the lockfile ${request.digest} ran once on the host's network, its scripts and pnpmfile off and its registry ${request.config.registry}, and exited 0 (${request.line}); the lockfile passes pnpm's supply-chain policies, so the setup runs again offline`], inputs, detail)
      this.put(request, 'verified', { decision, ...(requestId ? { requestId } : {}) })
      return { state: 'verified', decision }
    }
    const reason = `the verification of the lockfile ${request.digest} (${request.line}) did not exit 0: ${clip(ended.detail, 600)}`
    const decision = this.decide(request, 'fail', [reason], inputs, { ...detail, output: clip(ended.detail, 1500) })
    this.put(request, 'failed', { decision, reason, ...(requestId ? { requestId } : {}) })
    return { state: 'failed', reason, decision }
  }

  /** The `gate` decision of rule `agent-workers.lockfile-verification` (INV-13). */
  private decide(request: VerificationRequest, option: 'verify' | 'fail' | 'deny' | 'warn', reasons: string[], inputs: ArtifactRef[], detail: Record<string, unknown>): ContentId {
    const options = ['verify', 'fail', 'deny', 'warn'] as const
    return this.ctx.artifacts.recordDecision({
      decisionType: 'gate', question: clip(`May the lockfile ${request.digest} of ${request.repository} be verified online, once, by ${request.line}?`, 500),
      inputs: [...new Set(inputs)],
      candidates: options.map((o) => ({ option: o, selected: o === option, reasons: o === option ? reasons : [`not ${o}: ${reasons[0]}`] })),
      decider: RULE,
      outcome: { option, detail: { repository: request.repository, digest: request.digest, worktree: request.worktree, ...detail } },
      deterministic: true,
    }, { producer: { type: 'system', ref: 'agent-workers' }, runId: request.workflowRunId, classification: request.classification }).id as ContentId
  }
}
