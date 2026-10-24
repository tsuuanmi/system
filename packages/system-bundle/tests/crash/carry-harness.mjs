/**
 * One daemon process for the carry crash case (plain JavaScript on the built packages): boots the
 * store, routing, and the agent Worker source with one writing Worker on a scripted runtime, a worktree
 * per workflow run of the repository `<dir>/repo`. Reports on stdout as `@@ {json}` lines.
 * - `crash`: the writing run of workflow run `run_p` changes calc.py in its worktree; then the worktree
 *   of `run_r` is carried from that tree (ADR-0061) with a `git` first on PATH whose `read-tree` marks
 *   `<dir>/read-tree` and never returns, so the suite can kill the process with SIGKILL between the new
 *   worktree's `git worktree add --no-checkout` and the reading of the tree into it.
 * - `after`: reports the new worktree as the crash left it; sweeps the worktrees past their retention and
 *   reports what that left (the run's branch, its row, whether the worktree is there); then runs the
 *   agent of `run_r` and reports what calc.py held when it started.
 * Usage: carry-harness.mjs <dir> crash|after
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const [dir, mode] = process.argv.slice(2)
const report = (value) => void process.stdout.write(`@@ ${JSON.stringify(value)}\n`)
const repo = join(dir, 'repo')
const marker = join(dir, 'read-tree')

if (mode === 'crash') {
  // Read when the agent Worker source loads: put first on PATH before it is imported.
  const real = process.env.PATH.split(delimiter).map((p) => join(p, 'git')).find((p) => existsSync(p))
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = read-tree ]; then\n    : > '${marker}'\n    exec sleep 600\n  fi\ndone\nexec '${real}' "$@"\n`)
  chmodSync(join(bin, 'git'), 0o755)
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
}

const { Context } = await import('@deepseek-ai/cordis')
const { default: AgentRuntimeRegistry } = await import('@tsuuanmi/system-agent-runtimes')
const { default: AgentWorkers } = await import('@tsuuanmi/system-agent-workers')
const { default: Artifacts } = await import('@tsuuanmi/system-artifacts')
const { default: Egress } = await import('@tsuuanmi/system-egress')
const { default: EventLog } = await import('@tsuuanmi/system-event-log')
const { default: Leases } = await import('@tsuuanmi/system-leases')
const { default: Store } = await import('@tsuuanmi/system-store')
const { default: WorkerRouter } = await import('@tsuuanmi/system-workers')
const { LEASE_CAP_MS } = await import('./leases.mjs')

/** What `path` holds, or null when there is no such file: read once, never checked first. */
const contents = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** A scripted writing agent: says what calc.py holds when it starts, and, in `crash`, changes it. */
const scripted = {
  kind: 'scripted',
  probe: async () => ({ available: true, detail: 'scripted', sandboxes: ['read-only', 'workspace-write'], resume: false, executes: false, readsConfined: true, gatesToolCalls: true }),
  run: async (spec) => {
    const path = join(spec.workspace, 'calc.py')
    report({ ran: { workspace: spec.workspace, calc: contents(path) } })
    if (mode === 'crash') writeFileSync(path, 'def add(a, b):\n    return a + b\n')
    return { text: 'done' }
  },
}

const ctx = new Context()
const fibers = [
  ctx.plugin(Store, { path: join(dir, 'system.db') }), ctx.plugin(Artifacts, {}), ctx.plugin(EventLog, {}), ctx.plugin(Leases, { maxTtlMs: LEASE_CAP_MS }), ctx.plugin(Egress, {}),
  ctx.plugin(WorkerRouter, {}), ctx.plugin(AgentRuntimeRegistry, {}),
  ctx.plugin(AgentWorkers, { workers: [{ id: 'dev', runtime: 'scripted', workspace: repo, sandbox: 'workspace-write', tier: 'standard', tools: [], worktreePerRun: true }], worktreeRoot: join(dir, 'worktrees') }),
]
await Promise.all(fibers)
await new Promise((resolve) => ctx.inject(['agentWorkers', 'agentRuntimes'], () => resolve(undefined)))
ctx.agentRuntimes.register(scripted)
const source = ctx.workers.source('agents')
/** One writing agent run of workflow run `runId`, to its end. */
const write = (runId) => source.wait(source.start({
  key: `k-${runId}`, worker: 'agent:dev', prompt: `work of ${runId}`, runId, decisions: { tier: 'sha256:0', route: 'sha256:0' },
  requirement: {
    schema: 'work-requirement@1.0', objective: 'change calc.py', capabilities: ['develop'], data: { classification: 'operator-shared', refs: [] },
    egressPolicy: 'egress.classification-and-secrets', tier: { min: 'economy', source: 'caller' }, acceptance: { contract: 'acceptance.answer' },
  },
}).id, 60_000)
const git = (at, ...args) => execFileSync('git', ['-C', at, ...args], { encoding: 'utf8' }).trim()
const rowOf = () => ctx.store.db.prepare("SELECT path, carried_from, carried_commit, removed_at FROM agent_worktrees WHERE workflow_run_id = 'run_r'").get()

if (mode === 'crash') {
  const done = await write('run_p')
  const { workspace, subject } = ctx.artifacts.get(done.result).body
  report({ wrote: { status: done.status, workspace } })
  // Never settles: its read-tree waits until the process is killed.
  void ctx.workers.carry({ runId: 'run_r', from: { runId: 'run_p', workspace, subject: { ref: subject.ref, version: subject.version } }, message: 'system: carry the work of run_p into run_r' })
  const cut = setInterval(() => {
    if (existsSync(marker) && rowOf()) {
      clearInterval(cut)
      report({ cut: rowOf() })
    }
  }, 50)
} else {
  const { path, ...row } = rowOf()
  report({ before: { path, row, status: git(path, 'status', '--porcelain') } })
  const swept = await ctx.agentWorkers.sweepWorktrees(Date.now() + 169 * 60 * 60_000)
  const after = rowOf()
  report({ swept: { ...swept, tip: git(repo, 'rev-parse', 'system/run/run_r'), head: git(repo, 'rev-parse', 'HEAD'), row: { carried_from: after.carried_from, carried_commit: after.carried_commit }, exists: existsSync(path) } })
  const again = await write('run_r')
  report({ rerun: { status: again.status } })
  for (const fiber of [...fibers].reverse()) await fiber.dispose()
  process.exit(0)
}
