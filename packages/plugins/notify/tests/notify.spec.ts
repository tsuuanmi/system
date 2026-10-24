// Out-of-band notifications (docs/design/notifications.md): each event kind read into its notice,
// the expiry reminder, deduplication per subject and kind, the bounded queue, stale events, the
// cursor across a restart, the desktop sink through a stand-in notify-send, the webhook behind the
// egress gate (refused when not declared), and a producer never held by a sink.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import StoreApprovals from '@tsuuanmi/system-approvals'
import Artifacts from '@tsuuanmi/system-artifacts'
import Vault from '@tsuuanmi/system-credentials-vault'
import Egress from '@tsuuanmi/system-egress'
import EventLog, { type NewEvent, type SystemEvent } from '@tsuuanmi/system-event-log'
import { McpTools, type ToolHandler, type ToolSpec } from '@tsuuanmi/system-gateway-core'
import { SchemaRegistry } from '@tsuuanmi/system-libs'
import Store from '@tsuuanmi/system-store'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { POLICIES } from '../../../approvals-core/conformance/approvals.ts'
import * as notify from '../src/index.ts'
import { type Config, configProblems, DELIVERY_EVENT, desktopBody, KINDS, type Notice, Notifier, type Outcome, readEvent, type Sink, webhookProblem } from '../src/index.ts'

const schemas = new SchemaRegistry()
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
  vi.unstubAllEnvs()
})

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'system-notify-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A `ctx.mcp` that keeps contributed tools, so a test calls a handler as the operator would. */
class RecordingMcp extends McpTools {
  readonly tools = new Map<string, { spec: ToolSpec; handler: ToolHandler }>()
  tool(name: string, spec: ToolSpec, handler: ToolHandler): void {
    this.tools.set(name, { spec, handler })
  }
}

/** A sink that keeps what it is given and answers as told. */
class RecordingSink implements Sink {
  readonly sent: Notice[] = []
  outcome: Outcome = { sent: true }
  hold: Promise<void> | undefined
  constructor(readonly name: 'desktop' | 'webhook' = 'desktop') {}
  async send(notice: Notice): Promise<Outcome> {
    this.sent.push(notice)
    if (this.hold) await this.hold
    return this.outcome
  }
}

interface Booted { ctx: Context; dir: string; stop: () => Promise<void> }

/** The kernel the notifier reads (store, artifacts, event log), with the optional egress gate, vault, and MCP. */
async function kernel(options: { dir?: string; egress?: Record<string, unknown> | false; vault?: boolean; mcp?: boolean; notify?: Config } = {}): Promise<Booted> {
  const dir = options.dir ?? tempDir()
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}),
    ...(options.egress === false ? [] : [ctx.plugin(Egress, options.egress ?? {})]),
    ...(options.vault ? [ctx.plugin(Vault, { path: join(dir, 'vault.enc'), keyFile: join(dir, 'vault.key') })] : []),
    ...(options.mcp ? [ctx.plugin(RecordingMcp)] : []),
    ...(options.notify ? [ctx.plugin(notify, options.notify)] : []),
  ]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 0))
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
    await new Promise((resolve) => setImmediate(resolve))
  }
  cleanups.push(stop)
  return { ctx, dir, stop }
}

const NOW = Date.now()
const iso = (ms: number): string => new Date(ms).toISOString()
const read = (event: Partial<SystemEvent> & Pick<SystemEvent, 'type'>) => readEvent({ schema: 'event@1.0', seq: 7, at: iso(NOW), ...event }, { leadMs: 60 * 60_000, link: 'http://127.0.0.1:47317/ui/' })
const deliveries = (ctx: Context) => ctx.eventLog.query({ type: DELIVERY_EVENT, limit: 1000 }).map((e) => e.data as Record<string, unknown>)

/** Wait until `done` holds, polling; fails after `ms`. */
async function until(done: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('each event kind is read into its notice (REQ-HOST-8)', () => {
  it('an approval request opened: what, which request, and the channels to decide it; a reminder before its expiry', () => {
    const expiresAt = iso(NOW + 24 * 3600_000)
    const { notice, remind } = read({ type: 'approvals.requested', data: { requestId: 'apr_1', actionClass: 'merge', expiresAt, component: 'board', projectId: 'p1' } })
    expect(notice).toMatchObject({
      schema: 'notification@1.0', id: 'approval.opened:apr_1:7', kind: 'approval.opened', subject: 'apr_1', event: { seq: 7, type: 'approvals.requested' },
      title: 'Approval needed: merge', act: ['system ui', 'MCP approvals_get {"requestId":"apr_1"}', 'MCP approvals_decide'], link: 'http://127.0.0.1:47317/ui/',
    })
    expect(notice!.text).toBe(`Request apr_1 of project p1 (merge, asked by board) waits for your verdict. Unanswered, it is denied at ${expiresAt}.`)
    schemas.assert('notification@1.0', notice)
    expect(remind).toEqual({ requestId: 'apr_1', remindMs: Date.parse(expiresAt) - 3600_000, expiresMs: Date.parse(expiresAt), seq: 7, actionClass: 'merge', projectId: 'p1', policyChange: false })
    // A request that expires within the lead time is told once, as it opens.
    expect(read({ type: 'approvals.requested', data: { requestId: 'apr_2', actionClass: 'command', expiresAt: iso(NOW + 600_000) } }).remind).toBeUndefined()
    expect(read({ type: 'approvals.resolved', data: { requestId: 'apr_1', state: 'approved' } })).toEqual({ resolved: 'apr_1' })
  })

  it('an approval request close to its expiry: the reminder says when it is denied', () => {
    const expiresMs = NOW + 30 * 60_000
    const notice = notify.reminderNotice({ requestId: 'apr_1', remindMs: NOW, expiresMs, seq: 7, actionClass: 'deploy', policyChange: false }, NOW, { leadMs: 3600_000 })!
    expect(notice).toMatchObject({ kind: 'approval.expiring', subject: 'apr_1', title: 'Approval expires soon: deploy', act: ['system ui', 'MCP approvals_get {"requestId":"apr_1"}', 'MCP approvals_decide'] })
    expect(notice.text).toBe(`Request apr_1 (deploy) is denied at ${iso(expiresMs)}, in about 30 min, unless you answer it.`)
    schemas.assert('notification@1.0', notice)
  })

  it('a step or run failed with disposition USER_ACTION, and nothing else that failed', () => {
    const { notice } = read({ type: 'workflow.node.failed', runId: 'run-1', nodeId: 'develop:1', data: { kind: 'reauth_required', disposition: 'USER_ACTION' } })
    expect(notice).toMatchObject({ kind: 'run.user-action', subject: 'run-1', title: 'Run run-1 needs you', act: ['system explain run-1', 'system continue run-1 develop:1', 'system ui'] })
    expect(notice!.text).toBe('Step develop:1 failed as reauth_required (USER_ACTION): nothing more runs on its own until you act.')
    expect(read({ type: 'workflow.run.failed', runId: 'run-1', data: { template: 'chain', kind: 'budget_spent', disposition: 'USER_ACTION' } }).notice).toMatchObject({ kind: 'run.user-action', subject: 'run-1', act: ['system explain run-1', 'system ui'] })
    for (const disposition of ['NONE', 'BACKOFF', undefined]) expect(read({ type: 'workflow.node.failed', runId: 'run-1', nodeId: 'a', data: { kind: 'x', disposition } })).toEqual({})
  })

  it('a step escalated to a higher tier', () => {
    const { notice } = read({ type: 'workflow.node.escalated', runId: 'run-1', nodeId: 'answer', data: { from: 'economy', to: 'standard', escalation: 1 } })
    expect(notice).toMatchObject({ kind: 'run.escalated', subject: 'run-1', act: ['system explain run-1', 'system stop run-1'] })
    expect(notice!.text).toBe('Step answer\'s result was rejected, so it runs again at a higher tier (economy to standard).')
  })

  it('a step waiting for an assigned account\'s limit (ADR-0052 wait)', () => {
    const until = iso(NOW + 3 * 3600_000)
    const { notice } = read({ type: 'workflow.node.waiting', runId: 'run-1', nodeId: 'develop:1', data: { until, since: iso(NOW), attempt: 1 } })
    expect(notice).toMatchObject({ kind: 'run.waiting', subject: 'run-1', act: ['system explain run-1', 'system account list', 'system stop run-1'] })
    expect(notice!.text).toContain(`waits until ${until}`)
  })

  it('a pool closed at its limit', () => {
    const until = iso(NOW + 3600_000)
    const { notice } = read({ type: 'resources.pool.limited', data: { pool: 'plan/claude:0123456789abcdef', account: 'claude:0123456789abcdef', window: 'five-hour', until, source: 'limit-notice' } })
    expect(notice).toMatchObject({ kind: 'pool.limited', subject: 'plan/claude:0123456789abcdef', act: ['system health', 'MCP resources_pools'] })
    expect(notice!.text).toBe(`Window five-hour of account claude:0123456789abcdef reads limited until ${until}: no new work draws on the pool before then.`)
  })

  it('an agent account quarantined: its Workers take no work, and the command that resolves each reason', () => {
    const { notice } = read({ type: 'agent-workers.account.quarantined', data: { provider: 'codex', slot: 2, accountId: 'codex:0123456789abcdef', reason: 'changed', workers: ['agent:codex:0123456789abcdef:dev'] } })
    expect(notice).toMatchObject({ kind: 'worker.quarantined', subject: 'codex:0123456789abcdef', act: ['system account list', 'system account verify codex --slot 2 --accept', 'system account login codex:0123456789abcdef'] })
    expect(notice!.text).toBe('codex:0123456789abcdef is quarantined (changed): its Workers agent:codex:0123456789abcdef:dev take no work until you resolve it.')
    // A slot with no account id yet is its own subject.
    expect(read({ type: 'agent-workers.account.quarantined', data: { provider: 'codex', slot: 1, reason: 'unverified', workers: [] } }).notice).toMatchObject({ subject: 'codex:slot-1', act: ['system account list', 'system account verify codex --slot 1', 'system account login codex --slot 1'] })
  })

  it('reads ids and words only: anything else, or an event it does not know, makes no notice; nothing it quotes is long or unclean', () => {
    expect(read({ type: 'approvals.requested', data: { requestId: 'apr 1; rm -rf /', actionClass: 'merge', expiresAt: iso(NOW) } })).toEqual({})
    expect(read({ type: 'approvals.requested', data: { requestId: 'apr_1', actionClass: 'merge', expiresAt: 'tomorrow' } })).toEqual({})
    expect(read({ type: 'workflow.node.failed', runId: 'run-1', nodeId: 'a', data: { kind: 'x\ny', disposition: 'USER_ACTION' } }).notice!.text).toContain('failed as a failure')
    expect(read({ type: 'notify.delivery', data: { outcome: 'sent' } })).toEqual({})
    expect(read({ type: 'provider.turn.submitted', runId: 'run-1' })).toEqual({})
    const long = read({ type: 'workflow.node.escalated', runId: `r${'x'.repeat(199)}`, nodeId: 'a', data: {} }).notice!
    schemas.assert('notification@1.0', long)
    expect(long.title.length).toBeLessThanOrEqual(120)
  })

  it('a desktop body is the text, each command, then the link', () => {
    const { notice } = read({ type: 'workflow.node.escalated', runId: 'run-1', nodeId: 'a', data: {} })
    expect(desktopBody(notice!)).toBe(`${notice!.text}\n→ system explain run-1\n→ system stop run-1\nhttp://127.0.0.1:47317/ui/`)
  })
})

describe('the notifier', () => {
  const append = (ctx: Context, event: NewEvent): SystemEvent => ctx.eventLog.append(event)
  const failed = (runId: string): NewEvent => ({ type: 'workflow.node.failed', runId, nodeId: 'a', data: { kind: 'question', disposition: 'USER_ACTION' } })

  it('sends at most one notice per subject and kind per window, and again after it (REQ-HOST-8)', async () => {
    const { ctx } = await kernel()
    const sink = new RecordingSink()
    const notifier = new Notifier(ctx, { dedupMinutes: 10 }, [sink])
    append(ctx, failed('run-1'))
    append(ctx, { type: 'workflow.run.failed', runId: 'run-1', data: { kind: 'question', disposition: 'USER_ACTION' } })
    append(ctx, failed('run-2'))
    // Another kind of the same run is its own notice.
    append(ctx, { type: 'workflow.node.escalated', runId: 'run-1', nodeId: 'b', data: {} })
    notifier.pass(NOW)
    await notifier.idle()
    expect(sink.sent.map((n) => `${n.kind} ${n.subject}`)).toEqual(['run.user-action run-1', 'run.user-action run-2', 'run.escalated run-1'])
    append(ctx, failed('run-1'))
    notifier.pass(NOW + 9 * 60_000)
    await notifier.idle()
    expect(sink.sent).toHaveLength(3)
    append(ctx, failed('run-1'))
    notifier.pass(NOW + 21 * 60_000)
    await notifier.idle()
    expect(sink.sent.map((n) => n.subject)).toEqual(['run-1', 'run-2', 'run-1', 'run-1'])
    expect(deliveries(ctx).filter((d) => d.outcome === 'sent')).toHaveLength(4)
  })

  it('reminds of an open approval request once, before it expires, and not of one answered first', async () => {
    const { ctx } = await kernel()
    const sink = new RecordingSink()
    const notifier = new Notifier(ctx, { expiryLeadMinutes: 60 }, [sink])
    const expires = NOW + 3 * 3600_000
    append(ctx, { type: 'approvals.requested', data: { requestId: 'apr_1', actionClass: 'merge', expiresAt: iso(expires), component: 'board' } })
    append(ctx, { type: 'approvals.requested', data: { requestId: 'apr_2', actionClass: 'deploy', expiresAt: iso(expires), component: 'board' } })
    notifier.pass(NOW)
    await notifier.idle()
    expect(sink.sent.map((n) => `${n.kind} ${n.subject}`)).toEqual(['approval.opened apr_1', 'approval.opened apr_2'])
    append(ctx, { type: 'approvals.resolved', data: { requestId: 'apr_2', state: 'approved', cause: 'verdict' } })
    notifier.pass(NOW + 60_000)
    // Not yet due; then due; then never again.
    expect(sink.sent).toHaveLength(2)
    notifier.pass(expires - 59 * 60_000)
    await notifier.idle()
    expect(sink.sent.map((n) => `${n.kind} ${n.subject}`).slice(2)).toEqual(['approval.expiring apr_1'])
    notifier.pass(expires - 30 * 60_000)
    await notifier.idle()
    expect(sink.sent).toHaveLength(3)
  })

  it('makes no notice of an event older than maxAgeMinutes, but keeps an open request\'s reminder', async () => {
    const { ctx } = await kernel()
    const sink = new RecordingSink()
    const notifier = new Notifier(ctx, { maxAgeMinutes: 60, expiryLeadMinutes: 60 }, [sink])
    const old = append(ctx, { type: 'approvals.requested', data: { requestId: 'apr_old', actionClass: 'merge', expiresAt: iso(NOW + 26 * 3600_000), component: 'board' } })
    append(ctx, failed('run-old'))
    // Read two hours later (a host that was off): nothing now; the reminder still comes.
    notifier.pass(Date.parse(old.at) + 2 * 3600_000)
    await notifier.idle()
    expect(sink.sent).toEqual([])
    notifier.pass(NOW + 25 * 3600_000 + 60_000)
    await notifier.idle()
    expect(sink.sent.map((n) => `${n.kind} ${n.subject}`)).toEqual(['approval.expiring apr_old'])
  })

  it('sends only the kinds configured', async () => {
    const { ctx } = await kernel()
    const sink = new RecordingSink()
    const notifier = new Notifier(ctx, { kinds: ['run.user-action'] }, [sink])
    append(ctx, { type: 'workflow.node.escalated', runId: 'run-1', nodeId: 'b', data: {} })
    append(ctx, failed('run-1'))
    notifier.pass(NOW)
    await notifier.idle()
    expect(sink.sent.map((n) => n.kind)).toEqual(['run.user-action'])
  })

  it('drops a notice past a full queue, records it, and never blocks the next pass (INV-9)', async () => {
    const { ctx } = await kernel()
    const sink = new RecordingSink()
    let release!: () => void
    sink.hold = new Promise((resolve) => { release = resolve })
    const notifier = new Notifier(ctx, { maxQueue: 2 }, [sink])
    for (const run of ['run-1', 'run-2', 'run-3']) append(ctx, failed(run))
    notifier.pass(NOW)
    // Two fit the queue: run-1 is being sent (held), run-2 waits; run-3 is dropped.
    expect(notifier.pending).toBe(1)
    expect(deliveries(ctx).filter((d) => d.outcome === 'dropped').map((d) => d.subject)).toEqual(['run-3'])
    release()
    await notifier.idle()
    expect(sink.sent.map((n) => n.subject)).toEqual(['run-1', 'run-2'])
    // The dropped notice did not claim its window: the next failure of that run is told.
    append(ctx, failed('run-3'))
    notifier.pass(NOW + 1000)
    await notifier.idle()
    expect(sink.sent.map((n) => n.subject)).toEqual(['run-1', 'run-2', 'run-3'])
  })

  it('records a sink that fails, sends nothing again, and keeps sending to the others (no retry)', async () => {
    const { ctx } = await kernel()
    const broken = new RecordingSink('desktop')
    broken.outcome = { sent: false, reason: 'notify-send failed: no session bus' }
    const working = new RecordingSink('webhook')
    const notifier = new Notifier(ctx, {}, [broken, working])
    append(ctx, failed('run-1'))
    notifier.pass(NOW)
    await notifier.idle()
    notifier.pass(NOW + 1000)
    await notifier.idle()
    expect([broken.sent.length, working.sent.length]).toEqual([1, 1])
    expect(deliveries(ctx)).toEqual([
      { outcome: 'failed', sink: 'desktop', kind: 'run.user-action', subject: 'run-1', notice: 'run.user-action:run-1:1', reason: 'notify-send failed: no session bus' },
      { outcome: 'sent', sink: 'webhook', kind: 'run.user-action', subject: 'run-1', notice: 'run.user-action:run-1:1' },
    ])
  })

  it('keeps its cursor and its windows across a restart: nothing is told twice (plugin rule 6)', async () => {
    const first = await kernel()
    const sink = new RecordingSink()
    append(first.ctx, failed('run-1'))
    const notifier = new Notifier(first.ctx, {}, [sink])
    notifier.pass(NOW)
    await notifier.idle()
    await first.stop()
    const second = await kernel({ dir: first.dir })
    const again = new RecordingSink()
    const restarted = new Notifier(second.ctx, {}, [again])
    append(second.ctx, failed('run-1'))
    append(second.ctx, failed('run-2'))
    restarted.pass(NOW + 1000)
    await restarted.idle()
    expect(sink.sent.map((n) => n.subject)).toEqual(['run-1'])
    expect(again.sent.map((n) => n.subject)).toEqual(['run-2'])
  })

  it('reads a long backlog a bounded page at a time, and says when more is left', async () => {
    const { ctx } = await kernel()
    const sink = new RecordingSink()
    const notifier = new Notifier(ctx, { maxQueue: 1000 }, [sink])
    ctx.store.transaction(() => {
      for (let i = 0; i < 10_500; i++) ctx.eventLog.append({ type: 'provider.turn.submitted', runId: `r${i}` })
      append(ctx, failed('run-last'))
    })
    expect(notifier.pass(NOW)).toBe(true)
    expect(sink.sent).toEqual([])
    expect(notifier.pass(NOW)).toBe(false)
    await notifier.idle()
    expect(sink.sent.map((n) => n.subject)).toEqual(['run-last'])
  }, 60_000)
})

describe('from the real approval queue', () => {
  it('tells a request the queue opened, and no reminder once the operator answered it', async () => {
    const { ctx } = await kernel()
    const fiber = ctx.plugin(StoreApprovals, { policies: POLICIES, sweepSeconds: 3600 })
    await fiber
    cleanups.push(() => fiber.dispose())
    const sink = new RecordingSink()
    const notifier = new Notifier(ctx, { expiryLeadMinutes: 60 }, [sink])
    const verdict = await ctx.approvals.check({ class: 'merge' })
    const request = await ctx.approvals.request({
      subject: { type: 'content', ref: 'pr-7', version: 'v1' }, action: { class: 'merge', summary: 'merge the secret plan' },
      requester: { component: 'board', runId: 'run-7' }, verdict, classification: 'operator-shared',
    })
    notifier.pass()
    await notifier.idle()
    expect(sink.sent).toEqual([expect.objectContaining({ kind: 'approval.opened', subject: request.requestId })])
    expect(JSON.stringify(sink.sent)).not.toContain('secret plan')
    await ctx.approvals.decide([{ requestId: request.requestId, subject: request.subject, verdict: 'approved' }])
    notifier.pass(Date.parse(request.expiresAt) - 30 * 60_000)
    await notifier.idle()
    expect(sink.sent).toHaveLength(1)
  })
})

describe('the plugin, end to end', () => {
  /** A stand-in notify-send on PATH that writes its argv, one per line, to a file. */
  function fakeNotifySend(): { file: string } {
    const bin = tempDir()
    const file = join(bin, 'calls.txt')
    writeFileSync(join(bin, 'notify-send'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${file}'; done\nprintf '%s\\n' '--end--' >> '${file}'\n`)
    chmodSync(join(bin, 'notify-send'), 0o755)
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
    return { file }
  }

  /** A loopback webhook that keeps every body it is posted. */
  async function webhook(): Promise<{ url: string; bodies: unknown[] }> {
    const bodies: unknown[] = []
    const server: Server = createServer((req: IncomingMessage, res) => {
      let text = ''
      req.on('data', (chunk) => { text += chunk })
      req.on('end', () => {
        bodies.push(JSON.parse(text))
        res.writeHead(204).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise((resolve) => server.close(resolve)))
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/secret-token-123`, bodies }
  }

  it('notifies on the desktop through notify-send, after the producer\'s append returned, with -- before the text', async () => {
    const { file } = fakeNotifySend()
    const { ctx } = await kernel({ notify: { pollSeconds: 3600 } })
    ctx.eventLog.append({ type: 'workflow.node.failed', runId: 'run-1', nodeId: 'a', data: { kind: 'question', disposition: 'USER_ACTION' } })
    // Nothing ran in the producer's call: the notice comes on the notifier's own clock.
    expect(deliveries(ctx)).toEqual([])
    await until(() => deliveries(ctx).some((d) => d.outcome === 'sent'))
    const argv = readFileSync(file, 'utf8').split('\n')
    expect(argv.slice(0, 4)).toEqual(['--app-name=system', '--urgency=normal', '--', 'Run run-1 needs you'])
    expect(argv).toContain('→ system continue run-1 a')
  })

  it('without notify-send, is a no-op it records as unavailable at start and as failed for each notice', async () => {
    vi.stubEnv('PATH', tempDir())
    const { ctx } = await kernel({ notify: { pollSeconds: 3600 } })
    expect(deliveries(ctx)).toEqual([{ outcome: 'unavailable', sink: 'desktop', reason: expect.stringMatching(/notify-send is not on PATH.*desktop: false/) }])
    ctx.eventLog.append({ type: 'workflow.node.escalated', runId: 'run-1', nodeId: 'a', data: {} })
    await until(() => deliveries(ctx).some((d) => d.outcome === 'failed'))
  })

  it('refuses the webhook while egress is not declared for it: nothing is posted, the refusal is recorded (INV-12)', async () => {
    vi.stubEnv('PATH', tempDir())
    const hook = await webhook()
    const { ctx } = await kernel({ vault: true, mcp: true, notify: { desktop: false, pollSeconds: 3600, webhook: { enabled: true } } })
    const mcp = (ctx as unknown as { mcp: RecordingMcp }).mcp
    expect(await mcp.tools.get('notify_webhook')!.handler({ value: hook.url }, { scope: 'operator' })).toMatchObject({ content: [{ text: 'stored the webhook URL under SYSTEM_NOTIFY_WEBHOOK_URL' }] })
    ctx.eventLog.append({ type: 'workflow.node.escalated', runId: 'run-1', nodeId: 'a', data: {} })
    await until(() => deliveries(ctx).length > 0)
    expect(hook.bodies).toEqual([])
    const [refused] = deliveries(ctx)
    expect(refused).toMatchObject({ outcome: 'failed', sink: 'webhook', reason: expect.stringMatching(/^egress refused \(decision sha256:[0-9a-f]{64}\): operator-shared content may not leave for webhook Workers; declare it/) })
    // The egress decision is recorded, on the exact payload, and the URL is in no event.
    expect(ctx.artifacts.list({ kind: 'decision', decisionType: 'egress' })).toHaveLength(1)
    expect(JSON.stringify(ctx.eventLog.query({ limit: 1000 }))).not.toContain('secret-token-123')
  })

  it('refuses the webhook with no egress gate loaded (fail closed)', async () => {
    vi.stubEnv('PATH', tempDir())
    const { ctx } = await kernel({ egress: false, vault: true, notify: { desktop: false, pollSeconds: 3600, webhook: { enabled: true } } })
    ctx.eventLog.append({ type: 'workflow.node.escalated', runId: 'run-1', nodeId: 'a', data: {} })
    await until(() => deliveries(ctx).length > 0)
    expect(deliveries(ctx)[0]).toMatchObject({ outcome: 'failed', sink: 'webhook', reason: expect.stringMatching(/no egress gate/) })
  })

  it('posts the notice as notification@1.0 once egress is declared, the URL read from the vault', async () => {
    vi.stubEnv('PATH', tempDir())
    const hook = await webhook()
    const { ctx } = await kernel({ vault: true, egress: { workerClasses: { webhook: ['operator-shared'] } }, notify: { desktop: false, pollSeconds: 3600, webhook: { enabled: true } } })
    await ctx.credentials.set('SYSTEM_NOTIFY_WEBHOOK_URL' as never, hook.url)
    ctx.eventLog.append({ type: 'resources.pool.limited', data: { pool: 'max.agents', account: 'max', window: 'five-hour', until: iso(Date.now() + 3600_000), source: 'limit-notice' } })
    await until(() => hook.bodies.length > 0)
    const [body] = hook.bodies
    schemas.assert('notification@1.0', body)
    expect(body).toMatchObject({ kind: 'pool.limited', subject: 'max.agents', link: 'http://127.0.0.1:47317/ui/' })
    await until(() => deliveries(ctx).some((d) => d.outcome === 'sent' && d.sink === 'webhook'))
  })

  it('says no URL is stored, and never sends one that is not https or http to this machine', async () => {
    vi.stubEnv('PATH', tempDir())
    const { ctx } = await kernel({ vault: true, mcp: true, egress: { workerClasses: { webhook: ['operator-shared'] } }, notify: { desktop: false, pollSeconds: 3600, webhook: { enabled: true } } })
    ctx.eventLog.append({ type: 'workflow.node.escalated', runId: 'run-1', nodeId: 'a', data: {} })
    await until(() => deliveries(ctx).length > 0)
    expect(deliveries(ctx)[0]).toMatchObject({ outcome: 'failed', reason: 'no webhook URL is stored under SYSTEM_NOTIFY_WEBHOOK_URL (system notify webhook < file)' })
    const mcp = (ctx as unknown as { mcp: RecordingMcp }).mcp
    expect(await mcp.tools.get('notify_webhook')!.handler({ value: 'http://hooks.example.test/x' }, { scope: 'operator' })).toMatchObject({ isError: true })
    expect(webhookProblem('https://user:pw@hooks.example.test/x')).toMatch(/user or password/)
    expect(webhookProblem('https://hooks.example.test/x?token=abc')).toBeUndefined()
    expect(webhookProblem('http://localhost:8080/x')).toBeUndefined()
  })

  it('refuses a configuration the schema cannot state: a link with a token, a bad reference, no kinds', () => {
    expect(configProblems({})).toEqual([])
    expect(configProblems({ link: 'http://127.0.0.1:47317/ui/#token=abc' })).toEqual(['link must carry no fragment, user, or password: the token stays out of notices'])
    expect(configProblems({ link: 'file:///ui' })).toEqual(['link must be an http or https URL'])
    expect(configProblems({ webhook: { credential: 'https://x' } })).toEqual(['webhook.credential must be a credential reference (an UPPER_SNAKE name), not https://x'])
    expect(configProblems({ kinds: [] })).toEqual(['kinds is empty: turn the notify row off instead'])
    expect(KINDS).toHaveLength(7)
  })
})
